const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

const TIPOS_RESTAURANTE = [
  'negocio_aprobado','negocio_rechazado','negocio_suspendido',
  'bolsa_aprobada','bolsa_rechazada','bolsa_cambios_solicitados','nuevo_pedido','pedido_en_preparacion',
  'pedido_listo','liquidacion','liquidacion_pagada','perfil_aprobado','perfil_rechazado',
];

// GET /api/notificaciones
router.get('/', authMiddleware, async (req, res) => {
  let query = supabase
    .from('notificaciones')
    .select('*')
    .eq('usuario_id', req.usuario.id)
    .order('creado_en', { ascending: false })
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

// Formato que devuelve getExpoPushTokenAsync: ExponentPushToken[…] / ExpoPushToken[…].
const TOKEN_EXPO_REGEX = /^Expo(nent)?PushToken\[[^\]\s]{1,200}\]$/;

// POST /api/notificaciones/token — guardar/actualizar expo push token
//
// Un token identifica un DISPOSITIVO, no una cuenta. Si otra cuenta lo tenía
// (mismo teléfono, otra sesión), se le quita antes de asignarlo: si no, los
// push de la cuenta anterior seguirían llegando a este dispositivo.
router.post('/token', authMiddleware, async (req, res) => {
  const { expo_push_token } = req.body || {};
  if (typeof expo_push_token !== 'string' || !TOKEN_EXPO_REGEX.test(expo_push_token)) {
    return res.status(400).json({ error: 'expo_push_token inválido', code: 'TOKEN_INVALIDO' });
  }

  const { error: limpiarErr } = await supabase.from('usuarios')
    .update({ expo_push_token: null })
    .eq('expo_push_token', expo_push_token)
    .neq('id', req.usuario.id);
  if (limpiarErr) return res.status(503).json({ error: 'No se pudo registrar el dispositivo. Intenta de nuevo.' });

  const { error } = await supabase.from('usuarios').update({ expo_push_token })
    .eq('id', req.usuario.id);
  if (error) return res.status(503).json({ error: 'No se pudo registrar el dispositivo. Intenta de nuevo.' });
  res.json({ ok: true });
});

// DELETE /api/notificaciones/token — desvincular el dispositivo (logout).
//
// Body opcional { expo_push_token }: si viene, solo se borra cuando coincide
// con el guardado. Así cerrar sesión en un teléfono viejo no le quita el push
// al teléfono que registró la cuenta después. Idempotente.
router.delete('/token', authMiddleware, async (req, res) => {
  const token = req.body?.expo_push_token;
  if (token !== undefined && typeof token !== 'string') {
    return res.status(400).json({ error: 'expo_push_token inválido', code: 'TOKEN_INVALIDO' });
  }
  let query = supabase.from('usuarios').update({ expo_push_token: null }).eq('id', req.usuario.id);
  if (token) query = query.eq('expo_push_token', token);
  const { error } = await query;
  if (error) return res.status(503).json({ error: 'No se pudo desvincular el dispositivo. Intenta de nuevo.' });
  res.json({ ok: true });
});

module.exports = router;
