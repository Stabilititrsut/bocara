function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function redondearMoneda(valor) {
  return Math.round((aNumero(valor) + Number.EPSILON) * 100) / 100;
}

// Valor de productos sin propina, envío, cargo de plataforma ni descuentos
// financiados por Bocara. El snapshot financiero soporta pedidos con varios
// items; `precio_bolsa` por sí solo representa únicamente el item principal.
function obtenerSubtotalProductos(pedido = {}) {
  const propina = aNumero(pedido.propina);
  const costoEnvio = aNumero(pedido.costo_envio);
  const comisionBocara = aNumero(pedido.comision_bocara);

  if (pedido.monto_neto_restaurante != null && pedido.comision_bocara != null) {
    return Math.max(0, redondearMoneda(
      aNumero(pedido.monto_neto_restaurante) - propina - costoEnvio + comisionBocara
    ));
  }

  if (pedido.total != null) {
    return Math.max(0, redondearMoneda(
      aNumero(pedido.total)
      - propina
      - costoEnvio
      - aNumero(pedido.comision_pasarela)
      + aNumero(pedido.descuento_cupon)
    ));
  }

  return Math.max(0, redondearMoneda(
    aNumero(pedido.precio_bolsa) * Math.max(1, aNumero(pedido.cantidad) || 1)
  ));
}

module.exports = { aNumero, redondearMoneda, obtenerSubtotalProductos };
