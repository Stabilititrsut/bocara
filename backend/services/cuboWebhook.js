// ════════════════════════════════════════════════════════════════════════════
// Bocara — Núcleo del webhook de Cubo Pago
// ════════════════════════════════════════════════════════════════════════════
//
// Toda la lógica de recepción y verificación de pagos vive aquí, fuera de
// routes/webhooks.js, por dos razones:
//
//   1. Es el código que decide si un pedido queda cobrado. Merece pruebas
//      unitarias de verdad, y un módulo que hace `require('express')` y abre un
//      cliente de Supabase al importarse no se puede cargar en una prueba.
//   2. Las dependencias externas (Supabase, la API de Cubo, la cola de eventos
//      post-pago, el liberador de inventario) se inyectan. En producción se
//      resuelven solas; en pruebas se sustituyen por dobles y no se toca ni la
//      red ni la base de datos.
//
// routes/webhooks.js queda como un router delgado que traduce el resultado a
// una respuesta HTTP.
//
// ── Autenticidad ────────────────────────────────────────────────────────────
//
// Cubo Pago NO firma sus webhooks (no hay HMAC ni secreto compartido que
// verificar). La autenticidad no se toma del cuerpo recibido: antes de escribir
// nada se consulta a Cubo de forma independiente con
// GET /api/v1/transactions/:token y se comparan estado, token, moneda y monto
// contra lo que el pedido tenía guardado. Un webhook falsificado no sobrevive a
// esa consulta, porque la transacción no existe en Cubo o no coincide.
//
// FAIL-CLOSED: cualquier dato de verificación ausente o inválido detiene el
// procesamiento. Nunca se toca stock, puntos, QR ni notificaciones si la
// validación falla.

const { validarConfirmacionPago } = require('./orderStateMachine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Estados de pago que reconocemos. Cubo documenta SUCCEEDED / REJECTED, pero
// los contratos y otras pasarelas del mismo proveedor emiten también FAILED y
// DECLINED para el mismo hecho (no hubo cargo). Los tres se tratan como un
// único estado interno 'fallido' y disparan exactamente el mismo flujo de
// rechazo; cualquier otro valor es 'desconocido' y no altera nada.
const ESTADOS_APROBADO = new Set(['SUCCEEDED']);
const ESTADOS_FALLIDO  = new Set(['REJECTED', 'FAILED', 'DECLINED']);

/**
 * Normaliza el `status` crudo del webhook (o de la consulta a Cubo) a uno de
 * los tres estados internos: 'aprobado' | 'fallido' | 'desconocido'.
 * Tolera nulos, espacios y minúsculas — los payloads reales no son uniformes.
 */
function normalizarEstadoCubo(status) {
  const raw = String(status ?? '').trim().toUpperCase();
  if (ESTADOS_APROBADO.has(raw)) return { raw, estado: 'aprobado' };
  if (ESTADOS_FALLIDO.has(raw))  return { raw, estado: 'fallido' };
  return { raw, estado: 'desconocido' };
}

const SELECT_PEDIDO = 'id, codigo_recogida, total, tipo_entrega, bolsa_id, usuario_id, negocio_id, cantidad, estado, estado_pago, bolsas(cantidad_disponible), usuarios(expo_push_token), negocios(propietario_id)';

// ── Logging estructurado ────────────────────────────────────────────────────
//
// Una línea JSON por decisión, con el mismo juego de campos siempre. El webhook
// de pagos es lo primero que se revisa cuando un cliente dice que pagó y no le
// llegó nada: poder filtrar por `evento` y `pedido_id` en los logs de Render
// vale más que un mensaje bonito. Nunca se registra el cuerpo completo del
// webhook aquí para no dejar datos del cliente en los logs.
function registrar(nivel, evento, datos = {}) {
  const linea = JSON.stringify({
    ts: new Date().toISOString(),
    origen: 'cubo_webhook',
    evento,
    ...datos,
  });
  if (nivel === 'error') console.error(linea);
  else if (nivel === 'warn') console.warn(linea);
  else console.log(linea);
}

// Resuelve las dependencias. Las que no se inyectan se cargan de verdad — y
// solo entonces, para que una prueba que las inyecta todas no arrastre ni
// express ni el cliente de Supabase.
function resolverDependencias(deps = {}) {
  return {
    supabase: deps.supabase || require('../config/supabase'),
    consultarTransaccionCubo: deps.consultarTransaccionCubo
      || require('./visaLink').consultarTransaccionCubo,
    procesarEventosPedido: deps.procesarEventosPedido
      || require('./pagoEventos').procesarEventosPedido,
    liberarInventarioPedido: deps.liberarInventarioPedido
      || require('./stock').liberarInventarioPedido,
    // Se lee en cada llamada, no al importar: en producción la variable puede
    // configurarse después de arrancar el proceso.
    monedaEsperada: deps.monedaEsperada !== undefined
      ? deps.monedaEsperada
      : process.env.CUBO_CURRENCY,
  };
}

// Busca el pedido y sus columnas de verificación Cubo.
// Si las columnas no existen (migración pendiente), devuelve _cuboColumnsMissing: true
// para que el flujo falle cerrado en lugar de omitir las verificaciones.
async function buscarPedido(orderId, supabase) {
  if (!orderId || !UUID_RE.test(orderId)) return null;

  const { data } = await supabase.from('pedidos').select(SELECT_PEDIDO).eq('id', orderId).single();
  if (!data) return null;

  const { data: cuboData, error: cuboErr } = await supabase
    .from('pedidos')
    .select('cubo_payment_intent_token, monto_esperado_centavos')
    .eq('id', data.id)
    .single();

  if (cuboErr) {
    // Las columnas no existen aún — señalizar fail-closed; nunca omitir verificación
    return { ...data, _cuboColumnsMissing: true };
  }

  return { ...data, ...cuboData };
}

// Valida el payload del webhook y el resultado de la consulta independiente a Cubo.
// Función pura (sin efectos de red ni BD) — exportada para pruebas unitarias.
function validarWebhookCubo({ body, pedido, consulta, monedaEsperada }) {
  // 1. Campos mínimos del payload
  if (!body.identifier) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta identifier' };
  }
  if (!body.metadata?.orderId) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta metadata.orderId' };
  }

  const { raw: rawStatus, estado } = normalizarEstadoCubo(body.status);

  // 2. Solo estados reconocidos (ver normalizarEstadoCubo)
  if (estado === 'desconocido') {
    return { ok: false, statusCode: 200, warning: `estado no reconocido: ${rawStatus}` };
  }

  // Para REJECTED / FAILED / DECLINED no hay cargo — no se requiere verificación de monto ni token
  if (estado === 'fallido') {
    return { ok: true, statusCode: 200, tipo: 'fallido', status: rawStatus };
  }

  // ── A partir de aquí: estado === 'aprobado' (SUCCEEDED) ──────────────────────

  // 3. Consulta independiente obligatoria — sin ella no se puede verificar nada
  if (!consulta) {
    return { ok: false, statusCode: 503, error: 'Verificación con Cubo no disponible temporalmente — no se procesa el pago' };
  }

  // 4. Cubo confirma SUCCEEDED de forma independiente
  const statusConsulta = String(consulta.status || '').trim().toUpperCase();
  if (statusConsulta !== 'SUCCEEDED') {
    return { ok: false, statusCode: 409, error: `Cubo confirma estado "${statusConsulta}", no SUCCEEDED` };
  }

  // 5. Token de la consulta coincide con el identifier del webhook
  if (consulta.paymentIntentToken !== body.identifier) {
    return { ok: false, statusCode: 409, error: 'Token no coincide entre webhook identifier y consulta Cubo' };
  }

  // 6. Pedido encontrado
  if (!pedido) {
    return { ok: false, statusCode: 200, warning: 'Pedido no encontrado' };
  }

  // 7. Columnas de verificación disponibles — fail-closed si la migración no corrió
  if (pedido._cuboColumnsMissing) {
    return {
      ok: false,
      statusCode: 503,
      error: 'Columnas de verificación Cubo no existen en la BD — ejecutar migración SQL antes de procesar pagos',
    };
  }

  // 8. Token almacenado en el pedido — OBLIGATORIO (fail-closed)
  //    No basta con que el token llegue en el webhook; debe coincidir con el almacenado al crear el link.
  if (!pedido.cubo_payment_intent_token) {
    return {
      ok: false,
      statusCode: 422,
      error: 'Pedido sin cubo_payment_intent_token — no se puede verificar la autoría del pago',
    };
  }
  if (pedido.cubo_payment_intent_token !== body.identifier) {
    return { ok: false, statusCode: 409, error: 'Token no coincide con el almacenado en el pedido' };
  }

  // 9. Moneda — obligatoria si Cubo la devuelve (no asumir moneda por omisión)
  if (consulta.currency && consulta.currency !== monedaEsperada) {
    return {
      ok: false,
      statusCode: 409,
      error: `Moneda no coincide: Cubo devuelve "${consulta.currency}", esperada "${monedaEsperada}"`,
    };
  }

  // 10. Monto esperado — OBLIGATORIO (fail-closed)
  //     Cubo GET devuelve amount como string decimal ("10.00"); convertir a centavos para comparar.
  if (
    pedido.monto_esperado_centavos == null ||
    !Number.isInteger(pedido.monto_esperado_centavos) ||
    pedido.monto_esperado_centavos <= 0
  ) {
    return {
      ok: false,
      statusCode: 422,
      error: 'Pedido sin monto_esperado_centavos válido — no se puede verificar el importe del pago',
    };
  }

  const centavosConsulta = Math.round(parseFloat(consulta.amount) * 100);
  if (centavosConsulta !== pedido.monto_esperado_centavos) {
    return {
      ok: false,
      statusCode: 409,
      error: `Monto no coincide: consulta ${centavosConsulta}¢ ≠ esperado ${pedido.monto_esperado_centavos}¢`,
    };
  }

  // 11. Idempotencia — ya fue procesado en una ejecución anterior
  if (pedido.estado_pago === 'pagado') {
    return { ok: true, statusCode: 200, tipo: 'duplicado' };
  }

  return { ok: true, statusCode: 200, tipo: 'aprobado' };
}

/**
 * ¿Este webhook SUCCEEDED corresponde a un pago que ya quedó registrado?
 *
 * Se comprueba ANTES de consultar a Cubo. La verificación de idempotencia del
 * paso 11 de validarWebhookCubo sigue estando (es la red de seguridad para las
 * carreras), pero llegaba después de una llamada de red: cada reintento de un
 * pago ya procesado salía a internet, y si Cubo estaba lento o caído en ese
 * momento la respuesta era 502 — con lo que Cubo volvía a reintentar, en bucle,
 * un cobro que hacía rato estaba cerrado.
 *
 * Se exige que el token coincida con el guardado, no solo que el pedido esté
 * pagado. Un webhook con OTRO identifier sobre un pedido ya pagado no es un
 * duplicado: es un segundo cobro sobre el mismo pedido, y tiene que seguir el
 * camino largo para terminar en el 409 que lo hace visible.
 */
function esReintentoDeUnPagoYaRegistrado(pedido, paymentIntentToken) {
  return Boolean(
    pedido
    && !pedido._cuboColumnsMissing
    && pedido.estado_pago === 'pagado'
    && pedido.cubo_payment_intent_token
    && pedido.cubo_payment_intent_token === paymentIntentToken,
  );
}

/**
 * Procesa un evento de pago de Cubo.
 * Compartido por la ruta canónica (/api/webhooks/cubo) y la legacy
 * (/api/pagos/cubo-webhook).
 *
 * Devuelve siempre `{ statusCode, ...datos }` — nunca lanza para un fallo
 * esperado. El statusCode es lo que Cubo recibe, y decide si reintenta:
 *   · 2xx → no reintenta (procesado, duplicado, o nada que hacer)
 *   · 4xx → no reintenta (payload malo o discrepancia que exige revisión)
 *   · 5xx → reintenta (fallo transitorio nuestro o de Cubo)
 *
 * @param {object} body   cuerpo del webhook
 * @param {object} [deps] dependencias inyectables (ver resolverDependencias)
 */
async function procesarWebhookCubo(body = {}, deps = {}) {
  const {
    supabase, consultarTransaccionCubo, procesarEventosPedido,
    liberarInventarioPedido, monedaEsperada,
  } = resolverDependencias(deps);

  const { raw: rawStatus, estado: estadoNormalizado } = normalizarEstadoCubo(body.status);
  const paymentIntentToken = body.identifier;
  const { referenceId, authorizationCode, processedAt, metadata } = body;
  const orderId            = metadata?.orderId;

  registrar('info', 'recibido', { status: rawStatus || null, estado_normalizado: estadoNormalizado, identifier: paymentIntentToken || null, pedido_id: orderId || null });

  // ── Payload corrupto o incompleto → 400, sin tocar red ni BD ───────────────
  if (!paymentIntentToken || !orderId) {
    const faltan = [!paymentIntentToken && 'identifier', !orderId && 'metadata.orderId'].filter(Boolean);
    registrar('warn', 'payload_invalido', {
      faltan,
      claves_recibidas: Object.keys(body || {}),
    });
    return { statusCode: 400, error: `payload incompleto: faltan ${faltan.join(', ')}` };
  }

  // ── Estado que Cubo no documenta → 200 y a otra cosa ───────────────────────
  // No es un error del emisor ni nuestro: es un estado intermedio que no nos
  // interesa. 200 evita que Cubo lo reintente en bucle. Se registra igualmente
  // porque un estado nuevo en la pasarela es algo que queremos ver.
  if (estadoNormalizado === 'desconocido') {
    registrar('warn', 'estado_desconocido', { status: rawStatus, pedido_id: orderId });
    return { statusCode: 200, warning: `estado no reconocido: ${rawStatus}` };
  }

  // ══ SUCCEEDED ════════════════════════════════════════════════════════════
  if (estadoNormalizado === 'aprobado') {
    const pedido = await buscarPedido(orderId, supabase);

    // ── Idempotencia absoluta, antes de cualquier llamada de red ────────────
    if (esReintentoDeUnPagoYaRegistrado(pedido, paymentIntentToken)) {
      registrar('info', 'duplicado_ignorado', {
        pedido_id: pedido.id,
        identifier: paymentIntentToken,
        estado: pedido.estado,
      });
      // Reintentar los eventos post-pago que quedaron pendientes (una
      // notificación que falló, por ejemplo) NO es re-disparar nada: la cola
      // solo toma los que siguen en 'pendiente', y los reclama con un CAS. Un
      // evento ya completado no se vuelve a ejecutar.
      procesarEventosPedido(pedido.id).catch(err =>
        registrar('warn', 'eventos_pendientes_fallo', { pedido_id: pedido.id, detalle: err.message }));
      return { statusCode: 200, warning: 'pedido ya procesado', tipo: 'duplicado' };
    }

    // ── Consulta independiente a Cubo — la prueba de autenticidad ───────────
    let consulta;
    try {
      consulta = await consultarTransaccionCubo(paymentIntentToken);
      registrar('info', 'consulta_cubo_ok', {
        pedido_id: orderId,
        status: consulta?.status ?? null,
        currency: consulta?.currency ?? null,
        amount: consulta?.amount ?? null,
      });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        registrar('error', 'transaccion_inexistente_en_cubo', { pedido_id: orderId, identifier: paymentIntentToken });
        return { statusCode: 409, error: 'Transacción no encontrada en Cubo al verificar' };
      }
      // Error de red o Cubo caído → 502 para que Cubo reintente el webhook
      registrar('error', 'consulta_cubo_fallo', { pedido_id: orderId, codigo: err.code ?? null, detalle: err.message });
      return { statusCode: 502, error: 'Verificación con Cubo temporalmente no disponible — reintentar' };
    }

    if (!monedaEsperada) {
      registrar('error', 'config_ausente', { variable: 'CUBO_CURRENCY', pedido_id: orderId });
      return { statusCode: 503, error: 'CUBO_CURRENCY no configurada en el servidor — configurar como GTQ' };
    }

    const validacion = validarWebhookCubo({ body, pedido, consulta, monedaEsperada });

    if (!validacion.ok) {
      registrar('error', 'verificacion_fallida', {
        pedido_id: orderId,
        status_http: validacion.statusCode,
        detalle: validacion.error || validacion.warning,
      });
      return validacion;
    }

    // Red de seguridad: dos webhooks simultáneos pueden pasar los dos el
    // chequeo de arriba (ninguno ve al otro todavía). Este camino lo detecta
    // con el estado ya leído; la serialización real la impone la RPC, que
    // bloquea la fila con FOR UPDATE.
    if (validacion.tipo === 'duplicado') {
      registrar('info', 'duplicado_ignorado', { pedido_id: pedido.id, via: 'validacion' });
      procesarEventosPedido(pedido.id).catch(err =>
        registrar('warn', 'eventos_pendientes_fallo', { pedido_id: pedido.id, detalle: err.message }));
      return { statusCode: 200, warning: 'pedido ya procesado', tipo: 'duplicado' };
    }

    // Puerta de la máquina de estados. La RPC escribe estado='confirmado' y
    // estado_pago='pagado' en una sola transacción; en el modelo canónico eso es
    // 'pendiente' → 'pagado' → 'confirmado'. validarConfirmacionPago comprueba
    // las dos aristas y es el ÚNICO camino autorizado hasta 'confirmado' desde
    // 'pendiente' (la arista directa está prohibida).
    //
    // pagoVerificado: true porque a esta altura consultarTransaccionCubo ya
    // devolvió SUCCEEDED de forma independiente y validarWebhookCubo comparó
    // token, moneda y monto. Es exactamente la prueba que la condición exige;
    // el pedido todavía no tiene cubo_identifier porque lo escribe la RPC.
    const transicion = validarConfirmacionPago(pedido.estado, { pagoVerificado: true });
    if (!transicion.ok) {
      // 409 y no 400: el dinero ya se movió. Cubo no debe seguir reintentando un
      // pedido que la máquina rechaza, pero esto exige revisión manual.
      registrar('error', 'transicion_rechazada_con_pago_cobrado', {
        pedido_id: pedido.id,
        estado: pedido.estado,
        detalle: transicion.detalle,
        accion: 'intervencion_manual',
      });
      return {
        statusCode: 409,
        error: transicion.error,
        detalle: `${transicion.detalle} Pago cobrado — requiere intervención manual.`,
      };
    }

    // Monto verificado y convertido (validarWebhookCubo ya lo comprobó)
    const montoCentavosConsulta = Math.round(parseFloat(consulta.amount) * 100);

    // Confirmación atómica via RPC (bloqueo FOR UPDATE + verificación + stock + puntos
    // en una sola transacción PostgreSQL — la RPC falla completa o tiene éxito completo)
    const { data: rpcResult, error: rpcError } = await supabase.rpc('confirmar_pago_cubo', {
      p_pedido_id:               pedido.id,
      p_payment_intent_token:    paymentIntentToken,
      p_monto_centavos:          montoCentavosConsulta,
      p_estado_verificado:       'SUCCEEDED',
      p_cubo_identifier:         paymentIntentToken,
      p_cubo_reference_id:       referenceId       || null,
      p_cubo_authorization_code: authorizationCode || null,
      p_cubo_processed_at:       processedAt       || null,
    });

    if (rpcError) {
      registrar('error', 'rpc_fallo', { pedido_id: pedido.id, codigo: rpcError.code ?? null, detalle: rpcError.message });
      return { statusCode: 503, error: 'Error interno al confirmar pago — la función RPC puede no existir (ejecutar migración SQL)' };
    }

    const resultado = rpcResult?.resultado;

    switch (resultado) {
      case 'duplicado':
        // La RPC vio la fila bloqueada y ya pagada: otro webhook simultáneo
        // ganó la carrera. El stock ya lo descontó él, aquí no se toca nada.
        registrar('info', 'duplicado_ignorado', { pedido_id: pedido.id, via: 'rpc' });
        procesarEventosPedido(pedido.id).catch(err =>
          registrar('warn', 'eventos_pendientes_fallo', { pedido_id: pedido.id, detalle: err.message }));
        return { statusCode: 200, warning: 'pedido ya procesado', tipo: 'duplicado' };

      case 'stock_insuficiente':
        registrar('error', 'stock_insuficiente_con_pago_cobrado', {
          pedido_id: pedido.id, detalle: rpcResult, accion: 'intervencion_manual',
        });
        return { statusCode: 409, error: 'Stock insuficiente — pago recibido, intervención manual requerida', detalle: rpcResult };

      case 'token_incorrecto':
        registrar('error', 'rpc_token_incorrecto', { pedido_id: pedido.id });
        return { statusCode: 409, error: 'Token de pago no coincide (verificación RPC)' };

      case 'monto_incorrecto':
        registrar('error', 'rpc_monto_incorrecto', { pedido_id: pedido.id, detalle: rpcResult });
        return { statusCode: 409, error: 'Monto no coincide (verificación RPC)', detalle: rpcResult };

      case 'pedido_no_encontrado':
        registrar('warn', 'pedido_no_encontrado', { pedido_id: orderId, via: 'rpc' });
        return { statusCode: 200, warning: 'Pedido no encontrado (RPC)' };

      case 'items_ausentes':
        registrar('error', 'items_ausentes', { pedido_id: pedido.id, detalle: rpcResult?.detalle ?? null });
        return { statusCode: 422, error: 'Pedido sin items — no puede procesarse como pago Cubo (pedido legacy o sin pedido_items)', detalle: rpcResult };

      case 'procesado': {
        const codigoRecogida = rpcResult.codigo_recogida || pedido.codigo_recogida;

        // Convertir reserva de cupón en uso confirmado (idempotente)
        supabase.rpc('consumir_cupon_pedido', { p_pedido_id: pedido.id })
          .then(({ error }) => {
            if (error) registrar('error', 'consumir_cupon_fallo', { pedido_id: pedido.id, detalle: error.message });
          });

        // Recompensar referidor por primera compra del nuevo usuario (idempotente)
        supabase.rpc('procesar_recompensa_referido', {
          p_nuevo_usuario_id: pedido.usuario_id,
          p_pedido_id: pedido.id,
        }).then(({ data: res, error }) => {
          if (error) registrar('error', 'recompensa_referido_fallo', { pedido_id: pedido.id, detalle: error.message });
          else if (res && res !== 'sin_referidor') registrar('info', 'referido_recompensado', { pedido_id: pedido.id, resultado: res });
        });

        procesarEventosPedido(pedido.id).catch(err =>
          registrar('warn', 'eventos_post_pago_fallo', { pedido_id: pedido.id, detalle: err.message }));

        registrar('info', 'pago_confirmado', { pedido_id: pedido.id, codigo_recogida: codigoRecogida });
        return { statusCode: 200, tipo: 'procesado' };
      }

      default:
        registrar('error', 'rpc_resultado_inesperado', { pedido_id: pedido.id, resultado: resultado ?? null });
        return { statusCode: 503, error: `Resultado inesperado del procesador de pago: ${resultado}` };
    }
  }

  // ══ REJECTED / FAILED / DECLINED — no hubo cargo ═════════════════════════
  //
  // Los tres nombres describen el mismo hecho y entran por esta única rama.
  // Un rechazo nunca se ignora en silencio: se registra, se libera la reserva
  // de inventario de forma determinista y el pedido queda cancelado/fallido.
  if (estadoNormalizado === 'fallido') {
    const pedido = await buscarPedido(orderId, supabase);
    if (!pedido) {
      registrar('warn', 'pedido_no_encontrado', { pedido_id: orderId, status: rawStatus });
      return { statusCode: 200, warning: 'Pedido no encontrado' };
    }

    // Nunca sobreescribir un pedido ya pagado: un rechazo que llega tarde (o
    // duplicado) no puede cancelar un pedido que sí se cobró.
    if (pedido.estado_pago === 'pagado') {
      registrar('warn', 'rechazo_sobre_pedido_pagado_ignorado', { pedido_id: pedido.id, status: rawStatus, identifier: paymentIntentToken });
      return { statusCode: 200, warning: `pedido ya pagado — ${rawStatus} ignorado` };
    }

    // La liberación pasa por el liberador idempotente: Cubo reintenta sus
    // webhooks, y un UPDATE suelto aquí devolvía inventario en cada reintento.
    // El compare-and-swap sobre `estado` dentro de liberarInventarioPedido hace
    // que solo la primera ejecución libere de verdad; las siguientes responden
    // 'ya_cancelado' sin tocar el stock.
    const liberacion = await liberarInventarioPedido(pedido.id, {
      canceladoPor: 'sistema',
      motivo: `pago rechazado por Cubo|status:${rawStatus}|identifier:${paymentIntentToken}`,
    });

    if (!liberacion.ok) {
      // 503 hace que Cubo reintente. Es lo correcto: el pedido quedó sin
      // cancelar y el reintento es idempotente por diseño.
      registrar('error', 'liberacion_inventario_fallo', {
        pedido_id: pedido.id, status: rawStatus, tipo: liberacion.tipo, detalle: liberacion.detalle ?? null,
      });
      return { statusCode: 503, error: 'No se pudo registrar el rechazo del pago — reintentar', detalle: liberacion.tipo };
    }

    // estado_pago se marca aparte de `estado`: la máquina gobierna `estado`, y
    // 'fallido' es información de la pasarela, no un estado del pedido.
    try {
      const { error: pagoErr } = await supabase.from('pedidos')
        .update({ estado_pago: 'fallido' })
        .eq('id', pedido.id)
        .neq('estado_pago', 'pagado');
      if (pagoErr) registrar('error', 'marcar_estado_pago_fallido_error', { pedido_id: pedido.id, detalle: pagoErr.message });
    } catch (err) {
      registrar('error', 'marcar_estado_pago_fallido_excepcion', { pedido_id: pedido.id, detalle: err.message });
    }

    // Liberar reserva de cupón al rechazar el pago.
    // NOTA: .rpc(...) no expone .catch() directamente — encadenarlo así lanzaba
    // sincrónicamente y tumbaba esta función ANTES del return de abajo, así que
    // Cubo recibía 500 (y reintentaba el webhook) pese a que el pedido ya había
    // quedado bien marcado como cancelado/fallido. .then() sí devuelve una
    // promesa real, así que encadenar el catch después de él es seguro.
    supabase.rpc('liberar_reserva_cupon', { p_pedido_id: pedido.id })
      .then(({ error }) => { if (error) registrar('error', 'liberar_cupon_fallo', { pedido_id: pedido.id, detalle: error.message }); })
      .catch(err => registrar('error', 'liberar_cupon_excepcion', { pedido_id: pedido.id, detalle: err.message }));

    registrar('info', 'pago_rechazado_registrado', {
      pedido_id: pedido.id,
      status: rawStatus,
      estado_normalizado: 'fallido',
      tipo_liberacion: liberacion.tipo,
      stock_devuelto: liberacion.stockDevuelto === true,
    });
    return { statusCode: 200, tipo: 'rechazado', status: rawStatus, liberacion: liberacion.tipo };
  }

  return { statusCode: 200 };
}

module.exports = {
  procesarWebhookCubo,
  validarWebhookCubo,
  esReintentoDeUnPagoYaRegistrado,
  buscarPedido,
  registrar,
  normalizarEstadoCubo,
  ESTADOS_APROBADO,
  ESTADOS_FALLIDO,
  UUID_RE,
};
