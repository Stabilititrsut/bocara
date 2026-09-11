const express = require('express');
const { procesarWebhookCubo, validarWebhookCubo, registrar } = require('../services/cuboWebhook');
const router = express.Router();

// La lógica del webhook vive en services/cuboWebhook.js — aquí solo se traduce
// su resultado a una respuesta HTTP. Se separó para poder probarla sin levantar
// express ni abrir un cliente de Supabase (ver test/cuboWebhook.test.js).

// POST /api/webhooks/cubo — URL canónica; configurar en Cubo Admin → Developers → Webhooks
// URL: https://bocara.onrender.com/api/webhooks/cubo
//
// El statusCode que devuelve procesarWebhookCubo se propaga tal cual, porque es
// lo que le dice a Cubo si debe reintentar: 2xx/4xx no, 5xx sí. Aplanarlo a 200
// haría que un fallo transitorio se tragara el pago sin reintento.
router.post('/cubo', async (req, res) => {
  try {
    const result = await procesarWebhookCubo(req.body);
    const { statusCode = 200, ...data } = result;
    return res.status(statusCode).json({ received: true, ...data });
  } catch (err) {
    // procesarWebhookCubo no debería lanzar — devuelve statusCode para todo
    // fallo esperado. Si aun así lanza, 500 para que Cubo reintente: es mejor
    // un reintento (idempotente) que dar por bueno un pago que no se procesó.
    registrar('error', 'excepcion_no_capturada', { detalle: err.message });
    return res.status(500).json({ received: true, error: 'Error interno' });
  }
});

module.exports = router;
// Re-exportados para no romper a quien ya los importaba desde aquí
// (routes/pagos.js y scripts/test-webhook-cubo.js).
module.exports.procesarWebhookCubo = procesarWebhookCubo;
module.exports.validarWebhookCubo  = validarWebhookCubo;
