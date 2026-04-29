const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// GET /api/pedidos — pedidos del cliente autenticado
router.get('/', authMiddleware, async (req, res) => {
  try {
    let { data, error } = await supabase
      .from('pedidos')
      .select('*, bolsas(id,nombre), negocios(id,nombre,zona)')
      .eq('usuario_id', req.usuario.id)
      .order('created_at', { ascending: false });
    if (error) {
      // Fallback sin joins ni order
      const r = await supabase.from('pedidos').select('*').eq('usuario_id', req.usuario.id);
      data = r.data; error = r.error;
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pedidos/restaurante — pedidos para el restaurante
router.get('/restaurante', authMiddleware, async (req, res) => {
  try {
    if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
      return res.status(403).json({ error: 'No autorizado' });
    const { data: negocio } = await supabase
      .from('negocios').select('id').eq('propietario_id', req.usuario.id).single();
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    let { data, error } = await supabase
      .from('pedidos')
      .select('*, bolsas(id,nombre), usuarios(id,nombre,telefono)')
      .eq('negocio_id', negocio.id)
      .order('created_at', { ascending: false });
    if (error) {
      const r = await supabase.from('pedidos').select('*').eq('negocio_id', negocio.id);
      data = r.data; error = r.error;
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pedidos/:id — detalle de pedido
router.get('/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('*, bolsas(*), negocios(*)')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Pedido no encontrado' });
  // Solo puede verlo el dueño o el restaurante
  if (data.usuario_id !== req.usuario.id && data.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  res.json(data);
});

// PUT /api/pedidos/:id/estado — cambiar estado (restaurante)
router.put('/:id/estado', authMiddleware, async (req, res) => {
  const { estado } = req.body;
  const estados = ['listo', 'recogido', 'cancelado'];
  if (!estados.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { data: pedido } = await supabase
    .from('pedidos')
    .select('negocio_id, negocios(propietario_id)')
    .eq('id', req.params.id)
    .single();

  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Si fue recogido, sumar puntos al usuario (+10 por pedido)
  if (estado === 'recogido') {
    await supabase.rpc('sumar_puntos', { user_id: data.usuario_id, puntos: 10 });
  }

  res.json(data);
});

module.exports = router;
