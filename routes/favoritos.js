const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/favoritos
router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('favoritos')
    .select('*, negocios(id,nombre,imagen_url,categoria,zona,calificacion_promedio,verificado,activo)')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/favoritos/check/:negocio_id
router.get('/check/:negocio_id', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('favoritos')
    .select('id')
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', req.params.negocio_id)
    .single();
  res.json({ esFavorito: !!data });
});

// POST /api/favoritos
router.post('/', authMiddleware, async (req, res) => {
  const { negocio_id } = req.body;
  if (!negocio_id) return res.status(400).json({ error: 'negocio_id requerido' });
  const { data, error } = await supabase
    .from('favoritos')
    .upsert([{ usuario_id: req.usuario.id, negocio_id }], { onConflict: 'usuario_id,negocio_id' })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /api/favoritos/:negocio_id
router.delete('/:negocio_id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('favoritos')
    .delete()
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', req.params.negocio_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
