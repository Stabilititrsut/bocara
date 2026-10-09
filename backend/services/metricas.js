// Servicio canónico de indicadores (módulo "03 · Indicadores y Embudo").
// Fuente: Bocara_Guia_Visual_y_Requerimientos_Ingenieria.docx, sección 2.
//
// Cada KPI se devuelve con el contrato de la guía:
//   { clave, nombre, valor, unidad, formula, numerador, denominador, periodo,
//     exclusiones, estado: 'ok' | 'no_aplica' | 'sin_datos' }
//
//   · 'no_aplica'  → hay medición, pero el denominador es 0 (valor null).
//   · 'sin_datos'  → no hay medición observable en el periodo: la
//                    instrumentación no existía, no se registró inversión, la
//                    tabla no está desplegada... numerador/denominador/valor
//                    van en null. Nunca se rellena con ceros.
//
// Orígenes:
//   · RPC obtener_kpis_admin (SQL): pedidos completados, recompra, ticket
//     promedio y tiempos operativos (medianas percentile_cont).
//   · Este módulo, desde las tablas: conversión, liquidez, merma, CAC,
//     abandono del pago, pagos fallidos y negocios con oferta activa.
//
// Venta válida = estado_pago 'pagado' + estado distinto de 'cancelado' +
// cubo_payment_intent_token y cubo_identifier presentes (es_venta_valida en
// SQL; esVentaValida aquí). El evento 'purchase' que manda el cliente NUNCA
// cuenta como compra: las compras se leen de pedidos.

const {
  ZONA_GUATEMALA, ahoraGuatemala, hoyGuatemala, normalizarFecha, normalizarHora, sumarDias,
  rangoDiaGuatemalaUTC, rangoMesGuatemalaUTC,
} = require('./horarioGuatemala');
const { TIPOS_PUBLICACION, esAprobada, motivosNoVisible, negocioDisponiblePublico } = require('./publicaciones');

function supabasePorDefecto() {
  return require('../config/supabase');
}

const PERIODOS = Object.freeze(['hoy', 'mes_actual', 'mes', 'rango', 'historico']);
// Primer día con operación real en Bocara: el "histórico" arranca aquí.
const INICIO_HISTORICO = '2024-01-01';
// Ventana para declarar abandonado un inicio de pago: 2 × el TTL de la reserva
// (15 min, services/stock.js). Pasado el TTL la RPC ya rechaza el cobro, así
// que un pago que no se aprobó en esta ventana no se aprobará.
const VENTANA_ABANDONO_MINUTOS = 30;
const FUENTES_META = Object.freeze(['meta', 'meta_ads', 'facebook', 'fb', 'instagram', 'ig']);
const TAMANO_PAGINA = 1000;
const TAMANO_LOTE_IN = 200;
const MAX_FILAS = 200000;

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Definiciones (texto de la guía) ──────────────────────────────────────────

const DEFINICIONES = Object.freeze({
  conversion_compra: {
    nombre: 'Conversión a compra', unidad: '%',
    formula: 'Sesiones medidas con ≥1 compra pagada / sesiones medidas del periodo × 100',
    exclusiones: 'Sesiones sin eventos de analítica (no se reconstruyen visitas desde pedidos). La compra se verifica contra pedidos válidos, no contra el evento purchase del cliente.',
  },
  pedidos_completados: {
    nombre: 'Pedidos completados', unidad: '%',
    formula: 'Pedidos completados / pedidos creados válidos de la cohorte del periodo × 100',
    exclusiones: 'Borradores y pedidos sin pago verificado por Cubo.',
  },
  recompra: {
    nombre: 'Recompra', unidad: '%',
    formula: 'Compradores del periodo con ≥2 compras válidas acumuladas / compradores únicos del periodo × 100',
    exclusiones: 'Pedidos que no son venta válida.',
  },
  liquidez_ofertas: {
    nombre: 'Liquidez de ofertas', unidad: '%',
    formula: 'Ofertas publicadas de la cohorte con ≥1 venta válida / ofertas publicadas de esa cohorte × 100',
    exclusiones: 'Ofertas pendientes o rechazadas por moderación. La cohorte es la fecha de publicación (fecha_disponible o creación).',
  },
  tiempo_limitado_merma: {
    nombre: 'Tiempo limitado / Merma', unidad: '%',
    formula: 'Unidades vendidas dentro de su vigencia / unidades publicadas de esas ofertas × 100',
    exclusiones: 'Promociones (tipo cupón), ofertas con la vigencia aún abierta y ofertas sin fecha de caducidad.',
  },
  cac_meta_ads: {
    nombre: 'CAC · Meta Ads', unidad: 'GTQ',
    formula: 'Inversión publicitaria Meta Ads del periodo (prorrateada por días) / compradores nuevos atribuibles a Meta',
    exclusiones: 'Compradores sin sesión atribuida a Meta (utm_source). No se sustituyen compradores por registros.',
  },
  ticket_promedio: {
    nombre: 'Ticket promedio', unidad: 'GTQ',
    formula: 'Venta de productos de pedidos pagados válidos / número de esos pedidos',
    exclusiones: 'Propina, envío, cargo de plataforma y descuentos financiados por Bocara.',
  },
  abandono_pago: {
    nombre: 'Abandono del pago', unidad: '%',
    formula: `Inicios de pago sin compra aprobada dentro de ${VENTANA_ABANDONO_MINUTOS} min / inicios de pago con esa ventana ya observada × 100`,
    exclusiones: 'Procesos de compra cuya ventana aún no termina (se reportan como en curso). Deduplicado por pedido.',
  },
  pagos_fallidos: {
    nombre: 'Pagos fallidos', unidad: '%',
    formula: 'Intentos finalizados como fallidos / intentos de pago con resultado final × 100',
    exclusiones: 'Intentos pendientes (se reportan aparte).',
  },
  tiempos_operativos: {
    nombre: 'Tiempos operativos', unidad: 'minutos',
    formula: 'Mediana de recibido→aceptado (pagado_en → aceptado_en); desglose con aceptado→listo y listo→completado',
    exclusiones: 'Pedidos sin las marcas de tiempo (anteriores a la migración 202610070900).',
  },
  negocios_oferta_activa: {
    nombre: 'Negocios con oferta activa', unidad: '%',
    formula: 'Negocios verificados/habilitados con ≥1 oferta comprable / negocios verificados/habilitados × 100',
    exclusiones: 'Lectura actual: no depende del periodo. Oferta comprable = aprobada, activa, vigente y con unidades.',
  },
});

const ORDEN_KPIS = Object.freeze(Object.keys(DEFINICIONES));

const PASOS_EMBUDO = Object.freeze([
  { clave: 'visita', nombre: 'Visita', evento: null },
  { clave: 'vista_oferta', nombre: 'Vista de oferta', evento: 'view_item' },
  { clave: 'carrito', nombre: 'Carrito', evento: 'add_to_cart' },
  { clave: 'inicio_pago', nombre: 'Inicio de pago', evento: 'begin_checkout' },
  { clave: 'compra_pagada', nombre: 'Compra pagada', evento: null },
]);

// ── Utilidades ───────────────────────────────────────────────────────────────

const redondear = (v, decimales = 2) => {
  const f = 10 ** decimales;
  return Math.round((v + Number.EPSILON) * f) / f;
};
const ms = (iso) => (iso == null ? NaN : new Date(iso).getTime());
const fechaVenta = (p) => p.pagado_en || p.created_at;

function esVentaValida(p) {
  return !!p && p.estado_pago === 'pagado' && p.estado !== 'cancelado'
    && p.cubo_payment_intent_token != null && p.cubo_identifier != null;
}

function fechaValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Instante UTC de una hora de pared de Guatemala (UTC-6 fijo, sin horario de verano).
const instanteGuatemala = (fecha, hora = '00:00:00') => new Date(`${fecha}T${hora}-06:00`);

function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ── Periodo y filtros ────────────────────────────────────────────────────────

// Traduce los parámetros de consulta a un rango [desde, hasta) en UTC, con los
// días de calendario de Guatemala que cubre (ambos inclusivos).
function resolverPeriodo({ periodo = 'mes_actual', mes, desde, hasta } = {}, ahora = new Date()) {
  const hoy = hoyGuatemala(ahora);
  const armar = (tipo, desdeLocal, hastaLocal) => {
    const rango = {
      desde: rangoDiaGuatemalaUTC(desdeLocal).desde,
      hasta: rangoDiaGuatemalaUTC(hastaLocal).hasta,
    };
    return {
      periodo: {
        tipo, desde: rango.desde, hasta: rango.hasta, hasta_exclusivo: true,
        desde_local: desdeLocal, hasta_local: hastaLocal, zona_horaria: ZONA_GUATEMALA,
        abierto: ms(rango.hasta) > ahora.getTime(),
      },
    };
  };
  const ultimoDiaDeMes = (m) => sumarDias(`${new Date(ms(rangoMesGuatemalaUTC(m).hasta)).toISOString().slice(0, 7)}-01`, -1);

  switch (periodo) {
    case 'hoy':
      return armar('hoy', hoy, hoy);
    case 'mes_actual': {
      const m = hoy.slice(0, 7);
      return armar('mes_actual', `${m}-01`, ultimoDiaDeMes(m));
    }
    case 'mes':
      if (!RE_MES.test(mes || '')) return { error: 'mes debe tener formato YYYY-MM' };
      return armar('mes', `${mes}-01`, ultimoDiaDeMes(mes));
    case 'rango':
      if (!fechaValida(desde) || !fechaValida(hasta)) return { error: 'desde y hasta deben ser fechas válidas YYYY-MM-DD' };
      if (desde > hasta) return { error: 'desde no puede ser posterior a hasta' };
      return armar('rango', desde, hasta);
    case 'historico':
      return armar('historico', INICIO_HISTORICO, hoy);
    default:
      return { error: `periodo debe ser uno de: ${PERIODOS.join(', ')}` };
  }
}

function resolverFiltros({ negocio_id, zona, tipo } = {}) {
  const filtros = { negocio_id: null, zona: null, tipo: null };
  if (negocio_id != null && negocio_id !== '') {
    if (!RE_UUID.test(String(negocio_id))) return { error: 'negocio_id debe ser un UUID' };
    filtros.negocio_id = String(negocio_id).toLowerCase();
  }
  if (zona != null && String(zona).trim() !== '') {
    const z = String(zona).trim();
    if (z.length > 80) return { error: 'zona no puede superar 80 caracteres' };
    filtros.zona = z;
  }
  if (tipo != null && tipo !== '') {
    if (!TIPOS_PUBLICACION.includes(tipo)) return { error: `tipo debe ser uno de: ${TIPOS_PUBLICACION.join(', ')}` };
    filtros.tipo = tipo;
  }
  return { filtros };
}

const hayFiltros = (f) => !!(f.negocio_id || f.zona || f.tipo);

// ── Contrato ─────────────────────────────────────────────────────────────────

function construirKpi(clave, { numerador, denominador, escala = 1, decimales = 2, sinDatos = false, periodo, extra = {} }) {
  const def = DEFINICIONES[clave];
  const base = {
    clave, nombre: def.nombre, valor: null, unidad: def.unidad, formula: def.formula,
    numerador: null, denominador: null, periodo, exclusiones: def.exclusiones, estado: 'sin_datos',
  };
  if (sinDatos) return { ...base, ...extra };
  const num = Number(numerador) || 0;
  const den = Number(denominador) || 0;
  if (den === 0) return { ...base, numerador: num, denominador: 0, estado: 'no_aplica', ...extra };
  return { ...base, valor: redondear((num / den) * escala, decimales), numerador: num, denominador: den, estado: 'ok', ...extra };
}

// Una mediana no es un cociente: numerador/denominador van en null y la
// cantidad de pedidos medidos viaja en `muestras`.
function construirMediana({ clave, nombre, formula, mediana, muestras, periodo }) {
  const n = Number(muestras) || 0;
  return {
    clave, nombre, valor: n === 0 || mediana == null ? null : redondear(Number(mediana), 1), unidad: 'minutos',
    formula, numerador: null, denominador: null, periodo,
    exclusiones: DEFINICIONES.tiempos_operativos.exclusiones,
    estado: n === 0 || mediana == null ? 'sin_datos' : 'ok', muestras: n,
  };
}

// ── Lectura ──────────────────────────────────────────────────────────────────

// PostgREST corta en 1000 filas por respuesta: sin paginar, un KPI sobre una
// tabla grande saldría calculado sobre un subconjunto, en silencio.
async function leerPaginado(construir) {
  const filas = [];
  for (let inicio = 0; ; inicio += TAMANO_PAGINA) {
    const { data, error } = await construir().range(inicio, inicio + TAMANO_PAGINA - 1);
    if (error) throw new Error(error.message || 'error de lectura');
    filas.push(...(data || []));
    if (!data || data.length < TAMANO_PAGINA) return filas;
    if (filas.length >= MAX_FILAS) throw new Error(`más de ${MAX_FILAS} filas: acotar el periodo o mover el cálculo a SQL`);
  }
}

async function leerPorIds(cliente, tabla, columnas, columnaId, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const filas = [];
  for (let i = 0; i < unicos.length; i += TAMANO_LOTE_IN) {
    const lote = unicos.slice(i, i + TAMANO_LOTE_IN);
    filas.push(...await leerPaginado(() => cliente.from(tabla).select(columnas).in(columnaId, lote).order('id')));
  }
  return filas;
}

async function primerInstante(cliente, tabla, columna) {
  const { data, error } = await cliente.from(tabla).select(columna).order(columna, { ascending: true }).limit(1);
  if (error) throw new Error(error.message || 'error de lectura');
  return data?.[0]?.[columna] || null;
}

const COLUMNAS_PEDIDO = 'id,usuario_id,negocio_id,bolsa_id,cantidad,estado,estado_pago,pagado_en,created_at,cubo_payment_intent_token,cubo_identifier';
const COLUMNAS_BOLSA = 'id,negocio_id,tipo,created_at,fecha_disponible,fecha_caducidad,hora_recogida_inicio,hora_recogida_fin,cantidad_disponible,activo,estado_aprobacion,eliminado_en';

// Cada fuente se carga aislada: si una falla (p. ej. la migración no está
// desplegada), sus KPIs salen 'sin_datos' con una advertencia y el resto sigue.
async function cargar(advertencias, fuente, fn) {
  try {
    return { ok: true, datos: await fn() };
  } catch (err) {
    advertencias.push({ fuente, detalle: err.message });
    return { ok: false, datos: null };
  }
}

// ── Filtros sobre filas ──────────────────────────────────────────────────────

function crearFiltro(filtros, { negociosPorId, bolsasPorId, itemsPorPedido }) {
  const zona = filtros.zona ? filtros.zona.trim().toLowerCase() : null;
  const negocioOk = (negocioId) => {
    if (filtros.negocio_id && String(negocioId || '').toLowerCase() !== filtros.negocio_id) return false;
    if (zona && String(negociosPorId.get(negocioId)?.zona || '').trim().toLowerCase() !== zona) return false;
    return true;
  };
  const bolsaOk = (b) => !!b && negocioOk(b.negocio_id) && (!filtros.tipo || b.tipo === filtros.tipo);
  const bolsasDePedido = (p) => [p.bolsa_id, ...(itemsPorPedido.get(p.id) || []).map((i) => i.bolsa_id)].filter(Boolean);
  // Igual que la RPC: un pedido mixto entra en ambos tipos.
  const pedidoOk = (p) => negocioOk(p.negocio_id)
    && (!filtros.tipo || bolsasDePedido(p).some((id) => bolsasPorId.get(id)?.tipo === filtros.tipo));
  const eventoOk = (e) => {
    if (!hayFiltros(filtros)) return true;
    const b = bolsasPorId.get(e.bolsa_id);
    const negocioId = e.negocio_id || b?.negocio_id;
    if (!negocioId || !negocioOk(negocioId)) return false;
    return !filtros.tipo || b?.tipo === filtros.tipo;
  };
  return { negocioOk, bolsaOk, pedidoOk, eventoOk };
}

function unidadesPorBolsa(pedido, itemsPorPedido) {
  const items = itemsPorPedido.get(pedido.id) || [];
  if (items.length) return items.map((i) => [i.bolsa_id, Number(i.cantidad) || 0]);
  return pedido.bolsa_id ? [[pedido.bolsa_id, Math.max(1, Number(pedido.cantidad) || 1)]] : [];
}

// Agrupa los eventos del periodo por sesión. `compra` se decide con pedidos
// válidos (y que pasan el filtro), nunca con el evento 'purchase' del cliente.
function agruparSesiones(eventos, { eventoOk, compraOk }) {
  const sesiones = new Map();
  for (const e of eventos) {
    let s = sesiones.get(e.sesion_id);
    if (!s) { s = { medida: false, eventos: new Set(), compra: false, fuentes: new Set() }; sesiones.set(e.sesion_id, s); }
    if (eventoOk(e)) { s.medida = true; s.eventos.add(e.evento); }
    if (e.pedido_id && compraOk(e.pedido_id)) s.compra = true;
    if (e.utm_source) s.fuentes.add(String(e.utm_source).trim().toLowerCase());
  }
  return sesiones;
}

function coberturaAnalitica(primerEvento, periodo) {
  if (!primerEvento || ms(primerEvento) >= ms(periodo.hasta)) return { instrumentado: false, cobertura_desde: primerEvento };
  return {
    instrumentado: true,
    cobertura_desde: primerEvento,
    cobertura_parcial: ms(primerEvento) > ms(periodo.desde),
  };
}

// ── Cálculos por KPI ─────────────────────────────────────────────────────────

function kpisDesdeRpc(rpc, periodo) {
  const k = rpc?.kpis || {};
  const desdeRpc = (clave, escala) => {
    const r = k[clave];
    if (!r) return construirKpi(clave, { sinDatos: true, periodo });
    const extra = {};
    if (r.desglose) extra.desglose = r.desglose;
    if (r.cohorte) extra.cohorte = r.cohorte;
    if (r.periodo_abierto != null) extra.periodo_abierto = r.periodo_abierto;
    return construirKpi(clave, { numerador: r.numerador, denominador: r.denominador, escala, periodo, extra });
  };
  const mediana = (claveRpc, nombre, formula) => construirMediana({
    clave: claveRpc, nombre, formula, mediana: k[claveRpc]?.valor ?? null, muestras: k[claveRpc]?.muestras ?? 0, periodo,
  });
  const recibido = mediana('tiempo_recibido_aceptado', 'Recibido → aceptado', 'Mediana de aceptado_en − pagado_en');
  const desglose = [
    recibido,
    mediana('tiempo_aceptado_listo', 'Aceptado → listo (preparación)', 'Mediana de listo_en − aceptado_en'),
    mediana('tiempo_listo_completado', 'Listo → completado (espera de recogida)', 'Mediana de completado_en − listo_en'),
  ];
  const def = DEFINICIONES.tiempos_operativos;
  return {
    pedidos_completados: desdeRpc('pedidos_completados', 100),
    recompra: desdeRpc('recompra', 100),
    ticket_promedio: desdeRpc('ticket_promedio', 1),
    tiempos_operativos: {
      ...recibido, clave: 'tiempos_operativos', nombre: def.nombre, formula: def.formula, desglose,
    },
  };
}

function kpiConversion({ sesiones, cobertura, periodo }) {
  if (!cobertura.instrumentado) return construirKpi('conversion_compra', { sinDatos: true, periodo, extra: { cobertura_desde: cobertura.cobertura_desde } });
  let medidas = 0, conCompra = 0;
  for (const s of sesiones.values()) {
    if (!s.medida) continue;
    medidas++;
    if (s.compra) conCompra++;
  }
  return construirKpi('conversion_compra', {
    numerador: conCompra, denominador: medidas, escala: 100, periodo,
    extra: { cobertura_desde: cobertura.cobertura_desde, cobertura_parcial: cobertura.cobertura_parcial },
  });
}

function fechaPublicacion(b) {
  const f = normalizarFecha(b.fecha_disponible);
  return f ? instanteGuatemala(f).toISOString() : b.created_at;
}

// Fin de la vigencia de una oferta de tiempo limitado: fecha_caducidad + hora
// de fin (cruce de medianoche incluido); sin hora, el fin del día. Sin
// fecha_caducidad no hay vigencia observable → null.
function finVigencia(b) {
  const fecha = normalizarFecha(b.fecha_caducidad);
  if (!fecha) return null;
  const fin = normalizarHora(b.hora_recogida_fin);
  if (!fin) return instanteGuatemala(sumarDias(fecha, 1));
  const inicio = normalizarHora(b.hora_recogida_inicio);
  return instanteGuatemala(inicio && fin < inicio ? sumarDias(fecha, 1) : fecha, fin);
}

function kpisOfertas({ bolsas, ventas, itemsPorPedido, filtro, periodo, ahora }) {
  const vendidas = new Map(); // bolsa_id → [{ unidades, instante }]
  for (const v of ventas) {
    for (const [bolsaId, unidades] of unidadesPorBolsa(v, itemsPorPedido)) {
      if (!vendidas.has(bolsaId)) vendidas.set(bolsaId, []);
      vendidas.get(bolsaId).push({ unidades, instante: ms(fechaVenta(v)) });
    }
  }
  const totalVendido = (id) => (vendidas.get(id) || []).reduce((s, x) => s + x.unidades, 0);

  const cohorte = bolsas.filter((b) => esAprobada(b) && filtro.bolsaOk(b)
    && ms(fechaPublicacion(b)) >= ms(periodo.desde) && ms(fechaPublicacion(b)) < ms(periodo.hasta));

  const liquidez = construirKpi('liquidez_ofertas', {
    numerador: cohorte.filter((b) => totalVendido(b.id) > 0).length,
    denominador: cohorte.length, escala: 100, periodo,
    extra: { ventana_medicion: 'Ventas válidas desde la publicación hasta el fin del periodo' },
  });

  let observadas = 0, enVigencia = 0, sinVigencia = 0, vendidasEnVigencia = 0, publicadas = 0;
  for (const b of cohorte.filter((x) => x.tipo === 'bolsa')) {
    const fin = finVigencia(b);
    if (!fin) { sinVigencia++; continue; }
    if (fin.getTime() > ahora.getTime()) { enVigencia++; continue; }
    observadas++;
    vendidasEnVigencia += (vendidas.get(b.id) || []).filter((x) => x.instante <= fin.getTime()).reduce((s, x) => s + x.unidades, 0);
    publicadas += (Number(b.cantidad_disponible) || 0) + totalVendido(b.id);
  }
  const merma = construirKpi('tiempo_limitado_merma', {
    numerador: vendidasEnVigencia, denominador: publicadas, escala: 100, periodo,
    extra: {
      desglose: { ofertas_observadas: observadas, ofertas_en_vigencia: enVigencia, ofertas_sin_vigencia: sinVigencia },
      nota: 'Unidades publicadas estimadas como disponibles actuales + vendidas válidas: bolsas no guarda aún la cantidad publicada original.',
    },
  });
  return { liquidez, merma };
}

function kpiCac({ ventas, eventos, inversiones, cobertura, filtros, periodo }) {
  if (hayFiltros(filtros)) {
    return {
      ...construirKpi('cac_meta_ads', { sinDatos: true, periodo }),
      estado: 'no_aplica',
      nota: 'La inversión publicitaria no se segmenta por negocio, zona ni tipo.',
    };
  }
  const desdeLocal = periodo.desde_local, hastaLocal = periodo.hasta_local;
  const vigentes = (inversiones || []).filter((i) => (i.canal || 'meta_ads') === 'meta_ads'
    && i.fecha_inicio <= hastaLocal && i.fecha_fin >= desdeLocal);
  if (vigentes.length === 0) {
    return construirKpi('cac_meta_ads', { sinDatos: true, periodo, extra: { nota: 'Sin inversión Meta Ads registrada para el periodo.' } });
  }
  if (!cobertura.instrumentado) {
    return construirKpi('cac_meta_ads', { sinDatos: true, periodo, extra: { nota: 'Sin analítica de sesiones para atribuir compradores.' } });
  }
  const inversion = redondear(vigentes.reduce((s, i) => {
    const desde = i.fecha_inicio > desdeLocal ? i.fecha_inicio : desdeLocal;
    const hasta = i.fecha_fin < hastaLocal ? i.fecha_fin : hastaLocal;
    return s + Number(i.monto) * (diasEntre(desde, hasta) + 1) / (diasEntre(i.fecha_inicio, i.fecha_fin) + 1);
  }, 0));

  const primera = new Map();
  for (const v of ventas) {
    if (!v.usuario_id) continue;
    const actual = primera.get(v.usuario_id);
    if (!actual || ms(fechaVenta(v)) < ms(fechaVenta(actual))) primera.set(v.usuario_id, v);
  }
  const nuevos = [...primera.values()].filter((v) => ms(fechaVenta(v)) >= ms(periodo.desde) && ms(fechaVenta(v)) < ms(periodo.hasta));

  const fuentesPorSesion = new Map();
  const sesionesPorPedido = new Map();
  for (const e of eventos) {
    if (e.utm_source) {
      if (!fuentesPorSesion.has(e.sesion_id)) fuentesPorSesion.set(e.sesion_id, new Set());
      fuentesPorSesion.get(e.sesion_id).add(String(e.utm_source).trim().toLowerCase());
    }
    if (e.pedido_id) {
      if (!sesionesPorPedido.has(e.pedido_id)) sesionesPorPedido.set(e.pedido_id, new Set());
      sesionesPorPedido.get(e.pedido_id).add(e.sesion_id);
    }
  }
  const atribuible = (v) => [...(sesionesPorPedido.get(v.id) || [])]
    .some((s) => [...(fuentesPorSesion.get(s) || [])].some((f) => FUENTES_META.includes(f)));
  const atribuibles = nuevos.filter(atribuible).length;

  return construirKpi('cac_meta_ads', {
    numerador: inversion, denominador: atribuibles, escala: 1, periodo,
    extra: {
      desglose: { compradores_nuevos: nuevos.length, compradores_nuevos_atribuibles: atribuibles, registros_inversion: vigentes.length },
      cobertura_desde: cobertura.cobertura_desde,
    },
  });
}

function kpisPagos({ intentos, pedidosPorId, ventasPorId, filtro, primerIntento, periodo, ahora }) {
  if (!primerIntento || ms(primerIntento) >= ms(periodo.hasta)) {
    const extra = { cobertura_desde: primerIntento };
    return {
      abandono: construirKpi('abandono_pago', { sinDatos: true, periodo, extra }),
      fallidos: construirKpi('pagos_fallidos', { sinDatos: true, periodo, extra }),
    };
  }
  const pasa = (i) => {
    const p = pedidosPorId.get(i.pedido_id);
    return p ? filtro.pedidoOk(p) : !hayFiltros(filtro.filtros);
  };
  const propios = intentos.filter(pasa);

  // Abandono: un proceso de compra por pedido; arranca con su primer intento.
  const procesos = new Map();
  for (const i of propios) {
    const clave = i.pedido_id || i.id;
    if (!procesos.has(clave)) procesos.set(clave, []);
    procesos.get(clave).push(i);
  }
  const ventanaMs = VENTANA_ABANDONO_MINUTOS * 60000;
  let observados = 0, abandonados = 0, enCurso = 0;
  for (const [clave, lista] of procesos) {
    const inicio = Math.min(...lista.map((i) => ms(i.iniciado_en)));
    const limite = inicio + ventanaMs;
    if (limite > ahora.getTime()) { enCurso++; continue; }
    observados++;
    const venta = ventasPorId.get(clave);
    const aprobado = lista.some((i) => i.resultado === 'aprobado' && ms(i.finalizado_en) <= limite)
      || (venta && ms(fechaVenta(venta)) <= limite);
    if (!aprobado) abandonados++;
  }

  const finales = propios.filter((i) => i.resultado !== 'pendiente');
  const fallidos = finales.filter((i) => i.resultado === 'fallido');
  const cobertura = { cobertura_desde: primerIntento, cobertura_parcial: ms(primerIntento) > ms(periodo.desde) };

  return {
    abandono: construirKpi('abandono_pago', {
      numerador: abandonados, denominador: observados, escala: 100, periodo,
      extra: { ventana_minutos: VENTANA_ABANDONO_MINUTOS, desglose: { en_curso: enCurso, observados, abandonados }, ...cobertura },
    }),
    fallidos: construirKpi('pagos_fallidos', {
      numerador: fallidos.length, denominador: finales.length, escala: 100, periodo,
      extra: {
        desglose: {
          aprobados: finales.filter((i) => i.resultado === 'aprobado').length,
          fallidos: fallidos.length,
          expirados: finales.filter((i) => i.resultado === 'expirado').length,
          pendientes: propios.length - finales.length,
          pedidos_afectados: new Set(fallidos.map((i) => i.pedido_id).filter(Boolean)).size,
        },
        ...cobertura,
      },
    }),
  };
}

function kpiNegociosActivos({ negocios, bolsas, filtro, filtros, ahora }) {
  const periodo = { tipo: 'lectura_actual', instante: ahora.toISOString(), zona_horaria: ZONA_GUATEMALA };
  const habilitados = negocios.filter((n) => negocioDisponiblePublico(n) && filtro.negocioOk(n.id));
  const reloj = ahoraGuatemala(ahora);
  const conOferta = new Set(bolsas
    .filter((b) => (!filtros.tipo || b.tipo === filtros.tipo) && motivosNoVisible(b, { ahora: reloj }).length === 0)
    .map((b) => b.negocio_id));
  const num = habilitados.filter((n) => conOferta.has(n.id)).length;
  return construirKpi('negocios_oferta_activa', {
    numerador: num, denominador: habilitados.length, escala: 100, periodo,
    extra: { desglose: { con_oferta: num, sin_oferta: habilitados.length - num } },
  });
}

// ── Orquestación ─────────────────────────────────────────────────────────────

async function cargarBase(cliente, advertencias) {
  const [negocios, bolsas] = await Promise.all([
    cargar(advertencias, 'negocios', () => leerPaginado(() => cliente.from('negocios').select('id,zona,activo,verificado,estado_verificacion').order('id'))),
    cargar(advertencias, 'bolsas', () => leerPaginado(() => cliente.from('bolsas').select(COLUMNAS_BOLSA).order('id'))),
  ]);
  return {
    negocios: negocios.datos || [],
    bolsas: bolsas.datos || [],
    negociosPorId: new Map((negocios.datos || []).map((n) => [n.id, n])),
    bolsasPorId: new Map((bolsas.datos || []).map((b) => [b.id, b])),
    ok: negocios.ok && bolsas.ok,
  };
}

async function cargarEventos(cliente, periodo, advertencias) {
  return cargar(advertencias, 'eventos_analitica', async () => {
    const [primero, eventos] = await Promise.all([
      primerInstante(cliente, 'eventos_analitica', 'recibido_en'),
      leerPaginado(() => cliente.from('eventos_analitica')
        .select('id,sesion_id,evento,negocio_id,bolsa_id,pedido_id,utm_source,ocurrido_en')
        .gte('ocurrido_en', periodo.desde).lt('ocurrido_en', periodo.hasta).order('id')),
    ]);
    return { primero, eventos };
  });
}

async function obtenerIndicadores({ periodo, filtros, ahora = new Date(), cliente = supabasePorDefecto() }) {
  const advertencias = [];
  const base = await cargarBase(cliente, advertencias);

  const [rpc, ventasR, eventosR, intentosR, inversionesR] = await Promise.all([
    cargar(advertencias, 'obtener_kpis_admin', async () => {
      const { data, error } = await cliente.rpc('obtener_kpis_admin', {
        p_desde: periodo.desde, p_hasta: periodo.hasta,
        p_negocio_id: filtros.negocio_id, p_zona: filtros.zona, p_tipo: filtros.tipo,
      });
      if (error) throw new Error(error.message || 'RPC no disponible');
      if (!data?.kpis) throw new Error('RPC sin bloque kpis');
      return data;
    }),
    cargar(advertencias, 'pedidos', () => leerPaginado(() => cliente.from('pedidos').select(COLUMNAS_PEDIDO)
      .eq('estado_pago', 'pagado').neq('estado', 'cancelado')
      .not('cubo_payment_intent_token', 'is', null).not('cubo_identifier', 'is', null)
      .lt('created_at', periodo.hasta).order('id'))),
    cargarEventos(cliente, periodo, advertencias),
    cargar(advertencias, 'intentos_pago', async () => {
      const [primero, intentos] = await Promise.all([
        primerInstante(cliente, 'intentos_pago', 'iniciado_en'),
        leerPaginado(() => cliente.from('intentos_pago').select('id,pedido_id,iniciado_en,resultado,finalizado_en')
          .gte('iniciado_en', periodo.desde).lt('iniciado_en', periodo.hasta).order('id')),
      ]);
      return { primero, intentos };
    }),
    cargar(advertencias, 'inversion_publicitaria', () => leerPaginado(() => cliente.from('inversion_publicitaria')
      .select('id,canal,campana,fecha_inicio,fecha_fin,monto')
      .lte('fecha_inicio', periodo.hasta_local).gte('fecha_fin', periodo.desde_local).order('id'))),
  ]);

  const ventas = (ventasR.datos || []).filter((v) => esVentaValida(v) && ms(fechaVenta(v)) < ms(periodo.hasta));
  const ventasPorId = new Map(ventas.map((v) => [v.id, v]));
  const intentos = intentosR.datos?.intentos || [];
  const idsIntentos = intentos.map((i) => i.pedido_id).filter((id) => id && !ventasPorId.has(id));

  const [itemsR, pedidosIntentosR] = await Promise.all([
    cargar(advertencias, 'pedido_items', () => leerPorIds(cliente, 'pedido_items', 'id,pedido_id,bolsa_id,cantidad', 'pedido_id',
      [...ventas.map((v) => v.id), ...intentos.map((i) => i.pedido_id)])),
    cargar(advertencias, 'pedidos_de_intentos', () => leerPorIds(cliente, 'pedidos', COLUMNAS_PEDIDO, 'id', idsIntentos)),
  ]);
  const itemsPorPedido = new Map();
  for (const it of itemsR.datos || []) {
    if (!itemsPorPedido.has(it.pedido_id)) itemsPorPedido.set(it.pedido_id, []);
    itemsPorPedido.get(it.pedido_id).push(it);
  }
  const pedidosPorId = new Map([...ventas, ...(pedidosIntentosR.datos || [])].map((p) => [p.id, p]));

  const filtro = { ...crearFiltro(filtros, { ...base, itemsPorPedido }), filtros };
  const sinDatos = (clave) => construirKpi(clave, { sinDatos: true, periodo });
  const kpis = {};

  Object.assign(kpis, rpc.ok ? kpisDesdeRpc(rpc.datos, periodo) : {
    pedidos_completados: sinDatos('pedidos_completados'), recompra: sinDatos('recompra'),
    ticket_promedio: sinDatos('ticket_promedio'), tiempos_operativos: sinDatos('tiempos_operativos'),
  });

  const cobertura = eventosR.ok ? coberturaAnalitica(eventosR.datos.primero, periodo) : { instrumentado: false, cobertura_desde: null };
  const eventos = eventosR.datos?.eventos || [];
  const ventasFiltradas = new Set(ventas.filter(filtro.pedidoOk).map((v) => v.id));
  const sesiones = agruparSesiones(eventos, { eventoOk: filtro.eventoOk, compraOk: (id) => ventasFiltradas.has(id) });
  kpis.conversion_compra = eventosR.ok && ventasR.ok ? kpiConversion({ sesiones, cobertura, periodo }) : sinDatos('conversion_compra');

  if (base.ok && ventasR.ok && itemsR.ok) {
    const { liquidez, merma } = kpisOfertas({ bolsas: base.bolsas, ventas, itemsPorPedido, filtro, periodo, ahora });
    kpis.liquidez_ofertas = liquidez;
    kpis.tiempo_limitado_merma = merma;
  } else {
    kpis.liquidez_ofertas = sinDatos('liquidez_ofertas');
    kpis.tiempo_limitado_merma = sinDatos('tiempo_limitado_merma');
  }

  kpis.cac_meta_ads = ventasR.ok && inversionesR.ok && eventosR.ok
    ? kpiCac({ ventas, eventos, inversiones: inversionesR.datos, cobertura, filtros, periodo })
    : sinDatos('cac_meta_ads');

  if (intentosR.ok && pedidosIntentosR.ok && ventasR.ok) {
    const { abandono, fallidos } = kpisPagos({
      intentos, pedidosPorId, ventasPorId, filtro, primerIntento: intentosR.datos.primero, periodo, ahora,
    });
    kpis.abandono_pago = abandono;
    kpis.pagos_fallidos = fallidos;
  } else {
    kpis.abandono_pago = sinDatos('abandono_pago');
    kpis.pagos_fallidos = sinDatos('pagos_fallidos');
  }

  kpis.negocios_oferta_activa = base.ok
    ? kpiNegociosActivos({ negocios: base.negocios, bolsas: base.bolsas, filtro, filtros, ahora })
    : sinDatos('negocios_oferta_activa');

  return {
    periodo, filtros, generado_en: ahora.toISOString(),
    kpis: ORDEN_KPIS.map((c) => kpis[c]),
    advertencias,
  };
}

async function obtenerEmbudo({ periodo, filtros, ahora = new Date(), cliente = supabasePorDefecto() }) {
  const advertencias = [];
  const necesitaCatalogo = hayFiltros(filtros);
  const base = necesitaCatalogo
    ? await cargarBase(cliente, advertencias)
    : { negociosPorId: new Map(), bolsasPorId: new Map(), ok: true };
  const eventosR = await cargarEventos(cliente, periodo, advertencias);
  const respuesta = { periodo, filtros, generado_en: ahora.toISOString(), advertencias };
  const vacio = (estado) => ({
    ...respuesta, estado,
    pasos: PASOS_EMBUDO.map((p) => ({ clave: p.clave, nombre: p.nombre, evento: p.evento, sesiones: null, tasa_desde_anterior: null, tasa_desde_visita: null })),
  });
  if (!eventosR.ok || !base.ok) return vacio('sin_datos');
  const cobertura = coberturaAnalitica(eventosR.datos.primero, periodo);
  if (!cobertura.instrumentado) return { ...vacio('sin_datos'), cobertura_desde: cobertura.cobertura_desde };

  const eventos = eventosR.datos.eventos;
  const pedidosR = await cargar(advertencias, 'pedidos', () => leerPorIds(cliente, 'pedidos', COLUMNAS_PEDIDO, 'id', eventos.map((e) => e.pedido_id)));
  const itemsR = necesitaCatalogo && pedidosR.ok
    ? await cargar(advertencias, 'pedido_items', () => leerPorIds(cliente, 'pedido_items', 'id,pedido_id,bolsa_id,cantidad', 'pedido_id', (pedidosR.datos || []).map((p) => p.id)))
    : { ok: true, datos: [] };
  if (!pedidosR.ok || !itemsR.ok) return vacio('sin_datos');

  const itemsPorPedido = new Map();
  for (const it of itemsR.datos) {
    if (!itemsPorPedido.has(it.pedido_id)) itemsPorPedido.set(it.pedido_id, []);
    itemsPorPedido.get(it.pedido_id).push(it);
  }
  const filtro = crearFiltro(filtros, { ...base, itemsPorPedido });
  const validas = new Set(pedidosR.datos.filter((p) => esVentaValida(p) && filtro.pedidoOk(p)).map((p) => p.id));
  const sesiones = [...agruparSesiones(eventos, { eventoOk: filtro.eventoOk, compraOk: (id) => validas.has(id) }).values()]
    .filter((s) => s.medida);

  const conteos = PASOS_EMBUDO.map((paso) => {
    if (paso.clave === 'visita') return sesiones.length;
    if (paso.clave === 'compra_pagada') return sesiones.filter((s) => s.compra).length;
    return sesiones.filter((s) => s.eventos.has(paso.evento)).length;
  });
  const tasa = (num, den) => (den === 0
    ? { valor: null, numerador: num, denominador: 0, unidad: '%', estado: 'no_aplica' }
    : { valor: redondear((num / den) * 100), numerador: num, denominador: den, unidad: '%', estado: 'ok' });

  return {
    ...respuesta,
    estado: sesiones.length === 0 ? 'no_aplica' : 'ok',
    cobertura_desde: cobertura.cobertura_desde,
    cobertura_parcial: cobertura.cobertura_parcial,
    regla: 'Sesiones únicas que registraron cada paso en el periodo. La compra pagada se verifica contra pedidos válidos.',
    pasos: PASOS_EMBUDO.map((paso, i) => ({
      clave: paso.clave, nombre: paso.nombre, evento: paso.evento, sesiones: conteos[i],
      tasa_desde_anterior: i === 0 ? null : tasa(conteos[i], conteos[i - 1]),
      tasa_desde_visita: i === 0 ? null : tasa(conteos[i], conteos[0]),
    })),
  };
}

// ── Inversión publicitaria (CAC híbrido) ─────────────────────────────────────

const RE_CANAL = /^[a-z][a-z0-9_]{1,39}$/;
const MONTO_MAXIMO = 10000000;

// Devuelve { valor } con la fila lista para insertar (sin creado_por) o { error }.
function validarInversion(body = {}) {
  const canal = body.canal == null || body.canal === '' ? 'meta_ads' : String(body.canal).trim();
  if (!RE_CANAL.test(canal)) return { error: 'canal inválido (minúsculas, números y _; ej. meta_ads)' };

  let campana = null;
  if (body.campana != null && String(body.campana).trim() !== '') {
    if (typeof body.campana !== 'string') return { error: 'campana debe ser texto' };
    campana = body.campana.trim();
    if (campana.length > 120) return { error: 'campana no puede superar 120 caracteres' };
  }

  if (!fechaValida(body.fecha_inicio) || !fechaValida(body.fecha_fin)) {
    return { error: 'fecha_inicio y fecha_fin deben ser fechas válidas YYYY-MM-DD' };
  }
  if (body.fecha_fin < body.fecha_inicio) return { error: 'fecha_fin no puede ser anterior a fecha_inicio' };

  const texto = typeof body.monto === 'number' ? String(body.monto) : body.monto;
  if (typeof texto !== 'string' || !/^\d+(\.\d{1,2})?$/.test(texto.trim())) {
    return { error: 'monto debe ser un número positivo con hasta 2 decimales' };
  }
  const monto = Number(texto);
  if (!(monto > 0) || monto > MONTO_MAXIMO) return { error: `monto debe ser mayor que 0 y como máximo ${MONTO_MAXIMO}` };

  return { valor: { canal, campana, fecha_inicio: body.fecha_inicio, fecha_fin: body.fecha_fin, monto } };
}

async function listarInversiones({ desde, hasta, canal } = {}, cliente = supabasePorDefecto()) {
  if (desde != null && !fechaValida(desde)) return { error: 'desde debe ser YYYY-MM-DD' };
  if (hasta != null && !fechaValida(hasta)) return { error: 'hasta debe ser YYYY-MM-DD' };
  if (desde && hasta && desde > hasta) return { error: 'desde no puede ser posterior a hasta' };
  if (canal != null && !RE_CANAL.test(String(canal))) return { error: 'canal inválido' };

  const registros = await leerPaginado(() => {
    let q = cliente.from('inversion_publicitaria')
      .select('id,canal,campana,fecha_inicio,fecha_fin,monto,creado_por,created_at');
    if (hasta) q = q.lte('fecha_inicio', hasta);
    if (desde) q = q.gte('fecha_fin', desde);
    if (canal) q = q.eq('canal', canal);
    return q.order('id');
  });
  registros.sort((a, b) => (b.fecha_inicio > a.fecha_inicio ? 1 : b.fecha_inicio < a.fecha_inicio ? -1 : 0));
  const total = redondear(registros.reduce((s, r) => s + Number(r.monto), 0));
  return { registros, total };
}

module.exports = {
  PERIODOS, INICIO_HISTORICO, VENTANA_ABANDONO_MINUTOS, FUENTES_META, DEFINICIONES, ORDEN_KPIS, PASOS_EMBUDO,
  resolverPeriodo, resolverFiltros, construirKpi, construirMediana, esVentaValida, finVigencia,
  obtenerIndicadores, obtenerEmbudo, validarInversion, listarInversiones,
};
