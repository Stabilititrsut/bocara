const axios = require('axios');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Límite oficial de Expo: máximo 100 mensajes por request.
const EXPO_LOTE_MAX = 100;

// Canales de Android. 'default' es el único que la app crea hoy; 'pedidos' y
// 'promociones' los crea bocara-mobile (Fase C). Un channelId que no existe en
// el dispositivo hace que Android NO muestre la notificación, así que un valor
// desconocido cae a 'default' en vez de viajar tal cual.
const CANALES = new Set(['default', 'pedidos', 'promociones']);

// Lazy: este módulo se carga en pruebas que nunca tocan la BD; solo se abre el
// cliente real si hay que limpiar tokens y el llamador no inyectó uno.
function db() { return require('../config/supabase'); }

function buildHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN && process.env.EXPO_ACCESS_TOKEN !== 'TU_EXPO_TOKEN') {
    h.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  return h;
}

function canalValido(channelId) {
  return CANALES.has(channelId) ? channelId : 'default';
}

function construirMensaje(to, titulo, cuerpo, data = {}, channelId) {
  return {
    to, title: titulo, body: cuerpo, data, sound: 'default', priority: 'high',
    channelId: canalValido(channelId),
  };
}

// Un token que Expo reporta como DeviceNotRegistered no volverá a funcionar
// (app desinstalada, permiso revocado): se borra para no reintentarlo siempre.
// Por token y no por usuario: el ticket solo identifica el token.
async function limpiarTokensInvalidos(tokens, cliente) {
  if (!tokens.length) return;
  const { error } = await (cliente || db()).from('usuarios')
    .update({ expo_push_token: null })
    .in('expo_push_token', tokens);
  if (error) console.error('[PUSH] No se pudieron limpiar tokens inválidos:', error.message);
  else console.warn('[PUSH] Tokens DeviceNotRegistered limpiados:', tokens.length);
}

// Envía mensajes ya construidos en lotes de EXPO_LOTE_MAX y lee los tickets.
// Nunca lanza: un push es best-effort y no debe tumbar al llamador. `post` y
// `cliente` son inyectables para probar sin red ni BD.
async function enviarPushEnLotes(mensajes, { cliente, post = axios.post } = {}) {
  const validos = (mensajes || []).filter(m => m?.to);
  const resumen = { enviados: 0, errores: 0, tokensInvalidos: [] };

  for (let i = 0; i < validos.length; i += EXPO_LOTE_MAX) {
    const lote = validos.slice(i, i + EXPO_LOTE_MAX);
    try {
      const res = await post(EXPO_PUSH_URL, lote, { headers: buildHeaders(), timeout: 8000 });
      // Expo devuelve un ticket por mensaje, en el mismo orden del lote.
      const tickets = Array.isArray(res?.data?.data) ? res.data.data : [];
      lote.forEach((mensaje, idx) => {
        const ticket = tickets[idx];
        if (ticket?.status === 'ok') { resumen.enviados += 1; return; }
        resumen.errores += 1;
        if (ticket?.details?.error === 'DeviceNotRegistered') {
          resumen.tokensInvalidos.push(ticket.details.expoPushToken || mensaje.to);
        }
      });
    } catch (err) {
      resumen.errores += lote.length;
      console.error('[PUSH] Error enviando lote:', err.message);
    }
  }

  if (resumen.tokensInvalidos.length) {
    try { await limpiarTokensInvalidos(resumen.tokensInvalidos, cliente); }
    catch (err) { console.error('[PUSH] Error limpiando tokens:', err.message); }
  }
  return resumen;
}

async function enviarNotificacionPush(token, titulo, cuerpo, data = {}, { channelId, cliente, post } = {}) {
  if (!token) return;
  return enviarPushEnLotes([construirMensaje(token, titulo, cuerpo, data, channelId)], { cliente, post });
}

async function enviarNotificacionesMultiples(tokens, titulo, cuerpo, data = {}, { channelId, cliente, post } = {}) {
  const validos = (tokens || []).filter(Boolean);
  if (!validos.length) return;
  return enviarPushEnLotes(validos.map(to => construirMensaje(to, titulo, cuerpo, data, channelId)), { cliente, post });
}

async function guardarNotificacion(supabase, usuarioId, tipo, titulo, mensaje, data = {}) {
  if (!usuarioId) return;
  try {
    const { error } = await supabase.from('notificaciones').insert([{
      usuario_id: usuarioId,
      tipo,
      titulo,
      cuerpo: mensaje,
      data,
      leida: false,
    }]);
    // Fallback si la columna 'data' no existe aún en la tabla
    if (error && error.message && error.message.includes('data')) {
      await supabase.from('notificaciones').insert([{
        usuario_id: usuarioId,
        tipo,
        titulo,
        cuerpo: mensaje,
        leida: false,
      }]);
    } else if (error) {
      console.error('Guardar notificación error:', error.message);
    }
  } catch (err) {
    console.error('Guardar notificación error:', err.message);
  }
}

// Aviso al cliente en CADA cambio de fase de su pedido. El confirmado lo emite
// el webhook de pago (pagoEventos.js, tipo 'pago_confirmado'). Los `tipo` se
// conservan por compatibilidad con la bandeja y el ruteo de la app.
const FASES_CLIENTE = {
  en_preparacion: {
    tipo: 'pedido_en_preparacion',
    titulo: '👨‍🍳 Tu pedido está en preparación',
    cuerpo: (c) => `El restaurante ya está preparando tu pedido ${c}.`,
  },
  listo: {
    tipo: 'pedido_listo',
    titulo: '🛍️ ¡Tu pedido está listo para recoger!',
    cuerpo: (c) => `Tu pedido ${c} ya está listo. ¡Pasa por él!`,
  },
  completado: {
    tipo: 'bolsa_recogida',
    titulo: '✅ Pedido entregado',
    cuerpo: (c) => `Tu pedido ${c} fue entregado. ¡Gracias por comprar en Bocara!`,
  },
  cancelado: {
    tipo: 'pedido_cancelado',
    titulo: '❌ Tu pedido fue cancelado',
    cuerpo: (c) => `Tu pedido ${c} fue cancelado. Si tienes dudas escríbenos al WhatsApp +502 5107-7949.`,
  },
};
FASES_CLIENTE.recogido = FASES_CLIENTE.completado;

function textoFaseCliente(estado, codigo) {
  const fase = FASES_CLIENTE[estado];
  if (!fase) return null;
  return { tipo: fase.tipo, titulo: fase.titulo, cuerpo: fase.cuerpo(codigo || '') };
}

// Push (con sonido, prioridad alta) + fila en la bandeja: la bandeja es lo que
// la app detecta por polling para sonar en web y cuando no hay token de push.
// Best-effort: nunca lanza.
async function notificarFasePedidoCliente(supabase, { usuarioId, token, pedidoId, codigo, estado }, { push = enviarNotificacionPush } = {}) {
  const texto = textoFaseCliente(estado, codigo);
  if (!texto || !usuarioId) return null;
  const data = { pedidoId, screen: 'pedidos', estado };
  try {
    await push(token, texto.titulo, texto.cuerpo, data);
  } catch (err) {
    console.warn('[PUSH] Fase %s del pedido %s (best-effort) falló:', estado, pedidoId, err.message);
  }
  await guardarNotificacion(supabase, usuarioId, texto.tipo, texto.titulo, texto.cuerpo, data);
  return texto;
}

module.exports = {
  EXPO_LOTE_MAX, CANALES,
  construirMensaje, enviarPushEnLotes,
  enviarNotificacionPush, enviarNotificacionesMultiples, guardarNotificacion,
  FASES_CLIENTE, textoFaseCliente, notificarFasePedidoCliente,
};
