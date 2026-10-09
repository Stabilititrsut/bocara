// Ingesta pública de eventos de analítica (embudo de compra, módulo 03).
//
// POST /api/analitica/eventos  { eventos: [ {...}, ... ] }
//
// Pública a propósito: la visita y la vista de oferta ocurren antes del login.
// Por eso nada de lo que llega aquí se usa como verdad operativa: el evento
// 'purchase' se guarda, pero los KPIs cuentan compras desde pedidos válidos.
//
//   · usuario_id NUNCA se toma del cuerpo: solo de un JWT válido si viene. Un
//     token inválido no rechaza el lote (la analítica no debe romper la app),
//     simplemente se registra como anónimo.
//   · Validación por evento: los inválidos se rechazan con su índice y motivo
//     sin tirar el resto del lote.
//   · client_event_id es obligatorio y UNIQUE en la tabla: un reintento del
//     cliente se ignora (ON CONFLICT DO NOTHING) y se informa como duplicado.

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const supabase = require('../config/supabase');

const router = express.Router();

const EVENTOS_VALIDOS = Object.freeze(['session_start', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
const MAX_EVENTOS_POR_LOTE = 50;
// Un evento con reloj del dispositivo más de 10 min en el futuro o de hace más
// de 7 días (cola offline) no es confiable para ubicarlo en un periodo.
const TOLERANCIA_FUTURO_MS = 10 * 60 * 1000;
const ANTIGUEDAD_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_ID_CLIENTE = /^[A-Za-z0-9_.:-]{8,100}$/;
const RE_UTM = /^[\w .:/+-]{1,100}$/u;

const ingestaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados eventos. Intenta de nuevo en un minuto.' },
});

function usuarioOpcional(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    return RE_UUID.test(String(payload?.id || '')) ? payload.id : null;
  } catch {
    return null;
  }
}

// Devuelve { fila } o { error }.
function validarEvento(e, { usuarioId, ahora }) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'evento debe ser un objeto' };
  if (!RE_ID_CLIENTE.test(String(e.client_event_id ?? ''))) return { error: 'client_event_id requerido (8–100 caracteres [A-Za-z0-9_.:-])' };
  if (!RE_ID_CLIENTE.test(String(e.anon_id ?? ''))) return { error: 'anon_id requerido (8–100 caracteres [A-Za-z0-9_.:-])' };
  if (!RE_ID_CLIENTE.test(String(e.sesion_id ?? ''))) return { error: 'sesion_id requerido (8–100 caracteres [A-Za-z0-9_.:-])' };
  if (!EVENTOS_VALIDOS.includes(e.evento)) return { error: `evento debe ser uno de: ${EVENTOS_VALIDOS.join(', ')}` };

  if (typeof e.ocurrido_en !== 'string') return { error: 'ocurrido_en requerido (ISO 8601 con zona horaria)' };
  const instante = Date.parse(e.ocurrido_en);
  if (Number.isNaN(instante) || !/(Z|[+-]\d{2}:?\d{2})$/.test(e.ocurrido_en)) {
    return { error: 'ocurrido_en debe ser ISO 8601 con zona horaria' };
  }
  if (instante > ahora + TOLERANCIA_FUTURO_MS) return { error: 'ocurrido_en está en el futuro' };
  if (instante < ahora - ANTIGUEDAD_MAXIMA_MS) return { error: 'ocurrido_en tiene más de 7 días' };

  for (const campo of ['bolsa_id', 'negocio_id', 'pedido_id']) {
    if (e[campo] != null && !RE_UUID.test(String(e[campo]))) return { error: `${campo} debe ser un UUID` };
  }
  for (const campo of ['utm_source', 'utm_campaign']) {
    if (e[campo] != null && (typeof e[campo] !== 'string' || !RE_UTM.test(e[campo]))) return { error: `${campo} inválido` };
  }
  if (e.evento === 'view_item' && !e.bolsa_id) return { error: 'view_item requiere bolsa_id' };
  if (e.evento === 'add_to_cart' && !e.bolsa_id) return { error: 'add_to_cart requiere bolsa_id' };

  return {
    fila: {
      client_event_id: e.client_event_id,
      anon_id: e.anon_id,
      sesion_id: e.sesion_id,
      usuario_id: usuarioId,
      evento: e.evento,
      bolsa_id: e.bolsa_id || null,
      negocio_id: e.negocio_id || null,
      pedido_id: e.pedido_id || null,
      ocurrido_en: new Date(instante).toISOString(),
      utm_source: e.utm_source || null,
      utm_campaign: e.utm_campaign || null,
    },
  };
}

// POST /api/analitica/eventos
router.post('/eventos', ingestaLimiter, async (req, res) => {
  const lote = req.body?.eventos;
  if (!Array.isArray(lote) || lote.length === 0) {
    return res.status(400).json({ error: 'eventos debe ser un arreglo no vacío' });
  }
  if (lote.length > MAX_EVENTOS_POR_LOTE) {
    return res.status(413).json({ error: `máximo ${MAX_EVENTOS_POR_LOTE} eventos por lote` });
  }

  const usuarioId = usuarioOpcional(req);
  const ahora = Date.now();
  const rechazados = [];
  const filas = [];
  const vistos = new Set();
  let duplicados = 0;

  lote.forEach((e, indice) => {
    const r = validarEvento(e, { usuarioId, ahora });
    if (r.error) { rechazados.push({ indice, error: r.error }); return; }
    if (vistos.has(r.fila.client_event_id)) { duplicados++; return; }
    vistos.add(r.fila.client_event_id);
    filas.push(r.fila);
  });

  if (filas.length === 0) {
    return res.status(rechazados.length ? 400 : 200).json({ aceptados: 0, duplicados, rechazados });
  }

  const { data, error } = await supabase.from('eventos_analitica')
    .upsert(filas, { onConflict: 'client_event_id', ignoreDuplicates: true })
    .select('client_event_id');
  if (error) {
    console.error('[ANALITICA] no se pudo guardar el lote:', error.message);
    return res.status(503).json({ error: 'No se pudieron registrar los eventos. Reintentar.' });
  }

  const aceptados = data?.length || 0;
  res.status(202).json({ aceptados, duplicados: duplicados + (filas.length - aceptados), rechazados });
});

module.exports = router;
module.exports.validarEvento = validarEvento;
module.exports.EVENTOS_VALIDOS = EVENTOS_VALIDOS;
module.exports.MAX_EVENTOS_POR_LOTE = MAX_EVENTOS_POR_LOTE;
