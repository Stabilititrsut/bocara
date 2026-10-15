// Cada cambio de fase del pedido avisa al cliente: push con sonido + fila en
// su bandeja (la que la app web detecta por polling para sonar en pantalla).

const test = require('node:test');
const assert = require('node:assert/strict');
const { textoFaseCliente, notificarFasePedidoCliente, construirMensaje } = require('../services/notificaciones');

function supabaseEspia() {
  const filas = [];
  return {
    filas,
    from() { return { insert: async (f) => { filas.push(...f); return { error: null }; } }; },
  };
}

test('textoFaseCliente: cubre preparación, listo, entregado (completado/recogido) y cancelado', () => {
  assert.equal(textoFaseCliente('en_preparacion', 'AB12').tipo, 'pedido_en_preparacion');
  assert.equal(textoFaseCliente('listo', 'AB12').tipo, 'pedido_listo');
  assert.equal(textoFaseCliente('completado', 'AB12').tipo, 'bolsa_recogida');
  assert.deepEqual(textoFaseCliente('recogido', 'AB12'), textoFaseCliente('completado', 'AB12'));
  assert.equal(textoFaseCliente('cancelado', 'AB12').tipo, 'pedido_cancelado');
  assert.match(textoFaseCliente('cancelado', 'AB12').cuerpo, /5107-7949/);
  assert.match(textoFaseCliente('listo', 'AB12').cuerpo, /AB12/);
  assert.equal(textoFaseCliente('pendiente_pago', 'AB12'), null);
  for (const e of ['en_preparacion', 'listo', 'completado', 'cancelado']) {
    assert.doesNotMatch(textoFaseCliente(e, 'X').titulo + textoFaseCliente(e, 'X').cuerpo, /bolsa|puntos/i, e);
  }
});

test('notificarFasePedidoCliente: manda push y guarda la bandeja con el mismo texto', async () => {
  const sb = supabaseEspia();
  const pushes = [];
  const push = async (...args) => { pushes.push(args); };
  await notificarFasePedidoCliente(sb, { usuarioId: 'u1', token: 'ExponentPushToken[x]', pedidoId: 'p1', codigo: 'AB12', estado: 'listo' }, { push });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][0], 'ExponentPushToken[x]');
  assert.deepEqual(pushes[0][3], { pedidoId: 'p1', screen: 'pedidos', estado: 'listo' });
  assert.equal(sb.filas.length, 1);
  assert.equal(sb.filas[0].usuario_id, 'u1');
  assert.equal(sb.filas[0].tipo, 'pedido_listo');
  assert.equal(sb.filas[0].titulo, pushes[0][1]);
});

test('notificarFasePedidoCliente: sin token igual guarda la bandeja; un push que falla no lanza', async () => {
  const sb = supabaseEspia();
  await notificarFasePedidoCliente(sb, { usuarioId: 'u1', token: null, pedidoId: 'p1', codigo: 'AB12', estado: 'en_preparacion' }, {
    push: async () => { throw new Error('expo caído'); },
  });
  assert.equal(sb.filas.length, 1);
  assert.equal(await notificarFasePedidoCliente(sb, { usuarioId: 'u1', estado: 'desconocido' }), null);
});

test('el push de fase suena: sound default y prioridad alta', () => {
  const m = construirMensaje('ExponentPushToken[x]', 't', 'c', {});
  assert.equal(m.sound, 'default');
  assert.equal(m.priority, 'high');
});
