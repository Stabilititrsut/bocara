const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/resenas/mis-resenas — reseñas del cliente autenticado
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

// GET /api/resenas/restaurante — reseñas recibidas del restaurante autenticado
router.get('/restaurante', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  const { data: negocio } = await supabase
    .from('negocios').select('id').eq('propietario_id', req.usuario.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { data, error } = await supabase
    .from('resenas')
    .select('*, usuarios(nombre)')
    .eq('negocio_id', negocio.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/resenas/:negocio_id — reseñas de un negocio (público)
router.get('/:negocio_id', async (req, res) => {
  const { data, error } = await supabase
    .from('resenas')
    .select('*, usuarios(nombre)')
    .eq('negocio_id', req.params.negocio_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/resenas — crear reseña
// Requisitos: pedido_id obligatorio, pedido debe ser recogido y pertenecer al usuario
router.post('/', authMiddleware, async (req, res) => {
  const { pedido_id, negocio_id, calificacion, comentario } = req.body;

  if (!pedido_id || !negocio_id || !calificacion)
    return res.status(400).json({ error: 'pedido_id, negocio_id y calificacion son requeridos' });
  if (calificacion < 1 || calificacion > 5)
    return res.status(400).json({ error: 'Calificación debe ser entre 1 y 5' });

  // Verificar que el pedido es del usuario, del negocio, y ya fue recogido
  const { data: pedido } = await supabase
    .from('pedidos')
    .select('id, bolsa_id, estado')
    .eq('id', pedido_id)
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', negocio_id)
    .eq('estado', 'recogido')
    .single();

  if (!pedido)
    return res.status(403).json({ error: 'Solo puedes reseñar pedidos que hayas recogido en este negocio' });

  const { data, error } = await supabase
    .from('resenas')
    .insert([{
      pedido_id,
      negocio_id,
      bolsa_id: pedido.bolsa_id || null,
      usuario_id: req.usuario.id,
      calificacion,
      comentario,
    }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Actualizar calificación promedio del negocio
  const { data: todasResenas } = await supabase
    .from('resenas').select('calificacion').eq('negocio_id', negocio_id);
  if (todasResenas?.length) {
    const prom = todasResenas.reduce((s, r) => s + r.calificacion, 0) / todasResenas.length;
    await supabase.from('negocios').update({
      calificacion_promedio: Math.round(prom * 10) / 10,
      total_resenas: todasResenas.length,
    }).eq('id', negocio_id);
  }

  res.status(201).json(data);
});

module.exports = router;
