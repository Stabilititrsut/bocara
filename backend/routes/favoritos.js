const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// SQL a ejecutar en Supabase si la tabla no existe o necesita migración:
console.log(`
[FAVORITOS] SQL requerido en Supabase (ejecutar si la tabla no existe):
  CREATE TABLE IF NOT EXISTS favoritos (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_id  uuid NOT NULL,
    tipo        text NOT NULL CHECK (tipo IN ('negocio','bolsa')),
    referencia_id uuid NOT NULL,
    created_at  timestamp DEFAULT now(),
    UNIQUE(usuario_id, tipo, referencia_id)
  );
`);

// GET /api/favoritos/negocios — negocios favoritos del usuario
router.get('/negocios', authMiddleware, async (req, res) => {
  console.log('[FAV] GET /negocios usuario:', req.usuario?.id);
  const { data: favs, error } = await supabase
    .from('favoritos')
    .select('referencia_id')
    .eq('usuario_id', req.usuario.id)
    .eq('tipo', 'negocio');
  if (error) return res.status(500).json({ error: error.message });
  if (!favs?.length) return res.json([]);
  const ids = favs.map(f => f.referencia_id);
  const { data: negocios, error: err2 } = await supabase
    .from('negocios')
    .select('id, nombre, categoria, zona, imagen_url, calificacion_promedio')
    .in('id', ids);
  if (err2) return res.status(500).json({ error: err2.message });
  res.json(negocios || []);
});

// GET /api/favoritos/bolsas — bolsas favoritas del usuario
router.get('/bolsas', authMiddleware, async (req, res) => {
  console.log('[FAV] GET /bolsas usuario:', req.usuario?.id);
  const { data: favs, error } = await supabase
    .from('favoritos')
    .select('referencia_id')
    .eq('usuario_id', req.usuario.id)
    .eq('tipo', 'bolsa');
  if (error) return res.status(500).json({ error: error.message });
  if (!favs?.length) return res.json([]);
  const ids = favs.map(f => f.referencia_id);
  const { data: bolsas, error: err2 } = await supabase
    .from('bolsas')
    .select('*, negocios(id, nombre, imagen_url)')
    .in('id', ids);
  if (err2) return res.status(500).json({ error: err2.message });
  res.json(bolsas || []);
});

// GET /api/favoritos/check/:tipo/:referenciaId
router.get('/check/:tipo/:referenciaId', authMiddleware, async (req, res) => {
  console.log('[FAV] GET /check', req.params.tipo, req.params.referenciaId, 'usuario:', req.usuario?.id);
  const { data } = await supabase
    .from('favoritos')
    .select('id')
    .eq('usuario_id', req.usuario.id)
    .eq('tipo', req.params.tipo)
    .eq('referencia_id', req.params.referenciaId)
    .single();
  res.json({ esFavorito: !!data });
});

// POST /api/favoritos — agrega favorito
router.post('/', authMiddleware, async (req, res) => {
  console.log('[FAV] POST /favoritos body:', req.body, 'usuario:', req.usuario?.id);
  const { tipo, referencia_id } = req.body;
  const usuario_id = req.usuario.id;
  if (!tipo || !referencia_id)
    return res.status(400).json({ error: 'Faltan campos: tipo y referencia_id' });
  const { error } = await supabase
    .from('favoritos')
    .upsert({ usuario_id, tipo, referencia_id }, { onConflict: 'usuario_id,tipo,referencia_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// DELETE /api/favoritos/:referenciaId?tipo=negocio|bolsa
router.delete('/:referenciaId', authMiddleware, async (req, res) => {
  const usuario_id = req.usuario.id;
  const { referenciaId } = req.params;
  const tipo = req.query.tipo;
  console.log('[FAV] DELETE /favoritos', referenciaId, 'tipo:', tipo, 'usuario:', usuario_id);
  if (!tipo) return res.status(400).json({ error: 'Falta query param tipo' });
  const { error } = await supabase
    .from('favoritos')
    .delete()
    .eq('usuario_id', usuario_id)
    .eq('referencia_id', referenciaId)
    .eq('tipo', tipo);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
