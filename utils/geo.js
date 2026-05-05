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
async function geocodeAddress(direccion, zona = '', ciudad = 'Guatemala') {
  if (!direccion) return null;
  const partes = [direccion, zona, ciudad, 'Guatemala'].filter(Boolean);
  const q = partes.join(', ');
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 1, countrycodes: 'gt' },
      headers: { 'User-Agent': 'BocararApp/1.0 (contacto@bocara.gt)' },
      timeout: 5000,
    });
    const hit = res.data?.[0];
    if (hit) return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
    return null;
  } catch {
    return null;
  }
}

module.exports = { haversine, geocodeAddress };
