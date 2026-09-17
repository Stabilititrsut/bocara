const test = require('node:test');
const assert = require('node:assert/strict');
const { calcularSnapshotFinanciero, actualizarPropinaEnSnapshot } = require('../services/finanzasSnapshot');

const merma = { id: 'm', precio_descuento: 100, es_tiempo_limitado: true };
const promo = { id: 'p', precio_descuento: 50, es_promocion: true };

test('merma usa 25% y conserva todos los componentes del snapshot', () => {
  const s = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 1 }], bolsas: [merma], costoEnvio: 10, propina: 5 });
  assert.equal(s.tipo_financiero, 'merma');
  assert.equal(s.porcentaje_comision_aplicado, 0.25);
  assert.equal(s.comision_bocara, 25);
  assert.equal(s.monto_neto_restaurante, 90);
  assert.equal(s.total_cliente, 119.03);
});

test('promoción usa 20% definido por backend', () => {
  const s = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'p', cantidad: 1 }], bolsas: [promo] });
  assert.equal(s.tipo_financiero, 'promocion');
  assert.equal(s.porcentaje_comision_aplicado, 0.20);
  assert.equal(s.comision_bocara, 10);
  assert.equal(s.monto_neto_restaurante, 40);
  assert.equal(s.total_cliente, 51.75);
});

test('carrito mixto no mezcla porcentajes y el total cuadra', () => {
  const s = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 2 }, { bolsa_id: 'p', cantidad: 1 }], bolsas: [merma, promo] });
  assert.equal(s.tipo_financiero, 'mixto');
  assert.equal(s.comision_bocara, 60);
  assert.equal(s.total_cliente, 258.75);
  assert.equal(s.total_cliente, s.subtotal_productos + s.costo_envio + s.propina + s.comision_pasarela);
  assert.deepEqual(s.lineas.map(x => x.porcentaje_comision_aplicado), [0.25, 0.20]);
});

test('total_cliente = subtotal + envío + propina + comisión pasarela, siempre exacto', () => {
  const s = calcularSnapshotFinanciero({
    items: [{ bolsa_id: 'm', cantidad: 3 }], bolsas: [merma], costoEnvio: 12.5, propina: 7.25,
  });
  assert.equal(s.total_cliente, redondear2(s.subtotal_productos + s.costo_envio + s.propina + s.comision_pasarela));
});

test('monto_neto_restaurante = subtotal - comisión Bocara + envío + propina (nunca resta la comisión de pasarela)', () => {
  const s = calcularSnapshotFinanciero({
    items: [{ bolsa_id: 'p', cantidad: 2 }], bolsas: [promo], costoEnvio: 15, propina: 3,
  });
  assert.equal(s.monto_neto_restaurante, redondear2(s.subtotal_productos - s.comision_bocara + s.costo_envio + s.propina));
});

test('cambiar la configuración después de creado un pedido no altera su snapshot ya calculado', () => {
  // El snapshot es puro: recibe la fracción vigente EN EL MOMENTO de calcularse
  // (routes/pagos.js la lee de configuracion.js antes de llamar aquí) y jamás
  // vuelve a leerla. "Cambiar configuración" se simula pasando otra fracción:
  // el snapshot histórico ya devuelto por la llamada anterior no cambia porque
  // esta función no tiene estado ni vuelve a tocar la config global.
  const argsPedidoHistorico = { items: [{ bolsa_id: 'm', cantidad: 1 }], bolsas: [merma], comisionMerma: 0.25, comisionPromocion: 0.20 };
  const pedidoHistorico = calcularSnapshotFinanciero(argsPedidoHistorico);

  // "Hoy" el admin sube la comisión de merma a 30% — un pedido NUEVO usaría esa
  // fracción, pero volver a pedir el snapshot con los mismos argumentos del
  // pedido histórico (los que quedaron persistidos) reproduce el mismo 25%.
  const comisionNuevaEnConfigHoy = 0.30;
  assert.notEqual(comisionNuevaEnConfigHoy, argsPedidoHistorico.comisionMerma);
  const recalculoConArgsOriginales = calcularSnapshotFinanciero(argsPedidoHistorico);
  assert.equal(recalculoConArgsOriginales.porcentaje_comision_aplicado, pedidoHistorico.porcentaje_comision_aplicado);
  assert.equal(recalculoConArgsOriginales.comision_bocara, pedidoHistorico.comision_bocara);

  const pedidoNuevo = calcularSnapshotFinanciero({ ...argsPedidoHistorico, comisionMerma: comisionNuevaEnConfigHoy });
  assert.equal(pedidoNuevo.porcentaje_comision_aplicado, 0.30);
  assert.notEqual(pedidoNuevo.comision_bocara, pedidoHistorico.comision_bocara);
});

test('la comisión y el porcentaje nunca se aceptan desde el cliente — solo del catálogo leído por el backend', () => {
  // Un payload de cliente comprometido que intenta inyectar su propio % o monto
  // de comisión no tiene ningún parámetro por el que colarse: la función solo
  // lee porcentaje/precio de `bolsas` (el catálogo que el backend acaba de
  // consultar), nunca de `items` (lo único que envía el cliente).
  const itemsHostiles = [{
    bolsa_id: 'm', cantidad: 1,
    porcentaje_comision_aplicado: 0.01, comision_bocara: 0, precio_descuento: 1,
  }];
  const s = calcularSnapshotFinanciero({ items: itemsHostiles, bolsas: [merma] });
  assert.equal(s.porcentaje_comision_aplicado, 0.25);
  assert.equal(s.comision_bocara, 25);
});

function redondear2(n) { return Math.round(n * 100) / 100; }

// ── actualizarPropinaEnSnapshot — PATCH /pagos/borrador/:id (P2 del reporte anterior) ──

test('cambiar la propina en borrador actualiza snapshot_financiero.propina', () => {
  const snapshot = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 1 }], bolsas: [merma], costoEnvio: 10, propina: 5 });
  const actualizado = actualizarPropinaEnSnapshot(snapshot, 20);
  assert.equal(actualizado.propina, 20);
});

test('cambiar la propina actualiza snapshot_financiero.total_cliente', () => {
  const snapshot = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 1 }], bolsas: [merma], costoEnvio: 10, propina: 5 });
  const actualizado = actualizarPropinaEnSnapshot(snapshot, 20);
  assert.notEqual(actualizado.total_cliente, snapshot.total_cliente);
  assert.equal(actualizado.total_cliente, redondear2(actualizado.subtotal_productos + actualizado.costo_envio + actualizado.propina + actualizado.comision_pasarela));
});

test('cambiar la propina NO cambia la comisión Bocara ni sus líneas', () => {
  const snapshot = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 2 }, { bolsa_id: 'p', cantidad: 1 }], bolsas: [merma, promo], costoEnvio: 10, propina: 5 });
  const actualizado = actualizarPropinaEnSnapshot(snapshot, 50);
  assert.equal(actualizado.comision_bocara, snapshot.comision_bocara);
  assert.deepEqual(actualizado.lineas, snapshot.lineas);
});

test('cambiar la propina NO cambia tipo_financiero ni porcentaje_comision_aplicado', () => {
  const snapshotPromo = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'p', cantidad: 1 }], bolsas: [promo], propina: 0 });
  const actualizado = actualizarPropinaEnSnapshot(snapshotPromo, 15);
  assert.equal(actualizado.tipo_financiero, 'promocion');
  assert.equal(actualizado.porcentaje_comision_aplicado, 0.20);

  const snapshotMixto = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 1 }, { bolsa_id: 'p', cantidad: 1 }], bolsas: [merma, promo] });
  const actualizadoMixto = actualizarPropinaEnSnapshot(snapshotMixto, 8);
  assert.equal(actualizadoMixto.tipo_financiero, 'mixto');
  assert.equal(actualizadoMixto.porcentaje_comision_aplicado, null);
});

test('actualizarPropinaEnSnapshot recalcula el neto del restaurante (100% de la propina es del restaurante)', () => {
  const snapshot = calcularSnapshotFinanciero({ items: [{ bolsa_id: 'm', cantidad: 1 }], bolsas: [merma], costoEnvio: 0, propina: 0 });
  const actualizado = actualizarPropinaEnSnapshot(snapshot, 30);
  assert.equal(actualizado.monto_neto_restaurante, redondear2(snapshot.monto_neto_restaurante + 30));
});

test('actualizarPropinaEnSnapshot sobre snapshot ausente (pedido legacy sin snapshot) no lanza', () => {
  assert.equal(actualizarPropinaEnSnapshot(null, 10), null);
  assert.equal(actualizarPropinaEnSnapshot(undefined, 10), undefined);
});

// "pedido pagado no se muta": esta función no conoce el estado del pedido — la
// guarda vive en routes/pagos.js (`if (pedido.estado !== 'borrador') return 400`,
// sin tocar). No hay forma de que un pedido pagado/confirmado/completado llegue
// a llamar actualizarPropinaEnSnapshot: la ruta corta antes con 400.
