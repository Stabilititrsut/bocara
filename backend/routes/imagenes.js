// Acciones del restaurante sobre la mejora automática de su foto.
//   POST /api/imagenes/:tipo/:id/reintentar     (fallida o sin procesar → cola)
//   POST /api/imagenes/:tipo/:id/usar-original  (completada → descartada)
//   POST /api/imagenes/:tipo/:id/usar-mejorada  (descartada → completada)
// :tipo = publicacion (tabla bolsas) | negocio (tabla negocios).
// Solo el dueño del negocio o un admin.
// Publicaciones: "reintentar" no aplica. Su foto se valida ANTES de guardar con
// un trabajo (/trabajos, más abajo); reprocesarla aquí saltaría el análisis de
// calidad. Para otra foto, el restaurante la cambia en el formulario.
const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const pipeline = require('../services/imagenes/pipeline');
const trabajos = require('../services/imagenes/trabajos');

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

// ── Trabajos previos a publicar (services/imagenes/trabajos.js) ────────────
//   POST /api/imagenes/trabajos                { imagen_url, uso?, negocio_id? } → 202 { trabajo }
//        uso: publicacion (por defecto) | perfil | portada del restaurante
//   GET  /api/imagenes/trabajos/:id            → { trabajo }   (la app lo consulta cada ~1.5 s)
//   POST /api/imagenes/trabajos/:id/reintentar → 202 { trabajo }
async function negocioDelUsuario(usuario, negocioIdBody) {
  if (usuario.rol === 'admin') return typeof negocioIdBody === 'string' && negocioIdBody ? negocioIdBody : null;
  const { data } = await supabase.from('negocios').select('id').eq('propietario_id', usuario.id).limit(1).maybeSingle();
  return data?.id || null;
}

function responderError(res, r) {
  return res.status(r.status || 400).json({ error: r.error, ...(r.codigo ? { codigo: r.codigo } : {}) });
}

router.post('/trabajos', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });
  try {
    const negocioId = await negocioDelUsuario(req.usuario, req.body?.negocio_id);
    if (!negocioId) return res.status(400).json({ error: 'No encontramos tu negocio.' });
    const r = await trabajos.crearTrabajo({
      usuario: req.usuario, negocioId, imagenUrl: req.body?.imagen_url, uso: req.body?.uso || 'publicacion',
    });
    if (!r.ok) return responderError(res, r);
    res.status(202).json({ trabajo: trabajos.serializar(r.trabajo) });
  } catch (err) {
    console.error('[TRABAJOS_IMAGEN] crear falló: %s', err.message);
    res.status(503).json({ error: 'No se pudo iniciar el procesamiento de la foto. Intenta de nuevo.' });
  }
});

router.get('/trabajos/:id', authMiddleware, async (req, res) => {
  try {
    const r = await trabajos.leerTrabajoPropio(req.params.id, req.usuario);
    if (!r.ok) return responderError(res, r);
    res.set('Cache-Control', 'no-store');
    res.json({ trabajo: trabajos.serializar(r.trabajo) });
  } catch (err) {
    res.status(503).json({ error: 'No se pudo consultar la foto. Intenta de nuevo.' });
  }
});

router.post('/trabajos/:id/reintentar', authMiddleware, async (req, res) => {
  try {
    const r = await trabajos.reintentarTrabajo(req.params.id, req.usuario);
    if (!r.ok) return responderError(res, r);
    res.status(202).json({ trabajo: trabajos.serializar(r.trabajo) });
  } catch (err) {
    res.status(503).json({ error: 'No se pudo reintentar. Intenta de nuevo.' });
  }
});

router.post('/:tipo/:id/:accion', authMiddleware, async (req, res) => {
  const tabla = TABLA_POR_TIPO[req.params.tipo];
  const accion = ACCIONES[req.params.accion];
  if (!tabla || !accion) return res.status(404).json({ error: 'Acción no encontrada' });
  try {
    const permiso = await puedeEditar(req.usuario, tabla, req.params.id);
    if (!permiso.ok) return res.status(permiso.status).json({ error: permiso.status === 404 ? 'No encontrada' : 'No autorizado' });
    if (tabla === 'bolsas' && req.params.accion === 'reintentar') {
      return res.status(409).json({ error: 'Para reprocesar la foto de una publicación, cámbiala en el formulario de edición.', codigo: 'IMAGEN_SIN_VALIDAR' });
    }
    // Portada guardada con un trabajo de IA: volver a la original solo si
    // esta cumplía la calidad mínima (la decisión quedó en el meta al guardar).
    if (tabla === 'negocios' && req.params.accion === 'usar-original') {
      const { data: fila } = await supabase.from('negocios').select('imagen_procesamiento_meta').eq('id', req.params.id).maybeSingle();
      const meta = fila?.imagen_procesamiento_meta;
      if (meta?.trabajo_id && meta.original_aceptable !== true) {
        return res.status(409).json({ error: trabajos.CODIGOS_NEGOCIO.ORIGINAL_NO_PERMITIDA, codigo: 'ORIGINAL_NO_PERMITIDA' });
      }
    }

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
