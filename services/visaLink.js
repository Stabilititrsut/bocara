const axios = require('axios');

const BASE_URL = process.env.VISALINK_API_URL || 'https://admlink.ebi.com.gt/api';

// Token en memoria — en ebi Pay nunca expira (solo se invalida al generar uno nuevo)
let _cachedToken = null;

async function obtenerToken() {
  if (_cachedToken) return _cachedToken;

  const key  = process.env.VISALINK_API_KEY;
  const user = process.env.VISALINK_USUARIO;
  const pass = process.env.VISALINK_CLAVE;

  if (!user || !pass) {
    // Si no hay credenciales de login, usar la API key directamente como token
    return key;
  }

  const { data } = await axios.post(`${BASE_URL}/login`, {
    llave: key,
    usuario: user,
    clave: pass,
  });

  if (data.result !== 'success') {
    throw new Error(`Visa Link login fallido: ${data.message}`);
  }

  _cachedToken = data.data.token;
  return _cachedToken;
}

async function generarLinkPago({ referencia, titulo, descripcion, monto, urlExito, urlFalla }) {
  const key   = process.env.VISALINK_API_KEY;
  const token = await obtenerToken();

  const body = {
    nombre_interno: referencia,
    codigo_interno: referencia,
    titulo,
    descripcion,
    monto:          parseFloat(monto).toFixed(2),
    estado:         1,
    cuotas:         'VC00',
    redes_sociales: process.env.VISALINK_REDES || '1',
  };

  if (urlExito) body.url_exito = urlExito;
  if (urlFalla) body.url_falla = urlFalla;

  let data;
  try {
    ({ data } = await axios.post(`${BASE_URL}/link/maintenance`, body, {
      headers: { llave: key, token },
    }));
  } catch (err) {
    throw new Error(`Visa Link HTTP error: ${err.message}`);
  }

  if (data.result !== 'success') {
    // El token pudo haberse invalidado — resetear para que el próximo intento re-autentique
    _cachedToken = null;
    throw new Error(`Visa Link: ${data.message}`);
  }

  const link = data.data?.[0];
  // La API devuelve "URL" (mayúsculas) en algunos endpoints y "url" en otros
  const url = link?.URL || link?.url;
  if (!url) throw new Error('Visa Link no devolvió una URL de pago');
  return url;
}

module.exports = { generarLinkPago };
