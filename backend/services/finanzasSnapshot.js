const { redondearMoneda } = require('./finanzas');
// Se repite como default puro para que el cálculo sea testeable sin conexión;
// la tarifa configurable de comisión Bocara se inyecta explícitamente.
const COMISION_PLATAFORMA_FRACCION = 0.035;

function esPromocion(bolsa = {}) {
  return bolsa.es_promocion === true || bolsa.tipo === 'cupon';
}

// Construye un snapshot inmutable a partir del catálogo que el backend acaba
// de leer. No acepta porcentaje ni montos financieros enviados por el cliente.
function calcularSnapshotFinanciero({ items, bolsas, costoEnvio = 0, propina = 0, comisionMerma = 0.25, comisionPromocion = 0.20 }) {
  const lineas = items.map((item, i) => {
    const bolsa = bolsas[i] || {};
    const subtotal = redondearMoneda(Number(bolsa.precio_descuento) * Number(item.cantidad));
    const porcentaje_comision = esPromocion(bolsa) ? comisionPromocion : comisionMerma;
    return {
      bolsa_id: item.bolsa_id,
      tipo_financiero: esPromocion(bolsa) ? 'promocion' : 'merma',
      cantidad: Number(item.cantidad),
      precio_unitario: redondearMoneda(bolsa.precio_descuento),
      subtotal_productos: subtotal,
      porcentaje_comision_aplicado: porcentaje_comision,
      comision_bocara: redondearMoneda(subtotal * porcentaje_comision),
    };
  });
  const subtotal_productos = redondearMoneda(lineas.reduce((s, l) => s + l.subtotal_productos, 0));
  const comision_bocara = redondearMoneda(lineas.reduce((s, l) => s + l.comision_bocara, 0));
  const base = redondearMoneda(subtotal_productos + Number(costoEnvio) + Number(propina));
  const comision_pasarela = redondearMoneda(base * COMISION_PLATAFORMA_FRACCION);
  const total_cliente = redondearMoneda(base + comision_pasarela);
  const monto_neto_restaurante = redondearMoneda(subtotal_productos - comision_bocara + Number(costoEnvio) + Number(propina));
  const tipos = [...new Set(lineas.map(l => l.tipo_financiero))];
  const porcentajes = [...new Set(lineas.map(l => l.porcentaje_comision_aplicado))];
  return {
    version: 1, lineas, subtotal_productos, comision_bocara,
    porcentaje_comision_aplicado: porcentajes.length === 1 ? porcentajes[0] : null,
    tipo_financiero: tipos.length === 1 ? tipos[0] : 'mixto',
    cargo_plataforma_cliente: comision_pasarela, comision_pasarela,
    propina: redondearMoneda(propina), costo_envio: redondearMoneda(costoEnvio),
    total_cliente, monto_neto_restaurante,
  };
}

// Recalcula solo los componentes que dependen de la propina (comisión de
// pasarela, total al cliente, neto del restaurante) sobre un snapshot YA
// persistido — usado por PATCH /pagos/borrador/:id cuando el cliente ajusta
// la propina antes de pagar. `porcentaje_comision_aplicado`, `tipo_financiero`,
// `comision_bocara` y `lineas` son el registro histórico de la comisión que se
// fijó al crear el pedido y nunca se tocan aquí.
//
// El caller (la ruta) es responsable de no llamar esto sobre un pedido que ya
// no está en 'borrador' — esta función no conoce el estado del pedido.
function actualizarPropinaEnSnapshot(snapshot, propinaNueva) {
  if (!snapshot) return snapshot;
  const propina = redondearMoneda(propinaNueva);
  const base = redondearMoneda(snapshot.subtotal_productos + snapshot.costo_envio + propina);
  const comision_pasarela = redondearMoneda(base * COMISION_PLATAFORMA_FRACCION);
  const total_cliente = redondearMoneda(base + comision_pasarela);
  const monto_neto_restaurante = redondearMoneda(snapshot.subtotal_productos - snapshot.comision_bocara + snapshot.costo_envio + propina);
  return {
    ...snapshot,
    propina, comision_pasarela, cargo_plataforma_cliente: comision_pasarela,
    total_cliente, monto_neto_restaurante,
  };
}

module.exports = { calcularSnapshotFinanciero, esPromocion, actualizarPropinaEnSnapshot };
