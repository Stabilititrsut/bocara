// Feed de restaurantes del cliente (Inicio y Tiendas).
//
// REGLA DE NEGOCIO: aparecen SIEMPRE todos los restaurantes activos y
// verificados, sin importar la ubicación del usuario, la distancia ni si hoy
// tienen publicaciones. La ubicación SOLO ordena; nunca recorta.
//
// Orden:
//   1. Con publicaciones disponibles primero.
//   2. Dentro de cada grupo, más cercano primero (sin ubicación del usuario o
//      sin coordenadas del negocio → después de los que sí tienen distancia).
//   3. Desempate por calificación y luego por nombre (orden estable).

const { haversine, coordenadasValidas } = require('../utils/geo');

function distanciaKm(negocio, coords) {
  if (!coords) return null;
  const lat = Number(negocio.latitud);
  const lng = Number(negocio.longitud);
  if (negocio.latitud == null || negocio.longitud == null || !coordenadasValidas(lat, lng)) return null;
  return haversine(coords.lat, coords.lng, lat, lng);
}

// `negocios`: ya filtrados a disponibles públicos (activo y aprobado).
// `bolsas`: ya filtradas a visibles para el cliente, con `negocio_id`.
// `coords`: { lat, lng } válidas del usuario, o null.
function armarFeedNegocios(negocios = [], bolsas = [], coords = null) {
  const porNegocio = new Map();
  for (const b of bolsas || []) {
    const id = b?.negocio_id ?? b?.negocios?.id;
    if (!id) continue;
    const disc = b.precio_original > 0
      ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;
    const e = porNegocio.get(id) || { cantidad_bolsas: 0, max_descuento: 0 };
    e.cantidad_bolsas++;
    if (disc > e.max_descuento) e.max_descuento = disc;
    porNegocio.set(id, e);
  }

  const vistos = new Set();
  const lista = [];
  for (const n of negocios || []) {
    if (!n?.id || vistos.has(n.id)) continue;
    vistos.add(n.id);
    const exacta = distanciaKm(n, coords);
    lista.push({
      ...n,
      cantidad_bolsas: porNegocio.get(n.id)?.cantidad_bolsas || 0,
      max_descuento: porNegocio.get(n.id)?.max_descuento || 0,
      distancia_km: exacta === null ? null : Math.round(exacta * 100) / 100,
      _d: exacta,
    });
  }

  lista.sort((a, b) => {
    const dispA = a.cantidad_bolsas > 0 ? 0 : 1;
    const dispB = b.cantidad_bolsas > 0 ? 0 : 1;
    if (dispA !== dispB) return dispA - dispB;
    if (a._d !== b._d) {
      if (a._d === null) return 1;
      if (b._d === null) return -1;
      return a._d - b._d;
    }
    const cal = (Number(b.calificacion_promedio) || 0) - (Number(a.calificacion_promedio) || 0);
    if (cal !== 0) return cal;
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  });

  return lista.map(({ _d, ...n }) => n);
}

module.exports = { armarFeedNegocios };
