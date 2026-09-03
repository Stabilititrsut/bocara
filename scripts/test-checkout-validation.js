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
assert.match(validateCheckoutBags(
  [{ bolsa_id: 'b1', cantidad: 1 }, { bolsa_id: 'b2', cantidad: 1 }],
  [bolsa(), bolsa({ id: 'b2', negocio_id: 'n2', negocios: { id: 'n2', activo: true, estado_verificacion: 'aprobado' } })],
  'recogida'
), /un solo restaurante/);

console.log('checkoutValidation: todas las pruebas pasaron');
