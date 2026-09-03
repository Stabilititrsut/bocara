const MAX_DISTINCT_ITEMS = 20;
const MAX_QUANTITY_PER_ITEM = 50;

function normalizeCartItems(itemsReq, bolsaId, cantidadReq) {
  const rawItems = Array.isArray(itemsReq) && itemsReq.length > 0
    ? itemsReq
    : (bolsaId ? [{ bolsa_id: bolsaId, cantidad: cantidadReq ?? 1 }] : []);

  if (rawItems.length === 0) {
    return { error: 'Se requiere items[] o bolsa_id' };
  }
  if (rawItems.length > MAX_DISTINCT_ITEMS) {
    return { error: `El carrito admite como máximo ${MAX_DISTINCT_ITEMS} productos diferentes` };
  }

  const seen = new Set();
  const items = [];
  for (const raw of rawItems) {
    const bolsa_id = typeof raw?.bolsa_id === 'string' ? raw.bolsa_id.trim() : '';
    const cantidad = Number(raw?.cantidad ?? 1);
    if (!bolsa_id) return { error: 'Todos los productos deben tener bolsa_id' };
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_QUANTITY_PER_ITEM) {
      return { error: `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY_PER_ITEM}` };
    }
    if (seen.has(bolsa_id)) {
      return { error: 'El carrito contiene el mismo producto más de una vez' };
    }
    seen.add(bolsa_id);
    items.push({ bolsa_id, cantidad });
  }

  return { items };
}

function validateCheckoutBags(cartItems, bolsas, tipoEntrega) {
  if (!['recogida', 'envio'].includes(tipoEntrega)) {
    return 'Selecciona un tipo de entrega válido';
  }
  if (!Array.isArray(bolsas) || bolsas.length !== cartItems.length) {
    return 'No fue posible validar todos los productos del carrito';
  }

  const negocioIds = new Set();
  const hoyGuatemala = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  for (const bolsa of bolsas) {
    const negocio = bolsa?.negocios;
    if (!bolsa || !negocio) return 'Uno de los productos ya no está disponible';
    negocioIds.add(String(bolsa.negocio_id || negocio.id));

    if (bolsa.activo !== true ||
        (bolsa.estado_aprobacion != null && bolsa.estado_aprobacion !== 'aprobado')) {
      return `"${bolsa.nombre || 'Producto'}" ya no está disponible`;
    }
    if (negocio.activo !== true ||
        (negocio.estado_verificacion != null && negocio.estado_verificacion !== 'aprobado')) {
      return `El restaurante de "${bolsa.nombre || 'este producto'}" no está disponible`;
    }
    const precio = Number(bolsa.precio_descuento);
    if (!Number.isFinite(precio) || precio <= 0) {
      return `"${bolsa.nombre || 'Producto'}" tiene un precio inválido`;
    }
    if (bolsa.fecha_caducidad && String(bolsa.fecha_caducidad).slice(0, 10) < hoyGuatemala) {
      return `"${bolsa.nombre || 'Producto'}" ya venció`;
    }
    if (tipoEntrega === 'envio' && bolsa.permite_envio !== true) {
      return `"${bolsa.nombre || 'Producto'}" solo está disponible para recogida`;
    }
  }

  if (negocioIds.size !== 1) {
    return 'Cada pedido debe contener productos de un solo restaurante';
  }
  return null;
}

module.exports = {
  MAX_DISTINCT_ITEMS,
  MAX_QUANTITY_PER_ITEM,
  normalizeCartItems,
  validateCheckoutBags,
};
