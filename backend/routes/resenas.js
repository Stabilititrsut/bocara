const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { validarCalificacion, validarComentario, validarRespuesta, esDuplicado } = require('../services/resenas');
const router = express.Router();

const MENSAJE_DUPLICADA = 'Ya calificaste este pedido';

// GET /api/resenas/mis-resenas — reseñas del cliente autenticado (incluye
// las ocultas por moderación: son suyas y debe poder ver su estado)
router.get('/mis-resenas', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('resenas')
    .select('*, negocios(nombre,imagen_url)')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/resenas/restaurante — reseñas recibidas del restaurante autenticado.
// Un admin debe indicar ?negocio_id= (antes pasaba el chequeo de rol y luego
// respondía 404 porque buscaba un negocio del que él fuera propietario).
router.get('/restaurante', authMiddleware, async (req, res) => {
  let negocioId = null;
  if (req.usuario.rol === 'admin' && await authMiddleware.esAdminReal(req.usuario.id)) {
    negocioId = req.query.negocio_id || null;
    if (!negocioId) return res.status(400).json({ error: 'negocio_id es requerido para administradores' });
  } else if (req.usuario.rol === 'restaurante') {
    const { data: negocio } = await supabase
      .from('negocios').select('id').eq('propietario_id', req.usuario.id).maybeSingle();
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    negocioId = negocio.id;
  } else {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { data, error } = await supabase
    .from('resenas')
    .select('*, usuarios(nombre)')
    .eq('negocio_id', negocioId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/resenas/:negocio_id — reseñas de un negocio (público, solo visibles)
router.get('/:negocio_id', async (req, res) => {
  const { data, error } = await supabase
    .from('resenas')
    .select('id,negocio_id,calificacion,comentario,respuesta_restaurante,respondida_en,created_at,usuarios(nombre)')
    .eq('negocio_id', req.params.negocio_id)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/resenas — crear reseña verificada
// Requisitos: pedido del usuario, de ese negocio y ya entregado; una por pedido.
// El promedio del negocio lo recalcula el trigger de la base (no aquí).
router.post('/', authMiddleware, async (req, res) => {
  const { pedido_id, negocio_id } = req.body || {};
  if (!pedido_id || !negocio_id || req.body?.calificacion == null)
    return res.status(400).json({ error: 'pedido_id, negocio_id y calificacion son requeridos' });

  const calificacion = validarCalificacion(req.body.calificacion);
  if (calificacion.error) return res.status(400).json({ error: calificacion.error });
  const comentario = validarComentario(req.body.comentario);
  if (comentario.error) return res.status(400).json({ error: comentario.error });

  // Verificar que el pedido es del usuario, del negocio, y ya fue recogido
  const { data: pedido } = await supabase
    .from('pedidos')
    .select('id, bolsa_id, estado')
    .eq('id', pedido_id)
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', negocio_id)
    .in('estado', ['completado', 'recogido'])
    .maybeSingle();

  if (!pedido)
    return res.status(403).json({ error: 'Solo puedes reseñar pedidos que hayas recogido en este negocio' });

  const { data: previa } = await supabase
    .from('resenas').select('id').eq('pedido_id', pedido_id).maybeSingle();
  if (previa) return res.status(409).json({ error: MENSAJE_DUPLICADA, resena_id: previa.id });

  const { data, error } = await supabase
    .from('resenas')
    .insert([{
      pedido_id,
      negocio_id,
      usuario_id: req.usuario.id,
      calificacion: calificacion.valor,
      comentario: comentario.valor,
    }])
    .select()
    .single();

  // UNIQUE(pedido_id) cubre la carrera entre la verificación previa y el insert
  if (esDuplicado(error)) return res.status(409).json({ error: MENSAJE_DUPLICADA });
  if (error) return res.status(400).json({ error: error.message });

  res.status(201).json(data);
});

// PATCH /api/resenas/:id/respuesta — el comercio responde una reseña suya
router.patch('/:id/respuesta', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'restaurante')
    return res.status(403).json({ error: 'Solo el comercio puede responder reseñas' });
  const respuesta = validarRespuesta(req.body?.respuesta);
  if (respuesta.error) return res.status(400).json({ error: respuesta.error });

  const { data: negocio } = await supabase
    .from('negocios').select('id').eq('propietario_id', req.usuario.id).maybeSingle();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

  // 404 (no 403) si la reseña es de otro negocio: no revela que existe
  const { data: resena } = await supabase
    .from('resenas').select('id,negocio_id').eq('id', req.params.id).maybeSingle();
  if (!resena || resena.negocio_id !== negocio.id)
    return res.status(404).json({ error: 'Reseña no encontrada' });

  const { data, error } = await supabase
    .from('resenas')
    .update({ respuesta_restaurante: respuesta.valor, respondida_en: new Date().toISOString() })
    .eq('id', resena.id)
    .eq('negocio_id', negocio.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
