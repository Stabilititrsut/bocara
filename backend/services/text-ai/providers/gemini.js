// Proveedor Gemini (Google AI for Developers, REST generateContent).
//
// Contrato verificado en la documentación oficial (2026-10):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent
//   Header  x-goog-api-key: <GEMINI_API_KEY>   (la key nunca va en la URL)
//   Body    { systemInstruction: { parts: [{ text }] },
//             contents: [{ role: 'user', parts: [{ text }] }],
//             generationConfig: { temperature, maxOutputTokens, candidateCount } }
//   Resp.   candidates[0].content.parts[].text, candidates[0].finishReason
//           (STOP | MAX_TOKENS | SAFETY | RECITATION | ...),
//           promptFeedback.blockReason (si se bloqueó el prompt, sin candidates),
//           usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}
//
// Modelo por defecto `gemini-3.5-flash-lite`. Verificado con la API real el
// 2026-10-14: `gemini-2.5-flash-lite` responde 404 "no longer available to
// new users" y Google indica migrar a gemini-3.5-flash-lite. En la familia 3.x
// se pide razonamiento mínimo (thinkingLevel) para que la respuesta sea rápida
// y los tokens de salida sean texto. Configurable con GEMINI_TEXT_MODEL: no se
// hardcodea en otro lugar.
//
// Se usa fetch nativo (Node ≥ 20) en vez del SDK para no sumar dependencias
// a una sola llamada. `fetch` es inyectable: las pruebas nunca tocan la red.
const { ErrorTextoIA } = require('../errores');

const MODELO_POR_DEFECTO = 'gemini-3.5-flash-lite';
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RE_MODELO = /^[a-z0-9][a-z0-9.\-]{1,80}$/i;
const RE_RAZONAMIENTO_NIVEL = /^gemini-([3-9]|\d{2,})/i;

// Motivo legible de un error HTTP de Gemini (para el restaurante y los logs).
//   modelo_no_disponible  404: el modelo no existe o ya no se ofrece a esta clave
//   clave_invalida        400 API_KEY_INVALID / 401 / 403
//   cuota                 429 RESOURCE_EXHAUSTED
function motivoHttp(status, cuerpo) {
  const razon = (cuerpo?.error?.details || []).map((d) => d?.reason).filter(Boolean).join(',');
  if (status === 404) return 'modelo_no_disponible';
  if (status === 401 || status === 403 || /API_KEY/.test(razon)) return 'clave_invalida';
  if (status === 429) return 'cuota';
  return 'otro';
}

// Respaldo: si el modelo principal está saturado o no disponible (503/5xx,
// 429, 404 o tiempo agotado), se intenta UNA vez con este otro modelo dentro
// del mismo presupuesto de tiempo. GEMINI_TEXT_MODEL_FALLBACK=none lo apaga.
const RESPALDO_POR_DEFECTO = 'gemini-3.1-flash-lite';
const FRACCION_PRIMER_INTENTO = 0.6;

function usarRespaldo(err) {
  if (err?.codigo === 'timeout') return true;
  if (err?.codigo !== 'proveedor') return false;
  return err.motivo === 'modelo_no_disponible' || err.motivo === 'cuota' || !err.status || err.status >= 500;
}

function crearProveedorGemini({
  apiKey = process.env.GEMINI_API_KEY,
  modelo = process.env.GEMINI_TEXT_MODEL || MODELO_POR_DEFECTO,
  respaldo = process.env.GEMINI_TEXT_MODEL_FALLBACK ?? RESPALDO_POR_DEFECTO,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');
  if (!RE_MODELO.test(modelo)) throw new Error(`GEMINI_TEXT_MODEL inválido: ${modelo}`);
  const modeloRespaldo = respaldo && !['none', 'off', modelo].includes(String(respaldo).toLowerCase()) ? respaldo : null;
  if (modeloRespaldo && !RE_MODELO.test(modeloRespaldo)) throw new Error(`GEMINI_TEXT_MODEL_FALLBACK inválido: ${modeloRespaldo}`);

  async function llamar(m, { sistema, usuario, temperatura, maxTokens, timeoutMs }) {
    const url = `${URL_BASE}/models/${encodeURIComponent(m)}:generateContent`;
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sistema }] },
          contents: [{ role: 'user', parts: [{ text: usuario }] }],
          generationConfig: {
            temperature: temperatura, maxOutputTokens: maxTokens, candidateCount: 1,
            ...(RE_RAZONAMIENTO_NIVEL.test(m) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
          },
        }),
        signal: control.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError' || control.signal.aborted) {
        throw new ErrorTextoIA(`gemini (${m}): tiempo agotado (${timeoutMs} ms)`, { codigo: 'timeout' });
      }
      throw new ErrorTextoIA(`gemini (${m}): error de red (${err?.code || err?.name || 'desconocido'})`, { codigo: 'proveedor' });
    } finally {
      clearTimeout(reloj);
    }

    let cuerpo = null;
    try { cuerpo = await r.json(); } catch { /* cuerpo no JSON */ }
    if (!r.ok) {
      // error.status es p. ej. RESOURCE_EXHAUSTED / NOT_FOUND. El mensaje de
      // Google dice el porqué (modelo retirado, clave inválida, cuota) y se
      // incluye recortado; en otros errores no, porque podría repetir partes
      // del prompt.
      const estado = cuerpo?.error?.status || '';
      const motivo = motivoHttp(r.status, cuerpo);
      const msg = motivo !== 'otro' ? String(cuerpo?.error?.message || '').slice(0, 220) : '';
      throw new ErrorTextoIA(`gemini (${m}): HTTP ${r.status} ${estado}${msg ? ` — ${msg}` : ''}`.trim(),
        { codigo: 'proveedor', status: r.status, motivo });
    }

    const bloqueo = cuerpo?.promptFeedback?.blockReason;
    if (bloqueo) throw new ErrorTextoIA(`gemini: prompt bloqueado (${bloqueo})`, { codigo: 'bloqueado' });

    const candidato = cuerpo?.candidates?.[0];
    const fin = candidato?.finishReason || null;
    if (fin && fin !== 'STOP' && fin !== 'MAX_TOKENS') {
      throw new ErrorTextoIA(`gemini: respuesta detenida (${fin})`, { codigo: 'bloqueado' });
    }
    const texto = (candidato?.content?.parts || [])
      .filter((p) => typeof p?.text === 'string' && !p.thought)
      .map((p) => p.text).join('').trim();
    if (!texto) throw new ErrorTextoIA('gemini: respuesta sin texto', { codigo: 'salida_invalida' });

    const u = cuerpo?.usageMetadata || {};
    return {
      texto,
      modelo: m,
      finCorte: fin === 'MAX_TOKENS',
      uso: { entrada: u.promptTokenCount ?? null, salida: u.candidatesTokenCount ?? null, total: u.totalTokenCount ?? null },
    };
  }

  return {
    nombre: 'gemini',
    modelo,
    respaldo: modeloRespaldo,
    // → { texto, modelo, finCorte, uso }. Lanza ErrorTextoIA.
    async generar(opciones) {
      const inicio = Date.now();
      const total = opciones.timeoutMs;
      const primero = modeloRespaldo ? Math.round(total * FRACCION_PRIMER_INTENTO) : total;
      try {
        return await llamar(modelo, { ...opciones, timeoutMs: primero });
      } catch (err) {
        const restante = total - (Date.now() - inicio);
        if (!modeloRespaldo || !usarRespaldo(err) || restante < 2000) throw err;
        console.warn('[TEXTO_IA] %s falló (%s); probando el modelo de respaldo %s', modelo, err.message, modeloRespaldo);
        return llamar(modeloRespaldo, { ...opciones, timeoutMs: restante });
      }
    },
  };
}

module.exports = { MODELO_POR_DEFECTO, RESPALDO_POR_DEFECTO, crearProveedorGemini, motivoHttp };
