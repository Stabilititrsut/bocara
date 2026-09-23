const axios = require('axios');

// Haversine formula — returns distance in km between two lat/lng points
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordenadasValidas(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Convierte un valor de entrada (query string, body JSON) a número solo si es
// inequívocamente numérico. A propósito NO usa `Number(x)` directo sobre el
// valor crudo: `Number(true)` es 1, `Number(null)` es 0 y `Number([])` es 0 —
// los tres pasarían coordenadasValidas() como si fueran una coordenada real.
// Antes de convertir, solo se aceptan `number` y `string`; cualquier otro tipo
// (incluido null/undefined) devuelve NaN y coordenadasValidas lo rechaza.
function aNumeroCoordenada(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && valor.trim() !== '') return Number(valor);
  return NaN;
}

// Punto único de validación para cualquier endpoint que reciba lat/lng del
// cliente (query o body): PATCH /api/auth/ubicacion y GET /api/bolsas usan
// esta misma función para no divergir en qué cuenta como "válido".
function validarCoordenadasEntrada(latCruda, lngCruda) {
  const lat = aNumeroCoordenada(latCruda);
  const lng = aNumeroCoordenada(lngCruda);
  return { lat, lng, ok: coordenadasValidas(lat, lng) };
}

// Resuelve qué coordenadas usar para el filtro geográfico de un request:
//   1. Las del query explícito, si el cliente mandó cualquiera de las dos
//      (ganan siempre, aunque luego resulten inválidas — eso ya lo decide el
//      caller con validarCoordenadasEntrada antes de responder 422).
//   2. Si no mandó ninguna, la última ubicación que el usuario autenticado
//      persistió via PATCH /api/auth/ubicacion — solo si es una coordenada
//      válida (una fila vieja corrupta no debe colarse como si fuera buena).
//   3. Si no hay ninguna de las dos, `null`: no se inventa ubicación.
function resolverCoordenadasCliente({ queryLat, queryLng, usuarioLat, usuarioLng }) {
  if (queryLat !== undefined || queryLng !== undefined) {
    return { lat: queryLat ?? null, lng: queryLng ?? null, origen: 'request' };
  }
  if (coordenadasValidas(usuarioLat, usuarioLng)) {
    return { lat: usuarioLat, lng: usuarioLng, origen: 'perfil' };
  }
  return { lat: null, lng: null, origen: 'ninguna' };
}

// Geocode a street address in Guatemala using Nominatim (OpenStreetMap, free, no key)
// Returns { lat, lng } or null if not found / on error
async function geocodeAddress(direccion, zona = '', ciudad = 'Guatemala', nombre = '') {
  if (!direccion && !zona) return null;
  const zonaStr = zona ? (String(zona).toLowerCase().startsWith('zona') ? String(zona) : `Zona ${zona}`) : '';

  // Query principal: dirección + zona + ciudad (el nombre del negocio no es parte de una dirección postal)
  if (direccion) {
    const q = [direccion, zonaStr, ciudad, 'Guatemala'].filter(Boolean).join(', ');
    console.log(`[nominatim] query="${q}"`);
    const hit = await _nominatim(q);
    if (hit) return hit;
  }

  // Fallback: solo zona + ciudad — para negocios con dirección incompleta
  if (zonaStr) {
    const qFallback = [zonaStr, ciudad || 'Guatemala', 'Guatemala'].filter(Boolean).join(', ');
    console.log(`[nominatim] fallback="${qFallback}"`);
    const hit = await _nominatim(qFallback);
    if (hit) return hit;
  }

  return null;
}

async function _nominatim(q) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 1, countrycodes: 'gt' },
      headers: { 'User-Agent': 'BocararApp/1.0 (contacto@bocara.gt)' },
      timeout: 8000,
    });
    const hit = res.data?.[0];
    if (hit) return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  haversine, geocodeAddress, coordenadasValidas,
  aNumeroCoordenada, validarCoordenadasEntrada, resolverCoordenadasCliente,
};
