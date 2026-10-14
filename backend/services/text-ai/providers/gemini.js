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
// Modelo por defecto `gemini-2.5-flash-lite` (ID estable; razonamiento
// apagado por defecto, así que todos los tokens de salida son texto).
// Configurable con GEMINI_TEXT_MODEL: no se hardcodea en otro lugar.
//
// Se usa fetch nativo (Node ≥ 20) en vez del SDK para no sumar dependencias
// a una sola llamada. `fetch` es inyectable: las pruebas nunca tocan la red.
const { ErrorTextoIA } = require('../errores');

const MODELO_POR_DEFECTO = 'gemini-2.5-flash-lite';
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RE_MODELO = /^[a-z0-9][a-z0-9.\-]{1,80}$/i;

function crearProveedorGemini({
  apiKey = process.env.GEMINI_API_KEY,
  modelo = process.env.GEMINI_TEXT_MODEL || MODELO_POR_DEFECTO,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');
  if (!RE_MODELO.test(modelo)) throw new Error(`GEMINI_TEXT_MODEL inválido: ${modelo}`);
  const url = `${URL_BASE}/models/${encodeURIComponent(modelo)}:generateContent`;

  return {
    nombre: 'gemini',
    modelo,
    // → { texto, finCorte, uso }. Lanza ErrorTextoIA.
    async generar({ sistema, usuario, temperatura, maxTokens, timeoutMs }) {
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
            generationConfig: { temperature: temperatura, maxOutputTokens: maxTokens, candidateCount: 1 },
          }),
          signal: control.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError' || control.signal.aborted) {
          throw new ErrorTextoIA(`gemini: tiempo agotado (${timeoutMs} ms)`, { codigo: 'timeout' });
        }
        throw new ErrorTextoIA(`gemini: error de red (${err?.code || err?.name || 'desconocido'})`, { codigo: 'proveedor' });
      } finally {
        clearTimeout(reloj);
      }

      let cuerpo = null;
      try { cuerpo = await r.json(); } catch { /* cuerpo no JSON */ }
      if (!r.ok) {
        // error.status es p. ej. RESOURCE_EXHAUSTED / INVALID_ARGUMENT. No se
        // registra error.message completo: puede repetir partes del prompt.
        const estado = cuerpo?.error?.status || '';
        throw new ErrorTextoIA(`gemini: HTTP ${r.status} ${estado}`.trim(), { codigo: 'proveedor', status: r.status });
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
        finCorte: fin === 'MAX_TOKENS',
        uso: { entrada: u.promptTokenCount ?? null, salida: u.candidatesTokenCount ?? null, total: u.totalTokenCount ?? null },
      };
    },
  };
}

module.exports = { MODELO_POR_DEFECTO, crearProveedorGemini };
