// Proveedor OpenAI GPT Image (SDK oficial `openai`, endpoint images.edit).
//
// Modelo por defecto: `gpt-image-1-mini` (ID exacto según
// developers.openai.com/api/docs/models/gpt-image-1-mini): el modelo de
// edición de imágenes más económico de OpenAI. Configurable con
// OPENAI_IMAGE_MODEL (p. ej. gpt-image-1 o gpt-image-1.5 para más fidelidad).
//
// Proporción: los modelos GPT Image 1.x solo devuelven 1024x1024, 1536x1024 o
// 1024x1536. Para no recortar ni deformar la foto del restaurante:
//   1. se elige el tamaño de salida más parecido a la proporción de la foto;
//   2. la foto entra completa, centrada, sobre un fondo hecho con ella misma
//      ampliada y muy desenfocada (relleno neutro, no contenido nuevo);
//   3. del resultado se recorta exactamente el rectángulo de la foto.
// Así la mejorada tiene la misma proporción y encuadre que la original.
const { promptMejora } = require('./prompts');
const { ErrorProveedor } = require('./errores');

function sharp() { return require('sharp'); }

const MODELO_POR_DEFECTO = 'gpt-image-1-mini';
const TAMANOS = Object.freeze([
  { size: '1024x1024', ancho: 1024, alto: 1024 },
  { size: '1536x1024', ancho: 1536, alto: 1024 },
  { size: '1024x1536', ancho: 1024, alto: 1536 },
]);
const CALIDADES = new Set(['low', 'medium', 'high']);
const LADO_MAX_SALIDA = 1600;

// Tamaño cuya proporción es más cercana (en escala logarítmica: 2:1 y 1:2
// están igual de lejos de 1:1).
function elegirTamano(ancho, alto) {
  const r = Math.log(ancho / alto);
  return TAMANOS.reduce((mejor, t) => (
    Math.abs(Math.log(t.ancho / t.alto) - r) < Math.abs(Math.log(mejor.ancho / mejor.alto) - r) ? t : mejor
  ));
}

// Lienzo del tamaño de salida con la foto completa centrada y un fondo
// desenfocado de la misma foto. Devuelve el lienzo JPEG y el rectángulo útil.
async function prepararLienzo(buffer) {
  const base = sharp()(buffer, { failOn: 'none' }).rotate();
  const { data: plano, info } = await base.toBuffer({ resolveWithObject: true });
  const t = elegirTamano(info.width, info.height);
  const escala = Math.min(t.ancho / info.width, t.alto / info.height);
  const w = Math.min(t.ancho, Math.round(info.width * escala));
  const h = Math.min(t.alto, Math.round(info.height * escala));
  const rect = { left: Math.floor((t.ancho - w) / 2), top: Math.floor((t.alto - h) / 2), width: w, height: h };

  const [foto, fondo] = await Promise.all([
    sharp()(plano).resize(w, h, { fit: 'fill' }).toBuffer(),
    sharp()(plano).resize(t.ancho, t.alto, { fit: 'cover' }).blur(40).modulate({ brightness: 0.95 }).toBuffer(),
  ]);
  const lienzo = await sharp()(fondo).composite([{ input: foto, left: rect.left, top: rect.top }])
    .jpeg({ quality: 92 }).toBuffer();
  return { lienzo, tamano: t, rect };
}

// Clasifica errores del SDK: reintentar solo lo transitorio.
function clasificarError(err) {
  const status = err?.status;
  const codigo = err?.code || err?.error?.code;
  const transitorio = err?.name === 'APIConnectionTimeoutError' || err?.name === 'APIConnectionError'
    || status === 408 || status === 409 || (status >= 500)
    || (status === 429 && codigo !== 'insufficient_quota');
  const msg = err?.error?.message || err?.message || 'error desconocido';
  return new ErrorProveedor(`openai ${status || err?.name || ''}${codigo ? ` (${codigo})` : ''}: ${msg}`.trim(),
    { reintentable: !!transitorio });
}

function crearProveedorOpenAI({
  apiKey = process.env.OPENAI_API_KEY,
  modelo = process.env.OPENAI_IMAGE_MODEL || MODELO_POR_DEFECTO,
  calidad = process.env.OPENAI_IMAGE_QUALITY || 'medium',
  timeoutMs = Number(process.env.IMAGE_AI_TIMEOUT_MS) || 120000,
  cliente, // inyectable en pruebas: { images: { edit } }
} = {}) {
  if (!cliente && !apiKey) throw new Error('OPENAI_API_KEY no configurada');
  if (!CALIDADES.has(calidad)) throw new Error(`OPENAI_IMAGE_QUALITY inválida: ${calidad} (low | medium | high)`);
  let sdk = cliente;
  const obtenerCliente = () => {
    if (!sdk) {
      const { OpenAI } = require('openai');
      // Sin reintentos del SDK: el pipeline ya reintenta con espera y estado.
      sdk = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    }
    return sdk;
  };

  return {
    nombre: 'openai',
    ia: true,
    modelo,
    necesitaUrl: false, // la imagen viaja en la petición (multipart), no por URL
    async mejorar({ buffer }) {
      const inicio = Date.now();
      const { toFile } = require('openai');
      const { lienzo, tamano, rect } = await prepararLienzo(buffer);

      let respuesta;
      try {
        respuesta = await obtenerCliente().images.edit({
          model: modelo,
          image: await toFile(lienzo, 'foto.jpg', { type: 'image/jpeg' }),
          prompt: promptMejora(),
          size: tamano.size,
          quality: calidad,
          output_format: 'png',
          n: 1,
        });
      } catch (err) {
        throw clasificarError(err);
      }

      const b64 = respuesta?.data?.[0]?.b64_json;
      if (!b64) throw new ErrorProveedor('openai: la respuesta no trae imagen', { reintentable: true });
      let salida;
      try {
        const img = sharp()(Buffer.from(b64, 'base64'), { failOn: 'error' });
        const meta = await img.metadata();
        // Si OpenAI devolviera otro tamaño, el rectángulo se escala igual.
        const fx = meta.width / tamano.ancho, fy = meta.height / tamano.alto;
        const recorte = {
          left: Math.round(rect.left * fx), top: Math.round(rect.top * fy),
          width: Math.min(meta.width, Math.round(rect.width * fx)), height: Math.min(meta.height, Math.round(rect.height * fy)),
        };
        const { data, info } = await sharp()(Buffer.from(b64, 'base64')).extract(recorte)
          .resize({ width: LADO_MAX_SALIDA, height: LADO_MAX_SALIDA, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
        salida = { data, info };
      } catch (err) {
        throw new ErrorProveedor(`openai: la salida no es una imagen válida (${err.message})`, { reintentable: false });
      }

      return {
        buffer: salida.data,
        contentType: 'image/webp',
        meta: {
          ia: true, proveedor: 'openai', modelo, calidad, size: tamano.size,
          relleno: rect.width !== tamano.ancho || rect.height !== tamano.alto,
          ancho: salida.info.width, alto: salida.info.height, bytes: salida.info.size,
          uso: respuesta.usage || null, ms: Date.now() - inicio,
        },
      };
    },
  };
}

module.exports = { MODELO_POR_DEFECTO, TAMANOS, elegirTamano, prepararLienzo, clasificarError, crearProveedorOpenAI };
