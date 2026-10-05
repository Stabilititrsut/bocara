// DASH-2..5: GET /api/pedidos/restaurante?fecha=|mes= — filtros resueltos en
// el backend, en hora de Guatemala, sin traer todo el historial a memoria
// (gte/lt sobre `created_at` en SQL). Router real sobre Supabase en memoria.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, datosBase, iniciar, detener, pedir, pedidoPagado } = require('./helpers/appPedidos');
const { hoyGuatemala, sumarDias } = require('../services/horarioGuatemala');

const HOY = hoyGuatemala();
const AYER = sumarDias(HOY, -1);
const MES_ACTUAL = HOY.slice(0, 7);
// Mes anterior: día 1 de HOY menos 1 día cae siempre en el mes anterior.
const MES_ANTERIOR = sumarDias(`${HOY.slice(0, 8)}01`, -1).slice(0, 7);

function instanteMedioDia(fechaISO) {
  // 12:00 hora de Guatemala ese día → bien adentro del rango, lejos de los
  // bordes de medianoche que son los que de verdad pueden fallar por un
  // desfase de zona horaria.
  return `${fechaISO}T18:00:00.000Z`; // 12:00 Guatemala = 18:00 UTC
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

test('DASH-2: sin parámetros, "fecha=hoy" devuelve solo los pedidos de hoy (Guatemala)', async () => {
  fake.tabla('pedidos').push(
    pedidoPagado({ id: 'p-hoy', createdAtISO: instanteMedioDia(HOY) }),
    pedidoPagado({ id: 'p-ayer', createdAtISO: instanteMedioDia(AYER) }),
  );
  const r = await pedir('GET', '/api/pedidos/restaurante?fecha=hoy', { como: IDS.restaurante });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fecha, HOY, 'informa qué día resolvió, sin que el cliente lo calcule');
  assert.deepEqual(r.body.pedidos.map(p => p.id), ['p-hoy']);
});

test('DASH-3: un día anterior explícito (?fecha=AAAA-MM-DD) devuelve solo ese día', async () => {
  fake.tabla('pedidos').push(
    pedidoPagado({ id: 'p-hoy', createdAtISO: instanteMedioDia(HOY) }),
    pedidoPagado({ id: 'p-ayer', createdAtISO: instanteMedioDia(AYER) }),
  );
  const r = await pedir('GET', `/api/pedidos/restaurante?fecha=${AYER}`, { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.equal(r.body.fecha, AYER);
  assert.deepEqual(r.body.pedidos.map(p => p.id), ['p-ayer']);
});

test('DASH-4: mes actual (?mes=actual) incluye todo el mes, excluye el mes anterior', async () => {
  fake.tabla('pedidos').push(
    pedidoPagado({ id: 'p-este-mes', createdAtISO: instanteMedioDia(HOY) }),
    pedidoPagado({ id: 'p-mes-pasado', createdAtISO: instanteMedioDia(sumarDias(`${HOY.slice(0, 8)}01`, -1)) }),
  );
  const r = await pedir('GET', '/api/pedidos/restaurante?mes=actual', { como: IDS.restaurante });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mes, MES_ACTUAL);
  assert.deepEqual(r.body.pedidos.map(p => p.id), ['p-este-mes']);
});

test('DASH-5: mes anterior explícito (?mes=AAAA-MM) devuelve solo ese mes', async () => {
  const primerDiaMesAnterior = `${MES_ANTERIOR}-01`;
  fake.tabla('pedidos').push(
    pedidoPagado({ id: 'p-mes-pasado', createdAtISO: instanteMedioDia(sumarDias(primerDiaMesAnterior, 5)) }),
    pedidoPagado({ id: 'p-este-mes', createdAtISO: instanteMedioDia(HOY) }),
  );
  const r = await pedir('GET', `/api/pedidos/restaurante?mes=${MES_ANTERIOR}`, { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.equal(r.body.mes, MES_ANTERIOR);
  assert.deepEqual(r.body.pedidos.map(p => p.id), ['p-mes-pasado']);
});

test('DASH: los bordes del día se resuelven en hora de Guatemala, no en UTC', async () => {
  // 00:30 UTC del día siguiente a HOY sigue siendo las 18:30 de HOY en
  // Guatemala (UTC-6) — debe seguir contando como "hoy", no como "mañana".
  const limiteGuatemala = `${sumarDias(HOY, 1)}T00:30:00.000Z`;
  fake.tabla('pedidos').push(pedidoPagado({ id: 'p-borde', createdAtISO: limiteGuatemala }));
  const r = await pedir('GET', '/api/pedidos/restaurante?fecha=hoy', { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pedidos.map(p => p.id), ['p-borde']);
});

test('DASH: sin fecha ni mes, la forma de la respuesta no cambia (array plano, compatibilidad)', async () => {
  fake.tabla('pedidos').push(pedidoPagado({ id: 'p1', createdAtISO: instanteMedioDia(HOY) }));
  const r = await pedir('GET', '/api/pedidos/restaurante', { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), 'sin filtros sigue siendo un array, igual que antes');
  assert.deepEqual(r.body.map(p => p.id), ['p1']);
});

test('DASH: cambio de día — la misma llamada ?fecha=hoy resuelve un día distinto sin tocar el cliente', async () => {
  fake.tabla('pedidos').push(
    pedidoPagado({ id: 'p-hoy', createdAtISO: instanteMedioDia(HOY) }),
    pedidoPagado({ id: 'p-ayer', createdAtISO: instanteMedioDia(AYER) }),
  );
  const hoyReal = await pedir('GET', '/api/pedidos/restaurante?fecha=hoy', { como: IDS.restaurante });
  assert.deepEqual(hoyReal.body.pedidos.map(p => p.id), ['p-hoy']);
  // Simula "el día siguiente": lo que ayer era HOY, ahora se consulta como
  // fecha explícita — el mismo backend, sin ningún cambio de código, da la
  // respuesta correcta para ese día.
  const comoSiFueraOtroDia = await pedir('GET', `/api/pedidos/restaurante?fecha=${HOY}`, { como: IDS.restaurante });
  assert.deepEqual(comoSiFueraOtroDia.body.pedidos.map(p => p.id), ['p-hoy']);
});

test('DASH: fecha inválida responde 400, no 500 ni un array vacío silencioso', async () => {
  const r = await pedir('GET', '/api/pedidos/restaurante?fecha=no-es-una-fecha', { como: IDS.restaurante });
  assert.equal(r.status, 400);
});

test('DASH: mes inválido responde 400', async () => {
  const r = await pedir('GET', '/api/pedidos/restaurante?mes=2026', { como: IDS.restaurante });
  assert.equal(r.status, 400);
});

test('DASH: pedir fecha y mes a la vez responde 400 (ambiguo)', async () => {
  const r = await pedir('GET', `/api/pedidos/restaurante?fecha=hoy&mes=actual`, { como: IDS.restaurante });
  assert.equal(r.status, 400);
});

test('DASH: un pedido cancelado o no verificado por Cubo no cuenta aunque esté en el rango', async () => {
  fake.tabla('pedidos').push(
    { id: 'p-sin-cubo', negocio_id: IDS.olaAzul, usuario_id: 'c1', estado: 'completado',
      estado_pago: 'pagado', total: 50, created_at: instanteMedioDia(HOY) }, // sin cubo_identifier/token
  );
  const r = await pedir('GET', '/api/pedidos/restaurante?fecha=hoy', { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pedidos, []);
});
