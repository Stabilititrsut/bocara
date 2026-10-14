// Acciones del restaurante sobre la mejora automática de su foto.
//   POST /api/imagenes/:tipo/:id/reintentar     (fallida o sin procesar → cola)
//   POST /api/imagenes/:tipo/:id/usar-original  (completada → descartada)
//   POST /api/imagenes/:tipo/:id/usar-mejorada  (descartada → completada)
// :tipo = publicacion (tabla bolsas) | negocio (tabla negocios).
// Solo el dueño del negocio o un admin.
const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const pipeline = require('../services/imagenes/pipeline');

const router = express.Router();
const TABLA_POR_TIPO = { publicacion: 'bolsas', negocio: 'negocios' };
const ACCIONES = {
  reintentar: pipeline.reintentar,
  'usar-original': pipeline.usarOriginal,
  'usar-mejorada': pipeline.usarMejorada,
};

async function puedeEditar(usuario, tabla, id) {
  if (usuario.rol === 'admin') return { ok: true };
  if (usuario.rol !== 'restaurante') return { ok: false, status: 403 };
  const negocioId = tabla === 'negocios'
    ? id
    : (await supabase.from('bolsas').select('negocio_id').eq('id', id).maybeSingle()).data?.negocio_id;
  if (!negocioId) return { ok: false, status: 404 };
  const { data: negocio } = await supabase.from('negocios').select('propietario_id').eq('id', negocioId).maybeSingle();
  if (!negocio) return { ok: false, status: 404 };
  return negocio.propietario_id === usuario.id ? { ok: true } : { ok: false, status: 403 };
}

router.post('/:tipo/:id/:accion', authMiddleware, async (req, res) => {
  const tabla = TABLA_POR_TIPO[req.params.tipo];
  const accion = ACCIONES[req.params.accion];
  if (!tabla || !accion) return res.status(404).json({ error: 'Acción no encontrada' });
  try {
    const permiso = await puedeEditar(req.usuario, tabla, req.params.id);
    if (!permiso.ok) return res.status(permiso.status).json({ error: permiso.status === 404 ? 'No encontrada' : 'No autorizado' });

    const r = await accion(tabla, req.params.id);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    // Reintentar: además del job periódico, se intenta ya mismo.
    if (req.params.accion === 'reintentar') {
      pipeline.procesarFila(tabla, req.params.id).catch((err) => console.warn('[IMAGENES] reintento inmediato:', err.message));
    }
    const { data } = await supabase.from(tabla)
      .select('id, imagen_url, imagen_original_url, imagen_mejorada_url, estado_procesamiento_imagen, error_procesamiento_imagen')
      .eq('id', req.params.id).maybeSingle();
    res.json({ ok: true, imagen: data });
  } catch (err) {
    console.error('[IMAGENES] acción %s falló: %s', req.params.accion, err.message);
    res.status(503).json({ error: 'No se pudo completar la acción. Intenta de nuevo.' });
  }
});

module.exports = router;
