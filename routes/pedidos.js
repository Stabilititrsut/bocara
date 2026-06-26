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

// Estados que se muestran al cliente — borrador y pendiente son registros técnicos
// internos y nunca deben aparecer en la app. Un pedido solo existe para el cliente
// una vez que el pago fue confirmado y el estado es 'confirmado' o superior.
const ESTADOS_VISIBLES_CLIENTE = ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido', 'cancelado'];

// GET /api/pedidos — pedidos del cliente autenticado
router.get('/', authMiddleware, async (req, res) => {
  try {
    let { data, error } = await supabase
      .from('pedidos')
      .select('*, bolsas!bolsa_id(id,nombre), negocios!negocio_id(id,nombre,zona)')
      .eq('usuario_id', req.usuario.id)
      .in('estado', ESTADOS_VISIBLES_CLIENTE)
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('[PEDIDOS API] join failed, fallback:', error.message);
      const r = await supabase.from('pedidos').select('*')
        .eq('usuario_id', req.usuario.id)
        .in('estado', ESTADOS_VISIBLES_CLIENTE);
      data = r.data; error = r.error;
    }
    if (error) return res.status(500).json({ error: error.message });
    console.log('[PEDIDOS API] usuario:', req.usuario.id, 'rows:', data?.length, 'ids:', data?.map(p => p.id));
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
      .select('*, bolsas!bolsa_id(id,nombre), usuarios!usuario_id(id,nombre,telefono)')
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

// GET /api/pedidos/previos/:negocioId — bolsas que el usuario ya pidió en este negocio
router.get('/previos/:negocioId', authMiddleware, async (req, res) => {
  try {
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('bolsa_id')
      .eq('usuario_id', req.usuario.id)
      .eq('negocio_id', req.params.negocioId)
      .not('bolsa_id', 'is', null);

    if (!pedidos || pedidos.length === 0) return res.json([]);

    // Contar veces pedido por bolsa
    const vecesPedido = {};
    for (const p of pedidos) {
      vecesPedido[p.bolsa_id] = (vecesPedido[p.bolsa_id] || 0) + 1;
    }
    const ids = Object.keys(vecesPedido);

    const { data: bolsas } = await supabase
      .from('bolsas').select('*').in('id', ids).eq('activo', true);

    res.json((bolsas || []).map((b) => ({ ...b, veces_pedido: vecesPedido[b.id] || 1 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pedidos/resumen-cliente — estadísticas del cliente autenticado
router.get('/resumen-cliente', authMiddleware, async (req, res) => {
  try {
    const usuario_id = req.usuario.id;

    // Incluir todos los estados de pago confirmado: confirmado, en_preparacion, listo, recogido
    // y el estado legacy "completado". Excluir borrador/pendiente/cancelado.
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('id, bolsa_id, precio_bolsa')
      .eq('usuario_id', usuario_id)
      .eq('estado_pago', 'pagado')
      .not('estado', 'in', '(borrador,pendiente,cancelado)');

    if (!pedidos || pedidos.length === 0) {
      return res.json({ bolsas_rescatadas: 0, total_ahorrado: 0 });
    }

    const pedidoIds = pedidos.map(p => p.id);

    // Flujo nuevo (Cubo): items en pedido_items con FK a bolsas
    const { data: items } = await supabase
      .from('pedido_items')
      .select('pedido_id, cantidad, precio_unitario, bolsas(precio_original)')
      .in('pedido_id', pedidoIds);

    const pedidosConItems = new Set((items || []).map(i => i.pedido_id));

    // Flujo legacy: pedidos sin pedido_items — usar bolsa_id del pedido directamente
    const pedidosSinItems = pedidos.filter(p => !pedidosConItems.has(p.id));
    let bolsasLegacy = [];
    if (pedidosSinItems.length > 0) {
      const bolsaIds = [...new Set(pedidosSinItems.map(p => p.bolsa_id).filter(Boolean))];
      const { data: bData } = await supabase
        .from('bolsas').select('id, precio_original').in('id', bolsaIds);
      bolsasLegacy = bData || [];
    }
    const precioOriginalMap = {};
    for (const b of bolsasLegacy) precioOriginalMap[b.id] = parseFloat(b.precio_original || 0);

    let bolsas_rescatadas = 0;
    let total_ahorrado = 0;

    for (const item of (items || [])) {
      const cant = item.cantidad || 0;
      const precioOriginal = parseFloat(item.bolsas?.precio_original || 0);
      const precioPagado   = parseFloat(item.precio_unitario || 0);
      bolsas_rescatadas += cant;
      total_ahorrado    += (precioOriginal - precioPagado) * cant;
    }

    for (const pedido of pedidosSinItems) {
      bolsas_rescatadas += 1;
      const precioOriginal = precioOriginalMap[pedido.bolsa_id] || 0;
      const precioPagado   = parseFloat(pedido.precio_bolsa || 0);
      total_ahorrado += Math.max(0, precioOriginal - precioPagado);
    }

    res.json({
      bolsas_rescatadas,
      total_ahorrado: parseFloat(Math.max(0, total_ahorrado).toFixed(2)),
    });
  } catch (err) {
    console.error('[PEDIDOS] resumen-cliente error:', err.message);
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

// Transiciones válidas del estado de pedido
const TRANSICIONES_VALIDAS = {
  confirmado:      ['en_preparacion', 'cancelado'],
  en_preparacion:  ['listo', 'cancelado'],
  listo:           ['completado', 'cancelado'],
  completado:      [], // terminal
  recogido:        [], // terminal (legacy — datos anteriores a renombrado)
  cancelado:       [], // terminal
  pendiente:       ['confirmado', 'cancelado'], // legacy
};

// PUT /api/pedidos/:id/estado — cambiar estado (restaurante)
router.put('/:id/estado', authMiddleware, async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido', 'cancelado'];
  if (!estadosValidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const { data: pedido } = await supabase
    .from('pedidos')
    .select('estado, usuario_id, negocio_id, codigo_recogida, total, tipo_entrega, negocios(propietario_id), usuarios(expo_push_token)')
    .eq('id', req.params.id)
    .single();

  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  // Validar que la transición sea permitida
  const transicionesPermitidas = TRANSICIONES_VALIDAS[pedido.estado] || [];
  if (!transicionesPermitidas.includes(estado)) {
    return res.status(400).json({
      error: `No se puede cambiar de "${pedido.estado}" a "${estado}". Transiciones válidas: ${transicionesPermitidas.join(', ') || 'ninguna'}`,
    });
  }

  const { data, error } = await supabase
    .from('pedidos')
    .update({ estado })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const tokenCliente = pedido.usuarios?.expo_push_token;

  if (estado === 'en_preparacion') {
    await enviarNotificacionPush(tokenCliente, '👨‍🍳 Preparando tu pedido',
      `Tu pedido ${pedido.codigo_recogida} está en preparación.`,
      { pedidoId: req.params.id, screen: 'pedidos' });
    await guardarNotificacion(supabase, pedido.usuario_id, 'pedido_en_preparacion', '👨‍🍳 En preparación', `Tu pedido ${pedido.codigo_recogida} está siendo preparado.`, { pedidoId: req.params.id });
  }

  if (estado === 'listo') {
    await enviarNotificacionPush(tokenCliente, '🛍️ ¡Tu bolsa está lista!',
      `Tu pedido ${pedido.codigo_recogida} está listo para recoger.`,
      { pedidoId: req.params.id, screen: 'pedidos' });
    await guardarNotificacion(supabase, pedido.usuario_id, 'pedido_listo', '🛍️ Bolsa lista', `Tu pedido ${pedido.codigo_recogida} está listo.`, { pedidoId: req.params.id });
  }

  if (estado === 'completado' || estado === 'recogido') {
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

// PATCH /api/pedidos/:id/cancelar — solo uso admin
// El frontend no llama este endpoint (muestra botón WhatsApp al cliente).
// Las cancelaciones y devoluciones de pedidos pagados son manuales.
router.patch('/:id/cancelar', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Las cancelaciones se gestionan a través de soporte. Escríbenos al +502 5107-7949.',
      whatsapp: '+502 5107-7949',
      url_whatsapp: 'https://wa.me/50251077949',
    });
  }
  try {
    const usuario_id = req.usuario.id;

    const { data: pedido } = await supabase
      .from('pedidos')
      .select('id, estado, estado_pago, negocio_id, codigo_recogida, negocios(propietario_id)')
      .eq('id', req.params.id)
      .eq('usuario_id', usuario_id)
      .single();

    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // ── Idempotencia ──────────────────────────────────────────────────────────
    if (pedido.estado === 'cancelado')
      return res.json({ ok: true, tipo: 'ya_cancelado' });

    // ── Pedido pagado: requiere intervención manual (no hay API de reembolso) ─
    // Cubo Pago Guatemala solo expone generarLinkPago y consultarTransaccionCubo.
    // No existe endpoint de anulación/reembolso: la devolución es manual.
    if (pedido.estado_pago === 'pagado') {
      return res.status(409).json({
        ok: false,
        tipo: 'requiere_soporte',
        error: 'El pedido ya fue pagado. Comunícate con soporte para solicitar cancelación y devolución.',
        whatsapp: '+502 5107-7949',
        url_whatsapp: 'https://wa.me/50251077949',
      });
    }

    // ── Estados no cancelables automáticamente ────────────────────────────────
    const estadosNoPermitidos = ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido'];
    if (estadosNoPermitidos.includes(pedido.estado)) {
      return res.status(409).json({
        ok: false,
        tipo: 'requiere_soporte',
        error: 'El pedido ya no puede cancelarse desde la app. Comunícate con soporte al +502 5107-7949.',
        whatsapp: '+502 5107-7949',
        url_whatsapp: 'https://wa.me/50251077949',
      });
    }

    // ── Solo llega aquí: estado = 'pendiente' + estado_pago ≠ 'pagado' ────────
    if (pedido.estado !== 'pendiente') {
      return res.status(400).json({
        ok: false,
        error: `Estado inesperado "${pedido.estado}". Contáctanos al +502 5107-7949.`,
      });
    }

    const ahora = new Date().toISOString();

    // .maybeSingle() devuelve null cuando 0 filas coinciden — Supabase no genera
    // error en ese caso, por lo que es la única forma de detectar el race condition
    // en que el webhook de pago confirma el pedido entre el SELECT y este UPDATE.
    const { data: cancelado, error: cancelErr } = await supabase.from('pedidos')
      .update({ estado: 'cancelado', cancelado_por: 'cliente', cancelado_at: ahora })
      .eq('id', pedido.id)
      .eq('estado', 'pendiente')
      .neq('estado_pago', 'pagado')
      .select('id')
      .maybeSingle();

    let cancelConfirmado = cancelado;

    if (cancelErr) {
      // Las columnas de auditoría aún no existen — fallback sin ellas, igual con .maybeSingle()
      const { data: cancelado2, error: cancelErr2 } = await supabase.from('pedidos')
        .update({ estado: 'cancelado' })
        .eq('id', pedido.id)
        .eq('estado', 'pendiente')
        .neq('estado_pago', 'pagado')
        .select('id')
        .maybeSingle();
      if (cancelErr2) return res.status(500).json({ error: cancelErr2.message });
      cancelConfirmado = cancelado2;
    }

    // 0 filas coincidieron: el pedido fue pagado o modificado justo antes del UPDATE
    if (!cancelConfirmado) {
      return res.status(409).json({
        ok: false,
        tipo: 'requiere_soporte',
        error: 'El pedido cambió de estado o ya fue pagado. Comunícate con soporte al +502 5107-7949.',
        whatsapp: '+502 5107-7949',
        url_whatsapp: 'https://wa.me/50251077949',
      });
    }

    // Fila confirmada como cancelada — ahora liberamos recursos
    supabase.rpc('liberar_reserva_cupon', { p_pedido_id: pedido.id })
      .then(({ error: rpcErr }) => { if (rpcErr) console.warn('[CANCELAR] liberar_reserva_cupon:', rpcErr.message); })
      .catch(err => console.warn('[CANCELAR] liberar_reserva_cupon network:', err.message));

    const propietario_id = pedido.negocios?.propietario_id;
    if (propietario_id) {
      guardarNotificacion(supabase, propietario_id, 'pedido_cancelado', '❌ Pedido cancelado',
        `El cliente canceló el pedido ${pedido.codigo_recogida} (pendiente de pago)`, { pedidoId: pedido.id })
        .catch(err => console.warn('[CANCELAR] guardarNotificacion:', err.message));
    }

    res.json({ ok: true, tipo: 'cancelado_automaticamente', mensaje: 'Pedido cancelado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pedidos/:id/factura — guarda datos de facturación (NIT o CF)
router.post('/:id/factura', authMiddleware, async (req, res) => {
  try {
    const { tipo, nit, nombre_fiscal } = req.body;
    const { data: pedido } = await supabase
      .from('pedidos').select('usuario_id').eq('id', req.params.id).single();
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.usuario_id !== req.usuario.id && req.usuario.rol !== 'admin')
      return res.status(403).json({ error: 'No autorizado' });

    const facturaData = {
      factura_nit:          tipo === 'nit' ? (nit || '') : 'CF',
      factura_nombre:       tipo === 'nit' ? (nombre_fiscal || '') : 'Consumidor Final',
      factura_tipo:         tipo || 'cf',
      factura_generada_en:  new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('pedidos').update(facturaData).eq('id', req.params.id).select().single();

    if (error) {
      console.warn('[FACTURA] columnas no disponibles aún:', error.message);
      return res.json({ success: true, pendiente_migracion: true });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
