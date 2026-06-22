const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

const TIPOS_RESTAURANTE = [
  'negocio_aprobado','negocio_rechazado','negocio_suspendido',
  'bolsa_aprobada','bolsa_rechazada','nuevo_pedido','pedido_en_preparacion',
  'pedido_listo','liquidacion','liquidacion_pagada','perfil_aprobado','perfil_rechazado',
];

// GET /api/notificaciones
router.get('/', authMiddleware, async (req, res) => {
  let query = supabase
    .from('notificaciones')
    .select('*')
    .eq('usuario_id', req.usuario.id)
    .order('created_at', { ascending: false })
    .limit(50);

  // BUG 4: Filtrar por tipos relevantes según rol
  if (req.usuario.rol === 'restaurante') {
    query = query.in('tipo', TIPOS_RESTAURANTE);
  }

  let { data, error } = await query;
  if (error) {
    // Fallback sin filtros adicionales
    const r = await supabase.from('notificaciones').select('*').eq('usuario_id', req.usuario.id).limit(50);
    data = r.data;
  }
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
