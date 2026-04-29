const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// POST /api/pedidos/crear — confirmar pedido directamente (sin Stripe)
router.post('/crear', authMiddleware, async (req, res) => {
  try {
    const { bolsa_id, tipo_entrega, direccion_envio } = req.body;
    if (!bolsa_id) return res.status(400).json({ error: 'bolsa_id requerido' });

    const { data: bolsa, error: bolsaErr } = await supabase
      .from('bolsas')
      .select('*, negocios(id,nombre)')
      .eq('id', bolsa_id)
      .single();
    if (bolsaErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
    if (bolsa.cantidad_disponible < 1) return res.status(400).json({ error: 'Bolsa agotada' });

    // Código único: BOC- + 6 chars alfanuméricos sin caracteres confusos
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codigoRecogida = 'BOC-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');

    const costoEnvio = tipo_entrega === 'envio' ? 25 : 0;
    const total = bolsa.precio_descuento + costoEnvio;

    const insertData = {
      usuario_id: req.usuario.id,
      bolsa_id,
      negocio_id: bolsa.negocios.id,
      estado: 'confirmado',
      estado_pago: 'pagado',
      codigo_recogida: codigoRecogida,
      total,
      costo_envio: costoEnvio,
      comision_bocara: 0,
      precio_bolsa: bolsa.precio_descuento,
      hora_recogida_inicio: bolsa.hora_recogida_inicio,
      hora_recogida_fin: bolsa.hora_recogida_fin,
    };
    if (tipo_entrega) insertData.tipo_entrega = tipo_entrega;
    if (tipo_entrega === 'envio' && direccion_envio) insertData.direccion_envio = direccion_envio;

    const { data: pedido, error } = await supabase
      .from('pedidos').insert([insertData]).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Decrementar cantidad disponible
    await supabase.from('bolsas')
      .update({ cantidad_disponible: bolsa.cantidad_disponible - 1 })
      .eq('id', bolsa_id);

    res.status(201).json({ pedidoId: pedido.id, codigoRecogida, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
