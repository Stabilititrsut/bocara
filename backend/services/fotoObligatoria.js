// Foto obligatoria para publicaciones (bolsas.imagen_url) y negocios
// (negocios.imagen_url — la "foto del negocio"; no hay otra columna: ver
// comentario de CAMPOS_PUBLICOS en routes/negocios.js).
//
// Reglas (ver routes/bolsas.js, routes/negocios.js, routes/admin.js):
//   · Publicación NUEVA sin foto → 400.
//   · Editar nunca puede dejar sin foto una publicación/negocio que la tiene.
//   · Datos heredados sin foto: se leen igual (no se bloquea nada al leer), y
//     un valor vacío que llega en una edición donde ya estaba vacío no cuenta
//     como cambio. Pero no pueden volver a revisión (publicación) ni quedar
//     aprobados/activos (negocio) sin completar la foto.

const MENSAJE_FOTO_PUBLICACION = 'La foto es obligatoria';
const MENSAJE_FOTO_NEGOCIO = 'Debes agregar una foto del negocio para continuar.';
const MENSAJE_APROBAR_NEGOCIO_SIN_FOTO = 'No se puede aprobar el negocio porque no tiene foto.';
const MENSAJE_ACTIVAR_NEGOCIO_SIN_FOTO = 'No se puede activar el negocio porque no tiene foto.';
const MENSAJE_APROBAR_PUBLICACION_SIN_FOTO = 'No se puede aprobar la publicación porque no tiene foto.';

// null, undefined, '' y solo espacios no son una foto.
function tieneFoto(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

// Normaliza `updates.imagen_url` de una edición contra el valor guardado:
//   · foto válida → se guarda recortada;
//   · vacía y antes había foto → error (no se puede quitar la foto);
//   · vacía y antes tampoco había (dato heredado) → se descarta, no es un cambio.
// Devuelve el mensaje de error o null. Muta `updates`.
function normalizarFotoEnEdicion(updates, fotoActual, mensaje) {
  if (updates.imagen_url === undefined) return null;
  if (tieneFoto(updates.imagen_url)) {
    updates.imagen_url = updates.imagen_url.trim();
    return null;
  }
  if (tieneFoto(fotoActual)) return mensaje;
  delete updates.imagen_url;
  return null;
}

module.exports = {
  MENSAJE_FOTO_PUBLICACION,
  MENSAJE_FOTO_NEGOCIO,
  MENSAJE_APROBAR_NEGOCIO_SIN_FOTO,
  MENSAJE_ACTIVAR_NEGOCIO_SIN_FOTO,
  MENSAJE_APROBAR_PUBLICACION_SIN_FOTO,
  tieneFoto,
  normalizarFotoEnEdicion,
};
