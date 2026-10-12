// Tiempos operativos de /admin/indicadores ("Recibido → aceptado", "Aceptado →
// listo", "Listo → completado") de punta a punta: un pedido recorre el ciclo
// real por PUT /api/pedidos/:id/estado (routes/pedidos.js sella las marcas,
// además del trigger de BD) y services/metricas.js calcula los minutos.
//
// El SQL de obtener_kpis_admin no corre aquí (no hay Postgres en las pruebas):
// se ejercita su espejo en JS, tiemposOperativosDesdePedidos, que es el
// respaldo cuando la RPC no responde y replica su cohorte y su mediana.

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, datosBase, iniciar, detener, pedir, pedidoPagado } = require('./helpers/appPedidos');
const M = require('../services/metricas');

const PEDIDO = '00000000-0000-4000-8000-00000000c001';
// 10 de octubre de 2026, 10:00 en Guatemala (UTC-6).
const T0 = Date.parse('2026-10-10T16:00:00.000Z');
const min = (n) => new Date(T0 + n * 60000);
const fila = (id) => fake.tabla('pedidos').find((p) => p.id === id);
const cambiar = (id, estado) => pedir('PUT', `/api/pedidos/${id}/estado`, { como: IDS.restaurante, body: { estado } });

// Pedido pagado y confirmado, con las columnas de marcas presentes y vacías
// (BD con la migración 202610070900 aplicada).
function sembrarConfirmado(id = PEDIDO, extra = {}) {
  fake.tabla('pedidos').push({
    ...pedidoPagado({ id, createdAtISO: min(0).toISOString(), estado: 'confirmado' }),
    pagado_en: min(0).toISOString(), aceptado_en: null, listo_en: null, completado_en: null, ...extra,
  });
}

// Recorre confirmado → en_preparacion → listo → completado a los minutos dados.
async function recorrerCiclo(id, { aceptar, listo, completar }) {
  for (const [estado, minuto] of [['en_preparacion', aceptar], ['listo', listo], ['completado', completar]]) {
    mock.timers.setTime(min(minuto).getTime());
    const r = await cambiar(id, estado);
    assert.equal(r.status, 200, `${estado}: ${JSON.stringify(r.body)}`);
  }
}

const octubre = () => M.resolverPeriodo({ periodo: 'mes', mes: '2026-10' }, min(60)).periodo;

async function indicadoresOctubre() {
  // RPC no disponible (p. ej. migración sin desplegar) → respaldo en JS.
  fake.rpc = async () => ({ data: null, error: { message: 'function obtener_kpis_admin does not exist' } });
  const r = await M.obtenerIndicadores({
    periodo: octubre(), filtros: M.resolverFiltros({}).filtros, ahora: min(60), cliente: fake,
  });
  return { ...r, kpis: Object.fromEntries(r.kpis.map((k) => [k.clave, k])) };
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => {
  fake.reiniciar(datosBase());
  mock.timers.enable({ apis: ['Date'], now: T0 });
});
test.afterEach(() => mock.timers.reset());

test('ciclo completo: cada transición sella su marca con la hora del cambio', async () => {
  sembrarConfirmado();
  await recorrerCiclo(PEDIDO, { aceptar: 5, listo: 17, completar: 47 });
  const p = fila(PEDIDO);
  assert.equal(p.estado, 'completado');
  assert.equal(p.aceptado_en, min(5).toISOString());
  assert.equal(p.listo_en, min(17).toISOString());
  assert.equal(p.completado_en, min(47).toISOString());
});

test('ciclo completo: un solo pedido medido muestra sus minutos (5 / 12 / 30), no "Sin datos"', async () => {
  sembrarConfirmado();
  await recorrerCiclo(PEDIDO, { aceptar: 5, listo: 17, completar: 47 });
  const { kpis } = await indicadoresOctubre();
  const t = kpis.tiempos_operativos;
  assert.equal(t.fuente_calculo, 'respaldo_pedidos');
  assert.equal(t.valor, 5);
  assert.equal(t.estado, 'ok');
  assert.equal(t.muestras, 1);
  assert.deepEqual(t.desglose.map((d) => [d.clave, d.valor, d.muestras, d.estado]), [
    ['tiempo_recibido_aceptado', 5, 1, 'ok'],
    ['tiempo_aceptado_listo', 12, 1, 'ok'],
    ['tiempo_listo_completado', 30, 1, 'ok'],
  ]);
});

test('ciclo completo: con varios pedidos la mediana es la de percentile_cont (par → promedio)', async () => {
  sembrarConfirmado(PEDIDO);
  sembrarConfirmado('00000000-0000-4000-8000-00000000c002');
  await recorrerCiclo(PEDIDO, { aceptar: 4, listo: 14, completar: 20 });
  await recorrerCiclo('00000000-0000-4000-8000-00000000c002', { aceptar: 8, listo: 30, completar: 40 });
  const { kpis } = await indicadoresOctubre();
  assert.deepEqual(kpis.tiempos_operativos.desglose.map((d) => [d.valor, d.muestras]), [[6, 2], [16, 2], [8, 2]]);
});

test('entrega directa confirmado → completado: no se inventan tiempos de los tramos saltados', async () => {
  sembrarConfirmado();
  mock.timers.setTime(min(25).getTime());
  assert.equal((await cambiar(PEDIDO, 'completado')).status, 200);
  const p = fila(PEDIDO);
  assert.equal(p.aceptado_en, null);
  assert.equal(p.listo_en, null);
  assert.equal(p.completado_en, min(25).toISOString());
  const { kpis } = await indicadoresOctubre();
  assert.ok(kpis.tiempos_operativos.desglose.every((d) => d.estado === 'sin_datos' && d.muestras === 0));
});

test('una marca ya sellada (p. ej. por el trigger) no se sobrescribe', async () => {
  sembrarConfirmado(PEDIDO, { aceptado_en: min(2).toISOString() });
  mock.timers.setTime(min(9).getTime());
  assert.equal((await cambiar(PEDIDO, 'en_preparacion')).status, 200);
  assert.equal(fila(PEDIDO).aceptado_en, min(2).toISOString());
});

test('BD sin la migración (sin columnas de marcas): el UPDATE no manda columnas desconocidas', async () => {
  fake.tabla('pedidos').push({
    ...pedidoPagado({ id: PEDIDO, createdAtISO: min(0).toISOString(), estado: 'confirmado' }), pagado_en: min(0).toISOString(),
  });
  assert.equal((await cambiar(PEDIDO, 'en_preparacion')).status, 200);
  assert.equal('aceptado_en' in fila(PEDIDO), false);
});

test('periodo en hora de Guatemala: el borde del mes se corta a las 00:00 GT (06:00 UTC), no a medianoche UTC', () => {
  const periodo = octubre();
  assert.equal(periodo.desde, '2026-10-01T06:00:00.000Z');
  assert.equal(periodo.hasta, '2026-11-01T06:00:00.000Z');
  const medido = (id, createdAt) => ({
    id, cubo_payment_intent_token: 't', cubo_identifier: 'c', created_at: createdAt,
    pagado_en: createdAt, aceptado_en: new Date(Date.parse(createdAt) + 10 * 60000).toISOString(),
  });
  const k = M.tiemposOperativosDesdePedidos([
    medido('sep-30-21h-gt', '2026-10-01T03:00:00.000Z'), // 30 sep 21:00 GT → fuera
    medido('oct-31-21h-gt', '2026-11-01T03:00:00.000Z'), // 31 oct 21:00 GT → dentro
    medido('nov-01-00h-gt', '2026-11-01T06:00:00.000Z'), // 1 nov 00:00 GT → fuera (hasta exclusivo)
  ], periodo);
  assert.deepEqual(k.tiempo_recibido_aceptado, { valor: 10, muestras: 1 });
});

test('pedidos sin pago verificado por Cubo no entran a la cohorte', () => {
  const periodo = octubre();
  const k = M.tiemposOperativosDesdePedidos([{
    id: 'x', cubo_payment_intent_token: null, cubo_identifier: 'c', created_at: min(0).toISOString(),
    pagado_en: min(0).toISOString(), aceptado_en: min(5).toISOString(),
  }], periodo);
  assert.deepEqual(k.tiempo_recibido_aceptado, { valor: null, muestras: 0 });
});

test('medianaContinua replica percentile_cont(0.5)', () => {
  assert.equal(M.medianaContinua([]), null);
  assert.equal(M.medianaContinua([7]), 7);
  assert.equal(M.medianaContinua([3, 1]), 2);
  assert.equal(M.medianaContinua([5, 1, 3]), 3);
});

test('vía RPC: una sola muestra se muestra con su valor (n=1 → ok)', () => {
  const t = M.armarTiemposOperativos({
    tiempo_recibido_aceptado: { valor: 5, muestras: 1 },
    tiempo_aceptado_listo: { valor: 12, muestras: 1 },
    tiempo_listo_completado: { valor: 30, muestras: 1 },
  }, octubre());
  assert.deepEqual(t.desglose.map((d) => [d.valor, d.estado]), [[5, 'ok'], [12, 'ok'], [30, 'ok']]);
});
