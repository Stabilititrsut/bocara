const express = require('express');
const supabase = require('../config/supabase');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { consultarTransaccionCubo } = require('../services/visaLink');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Solo estados documentados oficialmente por Cubo Pago
const ESTADOS_APROBADO = new Set(['SUCCEEDED']);
const ESTADOS_FALLIDO  = new Set(['REJECTED']);

const SELECT_PEDIDO = 'id, codigo_recogida, total, tipo_entrega, bolsa_id, usuario_id, negocio_id, cantidad, estado_pago, bolsas(cantidad_disponible), usuarios(expo_push_token), negocios(propietario_id)';

async function buscarPedido(orderId) {
  if (!orderId || !UUID_RE.test(orderId)) return null;

  const { data } = await supabase.from('pedidos').select(SELECT_PEDIDO).eq('id', orderId).single();
  if (!data) return null;

  // Intentar obtener columnas de verificación Cubo (pueden no existir si migración pendiente)
  const { data: cuboData } = await supabase
    .from('pedidos')
    .select('cubo_payment_intent_token, monto_esperado_centavos')
    .eq('id', data.id)
    .single();

  return { ...data, ...(cuboData || {}) };
}

// Valida el payload y el resultado de la consulta a Cubo.
// Función pura — sin efectos de red ni BD; exportada para pruebas unitarias.
function validarWebhookCubo({ body, pedido, consulta, monedaEsperada }) {
  // 1. Campos mínimos del payload
  if (!body.identifier) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta identifier' };
  }
  if (!body.metadata?.orderId) {
    return { ok: false, statusCode: 400, error: 'payload incompleto: falta metadata.orderId' };
  }

  const rawStatus = String(body.status || '').trim().toUpperCase();

  // 2. Solo estados documentados
  if (!ESTADOS_APROBADO.has(rawStatus) && !ESTADOS_FALLIDO.has(rawStatus)) {
    return { ok: false, statusCode: 200, warning: `estado no reconocido: ${rawStatus}` };
  }

  // Para REJECTED no se requiere verificación de monto ni token (no hay cargo)
  if (ESTADOS_FALLIDO.has(rawStatus)) {
    return { ok: true, statusCode: 200, tipo: 'fallido' };
  }

  // A partir de aquí: rawStatus === 'SUCCEEDED'

  // 3. Consulta de verificación disponible
  if (!consulta) {
    return { ok: false, statusCode: 503, error: 'Verificación con Cubo no disponible temporalmente' };
  }

  // 4. Cubo confirma SUCCEEDED independientemente
  const statusConsulta = String(consulta.status || '').trim().toUpperCase();
  if (statusConsulta !== 'SUCCEEDED') {
    return { ok: false, statusCode: 409, error: `Cubo confirma estado "${statusConsulta}", no SUCCEEDED` };
  }

  // 5. Token de la consulta coincide con el identifier del webhook
  if (consulta.paymentIntentToken !== body.identifier) {
    return { ok: false, statusCode: 409, error: 'Token no coincide entre webhook identifier y consulta Cubo' };
  }

  // 6. Pedido encontrado en la BD
  if (!pedido) {
    return { ok: false, statusCode: 200, warning: 'Pedido no encontrado' };
  }

  // 7. Token almacenado en el pedido coincide (si la migración ya corrió)
  if (pedido.cubo_payment_intent_token && pedido.cubo_payment_intent_token !== body.identifier) {
    return { ok: false, statusCode: 409, error: 'Token no coincide con el almacenado en el pedido' };
  }

  // 8. Moneda
  if (consulta.currency && consulta.currency !== monedaEsperada) {
    return { ok: false, statusCode: 409, error: `Moneda no coincide: Cubo devuelve "${consulta.currency}", esperada "${monedaEsperada}"` };
  }

  // 9. Monto — Cubo devuelve string decimal ("10.00") en la consulta GET; centavos en webhook
  if (pedido.monto_esperado_centavos != null) {
    const centavosConsulta = Math.round(parseFloat(consulta.amount) * 100);
    if (centavosConsulta !== pedido.monto_esperado_centavos) {
      return {
        ok: false,
        statusCode: 409,
        error: `Monto no coincide: consulta ${centavosConsulta}¢ ≠ esperado ${pedido.monto_esperado_centavos}¢`,
      };
    }
  }

  // 10. Idempotencia: ya fue procesado
  if (pedido.estado_pago === 'pagado') {
    return { ok: true, statusCode: 200, tipo: 'duplicado' };
  }

  return { ok: true, statusCode: 200, tipo: 'aprobado' };
}

// Procesa un evento de pago de Cubo — compartido por la ruta canónica y la legacy.
async function procesarWebhookCubo(body) {
  const rawStatus = String(body.status || '').trim().toUpperCase();
  const paymentIntentToken = body.identifier;
  const { referenceId, authorizationCode, processedAt, metadata } = body;
  const orderId = metadata?.orderId;

  console.log('[CUBO WEBHOOK] status:', rawStatus, '| identifier:', paymentIntentToken);
  console.log('[CUBO WEBHOOK] metadata.orderId:', orderId);

  // Validación rápida del payload (sin consultar Cubo ni BD)
  const validacionBasica = validarWebhookCubo({ body, pedido: null, consulta: null, monedaEsperada: '' });
  if (!validacionBasica.ok && validacionBasica.statusCode === 400) {
    console.warn('[CUBO WEBHOOK] Payload incompleto:', validacionBasica.error, '| keys:', Object.keys(body).join(','));
    return validacionBasica;
  }
  if (!ESTADOS_APROBADO.has(rawStatus) && !ESTADOS_FALLIDO.has(rawStatus)) {
    console.log('[CUBO WEBHOOK] Estado no reconocido:', rawStatus, '— ignorando');
    return { statusCode: 200, warning: validacionBasica.warning };
  }

  // ── SUCCEEDED: verificar con Cubo antes de tocar la BD ──────────────────────
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
      // Error de red o servidor Cubo caído → no confirmar; devolver 502 para que Cubo reintente
      console.error('[CUBO WEBHOOK] No se pudo verificar transacción con Cubo:', err.code, err.message);
      return { statusCode: 502, error: 'Verificación con Cubo temporalmente no disponible — reintenta' };
    }

    const pedido = await buscarPedido(orderId);
    const monedaEsperada = process.env.CUBO_CURRENCY || 'USD';

    const validacion = validarWebhookCubo({ body, pedido, consulta, monedaEsperada });
    console.log('[CUBO WEBHOOK] Validación:', JSON.stringify(validacion));

    if (!validacion.ok) {
      console.error('[CUBO WEBHOOK] Fallo de verificación:', validacion.error || validacion.warning, '| pedido:', orderId);
      return validacion;
    }

    if (validacion.tipo === 'duplicado') {
      console.log('[CUBO WEBHOOK] Pedido ya pagado (fast path):', pedido.id);
      return { statusCode: 200, warning: 'pedido ya procesado' };
    }

    // Actualización condicional atómica: solo actualiza si el pedido todavía no está pagado.
    // Dos webhooks concurrentes compiten aquí; PostgreSQL garantiza que solo uno gana.
    const { data: updatedPedido, error: updateErr } = await supabase
      .from('pedidos')
      .update({
        estado_pago:             'pagado',
        estado:                  'confirmado',
        cubo_identifier:         paymentIntentToken,
        cubo_authorization_code: authorizationCode || null,
        cubo_reference_id:       referenceId       || null,
        pagado_en:               processedAt       || new Date().toISOString(),
      })
      .eq('id', pedido.id)
      .neq('estado_pago', 'pagado')
      .select('id')
      .maybeSingle();

    if (updateErr) {
      // Columnas opcionales no existen aún → reintentar sin ellas
      console.warn('[CUBO WEBHOOK] Columnas opcionales no disponibles (', updateErr.code, ') — reintentando sin ellas');
      const { data: u2, error: e2 } = await supabase
        .from('pedidos')
        .update({ estado_pago: 'pagado', estado: 'confirmado' })
        .eq('id', pedido.id)
        .neq('estado_pago', 'pagado')
        .select('id')
        .maybeSingle();
      if (e2) {
        console.error('[CUBO WEBHOOK] Error crítico actualizando pedido:', e2);
        return { statusCode: 500, error: 'Error al actualizar pedido' };
      }
      if (!u2) {
        console.log('[CUBO WEBHOOK] Pedido ya procesado (webhook concurrente ganó, retry):', pedido.id);
        return { statusCode: 200, warning: 'pedido ya procesado' };
      }
      console.log('[CUBO WEBHOOK] Pedido actualizado (sin cols extra):', pedido.id, '→ confirmado/pagado');
    } else if (!updatedPedido) {
      console.log('[CUBO WEBHOOK] Pedido ya procesado (webhook concurrente ganó la carrera atómica):', pedido.id);
      return { statusCode: 200, warning: 'pedido ya procesado' };
    } else {
      console.log('[CUBO WEBHOOK] Pedido actualizado:', updatedPedido.id, '→ confirmado/pagado | token:', paymentIntentToken);
    }

    // Decrementar stock — no usar Math.max; stock insuficiente requiere intervención manual
    const { data: pedidoItems } = await supabase
      .from('pedido_items').select('bolsa_id, cantidad').eq('pedido_id', pedido.id);

    if (pedidoItems && pedidoItems.length > 0) {
      for (const pi of pedidoItems) {
        const { data: b } = await supabase.from('bolsas').select('cantidad_disponible').eq('id', pi.bolsa_id).single();
        if (b) {
          if (b.cantidad_disponible < pi.cantidad) {
            console.error('[CUBO WEBHOOK] CRÍTICO: Stock insuficiente bolsa:', pi.bolsa_id,
              '| disponible:', b.cantidad_disponible, '| solicitado:', pi.cantidad,
              '| pedido:', pedido.id, '— requiere intervención manual');
          } else {
            await supabase.from('bolsas')
              .update({ cantidad_disponible: b.cantidad_disponible - pi.cantidad })
              .eq('id', pi.bolsa_id);
            console.log('[CUBO WEBHOOK] Bolsa:', pi.bolsa_id, 'stock:', b.cantidad_disponible, '→', b.cantidad_disponible - pi.cantidad);
          }
        }
      }
    } else {
      // Fallback: pedido con bolsa única
      const cantDisp         = pedido.bolsas?.cantidad_disponible ?? 0;
      const cantidadComprada = pedido.cantidad || 1;
      if (cantDisp < cantidadComprada) {
        console.error('[CUBO WEBHOOK] CRÍTICO: Stock insuficiente bolsa:', pedido.bolsa_id,
          '| disponible:', cantDisp, '| solicitado:', cantidadComprada,
          '| pedido:', pedido.id, '— requiere intervención manual');
      } else {
        await supabase.from('bolsas')
          .update({ cantidad_disponible: cantDisp - cantidadComprada })
          .eq('id', pedido.bolsa_id);
        console.log('[CUBO WEBHOOK] Bolsa:', pedido.bolsa_id, 'stock:', cantDisp, '→', cantDisp - cantidadComprada, '(fallback)');
      }
    }

    // Sumar puntos al cliente
    try {
      const { data: cfg } = await supabase.from('configuracion').select('valor').eq('clave', 'puntos_por_pedido').single();
      const puntos = cfg ? parseInt(cfg.valor) : 10;
      await supabase.rpc('sumar_puntos', { user_id: pedido.usuario_id, puntos });
    } catch {}

    // Notificar al cliente
    const mensajeCliente = pedido.tipo_entrega === 'recogida'
      ? `Código de recogida: ${pedido.codigo_recogida} — ¡Ya puedes ir!`
      : 'Tu pedido está siendo preparado. Te avisamos cuando salga.';

    await enviarNotificacionPush(
      pedido.usuarios?.expo_push_token,
      '✅ ¡Pago confirmado!', mensajeCliente,
      { pedidoId: pedido.id, screen: 'pedidos' }
    ).catch(() => {});

    await guardarNotificacion(
      supabase, pedido.usuario_id, 'pago_confirmado',
      '✅ Pago confirmado', mensajeCliente, { pedidoId: pedido.id }
    ).catch(() => {});

    // Notificar al restaurante
    if (pedido.negocios?.propietario_id) {
      const { data: propietario } = await supabase
        .from('usuarios').select('expo_push_token').eq('id', pedido.negocios.propietario_id).single();
      const mensajeRest = `Pedido ${pedido.codigo_recogida} — Q${pedido.total}`;
      await enviarNotificacionPush(
        propietario?.expo_push_token,
        '🛍️ Nuevo pedido', mensajeRest,
        { pedidoId: pedido.id, screen: 'restaurante' }
      ).catch(() => {});
      await guardarNotificacion(
        supabase, pedido.negocios.propietario_id, 'nuevo_pedido',
        '🛍️ Nuevo pedido', mensajeRest, { pedidoId: pedido.id }
      ).catch(() => {});
    }

    console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} (${pedido.codigo_recogida}) PAGADO — notificaciones enviadas`);
    return { statusCode: 200 };

  }

  // ── REJECTED: marcar fallido sin verificar monto (sin cargo) ────────────────
  if (ESTADOS_FALLIDO.has(rawStatus)) {
    const pedido = await buscarPedido(orderId);
    if (!pedido) {
      console.warn('[CUBO WEBHOOK] Pedido no encontrado para REJECTED — orderId:', orderId);
      return { statusCode: 200, warning: 'Pedido no encontrado' };
    }
    await supabase.from('pedidos')
      .update({ estado_pago: 'fallido', estado: 'cancelado' })
      .eq('id', pedido.id)
      .neq('estado_pago', 'pagado'); // no sobreescribir un pago ya confirmado
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
