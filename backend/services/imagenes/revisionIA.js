// Revisión con IA (visión) de una foto de publicación. Dos modos:
//   · 'original'  → antes de mejorar. Solo IRREPARABLES (no es comida, captura
//                   o collage) frenan el flujo; el resto de problemas se anota
//                   y la foto pasa igual a la mejora con IA.
//   · 'resultado' → la foto YA mejorada: ¿se puede publicar tal cual? Aquí sí
//                   cualquier problema bloquea la publicación (con su motivo).
// Cubre lo que las métricas técnicas (calidad.js) no ven: que no sea
// comida/producto, producto cortado, presentación descuidada, capturas, etc.
//
// OpenAI Responses API con entrada de imagen y Structured Outputs (json_schema
// estricto). Modelo: OPENAI_VISION_MODEL, por defecto `gpt-6-luna` (ID según
// developers.openai.com/api/docs/models/gpt-6-luna, verificado 2026-10-14:
// entrada texto+imagen, Structured Outputs, endpoint v1/responses,
// US$0.10 / US$0.50 por millón de tokens). No se hardcodea en otro lugar.
const { ErrorProveedor } = require('./errores');
const { clasificarError } = require('./proveedorOpenAI');

function sharp() { return require('sharp'); }

const MODELO_VISION_POR_DEFECTO = 'gpt-6-luna';
const LADO_REVISION = 768;

const PROBLEMAS = Object.freeze({
  no_es_comida: 'La foto no muestra un producto de comida o bebida.',
  recortada: 'El producto está cortado o mal encuadrado. Toma la foto con el producto completo y centrado.',
  borrosa: 'La foto está borrosa o fuera de foco.',
  muy_oscura: 'La foto está tan oscura que no se distingue el producto.',
  desordenada: 'La presentación se ve descuidada (fondo desordenado, empaques abiertos o sobras). Toma una foto más limpia.',
  captura_o_collage: 'Parece una captura de pantalla, un collage o una imagen con texto encima. Sube una foto real del producto.',
  manos_o_personas: 'Las manos o personas ocupan gran parte de la foto. El protagonista debe ser el producto.',
  baja_calidad: 'La foto no tiene la calidad mínima para mostrarse en Bocara.',
});

// Problemas que ninguna mejora de imagen arregla: con ellos ni se intenta.
const IRREPARABLES = Object.freeze(new Set(['no_es_comida', 'captura_o_collage']));

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['apta', 'problemas', 'resumen'],
  properties: {
    apta: { type: 'boolean', description: 'true si, tras mejorar luz/color/nitidez, la foto puede publicarse en un marketplace de comida.' },
    problemas: { type: 'array', items: { type: 'string', enum: Object.keys(PROBLEMAS) } },
    resumen: { type: 'string', description: 'Una frase en español, máximo 160 caracteres.' },
  },
};

const INSTRUCCIONES_ORIGINAL = [
  'Eres revisor de fotos de Bocara, un marketplace de comida en Guatemala.',
  'Decide si esta foto, DESPUÉS de una mejora automática de iluminación, balance de blancos, contraste, color y nitidez leve, puede publicarse como foto comercial del producto.',
  'Esa mejora NO puede: reencuadrar, recuperar partes cortadas, quitar desenfoque fuerte, cambiar el fondo ni el contenido.',
  'Marca apta=false y lista los problemas si: no es comida, bebida o un producto de restaurante; el producto principal está cortado por los bordes o muy descentrado; está muy borrosa o movida; está tan oscura que no se distingue el producto; la presentación es descuidada; es captura de pantalla, collage o tiene texto superpuesto; manos o personas dominan la imagen; o la calidad general es inaceptable.',
  'NO rechaces solo por luz algo baja, tono de color o poco contraste: eso lo corrige la mejora.',
  'Sé estricto pero justo: una foto casera bien encuadrada y enfocada es apta.',
].join('\n');

const INSTRUCCIONES_RESULTADO = [
  'Eres revisor de fotos de Bocara, un marketplace de comida en Guatemala.',
  'Esta foto YA fue mejorada automáticamente (luz, color, nitidez). Decide si, TAL COMO ESTÁ, puede publicarse como foto comercial del producto.',
  'Marca apta=false y lista los problemas si: no es comida, bebida o un producto de restaurante; el producto principal está cortado por los bordes o muy descentrado; está borrosa; está oscura o quemada; la presentación es descuidada; es captura de pantalla, collage o tiene texto superpuesto; manos o personas dominan la imagen; o se ve artificial (aspecto de render, plástico o ilustración).',
  'Sé estricto pero justo: una foto casera bien encuadrada, enfocada y con buena luz es apta.',
].join('\n');
const INSTRUCCIONES = Object.freeze({ original: INSTRUCCIONES_ORIGINAL, resultado: INSTRUCCIONES_RESULTADO });

function crearRevisorIA({
  apiKey = process.env.OPENAI_API_KEY,
  modelo = process.env.OPENAI_VISION_MODEL || MODELO_VISION_POR_DEFECTO,
  timeoutMs = Number(process.env.IMAGE_AI_REVIEW_TIMEOUT_MS) || 45000,
  cliente, // inyectable en pruebas: { responses: { create } }
} = {}) {
  if (!cliente && !apiKey) throw new Error('OPENAI_API_KEY no configurada');
  let sdk = cliente;
  const obtener = () => {
    if (!sdk) {
      const { OpenAI } = require('openai');
      sdk = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    }
    return sdk;
  };

  return {
    modelo,
    // → { apta, irreparable, problemas: [{ codigo, mensaje }], resumen, uso }. Lanza ErrorProveedor.
    // irreparable: algún problema que la mejora no puede arreglar.
    async revisar(buffer, { modo = 'original' } = {}) {
      if (!INSTRUCCIONES[modo]) throw new Error(`modo de revisión desconocido: ${modo}`);
      const inicio = Date.now();
      const jpeg = await sharp()(buffer, { failOn: 'none' }).rotate()
        .resize({ width: LADO_REVISION, height: LADO_REVISION, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 }).toBuffer();
      console.log('[IMAGEN_IA] OpenAI revisión (%s) → modelo=%s', modo, modelo);
      let r;
      try {
        r = await obtener().responses.create({
          model: modelo,
          reasoning: { effort: 'low' },
          max_output_tokens: 600,
          instructions: INSTRUCCIONES[modo],
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: 'Revisa esta foto de una publicación.' },
              { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'low' },
            ],
          }],
          text: { format: { type: 'json_schema', name: 'revision_foto', schema: ESQUEMA, strict: true } },
        });
      } catch (err) {
        const e = clasificarError(err);
        console.error('[IMAGEN_IA] OpenAI revisión (%s) FALLÓ en %d ms (motivo=%s): %s', modo, Date.now() - inicio, e.motivo, e.message);
        throw e;
      }
      let datos;
      try { datos = JSON.parse(r?.output_text || ''); } catch {
        throw new ErrorProveedor('revisión IA: respuesta sin JSON válido', { reintentable: true });
      }
      if (typeof datos?.apta !== 'boolean' || !Array.isArray(datos.problemas)) {
        throw new ErrorProveedor('revisión IA: respuesta incompleta', { reintentable: true });
      }
      const codigos = [...new Set(datos.problemas.filter((p) => p in PROBLEMAS))];
      // apta=false sin un problema reconocible → "baja_calidad" (nunca rechazo mudo).
      if (!datos.apta && !codigos.length) codigos.push('baja_calidad');
      const apta = datos.apta && codigos.length === 0;
      console.log('[IMAGEN_IA] OpenAI revisión (%s) en %d ms: apta=%s problemas=[%s]', modo, Date.now() - inicio, apta, codigos.join(','));
      return {
        apta,
        irreparable: codigos.some((c) => IRREPARABLES.has(c)),
        problemas: codigos.map((codigo) => ({ codigo, mensaje: PROBLEMAS[codigo] })),
        resumen: String(datos.resumen || '').slice(0, 200),
        uso: r.usage || null,
      };
    },
  };
}

module.exports = { MODELO_VISION_POR_DEFECTO, PROBLEMAS, IRREPARABLES, ESQUEMA, INSTRUCCIONES, crearRevisorIA };
