// Indicadores y embudo (módulo 03, Fase B): servicio canónico de métricas,
// endpoints de admin, ingesta pública de analítica e instrumentación de
// intentos de pago. Monta los routers REALES sobre el doble en memoria de
// Supabase; la RPC obtener_kpis_admin se emula con una respuesta fija porque
// sus cálculos SQL ya se validaron contra Postgres (PGlite) en la Fase A.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-metricas';

const fake = crearFakeSupabase();
const rutaSupabase = require.resolve(path.join(__dirname, '..', 'config', 'supabase'));
require.cache[rutaSupabase] = { id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: fake };

const M = require('../services/metricas');
const { validarEvento } = require('../routes/analitica');
const { registrarInicioIntento, finalizarIntento, expirarIntentosDePedidos } = require('../services/intentosPago');
const { procesarWebhookCubo } = require('../services/cuboWebhook');

// ── Datos ────────────────────────────────────────────────────────────────────

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDS = {
  admin: id(1), cliente: id(2), u1: id(11), u2: id(12), u3: id(13),
  n1: id(21), n2: id(22), n3: id(23),
  b1: id(31), b2: id(32), b3: id(33), b5: id(35), b6: id(36),
  p0: id(40), p1: id(41), p2: id(42), p3: id(43), p4: id(44), p5: id(45),
};

const valida = (extra) => ({
  estado: 'completado', estado_pago: 'pagado',
  cubo_payment_intent_token: `tok-${extra.id}`, cubo_identifier: `cid-${extra.id}`, ...extra,
});

const ev = (n, sesion, evento, extra = {}) => ({
  id: id(1000 + n), client_event_id: `evt-${String(n).padStart(6, '0')}`, anon_id: `anon-${sesion}`,
  sesion_id: `sesion-${sesion}`, evento, ocurrido_en: '2026-03-10T15:00:00.000Z',
  recibido_en: '2026-03-10T15:00:01.000Z', ...extra,
});

function datosBase() {
  return {
    usuarios: [
      { id: IDS.admin, rol: 'admin', activo: true, nombre: 'Admin' },
      { id: IDS.cliente, rol: 'cliente', activo: true, nombre: 'Cliente' },
    ],
    negocios: [
      { id: IDS.n1, zona: 'Zona 10', activo: true, verificado: true, estado_verificacion: 'aprobado' },
      { id: IDS.n2, zona: 'Zona 4', activo: true, verificado: true, estado_verificacion: 'aprobado' },
      { id: IDS.n3, zona: 'Zona 10', activo: true, verificado: false, estado_verificacion: 'pendiente' },
    ],
    bolsas: [
      // Cohorte de marzo 2026 (Tiempo limitado, vencida, 3 vendidas + 2 sin vender).
      { id: IDS.b1, negocio_id: IDS.n1, tipo: 'bolsa', created_at: '2026-03-04T12:00:00.000Z', fecha_disponible: '2026-03-05',
        fecha_caducidad: '2026-03-05', hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
        cantidad_disponible: 2, activo: true, estado_aprobacion: 'aprobado', eliminado_en: null },
      // Promoción de marzo, 1 vendida.
      { id: IDS.b2, negocio_id: IDS.n2, tipo: 'cupon', created_at: '2026-03-09T12:00:00.000Z', fecha_disponible: '2026-03-10',
        fecha_caducidad: '2026-03-31', hora_recogida_inicio: '09:00', hora_recogida_fin: '17:00',
        cantidad_disponible: 0, activo: true, estado_aprobacion: 'aprobado', eliminado_en: null },
      // Tiempo limitado de marzo sin ventas.
      { id: IDS.b3, negocio_id: IDS.n1, tipo: 'bolsa', created_at: '2026-03-19T12:00:00.000Z', fecha_disponible: '2026-03-20',
        fecha_caducidad: '2026-03-20', hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
        cantidad_disponible: 4, activo: true, estado_aprobacion: 'aprobado', eliminado_en: null },
      // Rechazada por moderación: fuera de la cohorte.
      { id: IDS.b5, negocio_id: IDS.n1, tipo: 'bolsa', created_at: '2026-03-21T12:00:00.000Z', fecha_disponible: '2026-03-22',
        fecha_caducidad: '2026-03-22', hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
        cantidad_disponible: 3, activo: false, estado_aprobacion: 'rechazado', eliminado_en: null },
      // Comprable HOY (sin caducidad), publicada en enero.
      { id: IDS.b6, negocio_id: IDS.n2, tipo: 'cupon', created_at: '2026-01-01T12:00:00.000Z', fecha_disponible: '2026-01-01',
        fecha_caducidad: null, hora_recogida_inicio: null, hora_recogida_fin: null,
        cantidad_disponible: 5, activo: true, estado_aprobacion: 'aprobado', eliminado_en: null },
    ],
    pedidos: [
      valida({ id: IDS.p0, usuario_id: IDS.u2, negocio_id: IDS.n2, bolsa_id: IDS.b6, cantidad: 1,
        created_at: '2026-02-10T15:00:00.000Z', pagado_en: '2026-02-10T15:05:00.000Z' }),
      valida({ id: IDS.p1, usuario_id: IDS.u1, negocio_id: IDS.n1, bolsa_id: IDS.b1, cantidad: 2,
        created_at: '2026-03-06T00:45:00.000Z', pagado_en: '2026-03-06T01:00:00.000Z' }),
      valida({ id: IDS.p2, usuario_id: IDS.u2, negocio_id: IDS.n1, bolsa_id: IDS.b1, cantidad: 1,
        created_at: '2026-03-06T01:15:00.000Z', pagado_en: '2026-03-06T01:30:00.000Z' }),
      valida({ id: IDS.p3, usuario_id: IDS.u1, negocio_id: IDS.n2, bolsa_id: IDS.b2, cantidad: 1,
        created_at: '2026-03-12T17:35:00.000Z', pagado_en: '2026-03-12T18:00:00.000Z' }),
      // Link emitido y nunca pagado (el cliente igual mandó 'purchase').
      { id: IDS.p4, usuario_id: IDS.u3, negocio_id: IDS.n2, bolsa_id: IDS.b2, cantidad: 1, estado: 'cancelado',
        estado_pago: 'fallido', cubo_payment_intent_token: 'tok-p4', cubo_identifier: null,
        created_at: '2026-03-15T11:55:00.000Z', pagado_en: null },
      // Pagado y luego cancelado: no es venta válida.
      valida({ id: IDS.p5, usuario_id: IDS.u3, negocio_id: IDS.n1, bolsa_id: IDS.b1, cantidad: 1, estado: 'cancelado',
        created_at: '2026-03-07T12:00:00.000Z', pagado_en: '2026-03-07T12:05:00.000Z' }),
    ],
    pedido_items: [
      { id: id(501), pedido_id: IDS.p1, bolsa_id: IDS.b1, cantidad: 2 },
      { id: id(502), pedido_id: IDS.p2, bolsa_id: IDS.b1, cantidad: 1 },
      { id: id(503), pedido_id: IDS.p3, bolsa_id: IDS.b2, cantidad: 1 },
      { id: id(504), pedido_id: IDS.p4, bolsa_id: IDS.b2, cantidad: 1 },
    ],
    eventos_analitica: [
      // S1: llega por Facebook y compra P1 (view_item repetido: cuenta una vez).
      ev(1, 1, 'session_start', { utm_source: 'Facebook', utm_campaign: 'marzo', recibido_en: '2026-03-01T10:00:00.000Z' }),
      ev(2, 1, 'view_item', { bolsa_id: IDS.b1, negocio_id: IDS.n1 }),
      ev(3, 1, 'view_item', { bolsa_id: IDS.b1, negocio_id: IDS.n1 }),
      ev(4, 1, 'add_to_cart', { bolsa_id: IDS.b1, negocio_id: IDS.n1 }),
      ev(5, 1, 'begin_checkout', { bolsa_id: IDS.b1, negocio_id: IDS.n1, pedido_id: IDS.p1 }),
      ev(6, 1, 'purchase', { negocio_id: IDS.n1, pedido_id: IDS.p1 }),
      // S2: dice 'purchase' pero el pedido nunca se pagó.
      ev(7, 2, 'session_start'),
      ev(8, 2, 'view_item', { bolsa_id: IDS.b2, negocio_id: IDS.n2 }),
      ev(9, 2, 'add_to_cart', { bolsa_id: IDS.b2, negocio_id: IDS.n2 }),
      ev(10, 2, 'begin_checkout', { bolsa_id: IDS.b2, negocio_id: IDS.n2, pedido_id: IDS.p4 }),
      ev(11, 2, 'purchase', { negocio_id: IDS.n2, pedido_id: IDS.p4 }),
      // S3: solo mira. S4: solo entra.
      ev(12, 3, 'session_start'),
      ev(13, 3, 'view_item', { bolsa_id: IDS.b3, negocio_id: IDS.n1 }),
      ev(14, 4, 'session_start'),
    ],
    intentos_pago: [
      { id: id(601), pedido_id: IDS.p1, payment_intent_token: 'tok-i1', iniciado_en: '2026-03-06T00:50:00.000Z', resultado: 'aprobado', finalizado_en: '2026-03-06T01:00:00.000Z' },
      { id: id(602), pedido_id: IDS.p2, payment_intent_token: 'tok-i2', iniciado_en: '2026-03-06T01:20:00.000Z', resultado: 'aprobado', finalizado_en: '2026-03-06T01:30:00.000Z' },
      { id: id(603), pedido_id: IDS.p3, payment_intent_token: 'tok-i3', iniciado_en: '2026-03-12T17:40:00.000Z', resultado: 'fallido', finalizado_en: '2026-03-12T17:42:00.000Z' },
      { id: id(604), pedido_id: IDS.p3, payment_intent_token: 'tok-i3b', iniciado_en: '2026-03-12T17:50:00.000Z', resultado: 'aprobado', finalizado_en: '2026-03-12T18:00:00.000Z' },
      { id: id(605), pedido_id: IDS.p4, payment_intent_token: 'tok-p4', iniciado_en: '2026-03-15T12:00:00.000Z', resultado: 'expirado', finalizado_en: '2026-03-15T12:15:00.000Z' },
    ],
    inversion_publicitaria: [
      { id: id(701), canal: 'meta_ads', campana: 'marzo', fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: 3100 },
      // 30 días, 16 dentro de marzo → 300 × 16/30 = 160.
      { id: id(702), canal: 'meta_ads', campana: 'puente', fecha_inicio: '2026-02-15', fecha_fin: '2026-03-16', monto: 300 },
      { id: id(703), canal: 'google_ads', campana: 'otro', fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: 999 },
    ],
  };
}

const RPC_KPIS = {
  periodo: {}, filtros: {},
  kpis: {
    pedidos_completados: { numerador: 2, denominador: 4, valor: 50, estado: 'ok', cohorte: 'cohorte SQL', periodo_abierto: false,
      desglose: { completados: 2, en_curso: 1, cancelados: 1, rechazados_restaurante: 1 } },
    recompra: { numerador: 1, denominador: 2, valor: 50, estado: 'ok' },
    ticket_promedio: { numerador: 95, denominador: 3, valor: 31.67, estado: 'ok' },
    tiempo_recibido_aceptado: { valor: 20, muestras: 3, estado: 'ok' },
    tiempo_aceptado_listo: { valor: null, muestras: 0, estado: 'sin_datos' },
    tiempo_listo_completado: { valor: 30, muestras: 1, estado: 'ok' },
  },
};

const rpc = { llamadas: [], respuesta: null };
fake.rpc = async (nombre, params) => {
  rpc.llamadas.push({ nombre, params });
  if (nombre === 'obtener_kpis_admin') return rpc.respuesta || { data: structuredClone(RPC_KPIS), error: null };
  return { data: null, error: null };
};

function reiniciar() {
  fake.reiniciar(datosBase());
  rpc.llamadas.length = 0;
  rpc.respuesta = null;
}

// ── Servidor ─────────────────────────────────────────────────────────────────

let servidor = null;
let base = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/analitica', require('../routes/analitica'));
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => new Promise((resolve) => servidor.close(resolve)));
test.beforeEach(reiniciar);

const token = (usuarioId, rol) => jwt.sign({ id: usuarioId, rol }, process.env.JWT_SECRET);
async function pedir(metodo, ruta, { como, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (como === 'admin') h.Authorization = `Bearer ${token(IDS.admin, 'admin')}`;
  if (como === 'cliente') h.Authorization = `Bearer ${token(IDS.cliente, 'cliente')}`;
  const r = await fetch(base + ruta, { method: metodo, headers: h, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  return { status: r.status, body: texto ? JSON.parse(texto) : null };
}

const CLAVES_CONTRATO = ['clave', 'nombre', 'valor', 'unidad', 'formula', 'numerador', 'denominador', 'periodo', 'exclusiones', 'estado'];
const porClave = (kpis) => Object.fromEntries(kpis.map((k) => [k.clave, k]));
const resumen = (k) => [k.numerador, k.denominador, k.valor, k.estado];

// ── Unidad: periodo y filtros ────────────────────────────────────────────────

test('resolverPeriodo: mes específico en hora de Guatemala (UTC-6), hasta exclusivo', () => {
  const { periodo } = M.resolverPeriodo({ periodo: 'mes', mes: '2026-02' });
  assert.equal(periodo.desde, '2026-02-01T06:00:00.000Z');
  assert.equal(periodo.hasta, '2026-03-01T06:00:00.000Z');
  assert.equal(periodo.desde_local, '2026-02-01');
  assert.equal(periodo.hasta_local, '2026-02-28');
  assert.equal(periodo.zona_horaria, 'America/Guatemala');
  assert.equal(periodo.hasta_exclusivo, true);
  const dic = M.resolverPeriodo({ periodo: 'mes', mes: '2026-12' }).periodo;
  assert.equal(dic.hasta, '2027-01-01T06:00:00.000Z');
  assert.equal(dic.hasta_local, '2026-12-31');
});

test('resolverPeriodo: hoy y mes actual usan el día de Guatemala, no el de UTC', () => {
  // 03:00 UTC del 1 de octubre = 21:00 del 30 de septiembre en Guatemala.
  const ahora = new Date('2026-10-01T03:00:00.000Z');
  const hoy = M.resolverPeriodo({ periodo: 'hoy' }, ahora).periodo;
  assert.equal(hoy.desde_local, '2026-09-30');
  assert.equal(hoy.desde, '2026-09-30T06:00:00.000Z');
  assert.equal(hoy.hasta, '2026-10-01T06:00:00.000Z');
  assert.equal(hoy.abierto, true);
  const mes = M.resolverPeriodo({}, ahora).periodo; // por defecto: mes_actual
  assert.equal(mes.tipo, 'mes_actual');
  assert.equal(mes.desde_local, '2026-09-01');
  assert.equal(mes.hasta_local, '2026-09-30');
});

test('resolverPeriodo: rango inclusivo e histórico', () => {
  const r = M.resolverPeriodo({ periodo: 'rango', desde: '2026-03-05', hasta: '2026-03-05' }).periodo;
  assert.equal(r.desde, '2026-03-05T06:00:00.000Z');
  assert.equal(r.hasta, '2026-03-06T06:00:00.000Z');
  const h = M.resolverPeriodo({ periodo: 'historico' }, new Date('2026-10-07T18:00:00.000Z')).periodo;
  assert.equal(h.desde_local, M.INICIO_HISTORICO);
  assert.equal(h.hasta_local, '2026-10-07');
});

test('resolverPeriodo: rechaza entradas inválidas', () => {
  assert.ok(M.resolverPeriodo({ periodo: 'mes', mes: '2026-13' }).error);
  assert.ok(M.resolverPeriodo({ periodo: 'mes' }).error);
  assert.ok(M.resolverPeriodo({ periodo: 'rango', desde: '2026-02-30', hasta: '2026-03-01' }).error);
  assert.ok(M.resolverPeriodo({ periodo: 'rango', desde: '2026-03-02', hasta: '2026-03-01' }).error);
  assert.ok(M.resolverPeriodo({ periodo: 'semana' }).error);
});

test('resolverFiltros: negocio_id UUID, zona recortada, tipo del catálogo', () => {
  assert.deepEqual(M.resolverFiltros({}).filtros, { negocio_id: null, zona: null, tipo: null });
  assert.deepEqual(M.resolverFiltros({ negocio_id: IDS.n1, zona: '  Zona 10 ', tipo: 'cupon' }).filtros,
    { negocio_id: IDS.n1, zona: 'Zona 10', tipo: 'cupon' });
  assert.ok(M.resolverFiltros({ negocio_id: '123' }).error);
  assert.ok(M.resolverFiltros({ tipo: 'promo' }).error);
  assert.ok(M.resolverFiltros({ zona: 'x'.repeat(81) }).error);
});

// ── Unidad: contrato ─────────────────────────────────────────────────────────

test('construirKpi: ok / no_aplica / sin_datos, sin ceros inventados', () => {
  const periodo = { tipo: 'mes' };
  const ok = M.construirKpi('recompra', { numerador: 1, denominador: 3, escala: 100, periodo });
  assert.deepEqual(Object.keys(ok), CLAVES_CONTRATO);
  assert.deepEqual(resumen(ok), [1, 3, 33.33, 'ok']);

  const noAplica = M.construirKpi('recompra', { numerador: 0, denominador: 0, escala: 100, periodo });
  assert.deepEqual(resumen(noAplica), [0, 0, null, 'no_aplica']);

  const sinDatos = M.construirKpi('recompra', { numerador: 5, denominador: 9, sinDatos: true, periodo });
  assert.deepEqual(resumen(sinDatos), [null, null, null, 'sin_datos']);
});

test('finVigencia: hora de fin en Guatemala, cruce de medianoche y fin de día', () => {
  assert.equal(M.finVigencia({ fecha_caducidad: '2026-03-05', hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' }).toISOString(),
    '2026-03-06T02:00:00.000Z');
  assert.equal(M.finVigencia({ fecha_caducidad: '2026-03-05', hora_recogida_inicio: '22:00', hora_recogida_fin: '01:00' }).toISOString(),
    '2026-03-06T07:00:00.000Z');
  assert.equal(M.finVigencia({ fecha_caducidad: '2026-03-05' }).toISOString(), '2026-03-06T06:00:00.000Z');
  assert.equal(M.finVigencia({ fecha_caducidad: null, hora_recogida_fin: '20:00' }), null);
});

test('esVentaValida: exige pagado, no cancelado y ambos tokens de Cubo', () => {
  const base = { estado: 'completado', estado_pago: 'pagado', cubo_payment_intent_token: 't', cubo_identifier: 'c' };
  assert.equal(M.esVentaValida(base), true);
  assert.equal(M.esVentaValida({ ...base, estado: 'cancelado' }), false);
  assert.equal(M.esVentaValida({ ...base, cubo_identifier: null }), false);
  assert.equal(M.esVentaValida({ ...base, estado_pago: 'pendiente' }), false);
});

test('validarInversion: fechas reales, rango, monto positivo con 2 decimales, canal por defecto', () => {
  const ok = M.validarInversion({ fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: '1500.50', campana: ' Marzo ' });
  assert.deepEqual(ok.valor, { canal: 'meta_ads', campana: 'Marzo', fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: 1500.5 });
  assert.ok(M.validarInversion({ fecha_inicio: '2026-03-31', fecha_fin: '2026-03-01', monto: 1 }).error);
  assert.ok(M.validarInversion({ fecha_inicio: '2026-02-30', fecha_fin: '2026-03-01', monto: 1 }).error);
  for (const monto of [0, -5, '1.234', 'abc', null, 1e9]) {
    assert.ok(M.validarInversion({ fecha_inicio: '2026-03-01', fecha_fin: '2026-03-01', monto }).error, String(monto));
  }
  assert.ok(M.validarInversion({ fecha_inicio: '2026-03-01', fecha_fin: '2026-03-01', monto: 1, canal: 'Meta Ads' }).error);
});

// ── Unidad: validación de eventos ────────────────────────────────────────────

const eventoOk = (extra = {}) => ({
  client_event_id: 'evt-unico-0001', anon_id: 'anon-000001', sesion_id: 'sesion-000001',
  evento: 'session_start', ocurrido_en: new Date().toISOString(), ...extra,
});

test('validarEvento: acepta el esquema y toma usuario_id del token, nunca del cuerpo', () => {
  const r = validarEvento(eventoOk({ usuario_id: IDS.admin, utm_source: 'facebook' }), { usuarioId: IDS.cliente, ahora: Date.now() });
  assert.equal(r.fila.usuario_id, IDS.cliente);
  assert.equal(r.fila.utm_source, 'facebook');
  const anonimo = validarEvento(eventoOk({ usuario_id: IDS.admin }), { usuarioId: null, ahora: Date.now() });
  assert.equal(anonimo.fila.usuario_id, null);
});

test('validarEvento: rechaza catálogo, ids, fechas y campos mal formados', () => {
  const ahora = Date.now();
  const casos = [
    eventoOk({ evento: 'login' }),
    eventoOk({ client_event_id: 'corto' }),
    eventoOk({ sesion_id: undefined }),
    eventoOk({ ocurrido_en: '2026-03-01 10:00' }),
    eventoOk({ ocurrido_en: new Date(ahora + 60 * 60 * 1000).toISOString() }),
    eventoOk({ ocurrido_en: new Date(ahora - 8 * 24 * 60 * 60 * 1000).toISOString() }),
    eventoOk({ evento: 'view_item' }),
    eventoOk({ pedido_id: 'no-es-uuid' }),
    eventoOk({ utm_source: '<script>' }),
    'texto',
  ];
  for (const c of casos) assert.ok(validarEvento(c, { usuarioId: null, ahora }).error, JSON.stringify(c));
});

// ── Unidad: intentos de pago ─────────────────────────────────────────────────

test('intentosPago: inicio idempotente por token y CAS de resultado', async () => {
  const cliente = crearFakeSupabase({ intentos_pago: [] });
  assert.deepEqual(await registrarInicioIntento({ pedidoId: IDS.p1, paymentIntentToken: 'tok-a', cliente }), { ok: true });
  assert.deepEqual(await registrarInicioIntento({ pedidoId: IDS.p1, paymentIntentToken: 'tok-a', cliente }), { ok: true, duplicado: true });
  assert.equal(cliente.tabla('intentos_pago').length, 1);
  assert.equal(cliente.tabla('intentos_pago')[0].resultado, 'pendiente');

  assert.equal((await finalizarIntento({ paymentIntentToken: 'tok-a', resultado: 'aprobado', statusRaw: 'SUCCEEDED', cliente })).actualizados, 1);
  // Un rechazo tardío no pisa un aprobado.
  assert.equal((await finalizarIntento({ paymentIntentToken: 'tok-a', resultado: 'fallido', cliente })).actualizados, 0);
  assert.equal(cliente.tabla('intentos_pago')[0].resultado, 'aprobado');
  assert.equal(cliente.tabla('intentos_pago')[0].status_raw, 'SUCCEEDED');
});

test('intentosPago: el barrido expira pendientes y un pago confirmado gana sobre expirado', async () => {
  const cliente = crearFakeSupabase({ intentos_pago: [
    { id: id(1), pedido_id: IDS.p1, payment_intent_token: 'tok-a', resultado: 'pendiente' },
    { id: id(2), pedido_id: IDS.p2, payment_intent_token: 'tok-b', resultado: 'fallido' },
  ] });
  assert.equal((await expirarIntentosDePedidos([IDS.p1, IDS.p2, IDS.p1], { cliente })).actualizados, 1);
  assert.deepEqual(cliente.tabla('intentos_pago').map((i) => i.resultado), ['expirado', 'fallido']);
  await finalizarIntento({ paymentIntentToken: 'tok-a', resultado: 'aprobado', cliente });
  assert.equal(cliente.tabla('intentos_pago')[0].resultado, 'aprobado');
});

test('intentosPago: nunca lanza aunque la tabla no exista', async () => {
  const cliente = crearFakeSupabase({});
  cliente.inyectarError({ message: 'relation "intentos_pago" does not exist' });
  const r = await registrarInicioIntento({ pedidoId: IDS.p1, paymentIntentToken: 'tok-x', cliente });
  assert.equal(r.ok, false);
  const roto = { from() { throw new Error('cliente roto'); } };
  assert.equal((await finalizarIntento({ paymentIntentToken: 'x', resultado: 'fallido', cliente: roto })).ok, false);
  assert.equal((await expirarIntentosDePedidos([IDS.p1], { cliente: roto })).ok, false);
});

test('webhook Cubo: un rechazo cierra el intento como fallido con el status crudo', async () => {
  const pedido = { id: IDS.p4, estado: 'pendiente', estado_pago: 'pendiente', usuario_id: IDS.u3, negocio_id: IDS.n2,
    bolsa_id: IDS.b2, cubo_payment_intent_token: 'tok-p4', created_at: '2026-03-15T11:55:00.000Z' };
  const cliente = crearFakeSupabase({ pedidos: [pedido], intentos_pago: [
    { id: id(1), pedido_id: IDS.p4, payment_intent_token: 'tok-p4', resultado: 'pendiente' }] });
  const r = await procesarWebhookCubo(
    { status: 'DECLINED', identifier: 'tok-p4', metadata: { orderId: IDS.p4 } },
    { supabase: cliente, liberarInventarioPedido: async () => ({ ok: true, tipo: 'cancelado' }), procesarEventosPedido: async () => {} },
  );
  assert.equal(r.statusCode, 200);
  const intento = cliente.tabla('intentos_pago')[0];
  assert.equal(intento.resultado, 'fallido');
  assert.equal(intento.status_raw, 'DECLINED');
  assert.ok(intento.finalizado_en);
});

test('webhook Cubo: el reintento de un pago ya registrado cierra el intento como aprobado', async () => {
  const pedido = valida({ id: IDS.p1, estado: 'confirmado', usuario_id: IDS.u1, negocio_id: IDS.n1, bolsa_id: IDS.b1,
    cubo_payment_intent_token: 'tok-i1', created_at: '2026-03-06T00:45:00.000Z' });
  const cliente = crearFakeSupabase({ pedidos: [pedido], intentos_pago: [
    { id: id(1), pedido_id: IDS.p1, payment_intent_token: 'tok-i1', resultado: 'expirado' }] });
  const r = await procesarWebhookCubo(
    { status: 'SUCCEEDED', identifier: 'tok-i1', metadata: { orderId: IDS.p1 } },
    { supabase: cliente, procesarEventosPedido: async () => {} },
  );
  assert.equal(r.tipo, 'duplicado');
  assert.equal(cliente.tabla('intentos_pago')[0].resultado, 'aprobado');
});

// ── HTTP: /api/admin/indicadores ─────────────────────────────────────────────

test('GET /indicadores: exige admin', async () => {
  assert.equal((await pedir('GET', '/api/admin/indicadores')).status, 401);
  assert.equal((await pedir('GET', '/api/admin/indicadores', { como: 'cliente' })).status, 403);
});

test('GET /indicadores: valida periodo y filtros con 400', async () => {
  for (const q of ['periodo=mes&mes=2026-3', 'periodo=rango&desde=2026-03-10&hasta=2026-03-01', 'negocio_id=abc', 'tipo=promo']) {
    const r = await pedir('GET', `/api/admin/indicadores?${q}`, { como: 'admin' });
    assert.equal(r.status, 400, q);
    assert.ok(r.body.error);
  }
});

test('GET /indicadores: matriz de 11 KPIs con contrato y valores de marzo 2026', async () => {
  const r = await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-03', { como: 'admin' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.advertencias, []);
  assert.deepEqual(r.body.kpis.map((k) => k.clave), M.ORDEN_KPIS);
  assert.equal(r.body.kpis.length, 11);
  for (const k of r.body.kpis) {
    for (const campo of CLAVES_CONTRATO) assert.ok(campo in k, `${k.clave} sin ${campo}`);
    assert.ok(['ok', 'no_aplica', 'sin_datos'].includes(k.estado), k.clave);
  }

  // La RPC recibe el periodo en UTC y los filtros vacíos.
  assert.deepEqual(rpc.llamadas.find((l) => l.nombre === 'obtener_kpis_admin').params, {
    p_desde: '2026-03-01T06:00:00.000Z', p_hasta: '2026-04-01T06:00:00.000Z', p_negocio_id: null, p_zona: null, p_tipo: null,
  });

  const k = porClave(r.body.kpis);
  // 4 sesiones medidas; solo S1 tiene un pedido válido (S2 mandó 'purchase' sin pagar).
  assert.deepEqual(resumen(k.conversion_compra), [1, 4, 25, 'ok']);
  // Desde la RPC.
  assert.deepEqual(resumen(k.pedidos_completados), [2, 4, 50, 'ok']);
  assert.deepEqual(k.pedidos_completados.desglose, RPC_KPIS.kpis.pedidos_completados.desglose);
  assert.deepEqual(resumen(k.recompra), [1, 2, 50, 'ok']);
  assert.deepEqual(resumen(k.ticket_promedio), [95, 3, 31.67, 'ok']);
  // Cohorte B1 (vendida), B2 (vendida), B3 (sin ventas); B5 rechazada fuera.
  assert.deepEqual(resumen(k.liquidez_ofertas), [2, 3, 66.67, 'ok']);
  // B1: 3 vendidas en vigencia de 5 publicadas (2 disponibles + 3); B3: 0 de 4.
  assert.deepEqual(resumen(k.tiempo_limitado_merma), [3, 9, 33.33, 'ok']);
  assert.deepEqual(k.tiempo_limitado_merma.desglose, { ofertas_observadas: 2, ofertas_en_vigencia: 0, ofertas_sin_vigencia: 0 });
  // 3100 + 300×16/30 = 3260 de Meta (Google excluido) / 1 comprador nuevo atribuible (U1 vía Facebook).
  assert.deepEqual(resumen(k.cac_meta_ads), [3260, 1, 3260, 'ok']);
  assert.deepEqual(k.cac_meta_ads.desglose, { compradores_nuevos: 1, compradores_nuevos_atribuibles: 1, registros_inversion: 2 });
  // P4 expiró sin pago: 1 de 4 procesos observados.
  assert.deepEqual(resumen(k.abandono_pago), [1, 4, 25, 'ok']);
  assert.equal(k.abandono_pago.ventana_minutos, 30);
  // 5 intentos finales, 1 fallido (P3 se reintentó y aprobó).
  assert.deepEqual(resumen(k.pagos_fallidos), [1, 5, 20, 'ok']);
  assert.deepEqual(k.pagos_fallidos.desglose, { aprobados: 3, fallidos: 1, expirados: 1, pendientes: 0, pedidos_afectados: 1 });
  // Medianas: numerador/denominador null, muestras aparte.
  assert.deepEqual(resumen(k.tiempos_operativos), [null, null, 20, 'ok']);
  assert.equal(k.tiempos_operativos.muestras, 3);
  assert.deepEqual(k.tiempos_operativos.desglose.map((d) => [d.clave, d.valor, d.estado]), [
    ['tiempo_recibido_aceptado', 20, 'ok'], ['tiempo_aceptado_listo', null, 'sin_datos'], ['tiempo_listo_completado', 30, 'ok']]);
  // Lectura actual: N1 y N2 habilitados (N3 pendiente); solo N2 tiene oferta comprable hoy.
  assert.deepEqual(resumen(k.negocios_oferta_activa), [1, 2, 50, 'ok']);
  assert.equal(k.negocios_oferta_activa.periodo.tipo, 'lectura_actual');
  assert.deepEqual(k.negocios_oferta_activa.desglose, { con_oferta: 1, sin_oferta: 1 });
});

test('GET /indicadores: filtro por negocio se aplica a todos los KPIs y CAC queda no_aplica', async () => {
  const r = await pedir('GET', `/api/admin/indicadores?periodo=mes&mes=2026-03&negocio_id=${IDS.n1}`, { como: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(rpc.llamadas[0].params.p_negocio_id, IDS.n1);
  const k = porClave(r.body.kpis);
  assert.deepEqual(resumen(k.conversion_compra), [1, 2, 50, 'ok']); // S1 y S3
  assert.deepEqual(resumen(k.liquidez_ofertas), [1, 2, 50, 'ok']); // B1 y B3
  assert.deepEqual(resumen(k.abandono_pago), [0, 2, 0, 'ok']); // P1 y P2
  assert.equal(k.cac_meta_ads.estado, 'no_aplica');
  assert.equal(k.cac_meta_ads.valor, null);
  assert.deepEqual(resumen(k.negocios_oferta_activa), [0, 1, 0, 'ok']);
});

test('GET /indicadores: filtros de zona y tipo', async () => {
  const z = porClave((await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-03&zona=zona%204', { como: 'admin' })).body.kpis);
  assert.deepEqual(resumen(z.liquidez_ofertas), [1, 1, 100, 'ok']); // B2
  assert.deepEqual(resumen(z.conversion_compra), [0, 1, 0, 'ok']); // S2 sin compra válida
  const t = porClave((await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-03&tipo=cupon', { como: 'admin' })).body.kpis);
  // Merma solo mide Tiempo limitado: con tipo=cupon no hay ofertas que medir.
  assert.deepEqual(resumen(t.tiempo_limitado_merma), [0, 0, null, 'no_aplica']);
  assert.deepEqual(resumen(t.pagos_fallidos), [1, 3, 33.33, 'ok']); // intentos de P3 (×2) y P4
});

test('GET /indicadores: periodo previo a la instrumentación → sin_datos, nunca ceros', async () => {
  const r = await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-01', { como: 'admin' });
  const k = porClave(r.body.kpis);
  for (const clave of ['conversion_compra', 'cac_meta_ads', 'abandono_pago', 'pagos_fallidos']) {
    assert.deepEqual(resumen(k[clave]), [null, null, null, 'sin_datos'], clave);
  }
  // Sin ofertas publicadas en enero salvo B6 (sin ventas): medición real con 0 → ok.
  assert.deepEqual(resumen(k.liquidez_ofertas), [0, 1, 0, 'ok']);
  assert.deepEqual(resumen(k.tiempo_limitado_merma), [0, 0, null, 'no_aplica']);
});

test('GET /indicadores: si la RPC falla, sus KPIs salen sin_datos con advertencia y el resto se calcula', async () => {
  rpc.respuesta = { data: null, error: { message: 'function obtener_kpis_admin does not exist' } };
  const r = await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-03', { como: 'admin' });
  assert.equal(r.status, 200);
  const k = porClave(r.body.kpis);
  for (const clave of ['pedidos_completados', 'recompra', 'ticket_promedio', 'tiempos_operativos']) {
    assert.deepEqual(resumen(k[clave]), [null, null, null, 'sin_datos'], clave);
  }
  assert.deepEqual(resumen(k.conversion_compra), [1, 4, 25, 'ok']);
  assert.deepEqual(r.body.advertencias.map((a) => a.fuente), ['obtener_kpis_admin']);
});

test('GET /indicadores: pagina más allá de 1000 filas (sin truncado silencioso de PostgREST)', async () => {
  const eventos = fake.tabla('eventos_analitica');
  for (let i = 0; i < 1203; i++) {
    eventos.push(ev(5000 + i, 9000 + i, 'session_start', { ocurrido_en: '2026-05-10T15:00:00.000Z', recibido_en: '2026-05-10T15:00:01.000Z' }));
  }
  const k = porClave((await pedir('GET', '/api/admin/indicadores?periodo=mes&mes=2026-05', { como: 'admin' })).body.kpis);
  assert.deepEqual(resumen(k.conversion_compra), [0, 1203, 0, 'ok']);
});

// ── HTTP: /api/admin/indicadores/embudo ──────────────────────────────────────

test('GET /indicadores/embudo: pasos deduplicados por sesión y compra verificada', async () => {
  const r = await pedir('GET', '/api/admin/indicadores/embudo?periodo=mes&mes=2026-03', { como: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'ok');
  assert.deepEqual(r.body.pasos.map((p) => [p.clave, p.sesiones]), [
    ['visita', 4], ['vista_oferta', 3], ['carrito', 2], ['inicio_pago', 2], ['compra_pagada', 1],
  ]);
  assert.equal(r.body.pasos[0].tasa_desde_anterior, null);
  assert.deepEqual(r.body.pasos[1].tasa_desde_anterior, { valor: 75, numerador: 3, denominador: 4, unidad: '%', estado: 'ok' });
  assert.deepEqual(r.body.pasos[4].tasa_desde_anterior, { valor: 50, numerador: 1, denominador: 2, unidad: '%', estado: 'ok' });
  assert.deepEqual(r.body.pasos[4].tasa_desde_visita, { valor: 25, numerador: 1, denominador: 4, unidad: '%', estado: 'ok' });
});

test('GET /indicadores/embudo: filtro por negocio y periodo sin instrumentación', async () => {
  const n1 = await pedir('GET', `/api/admin/indicadores/embudo?periodo=mes&mes=2026-03&negocio_id=${IDS.n1}`, { como: 'admin' });
  assert.deepEqual(n1.body.pasos.map((p) => p.sesiones), [2, 2, 1, 1, 1]);

  const ene = await pedir('GET', '/api/admin/indicadores/embudo?periodo=mes&mes=2026-01', { como: 'admin' });
  assert.equal(ene.body.estado, 'sin_datos');
  assert.ok(ene.body.pasos.every((p) => p.sesiones === null));

  const vacio = await pedir('GET', '/api/admin/indicadores/embudo?periodo=mes&mes=2026-04', { como: 'admin' });
  assert.equal(vacio.body.estado, 'no_aplica');
  assert.deepEqual(vacio.body.pasos.map((p) => p.sesiones), [0, 0, 0, 0, 0]);
  assert.equal(vacio.body.pasos[1].tasa_desde_anterior.estado, 'no_aplica');
});

// ── HTTP: /api/admin/inversion-publicitaria ──────────────────────────────────

test('POST /inversion-publicitaria: valida, registra con creado_por del admin y conserva histórico', async () => {
  assert.equal((await pedir('POST', '/api/admin/inversion-publicitaria', { como: 'cliente', body: {} })).status, 403);
  const malo = await pedir('POST', '/api/admin/inversion-publicitaria', { como: 'admin', body: { fecha_inicio: '2026-04-10', fecha_fin: '2026-04-01', monto: 10 } });
  assert.equal(malo.status, 400);

  const r = await pedir('POST', '/api/admin/inversion-publicitaria', {
    como: 'admin', body: { fecha_inicio: '2026-04-01', fecha_fin: '2026-04-30', monto: 2500, campana: 'Abril', creado_por: IDS.cliente },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.canal, 'meta_ads');
  assert.equal(r.body.creado_por, IDS.admin);
  assert.equal(fake.tabla('inversion_publicitaria').length, 4);
});

test('GET /inversion-publicitaria: filtra por solape de fechas y canal', async () => {
  const r = await pedir('GET', '/api/admin/inversion-publicitaria?desde=2026-03-17&hasta=2026-03-31&canal=meta_ads', { como: 'admin' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.registros.map((x) => x.campana), ['marzo']); // 'puente' termina el 16
  assert.equal(r.body.total, 3100);
  assert.equal((await pedir('GET', '/api/admin/inversion-publicitaria?desde=2026-3-1', { como: 'admin' })).status, 400);
});

// ── HTTP: /api/analitica/eventos ─────────────────────────────────────────────

test('POST /analitica/eventos: guarda el lote, deduplica y reporta rechazados por índice', async () => {
  fake.reiniciar({ usuarios: datosBase().usuarios, eventos_analitica: [] });
  const ahora = new Date().toISOString();
  const lote = [
    eventoOk({ client_event_id: 'evt-lote-0001', ocurrido_en: ahora }),
    eventoOk({ client_event_id: 'evt-lote-0002', evento: 'view_item', bolsa_id: IDS.b1, negocio_id: IDS.n1, ocurrido_en: ahora }),
    eventoOk({ client_event_id: 'evt-lote-0002', evento: 'view_item', bolsa_id: IDS.b1, ocurrido_en: ahora }), // repetido en el lote
    eventoOk({ client_event_id: 'evt-lote-0003', evento: 'login', ocurrido_en: ahora }),
  ];
  const r = await pedir('POST', '/api/analitica/eventos', { como: 'cliente', body: { eventos: lote } });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { aceptados: 2, duplicados: 1, rechazados: [{ indice: 3, error: r.body.rechazados[0].error }] });
  assert.match(r.body.rechazados[0].error, /evento debe ser uno de/);
  const guardados = fake.tabla('eventos_analitica');
  assert.equal(guardados.length, 2);
  assert.ok(guardados.every((e) => e.usuario_id === IDS.cliente));

  // Reintento del cliente: todo duplicado, nada nuevo.
  const otra = await pedir('POST', '/api/analitica/eventos', { body: { eventos: lote.slice(0, 2) } });
  assert.deepEqual(otra.body, { aceptados: 0, duplicados: 2, rechazados: [] });
  assert.equal(fake.tabla('eventos_analitica').length, 2);
});

test('POST /analitica/eventos: anónimo, token inválido no rompe, límites del lote', async () => {
  fake.reiniciar({ eventos_analitica: [] });
  const r = await pedir('POST', '/api/analitica/eventos', {
    headers: { Authorization: 'Bearer token-roto' },
    body: { eventos: [eventoOk({ usuario_id: IDS.admin })] },
  });
  assert.equal(r.status, 202);
  assert.equal(fake.tabla('eventos_analitica')[0].usuario_id, null);

  assert.equal((await pedir('POST', '/api/analitica/eventos', { body: { eventos: [] } })).status, 400);
  assert.equal((await pedir('POST', '/api/analitica/eventos', { body: {} })).status, 400);
  const grande = Array.from({ length: 51 }, (_, i) => eventoOk({ client_event_id: `evt-grande-${String(i).padStart(4, '0')}` }));
  assert.equal((await pedir('POST', '/api/analitica/eventos', { body: { eventos: grande } })).status, 413);
  const todosMalos = await pedir('POST', '/api/analitica/eventos', { body: { eventos: [{ evento: 'x' }] } });
  assert.equal(todosMalos.status, 400);
  assert.equal(todosMalos.body.aceptados, 0);
});

test('POST /analitica/eventos: error de base → 503 para que el cliente reintente', async () => {
  fake.reiniciar({ eventos_analitica: [] });
  fake.inyectarError({ message: 'relation "eventos_analitica" does not exist' });
  const r = await pedir('POST', '/api/analitica/eventos', { body: { eventos: [eventoOk()] } });
  assert.equal(r.status, 503);
});
