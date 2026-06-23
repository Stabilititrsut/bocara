const express = require('express');
const supabase = require('../config/supabase');
const { consultarTransaccionCubo } = require('../services/visaLink');
const { procesarEventosPedido } = require('../services/pagoEventos');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Solo estados documentados oficialmente por Cubo Pago
const ESTADOS_APROBADO = new Set(['SUCCEEDED']);
const ESTADOS_FALLIDO  = new Set(['REJECTED']);

const SELECT_PEDIDO = 'id, codigo_recogida, total, tipo_entrega, bolsa_id, usuario_id, negocio_id, cantidad, estado_pago, bolsas(cantidad_disponible), usuarios(expo_push_token), negocios(propietario_id)';

// Busca el pedido y sus columnas de verificación Cubo.
// Si las columnas no existen (migración pendiente), devuelve _cuboColumnsMissing: true
// para que el flujo falle cerrado en lugar de omitir las verificaciones.
async function buscarPedido(orderId) {
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
//
// FAIL-CLOSED: cualquier dato de verificación ausente o inválido detiene el procesamiento.
// Nunca continuar con stock, puntos, QR ni notificaciones si la validación falla.
function validarWebhookCubo({ body, pedido, consulta, monedaEsperada }) {
  // 1. Campos mínimos del payload
  if (!body.identifier) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta identifier' };
  }
  if (!body.metadata?.orderId) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta metadata.orderId' };
  }

  const rawStatus = String(body.status || '').trim().toUpperCase();

  // 2. Solo estados documentados por Cubo
  if (!ESTADOS_APROBADO.has(rawStatus) && !ESTADOS_FALLIDO.has(rawStatus)) {
    return { ok: false, statusCode: 200, warning: `estado no reconocido: ${rawStatus}` };
  }

  // Para REJECTED no hay cargo — no se requiere verificación de monto ni token
  if (ESTADOS_FALLIDO.has(rawStatus)) {
    return { ok: true, statusCode: 200, tipo: 'fallido' };
  }

  // ── A partir de aquí: rawStatus === 'SUCCEEDED' ──────────────────────────────

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

// Procesa un evento de pago de Cubo.
// Compartido por la ruta canónica (/api/webhooks/cubo) y la legacy (/api/pagos/cubo-webhook).
async function procesarWebhookCubo(body) {
  const rawStatus          = String(body.status || '').trim().toUpperCase();
  const paymentIntentToken = body.identifier;
  const { referenceId, authorizationCode, processedAt, metadata } = body;
  const orderId            = metadata?.orderId;

  console.log('[CUBO WEBHOOK] status:', rawStatus, '| identifier:', paymentIntentToken);
  console.log('[CUBO WEBHOOK] metadata.orderId:', orderId);

  // Validar payload antes de tocar la red o la BD
  if (!paymentIntentToken || !orderId) {
    const missing = [!paymentIntentToken && 'identifier', !orderId && 'metadata.orderId'].filter(Boolean);
    console.warn('[CUBO WEBHOOK] Payload incompleto — faltan:', missing.join(', '), '| keys:', Object.keys(body).join(','));
    return { statusCode: 400, error: `payload incompleto: faltan ${missing.join(', ')}` };
  }

  if (!ESTADOS_APROBADO.has(rawStatus) && !ESTADOS_FALLIDO.has(rawStatus)) {
    console.log('[CUBO WEBHOOK] Estado no reconocido:', rawStatus, '— ignorando');
    return { statusCode: 200, warning: `estado no reconocido: ${rawStatus}` };
  }

  // ── SUCCEEDED: verificar con Cubo ANTES de cualquier escritura en BD ────────
  if (ESTADOS_APROBADO.has(rawStatus)) {
    let consulta;
    try {
      consulta = await consultarTransaccionCubo(paymentIntentToken);
      console.log('[CUBO WEBHOOK] Consulta Cubo OK — status:', consulta.status, '| currency:', consulta.currency, '| amount:', consulta.amount);
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        console.error('[CUBO WEBHOOK] Transacción no encontrada en Cubo:', paymentIntentToken);
        return { statusCode: 409, error: 'Transacción no encontrada en Cubo al verificar' };
      }
      // Error de red o Cubo caído → devolver 502 para que Cubo reintente el webhook
      console.error('[CUBO WEBHOOK] No se pudo verificar transacción con Cubo:', err.code, err.message);
      return { statusCode: 502, error: 'Verificación con Cubo temporalmente no disponible — reintentar' };
    }

    const pedido        = await buscarPedido(orderId);
    const monedaEsperada = process.env.CUBO_CURRENCY || 'USD';

    const validacion = validarWebhookCubo({ body, pedido, consulta, monedaEsperada });
    console.log('[CUBO WEBHOOK] Validación:', JSON.stringify(validacion));

    if (!validacion.ok) {
      console.error('[CUBO WEBHOOK] Verificación falló:', validacion.error || validacion.warning, '| pedido:', orderId);
      return validacion;
    }

    if (validacion.tipo === 'duplicado') {
      console.log('[CUBO WEBHOOK] Fast-path: pedido ya pagado:', pedido.id);
      procesarEventosPedido(pedido.id).catch(err =>
        console.warn('[CUBO WEBHOOK] Error procesando eventos pendientes (fast-path duplicado):', err.message)
      );
      return { statusCode: 200, warning: 'pedido ya procesado' };
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
      console.error('[CUBO WEBHOOK] Error RPC confirmar_pago_cubo:', rpcError.code, rpcError.message);
      return { statusCode: 503, error: 'Error interno al confirmar pago — la función RPC puede no existir (ejecutar migración SQL)' };
    }

    const resultado = rpcResult?.resultado;
    console.log('[CUBO WEBHOOK] RPC resultado:', resultado, '| pedido:', pedido.id);

    switch (resultado) {
      case 'duplicado':
        procesarEventosPedido(pedido.id).catch(err =>
          console.warn('[CUBO WEBHOOK] Error procesando eventos pendientes (RPC duplicado):', err.message)
        );
        return { statusCode: 200, warning: 'pedido ya procesado' };

      case 'stock_insuficiente':
        console.error('[CUBO WEBHOOK] CRÍTICO: Stock insuficiente —', JSON.stringify(rpcResult), '| pedido:', pedido.id, '— requiere intervención manual');
        return { statusCode: 409, error: 'Stock insuficiente — pago recibido, intervención manual requerida', detalle: rpcResult };

      case 'token_incorrecto':
        console.error('[CUBO WEBHOOK] Token incorrecto en RPC — pedido:', pedido.id);
        return { statusCode: 409, error: 'Token de pago no coincide (verificación RPC)' };

      case 'monto_incorrecto':
        console.error('[CUBO WEBHOOK] Monto incorrecto en RPC:', JSON.stringify(rpcResult));
        return { statusCode: 409, error: 'Monto no coincide (verificación RPC)', detalle: rpcResult };

      case 'pedido_no_encontrado':
        return { statusCode: 200, warning: 'Pedido no encontrado (RPC)' };

      case 'items_ausentes':
        console.error('[CUBO WEBHOOK] Pedido sin items en pedido_items:', pedido.id, '—', rpcResult.detalle);
        return { statusCode: 422, error: 'Pedido sin items — no puede procesarse como pago Cubo (pedido legacy o sin pedido_items)', detalle: rpcResult };

      case 'procesado': {
        const codigoRecogida = rpcResult.codigo_recogida || pedido.codigo_recogida;
        procesarEventosPedido(pedido.id).catch(err =>
          console.warn('[CUBO WEBHOOK] Error procesando eventos post-pago:', err.message)
        );
        console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} CONFIRMADO — código: ${codigoRecogida}`);
        return { statusCode: 200 };
      }

      default:
        console.error('[CUBO WEBHOOK] RPC resultado inesperado:', resultado);
        return { statusCode: 503, error: `Resultado inesperado del procesador de pago: ${resultado}` };
    }

  }

  // ── REJECTED: marcar fallido sin cargo, sin verificación de monto ────────────
  if (ESTADOS_FALLIDO.has(rawStatus)) {
    const pedido = await buscarPedido(orderId);
    if (!pedido) {
      console.warn('[CUBO WEBHOOK] Pedido no encontrado para REJECTED — orderId:', orderId);
      return { statusCode: 200, warning: 'Pedido no encontrado' };
    }
    // No sobreescribir un pedido ya pagado; idempotente en re-ejecución
    await supabase.from('pedidos')
      .update({ estado_pago: 'fallido', estado: 'cancelado' })
      .eq('id', pedido.id)
      .neq('estado_pago', 'pagado');
    console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} marcado fallido/cancelado — status Cubo: ${rawStatus}`);
    return { statusCode: 200 };
  }

  return { statusCode: 200 };
}

// POST /api/webhooks/cubo — URL canónica; configurar en Cubo Admin → Developers → Webhooks
// URL: https://bocara.onrender.com/api/webhooks/cubo
router.post('/cubo', async (req, res) => {
  try {
    console.log('[CUBO WEBHOOK] body completo:', JSON.stringify(req.body, null, 2));
    const result = await procesarWebhookCubo(req.body);
    const { statusCode = 200, ...data } = result;
    return res.status(statusCode).json({ received: true, ...data });
  } catch (err) {
    console.error('[CUBO WEBHOOK] Error interno no capturado:', err.message);
    return res.status(500).json({ received: true, error: 'Error interno' });
  }
});

module.exports = router;
module.exports.procesarWebhookCubo = procesarWebhookCubo;
module.exports.validarWebhookCubo  = validarWebhookCubo;
