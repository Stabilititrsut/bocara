const axios = require('axios');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function buildHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN && process.env.EXPO_ACCESS_TOKEN !== 'TU_EXPO_TOKEN') {
    h.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  return h;
}

async function enviarNotificacionPush(token, titulo, cuerpo, data = {}) {
  if (!token) return;
  try {
    await axios.post(EXPO_PUSH_URL, {
      to: token,
      title: titulo,
      body: cuerpo,
      data,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }, { headers: buildHeaders(), timeout: 8000 });
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

async function enviarNotificacionesMultiples(tokens, titulo, cuerpo, data = {}) {
  const validos = tokens.filter(Boolean);
  if (!validos.length) return;
  const mensajes = validos.map(to => ({
    to, title: titulo, body: cuerpo, data, sound: 'default', priority: 'high', channelId: 'default',
  }));
  try {
    await axios.post(EXPO_PUSH_URL, mensajes, { headers: buildHeaders(), timeout: 8000 });
  } catch (err) {
    console.error('Push multi error:', err.message);
  }
}

async function guardarNotificacion(supabase, usuarioId, tipo, titulo, mensaje, data = {}) {
  if (!usuarioId) return;
  try {
    await supabase.from('notificaciones').insert([{
      usuario_id: usuarioId,
      tipo,
      titulo,
      mensaje,
      data,
      leida: false,
    }]);
  } catch (err) {
    console.error('Guardar notificación error:', err.message);
  }
}

module.exports = { enviarNotificacionPush, enviarNotificacionesMultiples, guardarNotificacion };
