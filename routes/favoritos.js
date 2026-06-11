const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/favoritos  —  lista negocios favoritos del usuario
router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('favoritos')
    .select('*, negocios(id,nombre,imagen_url,categoria,zona,calificacion_promedio,verificado,activo)')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/favoritos/negocios  —  alias explícito
router.get('/negocios', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('favoritos')
    .select('*, negocios(id,nombre,imagen_url,categoria,zona,calificacion_promedio,verificado,activo)')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/favoritos/bolsas  —  lista bolsas favoritas con datos completos
router.get('/bolsas', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('favoritos')
    .select('bolsa_id, bolsas(*, negocios(id,nombre,imagen_url))')
    .eq('usuario_id', req.usuario.id)
    .not('bolsa_id', 'is', null)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const bolsas = (data || []).map(f => f.bolsas).filter(Boolean);
  res.json(bolsas);
});

// GET /api/favoritos/check/:negocio_id
router.get('/check/:negocio_id', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('favoritos')
    .select('id')
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', req.params.negocio_id)
    .single();
  res.json({ es_favorito: !!data });
});

// GET /api/favoritos/check-bolsa/:bolsa_id
router.get('/check-bolsa/:bolsa_id', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('favoritos')
    .select('id')
    .eq('usuario_id', req.usuario.id)
    .eq('bolsa_id', req.params.bolsa_id)
    .single();
  res.json({ es_favorito: !!data });
});

// POST /api/favoritos  —  acepta negocio_id o bolsa_id
router.post('/', authMiddleware, async (req, res) => {
  const { negocio_id, bolsa_id } = req.body;
  if (!negocio_id && !bolsa_id) return res.status(400).json({ error: 'negocio_id o bolsa_id requerido' });

  const registro = { usuario_id: req.usuario.id };
  const conflicto = negocio_id
    ? 'usuario_id,negocio_id'
    : 'usuario_id,bolsa_id';

  if (negocio_id) registro.negocio_id = negocio_id;
  if (bolsa_id)   registro.bolsa_id   = bolsa_id;

  const { data, error } = await supabase
    .from('favoritos')
    .upsert([registro], { onConflict: conflicto })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /api/favoritos/:negocio_id  —  elimina favorito de negocio
router.delete('/:negocio_id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('favoritos')
    .delete()
    .eq('usuario_id', req.usuario.id)
    .eq('negocio_id', req.params.negocio_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// DELETE /api/favoritos/bolsa/:bolsa_id  —  elimina favorito de bolsa
router.delete('/bolsa/:bolsa_id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('favoritos')
    .delete()
    .eq('usuario_id', req.usuario.id)
    .eq('bolsa_id', req.params.bolsa_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
