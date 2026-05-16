/**
 * Cubo Pago Guatemala — https://developers.cubopago.com
 * Autenticación: X-API-KEY header (no requiere login previo)
 * Monto: en centavos (integer)
 */
const axios = require('axios');

const BASE_URL = process.env.VISALINK_API_URL || 'https://api.cubo.com';

async function generarLinkPago({ referencia, titulo, monto, urlRedireccion, cliente }) {
  const apiKey = process.env.VISALINK_API_KEY;
  if (!apiKey) throw new Error('VISALINK_API_KEY no configurada en el servidor');

  // Cubo Pago recibe el monto en centavos (entero)
  const montoCentavos = Math.round(parseFloat(monto) * 100);

  const body = {
    description: titulo,
    amount:      montoCentavos,
    redirectUri: urlRedireccion,
    metadata:    { referencia },
  };

  if (cliente?.nombre)   body.clientName  = cliente.nombre;
  if (cliente?.email)    body.clientEmail  = cliente.email;
  if (cliente?.telefono) body.clientPhone  = cliente.telefono;

  let data;
  try {
    ({ data } = await axios.post(`${BASE_URL}/api/v1/links/one-use`, body, {
      headers: {
        'X-API-KEY':    apiKey,
        'Content-Type': 'application/json',
      },
    }));
  } catch (err) {
    const msg = err.response?.data?.message ?? err.message;
    throw new Error(`Cubo Pago error: ${Array.isArray(msg) ? msg.join(', ') : msg}`);
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
