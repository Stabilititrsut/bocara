// Lógica de PATCH /api/auth/ubicacion, separada del router (mismo motivo que
// services/cuboWebhook.js: para poder probarla sin levantar express ni abrir
// un cliente de Supabase real).
const { validarCoordenadasEntrada } = require('../utils/geo');

// `usuarioId` SIEMPRE viene del JWT verificado por authMiddleware, nunca del
// payload — esta función no acepta ningún otro identificador de usuario, así
// que no hay forma de que un caller apunte la escritura a otra cuenta.
async function actualizarUbicacionUsuario({ usuarioId, latitud, longitud, cliente }) {
  if (latitud === undefined || latitud === null || longitud === undefined || longitud === null) {
    return { ok: false, status: 422, code: 'UBICACION_INVALIDA', error: 'latitud y longitud son obligatorias' };
  }

  const { lat, lng, ok } = validarCoordenadasEntrada(latitud, longitud);
  if (!ok) {
    return {
      ok: false, status: 422, code: 'UBICACION_INVALIDA',
      error: 'latitud debe estar entre -90 y 90, longitud entre -180 y 180, y ambas deben ser números',
    };
  }

  const ahora = new Date().toISOString();
  const { data, error } = await cliente
    .from('usuarios')
    .update({ latitud: lat, longitud: lng, ubicacion_actualizada_at: ahora })
    .eq('id', usuarioId)
    .select('latitud, longitud, ubicacion_actualizada_at')
    .single();

  if (error) {
    return { ok: false, status: 503, code: 'BD_NO_DISPONIBLE', error: 'No se pudo guardar la ubicación. Intenta de nuevo.' };
  }

  return { ok: true, status: 200, data };
}

module.exports = { actualizarUbicacionUsuario };
