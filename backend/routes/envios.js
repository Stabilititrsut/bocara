const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/envios/cotizar?zona=Zona+10 — cotizar costo de envío
router.get('/cotizar', async (req, res) => {
  const { zona } = req.query;
  const zonaStr = zona || '';
  const zonasBaratas = ['Zona 1','Zona 4','Zona 9','Zona 10','Zona 11','Zona 12','Zona 13'];
  const zonasMedianas = ['Zona 2','Zona 3','Zona 5','Zona 6','Zona 7','Zona 8','Zona 14','Zona 15'];
  let costo = parseFloat(process.env.DELIVERY_BASE_FEE_INTERIOR || 50);
  let tiempo = '2-3 días';
  if (zonasBaratas.includes(zonaStr)) { costo = parseFloat(process.env.DELIVERY_BASE_FEE_GTM_CITY || 15); tiempo = '1-2 horas'; }
  else if (zonasMedianas.includes(zonaStr)) { costo = parseFloat(process.env.DELIVERY_BASE_FEE_METRO || 25); tiempo = '2-4 horas'; }
  res.json({ costo, tiempo, zona: zonaStr });
});

// GET /api/envios/:pedidoId/tracking — tracking de un pedido
router.get('/:pedidoId/tracking', authMiddleware, async (req, res) => {
  const { data: pedido } = await supabase
    .from('pedidos')
    .select('id,carrier,tracking_number,tracking_url,estado,usuario_id')
    .eq('id', req.params.pedidoId)
    .single();
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.usuario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  res.json({
    carrier: pedido.carrier || 'Bocara Express',
    tracking_number: pedido.tracking_number,
    tracking_url: pedido.tracking_url,
    estado: pedido.estado,
  });
});

module.exports = router;
