// Separación contable Tiempo Limitado (25%) vs Promoción (20%):
//   · services/desgloseFinanciero.js (unitarias: desglose, periodos en hora GT)
//   · GET /api/admin/stats         → resumen_financiero
//   · GET /api/admin/financiero    → top restaurantes con columnas por tipo
//   · GET /api/negocios/mi-negocio/ganancias → desglose_tipos del restaurante
// Los snapshots se generan con el calcularSnapshotFinanciero real, igual que al cobrar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, datosBase, iniciar, detener, pedir } = require('./helpers/appPublicaciones');
const { calcularSnapshotFinanciero } = require('../services/finanzasSnapshot');
const { hoyGuatemala } = require('../services/horarioGuatemala');
const {
  desglosarPedido, resumirFinanzas, resolverPeriodoFinanciero, bolsasSinSnapshot,
} = require('../services/desgloseFinanciero');

const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString();
const BOLSA_PROMO_HEREDADA = '00000000-0000-4000-8000-0000000b0001';

// Pedido verificado por Cubo cuyas columnas salen del snapshot (como confirmar_pago_cubo).
function pedidoConSnapshot({ id, negocioId, createdAt, lineas, propina = 0, extra = {} }) {
  const sf = calcularSnapshotFinanciero({
    items: lineas.map((l, i) => ({ bolsa_id: `b-${id}-${i}`, cantidad: l.cantidad })),
    bolsas: lineas.map((l) => ({ precio_descuento: l.precio, tipo: l.tipo })),
    propina,
  });
  return {
    id, negocio_id: negocioId, estado: 'confirmado', estado_pago: 'pagado', created_at: createdAt,
    cubo_payment_intent_token: `tok-${id}`, cubo_identifier: `cid-${id}`,
    snapshot_financiero: sf, total: sf.total_cliente, comision_bocara: sf.comision_bocara,
    comision_pasarela: sf.comision_pasarela, monto_neto_restaurante: sf.monto_neto_restaurante,
    propina: sf.propina, costo_envio: 0, descuento_cupon: 0, ...extra,
  };
}

function sembrar() {
  const d = datosBase();
  d.bolsas.push({ id: BOLSA_PROMO_HEREDADA, negocio_id: IDS.olaAzul, tipo: 'cupon', nombre: 'Promo vieja' });
  d.pedidos = [
    // Hoy, Ola Azul: 2× Tiempo Limitado Q40 (25%) + 1× Promoción Q50 (20%), propina Q10.
    pedidoConSnapshot({
      id: 'p1', negocioId: IDS.olaAzul, createdAt: haceDias(0), propina: 10,
      lineas: [{ cantidad: 2, precio: 40, tipo: 'bolsa' }, { cantidad: 1, precio: 50, tipo: 'cupon' }],
    }),
    // Hace 3 días, Ola Azul: pedido HEREDADO sin snapshot de una promoción (Q40, comisión 20%).
    {
      id: 'p2', negocio_id: IDS.olaAzul, bolsa_id: BOLSA_PROMO_HEREDADA, cantidad: 1, estado: 'completado',
      estado_pago: 'pagado', created_at: haceDias(3), cubo_payment_intent_token: 'tok-p2', cubo_identifier: 'cid-p2',
      total: 41.4, comision_bocara: 8, comision_pasarela: 1.4, monto_neto_restaurante: 32, propina: 0, costo_envio: 0,
    },
    // Hace 40 días, otro negocio: 1× Tiempo Limitado Q100.
    pedidoConSnapshot({ id: 'p3', negocioId: IDS.otroNegocio, createdAt: haceDias(40), lineas: [{ cantidad: 1, precio: 100, tipo: 'bolsa' }] }),
    // Excluidos: sin verificación Cubo y cancelado.
    pedidoConSnapshot({ id: 'p4', negocioId: IDS.olaAzul, createdAt: haceDias(0), lineas: [{ cantidad: 9, precio: 99, tipo: 'bolsa' }],
      extra: { cubo_payment_intent_token: null } }),
    pedidoConSnapshot({ id: 'p5', negocioId: IDS.olaAzul, createdAt: haceDias(0), lineas: [{ cantidad: 9, precio: 99, tipo: 'cupon' }],
      extra: { estado: 'cancelado' } }),
  ];
  fake.reiniciar(d);
}

test.before(iniciar);
test.after(detener);
test.beforeEach(sembrar);

// ── Unitarias ────────────────────────────────────────────────────────────────

test('desglosarPedido: separa por línea del snapshot (merma → Tiempo Limitado)', () => {
  const p = fake.tabla('pedidos').find((x) => x.id === 'p1');
  const d = desglosarPedido(p);
  assert.equal(d.unidades_tiempo_limitado, 2);
  assert.equal(d.unidades_promocion, 1);
  assert.equal(d.ventas_tiempo_limitado, 80);
  assert.equal(d.comision_tiempo_limitado, 20);
  assert.equal(d.ventas_promocion, 50);
  assert.equal(d.comision_promocion, 10);
  assert.equal(d.propinas, 10);
  assert.equal(d.pago_restaurante, 110); // 140 − 30 de comisión, propina íntegra
  assert.equal(d.tipo_inferido, false);
});

test('desglosarPedido heredado: tipo por la bolsa; sin bolsa → Tiempo Limitado marcado como inferido', () => {
  const p2 = fake.tabla('pedidos').find((x) => x.id === 'p2');
  const conBolsa = desglosarPedido(p2, new Map([[BOLSA_PROMO_HEREDADA, { tipo: 'cupon' }]]));
  assert.deepEqual([conBolsa.ventas_promocion, conBolsa.comision_promocion, conBolsa.unidades_promocion], [40, 8, 1]);
  const sinBolsa = desglosarPedido(p2);
  assert.deepEqual([sinBolsa.ventas_tiempo_limitado, sinBolsa.tipo_inferido], [40, true]);
  assert.deepEqual(bolsasSinSnapshot(fake.tabla('pedidos')), [BOLSA_PROMO_HEREDADA]);
});

test('resumirFinanzas: totales, % efectivos y total_bocara = comisiones + 3.5%', () => {
  const { totales: t } = resumirFinanzas([
    pedidoConSnapshot({ id: 'a', negocioId: 'n', createdAt: haceDias(0), lineas: [{ cantidad: 4, precio: 25, tipo: 'bolsa' }] }),
    pedidoConSnapshot({ id: 'b', negocioId: 'n', createdAt: haceDias(0), lineas: [{ cantidad: 2, precio: 50, tipo: 'cupon' }] }),
  ]);
  assert.equal(t.ventas_tiempo_limitado, 100);
  assert.equal(t.comision_tiempo_limitado, 25);
  assert.equal(t.porcentaje_tiempo_limitado, 25);
  assert.equal(t.neto_tiempo_limitado, 75);
  assert.equal(t.ventas_promocion, 100);
  assert.equal(t.comision_promocion, 20);
  assert.equal(t.porcentaje_promocion, 20);
  assert.equal(t.neto_promocion, 80);
  assert.equal(t.cargo_plataforma, 7);
  assert.equal(t.total_bocara, 52);
});

test('resolverPeriodoFinanciero: rangos cortados a las 00:00 de Guatemala (06:00 UTC)', () => {
  const ahora = new Date('2026-10-11T03:00:00Z'); // 10 oct 21:00 en Guatemala
  assert.deepEqual(resolverPeriodoFinanciero({ periodo: 'hoy' }, { ahora }),
    { periodo: 'hoy', desde: '2026-10-10T06:00:00.000Z', hasta: '2026-10-11T06:00:00.000Z' });
  assert.equal(resolverPeriodoFinanciero({ periodo: 'dia' }, { ahora }).periodo, 'hoy');
  assert.equal(resolverPeriodoFinanciero({ periodo: '7d' }, { ahora }).desde, '2026-10-04T06:00:00.000Z');
  assert.equal(resolverPeriodoFinanciero({ periodo: '30d' }, { ahora }).desde, '2026-09-11T06:00:00.000Z');
  assert.deepEqual(resolverPeriodoFinanciero({ periodo: 'mes_actual' }, { ahora }),
    { periodo: 'mes', mes: '2026-10', desde: '2026-10-01T06:00:00.000Z', hasta: '2026-11-01T06:00:00.000Z' });
  assert.equal(resolverPeriodoFinanciero({ periodo: 'mes', mes: '2026-08' }, { ahora }).desde, '2026-08-01T06:00:00.000Z');
  assert.deepEqual(resolverPeriodoFinanciero({}, { ahora }), { periodo: 'todo', desde: null, hasta: null });
  assert.ok(resolverPeriodoFinanciero({ periodo: 'mes', mes: '2026-13' }, { ahora }).error);
  assert.ok(resolverPeriodoFinanciero({ periodo: 'mes', mes: '2026-11' }, { ahora }).error, 'mes futuro');
  assert.ok(resolverPeriodoFinanciero({ periodo: 'mes_especifico' }, { ahora }).error, 'sin mes');
  assert.ok(resolverPeriodoFinanciero({ periodo: 'anio' }, { ahora }).error);
});

// ── GET /api/admin/stats ─────────────────────────────────────────────────────

test('stats (todo): resumen financiero separado por tipo, sin cancelados ni pagos sin verificar', async () => {
  const r = await pedir('GET', '/api/admin/stats', { como: IDS.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = r.body.resumen_financiero;
  assert.equal(f.ventas_tiempo_limitado, 180);  // 80 (p1) + 100 (p3)
  assert.equal(f.comision_tiempo_limitado, 45); // 25%
  assert.equal(f.ventas_promocion, 90);         // 50 (p1) + 40 (p2 heredado)
  assert.equal(f.comision_promocion, 18);       // 20%
  assert.equal(f.cargo_cliente_plataforma, 9.8);
  assert.equal(f.total_bocara, 72.8);
  assert.equal(f.propinas, 10);
  assert.equal(f.pago_restaurantes, 217);
  assert.equal(f.pago_restaurantes_sin_propinas, 207);
  assert.equal(f.unidades_tiempo_limitado, 3);
  assert.equal(f.unidades_promocion, 2);
  assert.equal(f.pedidos, 3);
  assert.equal(r.body.total_pedidos, 3, 'campos previos se mantienen');
});

test('stats?periodo=hoy: solo los pedidos del día en Guatemala', async () => {
  const r = await pedir('GET', '/api/admin/stats?periodo=hoy', { como: IDS.admin });
  assert.equal(r.status, 200);
  const f = r.body.resumen_financiero;
  assert.deepEqual([f.ventas_tiempo_limitado, f.ventas_promocion, f.pedidos], [80, 50, 1]);
  assert.equal(r.body.periodo.periodo, 'hoy');
  assert.equal(r.body.ingresos_totales, f.total_cobrado);
});

test('stats con periodo inválido → 400', async () => {
  assert.equal((await pedir('GET', '/api/admin/stats?periodo=siglo', { como: IDS.admin })).status, 400);
});

// ── GET /api/admin/financiero (Top restaurantes) ─────────────────────────────

test('financiero?periodo=7d: columnas por tipo por negocio', async () => {
  const r = await pedir('GET', '/api/admin/financiero?periodo=7d', { como: IDS.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resumen.length, 1, 'el pedido de hace 40 días queda fuera');
  const ola = r.body.resumen[0];
  assert.equal(ola.negocio_id, IDS.olaAzul);
  assert.equal(ola.unidades_tiempo_limitado, 2);
  assert.equal(ola.unidades_promocion, 2);
  assert.equal(ola.ventas_tiempo_limitado, 80);
  assert.equal(ola.ventas_promocion, 90);
  assert.equal(ola.comision_bocara_tiempo_limitado, 20);
  assert.equal(ola.comision_bocara_promocion, 18);
  assert.equal(ola.neto_restaurante, 142);
  assert.equal(ola.total, 186.3);
  assert.equal(ola.pedidos, 2, 'campos previos se mantienen');
  assert.deepEqual(r.body.porcentajes, { tiempo_limitado: 25, promocion: 20 });
});

test('financiero?periodo=hoy y todo', async () => {
  const hoy = await pedir('GET', '/api/admin/financiero?periodo=hoy', { como: IDS.admin });
  assert.deepEqual(hoy.body.resumen.map((n) => [n.ventas_tiempo_limitado, n.ventas_promocion]), [[80, 50]]);
  const todo = await pedir('GET', '/api/admin/financiero?periodo=todo', { como: IDS.admin });
  assert.deepEqual(todo.body.resumen.map((n) => n.negocio_id), [IDS.olaAzul, IDS.otroNegocio]);
  assert.equal(todo.body.totales.comision_bocara_tiempo_limitado, 45);
  assert.equal(todo.body.totales.comision_bocara_promocion, 18);
});

// ── GET /api/negocios/mi-negocio/ganancias ───────────────────────────────────

test('ganancias (todo): Tiempo Limitado 75% / Promoción 80% / propinas íntegras', async () => {
  const r = await pedir('GET', '/api/negocios/mi-negocio/ganancias?periodo=todo', { como: IDS.restaurante });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.desglose_tipos;
  assert.deepEqual(d.tiempo_limitado, { unidades: 2, ventas: 80, comision_bocara: 20, porcentaje_comision: 25, ganancia: 60 });
  assert.deepEqual(d.promocion, { unidades: 2, ventas: 90, comision_bocara: 18, porcentaje_comision: 20, ganancia: 72 });
  assert.equal(d.propinas, 10);
  assert.equal(d.total_a_recibir, 142); // 60 + 72 + 10
  assert.equal(r.body.resumen.total_a_recibir, 142, 'coincide con el total histórico');
});

test('ganancias: hoy, mes específico, compatibilidad "mes" = 30 días y errores', async () => {
  const hoy = await pedir('GET', '/api/negocios/mi-negocio/ganancias?periodo=hoy', { como: IDS.restaurante });
  assert.equal(hoy.body.desglose_tipos.promocion.ventas, 50);
  const mesActual = hoyGuatemala().slice(0, 7);
  const mes = await pedir('GET', `/api/negocios/mi-negocio/ganancias?periodo=mes&mes=${mesActual}`, { como: IDS.restaurante });
  assert.equal(mes.status, 200);
  assert.equal(mes.body.rango.mes, mesActual);
  const legado = await pedir('GET', '/api/negocios/mi-negocio/ganancias?periodo=mes', { como: IDS.restaurante });
  assert.equal(legado.body.periodo, '30d');
  assert.equal((await pedir('GET', '/api/negocios/mi-negocio/ganancias?periodo=mes&mes=2026-13', { como: IDS.restaurante })).status, 400);
  assert.equal((await pedir('GET', '/api/negocios/mi-negocio/ganancias?periodo=mes&mes=2999-01', { como: IDS.restaurante })).status, 400);
});
