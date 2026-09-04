const test = require('node:test');
const assert = require('node:assert/strict');
const { obtenerSubtotalProductos } = require('../services/finanzas');

test('separa producto, propina y cargo de plataforma del pedido piloto', () => {
  assert.equal(obtenerSubtotalProductos({
    total: 2.07,
    propina: 1,
    costo_envio: 0,
    comision_bocara: 0.25,
    comision_pasarela: 0.07,
    monto_neto_restaurante: 1.75,
    descuento_cupon: 0,
  }), 1);
});

test('reconstruye correctamente un carrito con varios productos', () => {
  assert.equal(obtenerSubtotalProductos({
    total: 21.74,
    propina: 2,
    costo_envio: 3,
    comision_bocara: 4,
    comision_pasarela: 0.74,
    monto_neto_restaurante: 17,
    descuento_cupon: 0,
    precio_bolsa: 5,
  }), 16);
});

test('un cupón absorbido por Bocara no reduce la venta del restaurante', () => {
  assert.equal(obtenerSubtotalProductos({
    total: 8.35,
    propina: 0,
    costo_envio: 0,
    comision_pasarela: 0.35,
    descuento_cupon: 2,
  }), 10);
});
