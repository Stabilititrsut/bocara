// Monta los routers REALES de admin, negocios y reseñas sobre el doble en
// memoria de Supabase para probar liquidaciones mensuales y reseñas (Fase B)
// por HTTP. Agrega al doble lo que estas rutas necesitan y él no trae:
//
//   · storage en memoria (upload / createSignedUrl) para el bucket privado;
//   · rpc('crear_liquidacion_mensual_atomica') emulada en JS con las mismas
//     reglas que la función SQL (validaciones, corte < fin de mes en hora de
//     Guatemala con arrastre, montos desde snapshot con respaldo en columnas,
//     insert + vínculo de pedidos). La atomicidad y la concurrencia reales de
//     la RPC se probaron contra Postgres en la Fase A; aquí interesa el
//     contrato con las rutas.
//
// Debe requerirse ANTES que cualquier módulo que cargue config/supabase.

const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { crearFakeSupabase } = require('./fakeSupabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-liquidaciones';
delete process.env.RESEND_API_KEY; // nunca enviar correos reales desde pruebas

const fake = crearFakeSupabase();
const rutaSupabase = require.resolve(path.join(__dirname, '..', '..', 'config', 'supabase'));
require.cache[rutaSupabase] = { id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: fake };

const { rangoMesGuatemalaUTC, hoyGuatemala } = require('../../services/horarioGuatemala');

const IDS = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  restaurante: '00000000-0000-4000-8000-0000000000b1',
  otroRestaurante: '00000000-0000-4000-8000-0000000000b2',
  cliente: '00000000-0000-4000-8000-0000000000c1',
  olaAzul: '00000000-0000-4000-8000-00000000aa01',
  otroNegocio: '00000000-0000-4000-8000-00000000aa02',
};

function datosBase() {
  return {
    usuarios: [
      { id: IDS.admin, rol: 'admin', activo: true, nombre: 'Admin' },
      { id: IDS.restaurante, rol: 'restaurante', activo: true, nombre: 'Dueña Ola Azul', email: 'ola@bocara.test' },
      { id: IDS.otroRestaurante, rol: 'restaurante', activo: true, nombre: 'Otro dueño' },
      { id: IDS.cliente, rol: 'cliente', activo: true, nombre: 'Cliente' },
    ],
    negocios: [
      { id: IDS.olaAzul, nombre: 'Ola Azul', propietario_id: IDS.restaurante, calificacion_promedio: 4.5, total_resenas: 2 },
      { id: IDS.otroNegocio, nombre: 'Otro', propietario_id: IDS.otroRestaurante, calificacion_promedio: 0, total_resenas: 0 },
    ],
    pedidos: [],
    liquidaciones: [],
    resenas: [],
    notificaciones: [],
  };
}

// ── Storage en memoria ───────────────────────────────────────────────────────
const storage = {
  objetos: new Map(),
  fallarUpload: false,
  firmas: [],
  reiniciar() { this.objetos.clear(); this.fallarUpload = false; this.firmas = []; },
};
fake.storage = {
  from(bucket) {
    return {
      async upload(ruta, buffer, opciones = {}) {
        if (storage.fallarUpload) return { data: null, error: { message: 'storage caído (simulado)' } };
        const clave = `${bucket}/${ruta}`;
        if (storage.objetos.has(clave) && !opciones.upsert) return { data: null, error: { statusCode: '409', message: 'already exists' } };
        storage.objetos.set(clave, { buffer, contentType: opciones.contentType });
        return { data: { path: ruta }, error: null };
      },
      async createSignedUrl(ruta, segundos, opciones) {
        const clave = `${bucket}/${ruta}`;
        if (!storage.objetos.has(clave)) return { data: null, error: { message: 'Object not found' } };
        storage.firmas.push({ bucket, ruta, segundos, opciones });
        const descarga = opciones?.download ? `&download=${encodeURIComponent(opciones.download)}` : '';
        return { data: { signedUrl: `https://storage.test/${clave}?token=firmado&expires=${segundos}${descarga}` }, error: null };
      },
    };
  },
};

// ── RPC emulada ──────────────────────────────────────────────────────────────
const llamadasRpc = [];
const num = (v) => (v == null ? null : Number(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

function crearLiquidacionMensualAtomica({ p_negocio_id, p_mes, p_admin_id, p_fecha_limite }) {
  const t = (n) => fake._db.tablas[n] || (fake._db.tablas[n] = []);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p_mes || '')) return { ok: false, resultado: 'mes_invalido' };
  const { desde, hasta } = rangoMesGuatemalaUTC(p_mes);
  if (new Date(hasta) > new Date()) return { ok: false, resultado: 'mes_en_curso', periodo_fin: hasta };
  if (!t('usuarios').some((u) => u.id === p_admin_id && u.rol === 'admin')) return { ok: false, resultado: 'no_autorizado' };
  if (!t('negocios').some((n) => n.id === p_negocio_id)) return { ok: false, resultado: 'negocio_no_encontrado' };
  const existente = t('liquidaciones').find((l) => l.negocio_id === p_negocio_id && l.mes === p_mes && l.estado !== 'anulado');
  if (existente) return { ok: false, resultado: 'mes_ya_liquidado', liquidacion: structuredClone(existente) };

  const elegibles = t('pedidos').filter((p) => p.negocio_id === p_negocio_id
    && ['completado', 'recogido'].includes(p.estado) && p.estado_pago === 'pagado'
    && p.cubo_payment_intent_token != null && p.cubo_identifier != null && p.liquidacion_id == null
    && new Date(p.pagado_en || p.created_at) < new Date(hasta));
  const filas = elegibles.map((p) => {
    const sf = p.snapshot_financiero || {};
    const neto = num(sf.monto_neto_restaurante ?? p.monto_neto_restaurante);
    const comision = num(sf.comision_bocara ?? p.comision_bocara) ?? 0;
    const plataforma = num(sf.comision_pasarela ?? p.comision_pasarela) ?? 0;
    const propina = num(sf.propina ?? p.propina) ?? 0;
    const envio = num(sf.costo_envio ?? p.costo_envio) ?? 0;
    const bruto = sf.subtotal_productos != null ? Number(sf.subtotal_productos) : (neto ?? 0) - propina - envio + comision;
    return { p, neto, comision, plataforma, propina, envio, bruto };
  });
  const con = filas.filter((f) => f.neto != null);
  const sinDesglose = filas.filter((f) => f.neto == null).map((f) => f.p.id).sort();
  if (con.length === 0) return { ok: false, resultado: 'sin_pedidos_pendientes', pedidos_excluidos_sin_desglose: sinDesglose };

  const suma = (k) => r2(con.reduce((s, f) => s + f[k], 0));
  const id = crypto.randomUUID();
  const liq = {
    id, negocio_id: p_negocio_id, mes: p_mes, periodo_inicio: desde, periodo_fin: hasta,
    folio: `LIQ-${p_mes.replace('-', '')}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    monto: suma('neto'), ventas_brutas: suma('bruto'), comision_bocara: suma('comision'),
    comision_plataforma: suma('plataforma'), propinas: suma('propina'), costo_envio: suma('envio'),
    estado: 'pendiente', total_pedidos: con.length, fecha_limite_pago: p_fecha_limite, creada_por: p_admin_id,
    datos_transferencia: null, pagado_en: null, pagado_por: null,
    comprobante_path: null, comprobante_generado_en: null, created_at: new Date().toISOString(),
  };
  t('liquidaciones').push(liq);
  for (const f of con) f.p.liquidacion_id = id;
  return {
    ok: true, resultado: 'creada', liquidacion: structuredClone(liq),
    pedidos_ids: con.map((f) => f.p.id).sort(), pedidos_excluidos_sin_desglose: sinDesglose,
  };
}

fake.rpc = async (nombre, params) => {
  llamadasRpc.push({ nombre, params });
  if (nombre === 'crear_liquidacion_mensual_atomica') return { data: crearLiquidacionMensualAtomica(params), error: null };
  return { data: null, error: null };
};

function reiniciar() {
  fake.reiniciar(datosBase());
  storage.reiniciar();
  llamadasRpc.length = 0;
}

// ── Calendario relativo a hoy (las rutas usan la fecha real) ─────────────────
function mesRelativo(delta) {
  const [a, m] = hoyGuatemala().slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
const mitadDeMes = (mes) => `${mes}-15T18:00:00.000Z`;

let siguientePedido = 1;
// Pedido entregado, pagado y verificado por Cubo, con snapshot financiero.
function pedidoPagado({ negocioId = IDS.olaAzul, mes, pagadoEn, estado = 'completado', neto = 7.5, sinSnapshot = false, ...extra } = {}) {
  const id = `00000000-0000-4000-9000-${String(siguientePedido++).padStart(12, '0')}`;
  const snapshot = { version: 1, subtotal_productos: 10, comision_bocara: 2.5, comision_pasarela: 0.35, propina: 0, costo_envio: 0, monto_neto_restaurante: neto };
  return {
    id, negocio_id: negocioId, usuario_id: IDS.cliente, estado, estado_pago: 'pagado',
    cubo_payment_intent_token: `tok-${id}`, cubo_identifier: `cubo-${id}`,
    pagado_en: pagadoEn || mitadDeMes(mes), created_at: pagadoEn || mitadDeMes(mes),
    snapshot_financiero: sinSnapshot ? null : snapshot,
    comision_bocara: 2.5, comision_pasarela: 0.35, propina: 0, costo_envio: 0, monto_neto_restaurante: neto,
    liquidacion_id: null, ...extra,
  };
}

function token(id) {
  const usuario = Object.entries(IDS).find(([, v]) => v === id);
  const rol = { admin: 'admin', cliente: 'cliente' }[usuario?.[0]] || 'restaurante';
  return jwt.sign({ id, rol }, process.env.JWT_SECRET);
}

let servidor = null;
let base = null;

async function iniciar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use('/api/negocios', require('../../routes/negocios'));
  app.use('/api/admin', require('../../routes/admin'));
  app.use('/api/resenas', require('../../routes/resenas'));
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function detener() {
  if (!servidor) return;
  await new Promise((resolve) => servidor.close(resolve));
  servidor = null;
}

async function pedir(metodo, ruta, { como, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (como) headers.Authorization = `Bearer ${token(como)}`;
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }
  return { status: r.status, body: json };
}

module.exports = {
  fake, IDS, storage, llamadasRpc, reiniciar, iniciar, detener, pedir,
  pedidoPagado, mesRelativo, mitadDeMes,
};
