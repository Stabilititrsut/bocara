/**
 * Cubo Pago Guatemala — https://developers.cubopago.com
 * Autenticación: X-API-KEY header (no requiere login previo)
 * Monto: en centavos (integer)
 */
const axios = require('axios');

function resolverCredenciales() {
  const url = process.env.CUBO_API_URL;
  let key = process.env.CUBO_API_KEY;
  if (!key && process.env.CUBO_ENVIRONMENT !== 'production') {
    key = process.env.CUBOPAGO_API_KEY;
    if (key) console.warn('[CUBO] Usando CUBOPAGO_API_KEY como fallback de desarrollo. Configure CUBO_API_KEY en producción.');
  }
  if (!url) throw new Error('CUBO_API_URL no configurada en el servidor');
  if (!key) throw new Error('CUBO_API_KEY no configurada en el servidor');
  return { url, key };
}

function manejarErrorAxios(err) {
  if (!err.response) throw new Error(`Cubo Pago: error de red — ${err.message}`);
  const status  = err.response.status;
  // Log completo sin datos sensibles — ayuda a identificar el campo rechazado en 422
  console.error('[CUBO] Error HTTP:', status, '| Body completo:', JSON.stringify(err.response.data));
  const msg     = err.response.data?.message ?? err.message;
  const detalle = Array.isArray(msg) ? msg.join(', ') : String(msg);
  if (status === 401 || status === 403) throw new Error('Cubo Pago: API key inválida o sin permisos (401/403)');
  if (status === 400) throw new Error(`Cubo Pago: solicitud inválida — ${detalle}`);
  if (status === 422) throw new Error(`Cubo Pago error 422 (ver logs del servidor para body completo): ${detalle}`);
  throw new Error(`Cubo Pago error ${status}: ${detalle}`);
}

async function generarLinkPago({ referencia, pedidoId, titulo, monto, urlRedireccion, cliente, items }) {
  const { url: cuboApiUrl, key: cuboApiKey } = resolverCredenciales();

  const montoCentavos = Math.round(parseFloat(monto) * 100);

  if (montoCentavos <= 0) {
    throw new Error(`Monto inválido para Cubo: Q${monto} → ${montoCentavos} centavos. El total no puede ser cero o negativo.`);
  }

  console.log('[CUBO] monto GTQ:', parseFloat(monto).toFixed(2), '| centavos:', montoCentavos, '| moneda: GTQ');

  // metadata es devuelta sin cambios por Cubo en el webhook — incluir orderId (UUID del pedido)
  const body = {
    description: titulo,
    amount:      montoCentavos,
    redirectUri: urlRedireccion,
    metadata:    { referencia, orderId: pedidoId, pedidoId },
  };

  if (cliente?.nombre)   body.clientName  = cliente.nombre;
  if (cliente?.email)    body.clientEmail = cliente.email;
  if (cliente?.telefono) body.clientPhone = cliente.telefono;
  if (items?.length)     body.items       = items;

  let data;
  console.log('4. Llamando a CuboPago sandbox:', cuboApiUrl);
  console.log('5. Body enviado:', JSON.stringify(body));
  try {
    ({ data } = await axios.post(`${cuboApiUrl}/api/v1/links/one-use`, body, {
      headers: { 'X-API-KEY': cuboApiKey, 'Content-Type': 'application/json' },
      timeout: 10000,
    }));
    console.log('6. Respuesta CuboPago:', data);
  } catch (err) {
    manejarErrorAxios(err);
  }

  if (!data?.cuboRedirectUri) {
    throw new Error(`Cubo Pago: respuesta inesperada — ${JSON.stringify(data)}`);
  }

  return {
    url:   data.cuboRedirectUri,
    token: data.paymentIntentToken,
  };
}

// Consulta el estado de una transacción directamente en Cubo.
// Usada por el webhook para verificación independiente antes de confirmar un pago.
// Errores tipados: { code: 'NOT_FOUND' | 'AUTH_ERROR' | 'NETWORK_ERROR' | 'HTTP_ERROR' }
async function consultarTransaccionCubo(paymentIntentToken) {
  if (!paymentIntentToken || typeof paymentIntentToken !== 'string') {
    const err = new Error('paymentIntentToken requerido para consultar transacción');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const { url: cuboApiUrl, key: cuboApiKey } = resolverCredenciales();

  let data;
  try {
    ({ data } = await axios.get(
      `${cuboApiUrl}/api/v1/transactions/${encodeURIComponent(paymentIntentToken)}`,
      {
        headers: { 'X-API-KEY': cuboApiKey },
        timeout: 10000,
      }
    ));
  } catch (err) {
    if (!err.response) {
      const e = new Error(`Cubo Pago: error de red consultando transacción — ${err.message}`);
      e.code = 'NETWORK_ERROR';
      throw e;
    }
    const status = err.response.status;
    if (status === 404) {
      const e = new Error(`Cubo Pago: transacción no encontrada — ${paymentIntentToken}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (status === 401 || status === 403) {
      const e = new Error('Cubo Pago: API key inválida consultando transacción (401/403)');
      e.code = 'AUTH_ERROR';
      throw e;
    }
    const e = new Error(`Cubo Pago error ${status} consultando transacción`);
    e.code = 'HTTP_ERROR';
    e.httpStatus = status;
    throw e;
  }

  return data;
}

module.exports = { generarLinkPago, consultarTransaccionCubo };
