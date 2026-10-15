const assert = require('assert');
const { normalizeCartItems, validateCheckoutBags } = require('../services/checkoutValidation');

function bolsa(overrides = {}) {
  return {
    id: 'b1', negocio_id: 'n1', nombre: 'Bolsa', activo: true,
    estado_aprobacion: 'aprobado', precio_descuento: 25, cantidad_disponible: 3,
    permite_envio: true,
    negocios: { id: 'n1', activo: true, estado_verificacion: 'aprobado' },
    ...overrides,
  };
}

assert.deepStrictEqual(
  normalizeCartItems([{ bolsa_id: 'b1', cantidad: 2 }]).items,
  [{ bolsa_id: 'b1', cantidad: 2 }]
);
assert.match(normalizeCartItems([{ bolsa_id: 'b1', cantidad: 0 }]).error, /cantidad/);
assert.match(normalizeCartItems([
  { bolsa_id: 'b1', cantidad: 1 }, { bolsa_id: 'b1', cantidad: 1 },
]).error, /mismo producto/);

const items = [{ bolsa_id: 'b1', cantidad: 1 }];
assert.strictEqual(validateCheckoutBags(items, [bolsa()], 'recogida'), null);
assert.match(validateCheckoutBags(items, [bolsa({ activo: false })], 'recogida'), /no está disponible/);
assert.match(validateCheckoutBags(items, [bolsa({ estado_aprobacion: 'pendiente' })], 'recogida'), /no está disponible/);
assert.match(validateCheckoutBags(items, [bolsa({ negocios: { id: 'n1', activo: false } })], 'recogida'), /restaurante/);
assert.match(validateCheckoutBags(items, [bolsa({ permite_envio: false })], 'envio'), /recogida/);
// Horario de recogida (reloj real de Guatemala): una ventana que cierra a las
// 00:00 ya terminó a cualquier hora del día; una que cierra a las 23:59:59
// sigue abierta (salvo ese último segundo).
assert.match(validateCheckoutBags(items,
  [bolsa({ hora_recogida_inicio: '00:00', hora_recogida_fin: '00:00' })], 'recogida'), /horario de recogida terminó/);
assert.strictEqual(validateCheckoutBags(items,
  [bolsa({ hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59:59' })], 'recogida'), null);
assert.match(validateCheckoutBags(items,
  [bolsa({ hora_recogida_fin: 'mañana' })], 'recogida'), /horario de recogida terminó/);
assert.match(validateCheckoutBags(
  [{ bolsa_id: 'b1', cantidad: 1 }, { bolsa_id: 'b2', cantidad: 1 }],
  [bolsa(), bolsa({ id: 'b2', negocio_id: 'n2', negocios: { id: 'n2', activo: true, estado_verificacion: 'aprobado' } })],
  'recogida'
), /un solo restaurante/);

console.log('checkoutValidation: todas las pruebas pasaron');
