const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

// POST /api/webhooks/cubo — Cubo Pago notifica aquí cada evento de pago
// Configurar en Cubo Admin → Developers → Webhooks → URL: https://bocara.onrender.com/api/webhooks/cubo
router.post('/cubo', async (req, res) => {
  try {
    const body = req.body;
    console.log('[CUBO WEBHOOK] Evento recibido:', JSON.stringify(body, null, 2));

    const {
      status,
      amount,
      identifier,
      referenceId,
      authorizationCode,
      processedAt,
      metadata,
    } = body;

    const orderId    = metadata?.orderId;
    const referencia = metadata?.referencia || referenceId;

    console.log('[CUBO WEBHOOK] Campos clave:', {
      status,
      amount,
      identifier,
      referenceId,
      authorizationCode,
      processedAt,
      'metadata.orderId': orderId,
    });

    if (status === 'SUCCEEDED') {
      console.log(`[CUBO WEBHOOK] Pago APROBADO — orderId: ${orderId || 'N/A'}, referencia: ${referencia || 'N/A'}`);

      if (referencia && orderId !== 'TEST-CUBO-001') {
        const { data: pedido, error } = await supabase
          .from('pedidos')
          .select('id, codigo_recogida, total')
          .eq('payu_reference_code', referencia)
          .single();

        if (error || !pedido) {
          console.warn('[CUBO WEBHOOK] Pedido no encontrado para referencia:', referencia);
        } else {
          await supabase.from('pedidos')
            .update({ estado_pago: 'pagado', estado: 'confirmado' })
            .eq('id', pedido.id);
          console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} (${pedido.codigo_recogida}) marcado como PAGADO`);
        }
      } else {
        console.log('[CUBO WEBHOOK] TEST — Pedido TEST-CUBO-001 simulado como PAGADO (no se actualiza DB)');
      }

    } else if (status === 'REJECTED' || status === 'FAILED' || status === 'CANCELLED') {
      console.log(`[CUBO WEBHOOK] Pago ${status} — orderId: ${orderId || 'N/A'}, referencia: ${referencia || 'N/A'}`);

      if (referencia && orderId !== 'TEST-CUBO-001') {
        const { data: pedido } = await supabase
          .from('pedidos')
          .select('id')
          .eq('payu_reference_code', referencia)
          .single();

        if (pedido) {
          await supabase.from('pedidos')
            .update({ estado_pago: 'fallido', estado: 'cancelado' })
            .eq('id', pedido.id);
          console.log(`[CUBO WEBHOOK] Pedido ${pedido.id} marcado como RECHAZADO`);
        }
      } else {
        console.log('[CUBO WEBHOOK] TEST — Pedido TEST-CUBO-001 simulado como RECHAZADO (no se actualiza DB)');
      }

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
