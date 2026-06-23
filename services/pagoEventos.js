// Procesador idempotente de eventos post-pago.
//
// Los eventos se registran en pago_eventos_pendientes dentro de la misma
// transacción que confirma el pago (RPC confirmar_pago_cubo).
// Este servicio los procesa post-commit y los marca completados.
//
// Concurrencia: bloqueo optimista via columna "intentos".
// Solo el procesador cuyo UPDATE gana (intentos == valor esperado) ejecuta
// el handler. Los demás lo detectan (claimed === null) y omiten silenciosamente.

const supabase = require('../config/supabase');
const { enviarNotificacionPush, guardarNotificacion } = require('./notificaciones');

const MAX_INTENTOS = 5;

// Procesa todos los eventos pendientes de un pedido específico.
// Llamar justo después de que la RPC confirmar_pago_cubo retorne
// 'procesado' o 'duplicado' (para reintentar eventos que no completaron).
async function procesarEventosPedido(pedidoId) {
  if (!pedidoId) return;
  try {
    const { data: eventos, error } = await supabase
      .from('pago_eventos_pendientes')
      .select('*')
      .eq('pedido_id', pedidoId)
      .eq('completado', false)
      .lt('intentos', MAX_INTENTOS)
      .order('created_at', { ascending: true });

    if (error) {
      if (_esErrorTablaNoExiste(error)) {
        console.warn('[PAGO_EVENTOS] Tabla pago_eventos_pendientes no existe — ejecutar migración SQL');
        return;
      }
      console.error('[PAGO_EVENTOS] Error leyendo eventos del pedido:', error.message);
      return;
    }

    if (!eventos || eventos.length === 0) return;

    for (const evento of eventos) {
      await _procesarEvento(evento).catch(err =>
        console.error('[PAGO_EVENTOS] Error procesando evento', evento.tipo_evento, '| pedido', pedidoId, ':', err.message)
      );
    }
  } catch (err) {
    console.error('[PAGO_EVENTOS] Error inesperado en procesarEventosPedido:', err.message);
  }
}

// Procesa hasta maxEventos eventos fallidos (para reintentos periódicos).
// Llamar desde un cron o endpoint interno protegido.
async function procesarEventosFallidos(maxEventos = 20) {
  try {
    const { data: eventos, error } = await supabase
      .from('pago_eventos_pendientes')
      .select('*')
      .eq('completado', false)
      .lt('intentos', MAX_INTENTOS)
      .order('created_at', { ascending: true })
      .limit(maxEventos);

    if (error) {
      if (_esErrorTablaNoExiste(error)) return;
      console.error('[PAGO_EVENTOS] Error leyendo eventos fallidos:', error.message);
      return;
    }

    if (!eventos || eventos.length === 0) return;

    console.log('[PAGO_EVENTOS] Reintentando', eventos.length, 'evento(s) fallido(s)');
    for (const evento of eventos) {
      await _procesarEvento(evento).catch(err =>
        console.error('[PAGO_EVENTOS] Error en reintento', evento.tipo_evento, '| pedido', evento.pedido_id, ':', err.message)
      );
    }
  } catch (err) {
    console.error('[PAGO_EVENTOS] Error inesperado en procesarEventosFallidos:', err.message);
  }
}

// Procesa un único evento con bloqueo optimista.
// El UPDATE solo avanza si `intentos` no cambió (nadie más lo tomó).
async function _procesarEvento(evento) {
  const { data: claimed } = await supabase
    .from('pago_eventos_pendientes')
    .update({
      intentos:          evento.intentos + 1,
      ultimo_intento_at: new Date().toISOString(),
    })
    .eq('id', evento.id)
    .eq('intentos', evento.intentos)
    .eq('completado', false)
    .select()
    .single();

  if (!claimed) {
    // Otro procesador ganó el bloqueo optimista — omitir
    return;
  }

  let exito   = false;
  let errMsg  = null;

  try {
    switch (claimed.tipo_evento) {
      case 'sumar_puntos':
        await _procesarSumarPuntos(claimed);
        break;
      case 'pago_cubo_confirmado':
        await _procesarNotificacionPago(claimed);
        break;
      default:
        console.warn('[PAGO_EVENTOS] Tipo de evento desconocido:', claimed.tipo_evento, '| pedido', claimed.pedido_id);
    }
    exito = true;
  } catch (err) {
    errMsg = err.message;
    console.error('[PAGO_EVENTOS] Fallo evento', claimed.tipo_evento, '| pedido', claimed.pedido_id, ':', err.message);
  }

  if (exito) {
    await supabase
      .from('pago_eventos_pendientes')
      .update({ completado: true, completado_at: new Date().toISOString() })
      .eq('id', claimed.id);
  } else {
    await supabase
      .from('pago_eventos_pendientes')
      .update({ error_ultimo: errMsg })
      .eq('id', claimed.id);
  }
}

// Llama a sumar_puntos_idempotente (idempotente por UNIQUE(pedido_id, concepto)).
// Fallback a sumar_puntos legacy si la función nueva no existe aún.
async function _procesarSumarPuntos(evento) {
  const { usuario_id, puntos } = evento.payload || {};
  if (!usuario_id || !puntos) {
    throw new Error(`payload inválido en sumar_puntos: ${JSON.stringify(evento.payload)}`);
  }

  const { data, error } = await supabase.rpc('sumar_puntos_idempotente', {
    p_usuario_id: usuario_id,
    p_pedido_id:  evento.pedido_id,
    p_puntos:     puntos,
    p_concepto:   'pago_cubo',
  });

  if (error) {
    if (_esErrorFuncionNoExiste(error)) {
      console.warn('[PAGO_EVENTOS] sumar_puntos_idempotente no existe — usando sumar_puntos legacy');
      const { error: legacyErr } = await supabase.rpc('sumar_puntos', {
        user_id: usuario_id,
        puntos,
      });
      if (legacyErr) throw new Error(`sumar_puntos legacy falló: ${legacyErr.message}`);
      return;
    }
    throw new Error(`sumar_puntos_idempotente falló: ${error.message}`);
  }

  const resultado = data?.resultado;
  if (resultado === 'duplicado') {
    console.log('[PAGO_EVENTOS] Puntos ya sumados (duplicado idempotente) — pedido:', evento.pedido_id);
  } else if (resultado === 'sumado') {
    console.log('[PAGO_EVENTOS] Puntos sumados:', puntos, '— pedido:', evento.pedido_id);
  }
}

// Envía notificaciones al cliente y al restaurante.
// Usa clave_idempotencia para evitar duplicados si el evento se reintenta.
async function _procesarNotificacionPago(evento) {
  const { pedido_id, codigo_recogida, usuario_id, negocio_id, tipo_entrega, total } = evento.payload || {};
  if (!usuario_id || !pedido_id) {
    throw new Error(`payload inválido en pago_cubo_confirmado: ${JSON.stringify(evento.payload)}`);
  }

  const [clienteRes, negocioRes] = await Promise.all([
    supabase.from('usuarios').select('expo_push_token').eq('id', usuario_id).single(),
    supabase.from('negocios').select('propietario_id').eq('id', negocio_id).single(),
  ]);

  const tokenCliente  = clienteRes.data?.expo_push_token;
  const propietarioId = negocioRes.data?.propietario_id;

  const mensajeCliente = tipo_entrega === 'recogida'
    ? `Código de recogida: ${codigo_recogida} — ¡Ya puedes ir!`
    : 'Tu pedido está siendo preparado. Te avisamos cuando salga.';

  await Promise.all([
    enviarNotificacionPush(
      tokenCliente,
      '✅ ¡Pago confirmado!', mensajeCliente,
      { pedidoId: pedido_id, screen: 'pedidos' }
    ),
    _guardarNotificacionIdempotente(
      usuario_id, 'pago_confirmado', '✅ Pago confirmado', mensajeCliente,
      { pedidoId: pedido_id }, `cubo_pago:${pedido_id}:cliente`
    ),
  ]);

  if (propietarioId) {
    const { data: propietario } = await supabase
      .from('usuarios').select('expo_push_token').eq('id', propietarioId).single();
    const mensajeRest = `Pedido ${codigo_recogida} — Q${total}`;
    await Promise.all([
      enviarNotificacionPush(
        propietario?.expo_push_token,
        '🛍️ Nuevo pedido', mensajeRest,
        { pedidoId: pedido_id, screen: 'restaurante' }
      ),
      _guardarNotificacionIdempotente(
        propietarioId, 'nuevo_pedido', '🛍️ Nuevo pedido', mensajeRest,
        { pedidoId: pedido_id }, `cubo_pago:${pedido_id}:restaurante`
      ),
    ]);
  }
}

// Guarda una notificación con clave de idempotencia.
// Si la columna clave_idempotencia no existe (Bloque 9 no ejecutado),
// cae a guardarNotificacion() sin la clave.
async function _guardarNotificacionIdempotente(usuarioId, tipo, titulo, mensaje, data, claveIdempotencia) {
  if (!usuarioId) return;
  try {
    const { error } = await supabase.from('notificaciones').insert([{
      usuario_id:         usuarioId,
      tipo,
      titulo,
      cuerpo:             mensaje,
      data,
      leida:              false,
      clave_idempotencia: claveIdempotencia,
    }]);

    if (!error) return;

    // Columna clave_idempotencia no existe → fallback sin idempotencia
    if (error.code === '42703' || error.message?.includes('clave_idempotencia')) {
      await guardarNotificacion(supabase, usuarioId, tipo, titulo, mensaje, data);
      return;
    }

    // UNIQUE violation → notificación ya fue enviada (idempotente)
    if (error.code === '23505') {
      console.log('[PAGO_EVENTOS] Notificación duplicada (idempotente):', claveIdempotencia);
      return;
    }

    console.error('[PAGO_EVENTOS] Error guardando notificación:', error.message);
  } catch (err) {
    console.error('[PAGO_EVENTOS] Error inesperado guardando notificación:', err.message);
  }
}

function _esErrorTablaNoExiste(error) {
  return error.code === '42P01' || error.message?.includes('does not exist');
}

function _esErrorFuncionNoExiste(error) {
  return error.code === 'PGRST202' || error.message?.includes('function') || error.message?.includes('does not exist');
}

module.exports = { procesarEventosPedido, procesarEventosFallidos };
