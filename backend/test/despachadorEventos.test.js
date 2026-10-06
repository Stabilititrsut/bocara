const test = require('node:test');
const assert = require('node:assert/strict');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const {
  ABANDONO_MS, recuperarAbandonados, procesarPendientes, ejecutarDespachador,
} = require('../services/despachadorEventos');
const { MAX_ATTEMPTS } = require('../services/eventosDominio');

const T0 = Date.parse('2026-10-05T12:00:00Z');

function evento(id, extra = {}) {
  return {
    id, event_type: 'publicacion.visible', aggregate_type: 'bolsa', aggregate_id: `bolsa-${id}`,
    idempotency_key: `k-${id}`, payload: {}, status: 'pendiente', attempts: 0, last_error: null,
    created_at: new Date(T0).toISOString(), processing_at: null, processed_at: null, ...extra,
  };
}

function handlersEspia(impl = async () => {}) {
  const llamadas = [];
  return { llamadas, handlers: { 'publicacion.visible': async (ev, ctx) => { llamadas.push(ev.id); return impl(ev, ctx); } } };
}

test('procesa los pendientes con handler y los marca procesados', async () => {
  const cliente = crearFakeSupabase({ eventos_dominio: [evento('e1'), evento('e2')] });
  const { llamadas, handlers } = handlersEspia();
  const r = await procesarPendientes({ cliente, handlers });
  assert.deepEqual(llamadas, ['e1', 'e2']);
  assert.equal(r.procesados, 2);
  assert.deepEqual(cliente.tabla('eventos_dominio').map(e => e.status), ['procesado', 'procesado']);
});

test('no toca eventos sin handler (siguen siendo bitácora)', async () => {
  const cliente = crearFakeSupabase({
    eventos_dominio: [evento('pago', { event_type: 'pedido.pago_confirmado' }), evento('vis')],
  });
  const { llamadas, handlers } = handlersEspia();
  await procesarPendientes({ cliente, handlers });
  assert.deepEqual(llamadas, ['vis']);
  const pago = cliente.tabla('eventos_dominio').find(e => e.id === 'pago');
  assert.equal(pago.status, 'pendiente');
  assert.equal(pago.attempts, 0);
});

test('el handler recibe el cliente inyectado', async () => {
  const cliente = crearFakeSupabase({ eventos_dominio: [evento('e1')] });
  let recibido = null;
  const { handlers } = handlersEspia(async (_ev, ctx) => { recibido = ctx.cliente; });
  await procesarPendientes({ cliente, handlers });
  assert.equal(recibido, cliente);
});

test('un handler que falla deja el evento pendiente con el intento contado', async () => {
  const cliente = crearFakeSupabase({ eventos_dominio: [evento('e1'), evento('e2')] });
  const { handlers } = handlersEspia(async (ev) => { if (ev.id === 'e1') throw new Error('Expo caído'); });
  const r = await procesarPendientes({ cliente, handlers });
  assert.equal(r.fallidos, 1);
  assert.equal(r.procesados, 1, 'el fallo de uno no aborta el lote');
  const e1 = cliente.tabla('eventos_dominio').find(e => e.id === 'e1');
  assert.equal(e1.status, 'pendiente');
  assert.equal(e1.attempts, 1);
  assert.match(e1.last_error, /Expo caído/);
});

test('CAS: un evento ya reclamado por otro worker no se ejecuta dos veces', async () => {
  const cliente = crearFakeSupabase({ eventos_dominio: [evento('e1')] });
  const { llamadas, handlers } = handlersEspia();
  // Dos workers leen el mismo lote "a la vez".
  const [a, b] = await Promise.all([procesarPendientes({ cliente, handlers }), procesarPendientes({ cliente, handlers })]);
  assert.equal(llamadas.length, 1);
  assert.equal(a.procesados + b.procesados, 1);
  assert.equal(a.fallidos + b.fallidos, 0, 'perder el CAS no cuenta como fallo');
  assert.equal(cliente.tabla('eventos_dominio')[0].attempts, 0);
});

test(`recupera eventos con más de ${ABANDONO_MS / 60000} min en procesando, contando el intento`, async () => {
  const viejo = new Date(T0 - ABANDONO_MS - 1000).toISOString();
  const reciente = new Date(T0 - 60 * 1000).toISOString();
  const cliente = crearFakeSupabase({
    eventos_dominio: [
      evento('abandonado', { status: 'procesando', processing_at: viejo, attempts: 1 }),
      evento('en_curso', { status: 'procesando', processing_at: reciente }),
      evento('ajeno', { status: 'procesando', processing_at: viejo, event_type: 'pedido.pago_confirmado' }),
    ],
  });
  const n = await recuperarAbandonados({ cliente, ahora: T0 });
  assert.equal(n, 1);
  const porId = Object.fromEntries(cliente.tabla('eventos_dominio').map(e => [e.id, e]));
  assert.equal(porId.abandonado.status, 'pendiente');
  assert.equal(porId.abandonado.attempts, 2);
  assert.equal(porId.abandonado.processing_at, null);
  assert.equal(porId.en_curso.status, 'procesando', 'menos de 10 min: sigue siendo de su worker');
  assert.equal(porId.ajeno.status, 'procesando', 'sin handler: no se toca');
});

test('un evento abandonado que agota los intentos pasa a fallido (sin bucle infinito)', async () => {
  const viejo = new Date(T0 - ABANDONO_MS - 1000).toISOString();
  const cliente = crearFakeSupabase({
    eventos_dominio: [evento('e1', { status: 'procesando', processing_at: viejo, attempts: MAX_ATTEMPTS - 1 })],
  });
  await recuperarAbandonados({ cliente, ahora: T0 });
  assert.equal(cliente.tabla('eventos_dominio')[0].status, 'fallido');
});

test('ejecutarDespachador recupera y luego procesa en el mismo tick', async () => {
  const viejo = new Date(Date.now() - ABANDONO_MS - 1000).toISOString();
  const cliente = crearFakeSupabase({
    eventos_dominio: [evento('e1', { status: 'procesando', processing_at: viejo })],
  });
  const { llamadas, handlers } = handlersEspia();
  const r = await ejecutarDespachador({ cliente, handlers });
  assert.deepEqual(llamadas, ['e1']);
  assert.equal(r.procesados, 1);
  assert.equal(cliente.tabla('eventos_dominio')[0].status, 'procesado');
});

test('ejecutarDespachador no solapa ticks dentro del mismo proceso y nunca lanza', async () => {
  const cliente = crearFakeSupabase({ eventos_dominio: [evento('e1')] });
  let soltar;
  const bloqueo = new Promise((r) => { soltar = r; });
  const { handlers } = handlersEspia(() => bloqueo);
  const primero = ejecutarDespachador({ cliente, handlers });
  const segundo = await ejecutarDespachador({ cliente, handlers });
  assert.deepEqual(segundo, { omitido: 'en_curso' });
  soltar();
  await primero;

  cliente.inyectarError({ message: 'BD caída' });
  const r = await ejecutarDespachador({ cliente, handlers });
  assert.match(r.error, /BD caída/);
});
