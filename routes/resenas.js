const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/resenas/:negocio_id — reseñas de un negocio
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
router.post('/', authMiddleware, async (req, res) => {
  const { pedido_id, negocio_id, calificacion, comentario } = req.body;
  if (!negocio_id || !calificacion) return res.status(400).json({ error: 'negocio_id y calificacion requeridos' });
  if (calificacion < 1 || calificacion > 5) return res.status(400).json({ error: 'Calificación debe ser 1-5' });

  // Verificar que el usuario tiene un pedido recogido en ese negocio
  if (pedido_id) {
    const { data: pedido } = await supabase
      .from('pedidos')
      .select('id')
      .eq('id', pedido_id)
      .eq('usuario_id', req.usuario.id)
      .eq('negocio_id', negocio_id)
      .single();
    if (!pedido) return res.status(403).json({ error: 'Solo puedes reseñar negocios donde hayas comprado' });
  }

  const { data, error } = await supabase
    .from('resenas')
    .insert([{ pedido_id, negocio_id, usuario_id: req.usuario.id, calificacion, comentario }])
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
