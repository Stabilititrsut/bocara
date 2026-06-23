const express = require('express');
const supabase = require('../config/supabase');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Provisional — confirmar con integracion@cubopago.com el listado oficial de estados antes de producción real
const ESTADOS_APROBADO = new Set(['SUCCEEDED', 'PAID', 'APPROVED']);
const ESTADOS_FALLIDO  = new Set(['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED']);

// Busca un pedido usando múltiples estrategias para cubrir variaciones del webhook de Cubo
async function buscarPedido(orderId, referencia) {
  const SELECT = 'id, codigo_recogida, total, tipo_entrega, bolsa_id, usuario_id, negocio_id, cantidad, estado_pago, bolsas(cantidad_disponible), usuarios(expo_push_token), negocios(propietario_id)';

  // Estrategia 1: UUID directo → buscar por pedidos.id
  const uuids = [orderId].filter(v => v && UUID_RE.test(v));
  for (const uuid of uuids) {
    const { data } = await supabase.from('pedidos').select(SELECT).eq('id', uuid).single();
    if (data) return data;
  }

  // Estrategia 2: código de referencia → buscar por payu_reference_code
  const refs = [...new Set([referencia].filter(Boolean))];
  for (const ref of refs) {
    const { data } = await supabase.from('pedidos').select(SELECT).eq('payu_reference_code', ref).single();
    if (data) return data;
  }

  return null;
}

// Procesa un evento de pago de Cubo — compartido por la ruta canónica y la legacy.
// NOTA DE SEGURIDAD: hasta que Cubo confirme firma/secreto/IP o endpoint GET de verificación,
// no se puede autenticar criptográficamente el origen de este evento.
async function procesarWebhookCubo(body) {
  const rawStatus  = String(body.status || '').trim().toUpperCase();
  const { identifier, referenceId, authorizationCode, processedAt, metadata } = body;
  const orderId    = metadata?.orderId || metadata?.pedidoId;
  const referencia = metadata?.referencia || referenceId;

  console.log('[CUBO WEBHOOK] status:', rawStatus, '| identifier:', identifier);
  console.log('[CUBO WEBHOOK] buscando pedido por:', { orderId, referencia });

  if (!orderId && !referencia) {
    console.warn('[CUBO WEBHOOK] Sin orderId ni referencia — ignorando. Claves body:', Object.keys(body).join(','));
    return { warning: 'no se encontró identificador de pedido en el webhook' };
  }

  if (ESTADOS_APROBADO.has(rawStatus)) {
    const pedido = await buscarPedido(orderId, referencia);
    if (!pedido) {
      console.warn(`[CUBO WEBHOOK] Pedido no encontrado — orderId: ${orderId}, referencia: ${referencia}`);
      return { warning: 'Pedido no encontrado' };
    }

    // Optimización: fast-path para webhooks claramente duplicados
    // La barrera real de concurrencia está en el UPDATE condicional de abajo
    if (pedido.estado_pago === 'pagado') {
      console.log('[CUBO WEBHOOK] Pedido ya pagado (fast path):', pedido.id);
      return { warning: 'pedido ya procesado' };
    }

    // Actualización condicional atómica: solo actualiza si el pedido todavía no está pagado.
    // Dos webhooks concurrentes que pasen el fast-path compiten aquí;
    // PostgreSQL garantiza que solo uno gana — el otro obtiene 0 filas actualizadas.
    // Columnas cubo_identifier etc. son opcionales (ver SQL en docs/cubo-sandbox-test.md § 7)
    const { data: updatedPedido, error: updateErr } = await supabase
      .from('pedidos')
      .update({
        estado_pago:             'pagado',
        estado:                  'confirmado',
        cubo_identifier:         identifier         || null,
        cubo_authorization_code: authorizationCode  || null,
        pagado_en:               processedAt        || new Date().toISOString(),
      })
      .eq('id', pedido.id)
      .neq('estado_pago', 'pagado')
      .select('id')
      .maybeSingle();

    if (updateErr) {
      // Columnas opcionales no existen aún → reintentar sin ellas (misma barrera atómica)
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
        return { error: 'Error al actualizar pedido' };
      }
      if (!u2) {
        console.log('[CUBO WEBHOOK] Pedido ya procesado (webhook concurrente ganó la carrera, retry):', pedido.id);
        return { warning: 'pedido ya procesado' };
      }
      console.log('[CUBO WEBHOOK] Pedido actualizado (sin cols extra):', pedido.id, '→ confirmado/pagado');
    } else if (!updatedPedido) {
      // UPDATE no afectó ninguna fila: webhook concurrente ganó la carrera atómica
      console.log('[CUBO WEBHOOK] Pedido ya procesado (webhook concurrente ganó la carrera atómica):', pedido.id);
      return { warning: 'pedido ya procesado' };
    } else {
      console.log('[CUBO WEBHOOK] Pedido actualizado:', updatedPedido.id, '→ confirmado/pagado | identifier:', identifier);
    }

    // Decrementar stock — primero intenta con pedido_items (carrito multi-bolsa)
    // No usar Math.max para sobreventas: si hay insuficiencia, registrar crítico sin descontar
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
            // No decrementar — el pago fue recibido pero el inventario debe corregirse manualmente
          } else {
            await supabase.from('bolsas')
              .update({ cantidad_disponible: b.cantidad_disponible - pi.cantidad })
              .eq('id', pi.bolsa_id);
            console.log('[CUBO WEBHOOK] Bolsa:', pi.bolsa_id, 'stock:', b.cantidad_disponible, '→', b.cantidad_disponible - pi.cantidad);
          }
        }
      }
    } else {
      // Fallback: pedido antiguo con una sola bolsa
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

  } else if (ESTADOS_FALLIDO.has(rawStatus)) {
    const pedido = await buscarPedido(orderId, referencia);
    if (!pedido) {
      console.warn(`[CUBO WEBHOOK] Pedido no encontrado para estado ${rawStatus}`);
      return { warning: 'Pedido no encontrado' };
    }
    await supabase.from('pedidos')
      .update({ estado_pago: 'fallido', estado: 'cancelado' })
      .eq('id', pedido.id);
    console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} marcado ${rawStatus} → cancelado/fallido`);

  } else {
    console.log(`[CUBO WEBHOOK] Estado no reconocido: ${rawStatus}`);
  }

  return {};
}

// POST /api/webhooks/cubo — URL canónica; configurar en Cubo Admin → Developers → Webhooks
// URL: https://bocara.onrender.com/api/webhooks/cubo
router.post('/cubo', async (req, res) => {
  try {
    console.log('[CUBO WEBHOOK] body completo:', JSON.stringify(req.body, null, 2));
    const result = await procesarWebhookCubo(req.body);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error('[CUBO WEBHOOK] Error interno:', err.message);
    res.status(200).json({ received: true });
  }
});

module.exports = router;
module.exports.procesarWebhookCubo = procesarWebhookCubo;
