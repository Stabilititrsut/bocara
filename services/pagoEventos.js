// Procesador idempotente de eventos post-pago Cubo.
//
// Garantías:
//   · Sin fallbacks inseguros: si la infraestructura de puntos o notificaciones
//     no existe, el evento queda pendiente y se reintenta — no se usa sumar_puntos
//     legacy ni guardarNotificacion sin clave idempotente.
//   · Bloqueo optimista: SET estado='procesando' WHERE estado='pendiente' AND
//     intentos=<versión>. Solo el procesador cuyo UPDATE gana ejecuta el handler.
//   · Recuperación por timeout: procesarEventosFallidos resetea eventos stuck en
//     'procesando' durante más de ABANDONO_TIMEOUT_MS antes de buscar nuevos.
//   · Estados: pendiente → procesando → completado | fallido (tras MAX_INTENTOS).
//
// Tipos de evento registrados por confirmar_pago_cubo:
//   · sumar_puntos               — payload: { usuario_id, puntos }
//   · notificar_pago_cliente     — payload: { pedido_id, usuario_id, tipo_entrega, codigo_recogida }
//   · notificar_pago_restaurante — payload: { pedido_id, negocio_id, codigo_recogida, total }

const supabase = require('../config/supabase');
const { enviarNotificacionPush } = require('./notificaciones');

const MAX_INTENTOS        = 5;
const ABANDONO_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

// ── API pública ──────────────────────────────────────────────────────────────

// Procesa todos los eventos pendientes de un pedido específico.
// Llamar justo después de que la RPC confirmar_pago_cubo retorne
// 'procesado' o 'duplicado'.
async function procesarEventosPedido(pedidoId) {
  if (!pedidoId) return;
  try {
    const { data: eventos, error } = await supabase
      .from('pago_eventos_pendientes')
      .select('*')
      .eq('pedido_id', pedidoId)
      .eq('estado', 'pendiente')
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

    for (const evento of eventos || []) {
      await _procesarEvento(evento).catch(err =>
        console.error('[PAGO_EVENTOS]', evento.tipo_evento, '| pedido', pedidoId, ':', err.message)
      );
    }
  } catch (err) {
    console.error('[PAGO_EVENTOS] Error inesperado en procesarEventosPedido:', err.message);
  }
}

// Recupera eventos abandonados y reintenta hasta maxEventos eventos pendientes.
// Llamar desde un cron o endpoint interno protegido (no expuesto públicamente).
async function procesarEventosFallidos(maxEventos = 20) {
  try {
    // 1. Recuperar eventos stuck en 'procesando' más de ABANDONO_TIMEOUT_MS
    const abandonadoDesde = new Date(Date.now() - ABANDONO_TIMEOUT_MS).toISOString();
    const { error: recoveryErr } = await supabase
      .from('pago_eventos_pendientes')
      .update({ estado: 'pendiente', procesando_desde: null })
      .eq('estado', 'procesando')
      .lt('procesando_desde', abandonadoDesde)
      .lt('intentos', MAX_INTENTOS);

    if (recoveryErr && !_esErrorTablaNoExiste(recoveryErr)) {
      console.error('[PAGO_EVENTOS] Error en recovery de eventos abandonados:', recoveryErr.message);
    }

    // 2. Buscar y procesar eventos pendientes
    const { data: eventos, error } = await supabase
      .from('pago_eventos_pendientes')
      .select('*')
      .eq('estado', 'pendiente')
      .lt('intentos', MAX_INTENTOS)
      .order('created_at', { ascending: true })
      .limit(maxEventos);

    if (error) {
      if (_esErrorTablaNoExiste(error)) return;
      console.error('[PAGO_EVENTOS] Error leyendo eventos fallidos:', error.message);
      return;
    }

    if (!eventos || eventos.length === 0) return;

    console.log('[PAGO_EVENTOS] Reintentando', eventos.length, 'evento(s) pendiente(s)');
    for (const evento of eventos) {
      await _procesarEvento(evento).catch(err =>
        console.error('[PAGO_EVENTOS] Reintento', evento.tipo_evento, '| pedido', evento.pedido_id, ':', err.message)
      );
    }
  } catch (err) {
    console.error('[PAGO_EVENTOS] Error inesperado en procesarEventosFallidos:', err.message);
  }
}

// ── Procesamiento interno ────────────────────────────────────────────────────

// Reclama y ejecuta un único evento con bloqueo optimista.
// Dos procesadores concurrentes que lean el mismo evento (estado='pendiente',
// intentos=N) solo pueden avanzar uno: el UPDATE con la condición AND intentos=N
// es atómico en PostgreSQL — el segundo obtiene 0 filas y retorna sin hacer nada.
async function _procesarEvento(evento) {
  // Bloqueo optimista: claim solo si estado='pendiente' E intentos no cambió
  const { data: claimed } = await supabase
    .from('pago_eventos_pendientes')
    .update({
      estado:            'procesando',
      procesando_desde:  new Date().toISOString(),
      intentos:          evento.intentos + 1,
      ultimo_intento_at: new Date().toISOString(),
    })
    .eq('id', evento.id)
    .eq('estado', 'pendiente')
    .eq('intentos', evento.intentos)
    .select()
    .single();

  if (!claimed) return; // otro procesador ganó — omitir silenciosamente

  let exito  = false;
  let errMsg = null;

  try {
    switch (claimed.tipo_evento) {
      case 'sumar_puntos':
        await _procesarSumarPuntos(claimed);
        break;
      case 'notificar_pago_cliente':
        await _procesarNotificacionCliente(claimed);
        break;
      case 'notificar_pago_restaurante':
        await _procesarNotificacionRestaurante(claimed);
        break;
      default:
        throw new Error(`tipo_evento desconocido: ${claimed.tipo_evento}`);
    }
    exito = true;
  } catch (err) {
    errMsg = err.message;
    console.error('[PAGO_EVENTOS] Fallo', claimed.tipo_evento, '| pedido', claimed.pedido_id,
      '| intento', claimed.intentos, ':', err.message);
  }

  // claimed.intentos ya fue incrementado por el UPDATE de claim
  const nuevoEstado = exito
    ? 'completado'
    : (claimed.intentos >= MAX_INTENTOS ? 'fallido' : 'pendiente');

  await supabase
    .from('pago_eventos_pendientes')
    .update({
      estado:           nuevoEstado,
      procesando_desde: null,
      completado_at:    exito ? new Date().toISOString() : undefined,
      ...(errMsg ? { error_ultimo: errMsg } : {}),
    })
    .eq('id', claimed.id);

  if (nuevoEstado === 'fallido') {
    console.error('[PAGO_EVENTOS] EVENTO FALLIDO definitivamente tras', claimed.intentos,
      'intentos — tipo:', claimed.tipo_evento, '| pedido:', claimed.pedido_id,
      '— requiere intervención manual');
  }
}

// ── Handlers por tipo de evento ──────────────────────────────────────────────

// Suma puntos al usuario via sumar_puntos_idempotente.
// SIN FALLBACK: si la función o tabla no existe, lanza error → evento queda pendiente.
// Escenario tolerado: RPC suma puntos → Node falla antes de marcar completado →
//   reintento llama RPC → responde 'duplicado' → evento marcado completado sin doble suma.
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
    // No hay fallback a sumar_puntos legacy. El evento queda pendiente.
    throw new Error(`sumar_puntos_idempotente falló (código ${error.code}): ${error.message}`);
  }

  const resultado = data?.resultado;
  if (resultado === 'parametro_invalido') {
    throw new Error(`sumar_puntos_idempotente: parámetro inválido — ${JSON.stringify(data)}`);
  }
  // 'sumado' y 'duplicado' son ambos éxito (garantía de idempotencia)
  console.log('[PAGO_EVENTOS] sumar_puntos:', resultado, '| puntos:', puntos, '| pedido:', evento.pedido_id);
}

// Notifica al cliente (push + notificación persistente idempotente).
// SIN FALLBACK: si clave_idempotencia no existe en notificaciones, lanza error.
// Push es best-effort (fallo no bloquea el evento).
// Notificación persistente es obligatoria e idempotente.
async function _procesarNotificacionCliente(evento) {
  const { pedido_id, usuario_id, tipo_entrega, codigo_recogida } = evento.payload || {};
  if (!usuario_id || !pedido_id) {
    throw new Error(`payload inválido en notificar_pago_cliente: ${JSON.stringify(evento.payload)}`);
  }

  const { data: cliente } = await supabase
    .from('usuarios').select('expo_push_token').eq('id', usuario_id).single();

  const mensaje = tipo_entrega === 'recogida'
    ? `Código de recogida: ${codigo_recogida} — ¡Ya puedes ir!`
    : 'Tu pedido está siendo preparado. Te avisamos cuando salga.';

  // Push: best-effort — fallo no bloquea el evento
  await enviarNotificacionPush(
    cliente?.expo_push_token, '✅ ¡Pago confirmado!', mensaje,
    { pedidoId: pedido_id, screen: 'pedidos' }
  ).catch(err => console.warn('[PAGO_EVENTOS] Push cliente (best-effort) falló:', err.message));

  // Notificación persistente: idempotente obligatoria — lanza si infraestructura ausente
  await _guardarNotificacionIdempotente(
    usuario_id, 'pago_confirmado', '✅ Pago confirmado', mensaje,
    { pedidoId: pedido_id }, `cubo_pago:${pedido_id}:cliente`
  );
}

// Notifica al restaurante (push + notificación persistente idempotente).
// SIN FALLBACK: misma semántica que _procesarNotificacionCliente.
async function _procesarNotificacionRestaurante(evento) {
  const { pedido_id, negocio_id, codigo_recogida, total } = evento.payload || {};
  if (!negocio_id || !pedido_id) {
    throw new Error(`payload inválido en notificar_pago_restaurante: ${JSON.stringify(evento.payload)}`);
  }

  const { data: negocio } = await supabase
    .from('negocios').select('propietario_id').eq('id', negocio_id).single();

  const propietarioId = negocio?.propietario_id;
  if (!propietarioId) {
    // Negocio sin propietario: omitir sin error (no hay a quién notificar)
    console.warn('[PAGO_EVENTOS] notificar_pago_restaurante: negocio sin propietario_id — pedido:', pedido_id);
    return;
  }

  const { data: propietario } = await supabase
    .from('usuarios').select('expo_push_token').eq('id', propietarioId).single();

  const mensajeRest = `Pedido ${codigo_recogida} — Q${total}`;

  // Push: best-effort
  await enviarNotificacionPush(
    propietario?.expo_push_token, '🛍️ Nuevo pedido', mensajeRest,
    { pedidoId: pedido_id, screen: 'restaurante' }
  ).catch(err => console.warn('[PAGO_EVENTOS] Push restaurante (best-effort) falló:', err.message));

  // Notificación persistente: idempotente obligatoria
  await _guardarNotificacionIdempotente(
    propietarioId, 'nuevo_pedido', '🛍️ Nuevo pedido', mensajeRest,
    { pedidoId: pedido_id }, `cubo_pago:${pedido_id}:restaurante`
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Inserta una notificación con clave de idempotencia.
// SIN FALLBACK NO-IDEMPOTENTE: si la columna clave_idempotencia no existe
// en la tabla notificaciones, lanza un error para que el evento quede pendiente.
// Esto obliga a ejecutar la migración SQL antes de activar el procesador.
//
// Códigos de resultado:
//   · Sin error → insertada correctamente
//   · 23505    → duplicado idempotente (ya fue enviada en intento anterior) — OK
//   · 42703    → columna clave_idempotencia no existe → LANZA, evento queda pendiente
//   · otros    → error real → LANZA, evento queda pendiente
async function _guardarNotificacionIdempotente(usuarioId, tipo, titulo, mensaje, data, claveIdempotencia) {
  if (!usuarioId) return;

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

  // UNIQUE violation: ya fue enviada en un intento anterior (idempotente)
  if (error.code === '23505') {
    console.log('[PAGO_EVENTOS] Notificación ya enviada (idempotente):', claveIdempotencia);
    return;
  }

  // Columna faltante: migración SQL pendiente → no usar fallback no-idempotente
  if (error.code === '42703' || error.message?.includes('clave_idempotencia')) {
    throw new Error(
      `columna clave_idempotencia no existe en notificaciones — ejecutar migración SQL ` +
      `(sql/cubo-pago-schema.sql BLOQUE 2). Evento quedará pendiente. (${error.message})`
    );
  }

  throw new Error(`Error guardando notificación idempotente: ${error.message}`);
}

function _esErrorTablaNoExiste(error) {
  return error.code === '42P01' || error.message?.includes('does not exist');
}

module.exports = { procesarEventosPedido, procesarEventosFallidos };
