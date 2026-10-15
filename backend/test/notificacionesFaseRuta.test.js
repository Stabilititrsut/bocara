// PUT /api/pedidos/:id/estado: cada fase del ciclo deja el aviso del cliente
// en su bandeja (y dispara el push si tiene token).

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, datosBase, iniciar, detener, pedir, pedidoPagado } = require('./helpers/appPedidos');

const PEDIDO = '00000000-0000-4000-8000-00000000c101';
const cambiar = (estado) => pedir('PUT', `/api/pedidos/${PEDIDO}/estado`, { como: IDS.restaurante, body: { estado } });

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

test('confirmado → en_preparacion → listo → completado: un aviso al cliente por fase', async () => {
  fake.tabla('pedidos').push({
    ...pedidoPagado({ id: PEDIDO, createdAtISO: new Date().toISOString(), estado: 'confirmado' }),
    codigo_recogida: 'AB12',
  });
  for (const estado of ['en_preparacion', 'listo', 'completado']) {
    const r = await cambiar(estado);
    assert.equal(r.status, 200, `${estado}: ${JSON.stringify(r.body)}`);
  }
  const avisos = fake.tabla('notificaciones').filter((n) => n.usuario_id === 'cliente-1');
  assert.deepEqual(avisos.map((n) => n.tipo), ['pedido_en_preparacion', 'pedido_listo', 'bolsa_recogida']);
  assert.ok(avisos.every((n) => n.data?.pedidoId === PEDIDO && n.leida === false));
  assert.match(avisos[1].cuerpo, /AB12/);
});
