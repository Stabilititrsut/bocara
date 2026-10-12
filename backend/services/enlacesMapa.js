// Enlaces de navegación del negocio (negocios.google_maps_url / waze_url).
//
// Regla (ver POST /api/bolsas en routes/bolsas.js): un negocio no puede crear
// publicaciones nuevas sin los dos enlaces — el cliente que paga tiene que
// poder llegar a recoger. Editar u ocultar publicaciones existentes no se
// bloquea. null, undefined, '' y solo espacios no cuentan como enlace.

const MENSAJE_ENLACES_MAPA = 'Debes configurar los enlaces de Google Maps y Waze de tu negocio antes de publicar';

function tieneTexto(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function tieneEnlacesMapa(negocio) {
  return tieneTexto(negocio?.google_maps_url) && tieneTexto(negocio?.waze_url);
}

module.exports = {
  MENSAJE_ENLACES_MAPA,
  tieneEnlacesMapa,
};
