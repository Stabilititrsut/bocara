/**
 * Cubo Pago Guatemala — https://developers.cubopago.com
 * Autenticación: X-API-KEY header (no requiere login previo)
 * Monto: en centavos (integer)
 */
const axios = require('axios');

async function generarLinkPago({ referencia, pedidoId, titulo, monto, urlRedireccion, cliente, items }) {
  const cuboApiUrl = process.env.CUBO_API_URL;
  let cuboApiKey = process.env.CUBO_API_KEY;

  // En desarrollo se acepta CUBOPAGO_API_KEY como fallback con advertencia explícita
  if (!cuboApiKey && process.env.CUBO_ENVIRONMENT !== 'production') {
    cuboApiKey = process.env.CUBOPAGO_API_KEY;
    if (cuboApiKey) {
      console.warn('[CUBO] Usando CUBOPAGO_API_KEY como fallback de desarrollo. Configure CUBO_API_KEY en producción.');
    }
  }

  if (!cuboApiUrl) throw new Error('CUBO_API_URL no configurada en el servidor');
  if (!cuboApiKey) throw new Error('CUBO_API_KEY no configurada en el servidor');

  // Cubo Pago recibe el monto en centavos (entero)
  const montoCentavos = Math.round(parseFloat(monto) * 100);

  // metadata es devuelta sin cambios por Cubo en el webhook — incluir todos los
  // identificadores posibles para que buscarPedido() siempre encuentre el pedido
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
  try {
    ({ data } = await axios.post(`${cuboApiUrl}/api/v1/links/one-use`, body, {
      headers: {
        'X-API-KEY':    cuboApiKey,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }));
  } catch (err) {
    if (!err.response) {
      throw new Error(`Cubo Pago: error de red — ${err.message}`);
    }
    const status  = err.response.status;
    const msg     = err.response.data?.message ?? err.message;
    const detalle = Array.isArray(msg) ? msg.join(', ') : String(msg);
    if (status === 401 || status === 403) {
      throw new Error('Cubo Pago: API key inválida o sin permisos (401/403)');
    }
    if (status === 400) {
      throw new Error(`Cubo Pago: solicitud inválida — ${detalle}`);
    }
    throw new Error(`Cubo Pago error ${status}: ${detalle}`);
  }

  if (!data?.cuboRedirectUri) {
    throw new Error(`Cubo Pago: respuesta inesperada — ${JSON.stringify(data)}`);
  }

  return {
    url:   data.cuboRedirectUri,
    token: data.paymentIntentToken,
  };
}

module.exports = { generarLinkPago };
