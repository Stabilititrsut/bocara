const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/notificaciones
router.get('/', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('notificaciones')
    .select('*')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false })
    .limit(30);
  res.json(data || []);
});

// PUT /api/notificaciones/:id/leer
router.put('/:id/leer', authMiddleware, async (req, res) => {
  await supabase.from('notificaciones').update({ leida: true })
    .eq('id', req.params.id).eq('usuario_id', req.usuario.id);
  res.json({ ok: true });
});

// POST /api/notificaciones/token — guardar/actualizar expo push token
router.post('/token', authMiddleware, async (req, res) => {
  const { expo_push_token } = req.body;
  if (!expo_push_token) return res.status(400).json({ error: 'token requerido' });
  await supabase.from('usuarios').update({ expo_push_token })
    .eq('id', req.usuario.id);
  res.json({ ok: true });
});

module.exports = router;
