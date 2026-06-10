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

module.exports = { haversine, geocodeAddress };
