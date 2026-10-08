// Doble en memoria del cliente de Supabase (subconjunto de postgrest-js) para
// pruebas de integración de rutas: permite montar los routers reales de Express
// sin red ni base de datos. Solo implementa lo que usan las rutas de
// publicaciones (bolsas.js, admin.js, negocios.js) y sus servicios:
//
//   select (con embebidos `tabla(cols)` y { count, head }), insert, upsert
//   (solo { onConflict, ignoreDuplicates: true }), update, delete, eq, neq, gt,
//   gte, lt, lte, in, is, ilike, not(col,'in'|'is',...), or, order, limit,
//   range, single, maybeSingle, rpc.
//
// Fidelidad deliberada en tres puntos que importan para estas pruebas:
//   · la proyección de columnas (un campo que no se selecciona no viaja);
//   · `.or()` repetido se combina con AND, igual que PostgREST con varios
//     parámetros `or=` en la misma URL;
//   · columnas UNIQUE de UNICOS (error 23505 al repetir; upsert con
//     ignoreDuplicates las omite como ON CONFLICT DO NOTHING).

const crypto = require('node:crypto');

const DEFAULTS = {
  bolsas: () => ({
    activo: true,
    estado_aprobacion: 'aprobado',
    motivo_rechazo: null,
    inactivo_desde: null,
    eliminado_en: null,
    eliminado_por: null,
    fecha_caducidad: null,
    created_at: new Date().toISOString(),
  }),
  // DEFAULTs de la migración 202610061200 (visible) y de la tabla (created_at).
  resenas: () => ({
    visible: true,
    created_at: new Date().toISOString(),
  }),
  // DEFAULTs de la migración 202610070900.
  intentos_pago: () => ({
    iniciado_en: new Date().toISOString(),
    resultado: 'pendiente',
    finalizado_en: null,
    status_raw: null,
  }),
  eventos_analitica: () => ({
    recibido_en: new Date().toISOString(),
  }),
};

const UNICOS = {
  eventos_dominio: ['idempotency_key'],
  intentos_pago: ['payment_intent_token'],
  eventos_analitica: ['client_event_id'],
};

function dividirNivelSuperior(texto) {
  const partes = [];
  let nivel = 0, actual = '';
  for (const c of texto) {
    if (c === '(') nivel++;
    if (c === ')') nivel--;
    if (c === ',' && nivel === 0) { partes.push(actual.trim()); actual = ''; continue; }
    actual += c;
  }
  if (actual.trim()) partes.push(actual.trim());
  return partes;
}

function valorLiteral(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function comparar(a, b) {
  if (a == null || b == null) return NaN;
  const na = Number(a), nb = Number(b);
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && a !== '' && b !== '' &&
      Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function iguales(a, b) {
  // SQL: NULL = x nunca es verdadero (para eso existe `is.null`).
  if (a == null || b == null) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return comparar(a, b) === 0;
}

function evaluar(fila, col, op, valor) {
  const v = fila[col];
  switch (op) {
    case 'eq': return iguales(v, valor);
    case 'neq': return !iguales(v, valor);
    case 'gt': return comparar(v, valor) > 0;
    case 'gte': return comparar(v, valor) >= 0;
    case 'lt': return comparar(v, valor) < 0;
    case 'lte': return comparar(v, valor) <= 0;
    case 'is': return valor === null ? v == null : v === valor;
    case 'in': return valor.some(x => iguales(v, x));
    case 'ilike': {
      const re = new RegExp('^' + String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return v != null && re.test(String(v));
    }
    default: throw new Error(`fakeSupabase: operador no soportado ${op}`);
  }
}

function parsearOr(expr) {
  return dividirNivelSuperior(expr).map((cond) => {
    const [col, op, ...resto] = cond.split('.');
    return { col, op, valor: valorLiteral(resto.join('.')) };
  });
}

class Query {
  constructor(db, tabla) {
    this.db = db;
    this.tabla = tabla;
    this.filtros = [];
    this.accion = 'select';
    this.columnas = '*';
    this.opciones = {};
    this.modo = 'many';
    this.orden = null;
    this.limite = null;
    this.rango = null;
    this.devolver = false;
    this.omitirDuplicados = false;
  }

  select(columnas = '*', opciones = {}) {
    if (this.accion === 'select') { this.columnas = columnas; this.opciones = opciones; }
    else { this.devolver = true; this.columnas = columnas; }
    return this;
  }
  insert(filas) { this.accion = 'insert'; this.payload = Array.isArray(filas) ? filas : [filas]; return this; }
  upsert(filas, { ignoreDuplicates = false } = {}) {
    if (!ignoreDuplicates) throw new Error('fakeSupabase: upsert solo soporta ignoreDuplicates: true');
    this.omitirDuplicados = true;
    return this.insert(filas);
  }
  update(valores) { this.accion = 'update'; this.payload = valores; return this; }
  delete() { this.accion = 'delete'; return this; }

  _f(fn) { this.filtros.push(fn); return this; }
  eq(c, v) { return this._f(f => evaluar(f, c, 'eq', v)); }
  neq(c, v) { return this._f(f => evaluar(f, c, 'neq', v)); }
  gt(c, v) { return this._f(f => evaluar(f, c, 'gt', v)); }
  gte(c, v) { return this._f(f => evaluar(f, c, 'gte', v)); }
  lt(c, v) { return this._f(f => evaluar(f, c, 'lt', v)); }
  lte(c, v) { return this._f(f => evaluar(f, c, 'lte', v)); }
  in(c, v) { return this._f(f => evaluar(f, c, 'in', v)); }
  is(c, v) { return this._f(f => evaluar(f, c, 'is', v)); }
  ilike(c, v) { return this._f(f => evaluar(f, c, 'ilike', v)); }
  not(c, op, v) {
    const lista = op === 'in' ? String(v).replace(/^\(|\)$/g, '').split(',') : valorLiteral(v);
    return this._f(f => !evaluar(f, c, op, lista));
  }
  or(expr) {
    const conds = parsearOr(expr);
    return this._f(f => conds.some(({ col, op, valor }) => evaluar(f, col, op, valor)));
  }
  order(col, { ascending = true } = {}) { this.orden = { col, ascending }; return this; }
  limit(n) { this.limite = n; return this; }
  range(desde, hasta) { this.rango = [desde, hasta]; return this; }
  single() { this.modo = 'single'; return this; }
  maybeSingle() { this.modo = 'maybe'; return this; }

  then(resolve, reject) { return Promise.resolve().then(() => this._ejecutar()).then(resolve, reject); }

  _filas() { return this.db.tablas[this.tabla] || (this.db.tablas[this.tabla] = []); }

  _proyectar(fila) {
    const cols = dividirNivelSuperior(this.columnas || '*');
    const salida = {};
    for (const col of cols) {
      const emb = /^(\w+)\((.*)\)$/.exec(col);
      if (emb) {
        const [, rel, sub] = emb;
        const fk = rel.replace(/s$/, '') + '_id';
        const relacionada = (this.db.tablas[rel] || []).find(r => r.id === fila[fk]);
        salida[rel] = relacionada
          ? new Query(this.db, rel).select(sub)._proyectar(relacionada)
          : null;
      } else if (col === '*') {
        Object.assign(salida, structuredClone(fila));
      } else if (col in fila) {
        salida[col] = structuredClone(fila[col]);
      }
    }
    return salida;
  }

  _resultado(filas) {
    const error = this.db.fallos.length ? this.db.fallos.shift() : null;
    if (error) return { data: null, error, count: null };
    if (this.modo === 'single') {
      if (filas.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: filas[0], error: null };
    }
    if (this.modo === 'maybe') return { data: filas[0] || null, error: null };
    return { data: filas, error: null };
  }

  _ejecutar() {
    const todas = this._filas();
    const coincide = (f) => this.filtros.every(fn => fn(f));

    if (this.accion === 'insert') {
      const insertadas = [];
      for (const p of this.payload) {
        const fila = { id: crypto.randomUUID(), ...(DEFAULTS[this.tabla]?.() || {}), ...structuredClone(p) };
        const choca = (UNICOS[this.tabla] || []).find(col => fila[col] != null && todas.some(r => r[col] === fila[col]));
        if (choca && this.omitirDuplicados) continue;
        if (choca) {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${choca})` } };
        }
        todas.push(fila);
        insertadas.push(fila);
      }
      return this._resultado(this.devolver ? insertadas.map(f => this._proyectar(f)) : []);
    }

    if (this.accion === 'update') {
      const afectadas = todas.filter(coincide);
      for (const f of afectadas) Object.assign(f, structuredClone(this.payload));
      return this._resultado(this.devolver ? afectadas.map(f => this._proyectar(f)) : []);
    }

    if (this.accion === 'delete') {
      const quedan = todas.filter(f => !coincide(f));
      this.db.tablas[this.tabla] = quedan;
      return this._resultado([]);
    }

    let filas = todas.filter(coincide);
    if (this.orden) {
      const { col, ascending } = this.orden;
      filas = [...filas].sort((a, b) => (ascending ? 1 : -1) * comparar(a[col], b[col]));
    }
    if (this.limite != null) filas = filas.slice(0, this.limite);
    if (this.rango) filas = filas.slice(this.rango[0], this.rango[1] + 1);
    if (this.opciones.head) return { data: null, error: null, count: filas.length };
    const r = this._resultado(filas.map(f => this._proyectar(f)));
    if (this.opciones.count) r.count = filas.length;
    return r;
  }
}

function crearFakeSupabase(tablasIniciales = {}) {
  const db = {
    tablas: structuredClone(tablasIniciales),
    // Cola de errores a inyectar: cada uno lo consume, en orden, la siguiente
    // consulta que termine.
    fallos: [],
  };
  return {
    _db: db,
    from: (tabla) => new Query(db, tabla),
    rpc: async () => ({ data: null, error: null }),
    // Fuerza que la próxima consulta devuelva este error (para probar fallbacks).
    inyectarError(error) { db.fallos.push(error); },
    // Reemplaza todo el contenido (cada escenario arranca de un estado conocido).
    reiniciar(tablas = {}) { db.tablas = structuredClone(tablas); db.fallos.length = 0; },
    tabla(nombre) { return db.tablas[nombre] || []; },
  };
}

module.exports = { crearFakeSupabase };
