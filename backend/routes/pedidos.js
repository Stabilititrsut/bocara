const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const soloCliente = require('../middleware/soloCliente');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { validarTransicion, esEstadoValido, ESTADOS_ENTREGADOS } = require('../services/orderStateMachine');
const { liberarInventarioPedido } = require('../services/stock');
const { impactoDePedidos } = require('../services/impactoAmbiental');
const router = express.Router();

// Ruta heredada retirada: ningún cliente puede crear un pedido pagado sin una
// confirmación verificable de Cubo. Se mantiene el 410 para versiones antiguas.
router.post('/crear', authMiddleware, soloCliente, (_req, res) => {
  res.status(410).json({ error: 'Este flujo fue retirado. Realiza el pago mediante Cubo.' });
});

// Estados que se muestran al cliente — borrador y pendiente son registros técnicos
// internos y nunca deben aparecer en la app. Un pedido solo existe para el cliente
// una vez que el pago fue confirmado y el estado es 'confirmado' o superior.
const ESTADOS_VISIBLES_CLIENTE = ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido', 'cancelado'];

// estado_pago='pagado' por sí solo no basta: /pedidos/crear (sin pasarela) y el
// webhook legacy de PayU también lo escriben, sin ninguna verificación real de
// que el dinero se haya movido. cubo_payment_intent_token Y cubo_identifier
// SOLO se escriben juntos dentro de la RPC confirmar_pago_cubo (sql/cubo-pago-
// schema.sql), y solo después de que el webhook consultó a Cubo de forma
// independiente y confirmó SUCCEEDED — es la única prueba confiable de un pago
// real. Un filtro por separado en vez de .or() porque Supabase-js no encadena
// bien .not() dentro de .or() con múltiples condiciones is-null.
function filtrarSoloPagosCuboVerificados(query) {
  return query
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null);
}

// GET /api/pedidos — pedidos del cliente autenticado
router.get('/', authMiddleware, async (req, res) => {
  try {
    let { data, error } = await filtrarSoloPagosCuboVerificados(
      supabase
        .from('pedidos')
        .select('*, bolsas!bolsa_id(id,nombre), negocios!negocio_id(id,nombre,zona)')
        .eq('usuario_id', req.usuario.id)
        .in('estado', ESTADOS_VISIBLES_CLIENTE)
    ).order('created_at', { ascending: false });
    if (error) {
      console.warn('[PEDIDOS API] join failed, fallback:', error.message);
      const r = await filtrarSoloPagosCuboVerificados(
        supabase.from('pedidos').select('*')
          .eq('usuario_id', req.usuario.id)
          .in('estado', ESTADOS_VISIBLES_CLIENTE)
      );
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
//
// El flujo de carrito (POST /pagos/preparar) crea el pedido en estado 'borrador'
// ANTES de que el cliente confirme nada — es solo un carrito. Si el cliente lo
// abandona, un cron (server.js) o el propio /pagos/preparar lo pasa a
// 'cancelado' un par de horas después. Ese 'cancelado' no representa un pedido
// real: el cliente nunca llegó a pagar. Mostrarlo en el panel del restaurante
// como "pedido cancelado" sería engañoso — infla el conteo con carritos que
// nadie intentó completar.
//
// Un pedido cuenta como real solo con confirmación genuina de Cubo (ver
// filtrarSoloPagosCuboVerificados). Antes se aceptaba también con solo
// cubo_payment_intent_token (el link de pago generado, antes de pagar) — eso
// mostraba pedidos "iniciados" pero nunca cobrados. Ya no: el restaurante debe
// ver únicamente lo que de verdad se pagó, para que sus cifras coincidan con
// las de Finanzas del admin.
router.get('/restaurante', authMiddleware, async (req, res) => {
  try {
    if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
      return res.status(403).json({ error: 'No autorizado' });
    const { data: negocio } = await supabase
      .from('negocios').select('id').eq('propietario_id', req.usuario.id).single();
    if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
    let { data, error } = await filtrarSoloPagosCuboVerificados(
      supabase
        .from('pedidos')
        .select('*, bolsas!bolsa_id(id,nombre), usuarios!usuario_id(id,nombre,telefono)')
        .eq('negocio_id', negocio.id)
    ).order('created_at', { ascending: false });
    if (error) {
      const r = await filtrarSoloPagosCuboVerificados(
        supabase.from('pedidos').select('*').eq('negocio_id', negocio.id)
      );
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

// GET /api/pedidos/resumen-cliente — impacto del cliente autenticado
//
// "Rescatado" = recogido. Antes esta consulta contaba también los pedidos
// 'confirmado', 'en_preparacion' y 'listo': comida pagada que todavía estaba en
// el mostrador y que aún podía cancelarse. El número subía al pagar y no volvía
// a bajar si el pedido se caía después.
//
// El modelo híbrido (pedido_items para carritos multi-bolsa, pedidos.bolsa_id
// para los heredados) y el cálculo de kg/CO₂/ahorro viven ahora en
// services/impactoAmbiental.js — el mismo código que alimenta el panel del
// restaurante, para que las dos pantallas no puedan contar distinto.
router.get('/resumen-cliente', authMiddleware, async (req, res) => {
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('id, bolsa_id, cantidad, precio_bolsa')
      .eq('usuario_id', req.usuario.id)
      .eq('estado_pago', 'pagado')
      .in('estado', ESTADOS_ENTREGADOS);

    if (error) return res.status(500).json({ error: error.message });

    const impacto = await impactoDePedidos(pedidos || []);

    res.json({
      bolsas_rescatadas: impacto.unidades_rescatadas,
      total_ahorrado: impacto.dinero_ahorrado,
      kg_rescatados: impacto.kg_rescatados,
      co2_evitado_kg: impacto.co2_evitado_kg,
      pedidos_completados: impacto.pedidos_completados,
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
    .select('*, bolsas(id,nombre,descripcion,imagen_url), negocios(id,nombre,direccion,zona,ciudad,telefono,categoria,imagen_url,punto_referencia,google_maps_url,waze_url,latitud,longitud,propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (data.usuario_id !== req.usuario.id && data.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  if (data.negocios) delete data.negocios.propietario_id;
  res.json(data);
});

// La matriz de transiciones vive ahora en services/orderStateMachine.js — era
// una copia local que había divergido y permitía 'pendiente' → 'confirmado'
// (confirmar un pedido sin pago verificado). No volver a declararla aquí.

// Estados que el restaurante puede pedir desde su panel. Es un subconjunto de
// la máquina, no una matriz alterna: la validación real la hace validarTransicion.
const ESTADOS_SOLICITABLES_RESTAURANTE = ['en_preparacion', 'listo', 'completado', 'recogido', 'cancelado'];

// PUT /api/pedidos/:id/estado — cambiar estado (restaurante)
router.put('/:id/estado', authMiddleware, async (req, res) => {
  const { estado } = req.body;
  if (!esEstadoValido(estado) || !ESTADOS_SOLICITABLES_RESTAURANTE.includes(estado)) {
    return res.status(400).json({
      ok: false,
      error: 'ESTADO_INVALIDO',
      detalle: `Estado "${estado}" no es un destino válido desde el panel del restaurante. Válidos: ${ESTADOS_SOLICITABLES_RESTAURANTE.join(', ')}.`,
    });
  }

  const { data: pedido, error: pedidoErr } = await supabase
    .from('pedidos')
    .select('estado, estado_pago, cubo_payment_intent_token, cubo_identifier, usuario_id, negocio_id, codigo_recogida, total, tipo_entrega, negocios(propietario_id), usuarios(expo_push_token)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (pedidoErr) {
    console.error('[PEDIDOS] no se pudo leer el pedido', req.params.id, ':', pedidoErr.message);
    return res.status(503).json({ ok: false, error: 'BD_NO_DISPONIBLE', detalle: 'No se pudo consultar el pedido. Intenta de nuevo.' });
  }
  if (!pedido) return res.status(404).json({ ok: false, error: 'PEDIDO_NO_ENCONTRADO', detalle: 'Pedido no encontrado' });
  if (pedido.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ ok: false, error: 'NO_AUTORIZADO', detalle: 'No autorizado' });

  // Fuente canónica: rechaza terminales, la arista prohibida y las condiciones
  // de pago, todo con la misma forma de respuesta.
  const validacion = validarTransicion(pedido.estado, estado, { pedido });
  if (!validacion.ok) {
    return res.status(validacion.status).json({
      ok: false,
      error: validacion.error,
      codigo: validacion.codigo,
      detalle: validacion.detalle,
      estado_actual: validacion.estadoActual,
      transiciones_permitidas: validacion.transicionesPermitidas,
    });
  }

  // Cancelar desde el panel pasa por el liberador idempotente: es el único
  // camino que devuelve inventario, y hacerlo con un UPDATE suelto aquí
  // duplicaría stock si el restaurante toca el botón dos veces.
  if (estado === 'cancelado') {
    const resultado = await liberarInventarioPedido(req.params.id, {
      canceladoPor: req.usuario.rol === 'admin' ? 'admin' : 'restaurante',
      motivo: `cancelado desde panel|actor:${req.usuario.id}`,
    });
    if (!resultado.ok) {
      return res.status(resultado.status || 500).json({
        ok: false,
        error: resultado.error || 'CANCELACION_FALLIDA',
        codigo: resultado.codigo,
        detalle: resultado.detalle || 'No se pudo cancelar el pedido.',
      });
    }
    return res.json({ ok: true, tipo: resultado.tipo, estado: 'cancelado', stock_devuelto: resultado.stockDevuelto === true });
  }

  // El CAS sobre `estado` cierra la ventana entre el SELECT y el UPDATE: si el
  // pedido se movió en medio, no se pisa el estado nuevo.
  let data;
  try {
    const r = await supabase
      .from('pedidos')
      .update({ estado })
      .eq('id', req.params.id)
      .eq('estado', pedido.estado)
      .select()
      .maybeSingle();
    if (r.error) {
      console.error('[PEDIDOS] UPDATE de estado falló para', req.params.id, ':', r.error.message);
      return res.status(503).json({ ok: false, error: 'BD_NO_DISPONIBLE', detalle: 'No se pudo actualizar el pedido. Intenta de nuevo.' });
    }
    data = r.data;
  } catch (err) {
    console.error('[PEDIDOS] UPDATE de estado no disponible para', req.params.id, ':', err.message);
    return res.status(503).json({ ok: false, error: 'BD_NO_DISPONIBLE', detalle: 'No se pudo actualizar el pedido. Intenta de nuevo.' });
  }

  if (!data) {
    return res.status(409).json({
      ok: false,
      error: 'CONFLICTO_DE_ESTADO',
      detalle: `El pedido cambió de estado mientras se procesaba la solicitud (estaba en "${pedido.estado}"). Recarga y vuelve a intentar.`,
    });
  }

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
    await enviarNotificacionPush(tokenCliente, '⭐ ¡Bolsa rescatada!',
      '¡Gracias por rescatar tu bolsa! Tus puntos Bocara ya están en tu cuenta.',
      { pedidoId: req.params.id, screen: 'pedidos' });
    await guardarNotificacion(supabase, pedido.usuario_id, 'bolsa_recogida', '⭐ ¡Bolsa rescatada!', 'Tus puntos Bocara ya están en tu cuenta.', { pedidoId: req.params.id });
  }

  res.json(data);
});

// PATCH /api/pedidos/:id/cancelar — solo uso admin con reembolso previo registrado
//
// Política:
//   · No admin                          → 403
//   · Faltan datos de reembolso         → 400
//   · ya cancelado                      → 200 ya_cancelado
//   · estado = listo/completado/recogido → 409 no cancelable
//   · estado = confirmado/en_preparacion → cancela con auditoría de reembolso
//
// Cubo Pago no tiene API de reembolso. El admin debe procesar la devolución
// manualmente y registrar los datos antes de llamar este endpoint.
router.patch('/:id/cancelar', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Las cancelaciones de pedidos pagados se gestionan a través de soporte. Escríbenos al +502 5107-7949.',
      whatsapp: '+502 5107-7949',
      url_whatsapp: 'https://wa.me/50251077949',
    });
  }
  try {
    const { monto_reembolsado, referencia_reembolso, fecha_reembolso } = req.body;

    if (!monto_reembolsado || !referencia_reembolso || !fecha_reembolso) {
      return res.status(400).json({
        ok: false,
        error: 'REEMBOLSO_NO_REGISTRADO',
        detalle: 'Se debe registrar el reembolso antes de cancelar: monto_reembolsado, referencia_reembolso, fecha_reembolso.',
      });
    }

    // Admin puede cancelar pedidos de cualquier usuario — sin filtro por usuario_id
    const { data: pedido, error: leerErr } = await supabase
      .from('pedidos')
      .select('id, estado, estado_pago, negocio_id, codigo_recogida, negocios(propietario_id)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (leerErr) {
      console.error('[CANCELAR ADMIN] lectura falló:', leerErr.message);
      return res.status(503).json({ ok: false, error: 'BD_NO_DISPONIBLE', detalle: 'No se pudo consultar el pedido. Intenta de nuevo.' });
    }
    if (!pedido) return res.status(404).json({ ok: false, error: 'PEDIDO_NO_ENCONTRADO', detalle: 'Pedido no encontrado' });

    const auditoria = `reembolso:Q${monto_reembolsado}|ref:${referencia_reembolso}|fecha:${fecha_reembolso}|admin:${req.usuario.id}`;

    // Una sola puerta para cancelar: el CAS sobre `estado` dentro de
    // liberarInventarioPedido garantiza que el inventario se devuelve una vez
    // aunque soporte reintente. estadosPermitidos mantiene la política de este
    // endpoint — 'listo', 'completado' y 'recogido' no se cancelan porque el
    // cliente ya tiene la bolsa o está lista para recoger.
    const resultado = await liberarInventarioPedido(pedido.id, {
      canceladoPor: 'admin',
      motivo: auditoria,
      estadosPermitidos: ['confirmado', 'en_preparacion'],
    });

    if (resultado.tipo === 'ya_cancelado')
      return res.json({ ok: true, tipo: 'ya_cancelado' });

    if (resultado.tipo === 'transicion_invalida') {
      return res.status(409).json({
        ok: false,
        tipo: 'estado_no_cancelable',
        error: resultado.error,
        codigo: resultado.codigo,
        detalle: resultado.detalle,
        estado_actual: pedido.estado,
      });
    }

    if (!resultado.ok) {
      return res.status(resultado.status || 500).json({
        ok: false,
        error: resultado.error || 'CANCELACION_FALLIDA',
        detalle: resultado.detalle || 'No se pudo cancelar el pedido.',
      });
    }

    // Liberar cupón — best-effort, idempotente
    supabase.rpc('liberar_reserva_cupon', { p_pedido_id: pedido.id })
      .then(({ error: rpcErr }) => { if (rpcErr) console.warn('[CANCELAR ADMIN] liberar_reserva_cupon:', rpcErr.message); })
      .catch(err => console.warn('[CANCELAR ADMIN] liberar_reserva_cupon network:', err.message));

    // Notificar al restaurante
    const propietario_id = pedido.negocios?.propietario_id;
    if (propietario_id) {
      guardarNotificacion(supabase, propietario_id, 'pedido_cancelado', '❌ Pedido cancelado por soporte',
        `El pedido ${pedido.codigo_recogida} fue cancelado por soporte. Reembolso: Q${monto_reembolsado}`, { pedidoId: pedido.id })
        .catch(err => console.warn('[CANCELAR ADMIN] guardarNotificacion:', err.message));
    }

    res.json({
      ok: true,
      tipo: 'cancelado_por_admin',
      stock_devuelto: resultado.stockDevuelto === true,
      mensaje: 'Pedido cancelado y reembolso registrado correctamente',
    });
  } catch (err) {
    console.error('[CANCELAR ADMIN] error no capturado:', err.message);
    res.status(500).json({ ok: false, error: 'ERROR_INTERNO', detalle: err.message });
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
