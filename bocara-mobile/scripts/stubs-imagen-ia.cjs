// Dobles de la foto con IA para los arneses que montan restaurante/bolsas.tsx
// (test-cart, test-ciclo-publicaciones, test-formularios-negocio,
// test-foto-obligatoria). Esas pruebas cubren otras reglas (payload, doble
// envío, horario...), así que la foto se da por validada ("lista").
// La regla de la foto en sí se prueba en scripts/test-proceso-imagen.cjs.
const TRABAJO_LISTO = Object.freeze({
  id: 'trabajo-prueba', estado: 'lista', original_url: 'https://cdn.bocara.test/foto.jpg',
  mejorada_url: 'https://cdn.bocara.test/foto.jpg', motivos: [], error_codigo: null, error: null, detalle: null, puede_reintentar: false,
});

module.exports = () => ({
  '@/components/EstadoProcesoImagen': { __esModule: true, default: () => null },
  // Foto de perfil / portada del restaurante: elemento inerte con sus props
  // (su flujo con IA se prueba en scripts/test-proceso-imagen.cjs).
  '@/components/ImagenNegocioIA': { __esModule: true, default: 'ImagenNegocioIA' },
  '@/hooks/use-trabajo-imagen': {
    useTrabajoImagen: () => ({ trabajo: TRABAJO_LISTO, error: null, errorRed: false, iniciar() {}, reintentar() {}, reiniciar() {} }),
  },
  '@/src/utils/procesoImagen': {
    bloqueoPorFoto: () => null,
    trabajoDeLaFoto: (t) => t,
    esFotoNueva: () => false,
    bolsaConImagenValidada: () => true,
    BLOQUEOS: { sinValidar: 'sin validar' },
  },
});
module.exports.TRABAJO_LISTO = TRABAJO_LISTO;
