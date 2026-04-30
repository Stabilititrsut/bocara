const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const router = express.Router();

// POST /api/pedidos/crear — confirmar pedido directamente (sin pasarela de pago)
router.post('/crear', authMiddleware, async (req, res) => {
  try {
    const { bolsa_id, tipo_entrega, direccion_envio } = req.body;
    if (!bolsa_id) return res.status(400).json({ error: 'bolsa_id requerido' });

    const { data: bolsa, error: bolsaErr } = await supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,propietario_id)')
      .eq('id', bolsa_id)
      .single();
    if (bolsaErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
    if (bolsa.cantidad_disponible < 1) return res.status(400).json({ error: 'Bolsa agotada' });

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codigoRecogida = 'BOC-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');

    const costoEnvio = tipo_entrega === 'envio' ? 25 : 0;
    const precioBolsa = bolsa.precio_descuento;
    const total = precioBolsa + costoEnvio;
    const comisionBocara = Math.round(precioBolsa * 0.25 * 100) / 100;
    const montoNetoRestaurante = Math.round((precioBolsa - comisionBocara) * 100) / 100;

    const insertData = {
      usuario_id: req.usuario.id,
      bolsa_id,
      negocio_id: bolsa.negocios.id,
      estado: 'confirmado',
      estado_pago: 'pagado',
      codigo_recogida: codigoRecogida,
      total,
      costo_envio: costoEnvio,
      precio_bolsa: precioBolsa,
      comision_bocara: comisionBocara,
      comision_pasarela: 0,
      monto_neto_restaurante: montoNetoRestaurante,
      hora_recogida_inicio: bolsa.hora_recogida_inicio,
      hora_recogida_fin: bolsa.hora_recogida_fin,
    };
    if (tipo_entrega) insertData.tipo_entrega = tipo_entrega;
    if (tipo_entrega === 'envio' && direccion_envio) insertData.direccion_envio = direccion_envio;

    const { data: pedido, error } = await supabase
      .from('pedidos').insert([insertData]).select().single();
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('bolsas')
      .update({ cantidad_disponible: bolsa.cantidad_disponible - 1 })
      .eq('id', bolsa_id);

    // Push al restaurante
    const { data: propietario } = await supabase
      .from('usuarios').select('expo_push_token').eq('id', bolsa.negocios.propietario_id).single();
    const mensajeRest = `Pedido ${codigoRecogida} — Q${total}`;
    await enviarNotificacionPush(propietario?.expo_push_token, '🛍️ Nuevo pedido', mensajeRest, { pedidoId: pedido.id, screen: 'restaurante' });
    await guardarNotificacion(supabase, bolsa.negocios.propietario_id, 'nuevo_pedido', '🛍️ Nuevo pedido', mensajeRest, { pedidoId: pedido.id });

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
  if (data.usuario_id !== req.usuario.id && data.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  res.json(data);
});

// PUT /api/pedidos/:id/estado — cambiar estado (restaurante)
router.put('/:id/estado', authMiddleware, async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['listo', 'recogido', 'cancelado'];
  if (!estadosValidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { data: pedido } = await supabase
    .from('pedidos')
    .select('usuario_id, negocio_id, codigo_recogida, total, tipo_entrega, negocios(propietario_id), usuarios(expo_push_token)')
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

  const tokenCliente = pedido.usuarios?.expo_push_token;

  if (estado === 'listo') {
    await enviarNotificacionPush(tokenCliente, '🛍️ ¡Tu bolsa está lista!',
      `Tu pedido ${pedido.codigo_recogida} está listo para recoger.`,
      { pedidoId: req.params.id, screen: 'pedidos' });
    await guardarNotificacion(supabase, pedido.usuario_id, 'pedido_listo', '🛍️ Bolsa lista', `Tu pedido ${pedido.codigo_recogida} está listo.`, { pedidoId: req.params.id });
  }

  if (estado === 'recogido') {
    try {
      const { data: cfg } = await supabase.from('configuracion').select('valor').eq('clave', 'puntos_por_pedido').single();
      const puntos = cfg ? parseInt(cfg.valor) : 10;
      await supabase.rpc('sumar_puntos', { user_id: pedido.usuario_id, puntos });
    } catch { }

    await enviarNotificacionPush(tokenCliente, '⭐ ¡Bolsa rescatada!',
      `¡Gracias por rescatar tu bolsa! Ganaste puntos Bocara.`,
      { pedidoId: req.params.id, screen: 'pedidos' });
    await guardarNotificacion(supabase, pedido.usuario_id, 'bolsa_recogida', '⭐ ¡Bolsa rescatada!', 'Ganaste puntos por rescatar comida.', { pedidoId: req.params.id });
  }

  res.json(data);
});

module.exports = router;
