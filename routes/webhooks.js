const express = require('express');
const supabase = require('../config/supabase');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Busca un pedido por UUID directo (metadata.orderId) o por referenceCode (metadata.referencia)
async function buscarPedido(orderId, referencia) {
  const SELECT = 'id, codigo_recogida, total, tipo_entrega, bolsa_id, usuario_id, negocio_id, cantidad, bolsas(cantidad_disponible), usuarios(expo_push_token), negocios(propietario_id)';

  // Estrategia 1: orderId es un UUID real de pedido
  if (orderId && UUID_RE.test(orderId)) {
    const { data } = await supabase
      .from('pedidos').select(SELECT).eq('id', orderId).single();
    if (data) return data;
  }

  // Estrategia 2: buscar por payu_reference_code (la referencia enviada al crear el link)
  if (referencia) {
    const { data } = await supabase
      .from('pedidos').select(SELECT).eq('payu_reference_code', referencia).single();
    if (data) return data;
  }

  return null;
}

// POST /api/webhooks/cubo — Cubo Pago notifica aquí cada evento de pago
// Configurar en Cubo Admin → Developers → Webhooks → URL: https://bocara.onrender.com/api/webhooks/cubo
router.post('/cubo', async (req, res) => {
  // Siempre responder 200 al final para que Cubo no reintente indefinidamente
  try {
    const body = req.body;
    console.log('[CUBO WEBHOOK] Evento recibido:', JSON.stringify(body, null, 2));

    const { status, amount, identifier, referenceId, authorizationCode, processedAt, metadata } = body;

    const orderId    = metadata?.orderId;
    const referencia = metadata?.referencia || referenceId;

    console.log('[CUBO WEBHOOK] orderId:', orderId);
    console.log('[CUBO WEBHOOK] status:', status);
    console.log('[CUBO WEBHOOK] referencia:', referencia);
    console.log('[CUBO WEBHOOK] identifier:', identifier);
    console.log('[CUBO WEBHOOK] authorizationCode:', authorizationCode);
    console.log('[CUBO WEBHOOK] amount:', amount);

    if (!orderId && !referencia) {
      console.warn('[CUBO WEBHOOK] Sin orderId ni referencia — ignorando evento');
      return res.status(200).json({ received: true, warning: 'metadata.orderId missing' });
    }

    // ── PAGO APROBADO ──────────────────────────────────────────────────────
    if (status === 'SUCCEEDED') {
      const pedido = await buscarPedido(orderId, referencia);

      if (!pedido) {
        console.warn(`[CUBO WEBHOOK] Pedido no encontrado — orderId: ${orderId}, referencia: ${referencia}`);
        return res.status(200).json({ received: true, warning: 'Pedido no encontrado' });
      }

      // Actualizar estado del pedido
      const { data: updatedPedido, error: updateErr } = await supabase
        .from('pedidos')
        .update({ estado_pago: 'pagado', estado: 'confirmado' })
        .eq('id', pedido.id)
        .select()
        .single();

      if (updateErr) {
        console.error('[CUBO WEBHOOK] Error actualizando pedido:', updateErr);
      } else {
        console.log('[CUBO WEBHOOK] Pedido actualizado:', updatedPedido?.id, '→ estado: confirmado, estado_pago: pagado');
      }

      // Decrementar stock — primero intenta con pedido_items (multi-bolsa)
      const { data: pedidoItems } = await supabase
        .from('pedido_items').select('bolsa_id, cantidad').eq('pedido_id', pedido.id);

      if (pedidoItems && pedidoItems.length > 0) {
        // Carrito con múltiples bolsas: descontar cada una
        for (const pi of pedidoItems) {
          const { data: b } = await supabase.from('bolsas').select('cantidad_disponible').eq('id', pi.bolsa_id).single();
          if (b) {
            const nuevoStock = Math.max(0, b.cantidad_disponible - pi.cantidad);
            await supabase.from('bolsas').update({ cantidad_disponible: nuevoStock }).eq('id', pi.bolsa_id);
            console.log(`[CUBO WEBHOOK] Stock bolsa ${pi.bolsa_id}: ${b.cantidad_disponible} → ${nuevoStock} (compradas: ${pi.cantidad})`);
          }
        }
      } else {
        // Fallback: pedido antiguo con una sola bolsa
        const cantDisp = pedido.bolsas?.cantidad_disponible ?? 0;
        const cantidadComprada = pedido.cantidad || 1;
        const nuevoStock = Math.max(0, cantDisp - cantidadComprada);
        if (cantDisp > 0) {
          await supabase.from('bolsas').update({ cantidad_disponible: nuevoStock }).eq('id', pedido.bolsa_id);
          console.log(`[CUBO WEBHOOK] Stock bolsa ${pedido.bolsa_id}: ${cantDisp} → ${nuevoStock} (fallback)`);
        }
      }

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

      console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} (${pedido.codigo_recogida}) marcado PAGADO — notificaciones enviadas`);

    // ── PAGO RECHAZADO / FALLIDO / CANCELADO ───────────────────────────────
    } else if (status === 'REJECTED' || status === 'FAILED' || status === 'CANCELLED') {
      const pedido = await buscarPedido(orderId, referencia);

      if (!pedido) {
        console.warn(`[CUBO WEBHOOK] Pedido no encontrado para estado ${status}`);
        return res.status(200).json({ received: true, warning: 'Pedido no encontrado' });
      }

      await supabase.from('pedidos')
        .update({ estado_pago: 'fallido', estado: 'cancelado' })
        .eq('id', pedido.id);

      console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} marcado como ${status} → estado: cancelado, estado_pago: fallido`);

    // ── ESTADO NO RECONOCIDO ───────────────────────────────────────────────
    } else {
      console.log(`[CUBO WEBHOOK] Estado no manejado: ${status}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[CUBO WEBHOOK] Error interno:', err.message);
    res.status(200).json({ received: true });
  }
});

module.exports = router;
