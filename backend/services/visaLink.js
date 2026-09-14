/**
 * Cubo Pago Guatemala — https://developers.cubopago.com
 * Autenticación: X-API-KEY header (no requiere login previo)
 * Monto: en centavos (integer)
 */
// axios se carga al usarlo, no al importar este módulo: así test/visaLink.test.js
// puede comprobar la construcción del payload (y su caducidad) sin que haga
// falta instalar dependencias, igual que services/stock.js hace con el cliente
// de Supabase. El coste es nulo — require() cachea el módulo.
function http() {
  return require('axios');
}

const { RESERVA_TTL_MINUTOS } = require('./stock');

// ── Vigencia del link de pago = vigencia de la reserva ──────────────────────
//
// El link de Cubo y la reserva de stock tienen que caducar a la vez. Si el link
// vive más que la reserva (antes vivía indefinidamente, y el pedido seguía
// siendo "pagable" hasta que el barrido lo cerraba dos horas después) aparece
// la asincronía que produce sobreventa: el cliente abre el link, lo deja
// aparcado, la unidad vuelve al catálogo a los 15 minutos, otro la compra y el
// primero paga después sobre un stock que ya no existe. El cobro llega, la
// bolsa no, y alguien tiene que devolver el dinero a mano.
//
// La defensa tiene tres capas, y esta es la primera (la que evita el cobro):
//   1. aquí — el link nace con TTL = RESERVA_TTL_MINUTOS.
//   2. services/cuboWebhook.js — un SUCCEEDED que llega con la reserva vencida
//      se rechaza (no se confirma nada) y queda marcado para revisión.
//   3. expirar_reservas_vencidas (server.js) — cierra formalmente el pedido al
//      cumplirse el TTL, para que no quede en un limbo pagable.
//
// Cubo NO documenta públicamente el campo de expiración de
// POST /api/v1/links/one-use, y mandar un campo que su validador no espera
// devuelve 422 (se ha visto con otros campos). Por eso el campo de API es
// opt-in: se envía solo si el operador configura su nombre en
// CUBO_LINK_EXPIRACION_CAMPO. La marca en `metadata` va SIEMPRE — Cubo la
// devuelve intacta en el webhook y en la consulta, así que queda registrada la
// vigencia con la que se emitió el link aunque la pasarela no la aplique.
const FORMATOS_EXPIRACION = {
  iso:      (ms) => new Date(ms).toISOString(),
  epoch:    (ms) => Math.floor(ms / 1000),
  epoch_ms: (ms) => ms,
  minutos:  (ms, ttlMinutos) => ttlMinutos,
};

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

/**
 * Arma el cuerpo de POST /api/v1/links/one-use.
 *
 * Función pura (sin red ni entorno implícito) para poder probar la caducidad
 * del link sin llamar a Cubo. generarLinkPago la usa con los valores reales.
 *
 * @returns {{ body: object, montoCentavos: number, expiraEn: string, ttlMinutos: number }}
 */
function construirPayloadLink({
  referencia, pedidoId, titulo, monto, urlRedireccion, cliente, items,
  ttlMinutos = RESERVA_TTL_MINUTOS,
  ahora = Date.now(),
  campoExpiracion = process.env.CUBO_LINK_EXPIRACION_CAMPO,
  formatoExpiracion = process.env.CUBO_LINK_EXPIRACION_FORMATO,
}) {
  const montoCentavos = Math.round(parseFloat(monto) * 100);

  if (!Number.isFinite(montoCentavos) || montoCentavos <= 0) {
    throw new Error(`Monto inválido para Cubo: Q${monto} → ${montoCentavos} centavos. El total no puede ser cero o negativo.`);
  }

  const ttl = Number.isFinite(Number(ttlMinutos)) && Number(ttlMinutos) > 0
    ? Number(ttlMinutos)
    : RESERVA_TTL_MINUTOS;
  const expiraEnMs = ahora + ttl * 60 * 1000;
  const expiraEn = new Date(expiraEnMs).toISOString();

  // metadata es devuelta sin cambios por Cubo en el webhook — incluir orderId (UUID del pedido)
  const body = {
    description: titulo,
    amount:      montoCentavos,
    redirectUri: urlRedireccion,
    metadata: {
      referencia,
      orderId:   pedidoId,
      pedidoId,
      // Vigencia con la que se emitió el link = vigencia de la reserva.
      expiraEn,
      ttlReservaMinutos: ttl,
    },
  };

  if (cliente?.nombre)   body.clientName  = cliente.nombre;
  if (cliente?.email)    body.clientEmail = cliente.email;
  if (cliente?.telefono) body.clientPhone = cliente.telefono;
  if (items?.length)     body.items       = items;

  const campo = String(campoExpiracion || '').trim();
  if (campo) {
    const formato = String(formatoExpiracion || 'iso').trim().toLowerCase();
    const convertir = FORMATOS_EXPIRACION[formato];
    if (!convertir) {
      throw new Error(
        `CUBO_LINK_EXPIRACION_FORMATO="${formato}" no soportado. Valores válidos: ${Object.keys(FORMATOS_EXPIRACION).join(', ')}.`,
      );
    }
    body[campo] = convertir(expiraEnMs, ttl);
  }

  return { body, montoCentavos, expiraEn, ttlMinutos: ttl };
}

async function generarLinkPago({ referencia, pedidoId, titulo, monto, urlRedireccion, cliente, items, ttlMinutos }) {
  const { url: cuboApiUrl, key: cuboApiKey } = resolverCredenciales();

  const { body, montoCentavos, expiraEn, ttlMinutos: ttl } = construirPayloadLink({
    referencia, pedidoId, titulo, monto, urlRedireccion, cliente, items, ttlMinutos,
  });

  console.log('[CUBO] monto GTQ:', parseFloat(monto).toFixed(2), '| centavos:', montoCentavos, '| moneda: GTQ');
  console.log('[CUBO] vigencia del link:', ttl, 'min (= TTL de reserva) | expira:', expiraEn,
    '| campo de expiración enviado a Cubo:', process.env.CUBO_LINK_EXPIRACION_CAMPO || 'ninguno (solo metadata)');

  let data;
  console.log('4. Llamando a CuboPago sandbox:', cuboApiUrl);
  console.log('5. Body enviado:', JSON.stringify(body));
  try {
    ({ data } = await http().post(`${cuboApiUrl}/api/v1/links/one-use`, body, {
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
    expiraEn,
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
    ({ data } = await http().get(
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

module.exports = { generarLinkPago, construirPayloadLink, consultarTransaccionCubo, FORMATOS_EXPIRACION };
