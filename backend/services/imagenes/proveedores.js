// Proveedores de mejora de imagen (patrón adapter).
//
// Contrato de un proveedor:
//   { nombre, mejorar({ buffer, contentType, urlOriginal, contexto }) → { buffer, contentType, meta } }
// Debe LANZAR si no pudo mejorar: el pipeline decide reintento / fallida y la
// publicación sigue mostrando la original.
//
// Selección por entorno (IMAGE_AI_PROVIDER):
//   local      (por defecto) — gratis, sin API externa: ajuste fotográfico con
//              sharp (orientación, contraste suave, color, nitidez, tamaño web).
//              No puede "inventar" nada: solo corrige la foto real.
//   replicate  — IA generativa de pago vía Replicate (modelo de edición por
//              instrucción, por defecto black-forest-labs/flux-kontext-pro).
//              Requiere REPLICATE_API_TOKEN; sin token cae a `local` con aviso.
//   none       — pipeline apagado: no se encola nada, se muestra la original.
const axios = require('axios');

const LADO_MAX = 1600;
const CALIDAD_WEBP = 85;

function sharp() { return require('sharp'); }

// Prompt para modelos de edición por instrucción. Prioriza fidelidad: mejorar
// la foto, no cambiar el producto. Sobrescribible con IMAGE_AI_PROMPT.
const PROMPT_COMIDA = [
  'Professionally retouch this real restaurant product photo so it looks appetizing and commercial:',
  'balanced natural lighting, accurate vibrant but realistic colors, gentle contrast, crisp but not oversharpened detail,',
  'clean tidy background and a pleasing composition.',
  'Keep exactly the same food or product, same portion size, same ingredients, same plate or packaging and same arrangement.',
  'Do not add, remove or replace any food, garnish, object or text; keep any existing text and logos legible and unchanged.',
  'No cartoon or illustration style, no heavy filters, no exaggeration. Photorealistic result.',
].join(' ');

// Ajuste fotográfico "comida comercial" moderado. Valores conservadores a
// propósito: mejor quedarse corto que sobreprocesar.
async function ajusteFotografico(buffer) {
  const img = sharp()(buffer, { failOn: 'none' })
    .rotate() // respeta EXIF (fotos de celular giradas)
    .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
    .normalise({ lower: 1, upper: 99 }) // estira contraste sin quemar luces/sombras
    .modulate({ brightness: 1.03, saturation: 1.12 })
    .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.5 })
    .webp({ quality: CALIDAD_WEBP });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: 'image/webp', meta: { ancho: info.width, alto: info.height, bytes: info.size } };
}

const proveedorLocal = {
  nombre: 'local',
  async mejorar({ buffer }) {
    const r = await ajusteFotografico(buffer);
    return { ...r, meta: { ...r.meta, preset: 'comida_comercial_v1' } };
  },
};

const proveedorNinguno = { nombre: 'none', async mejorar() { throw new Error('pipeline desactivado'); } };

function crearProveedorReplicate({
  token = process.env.REPLICATE_API_TOKEN,
  modelo = process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-kontext-pro',
  prompt = process.env.IMAGE_AI_PROMPT || PROMPT_COMIDA,
  timeoutMs = Number(process.env.IMAGE_AI_TIMEOUT_MS) || 120000,
  http = axios,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    nombre: 'replicate',
    modelo,
    async mejorar({ urlOriginal }) {
      const inicio = Date.now();
      const { data: creada } = await http.post(
        `https://api.replicate.com/v1/models/${modelo}/predictions`,
        { input: { prompt, input_image: urlOriginal, aspect_ratio: 'match_input_image', output_format: 'png', safety_tolerance: 2 } },
        { headers: { ...headers, Prefer: 'wait=60' }, timeout: 70000 },
      );
      let pred = creada;
      while (pred && !['succeeded', 'failed', 'canceled'].includes(pred.status)) {
        if (Date.now() - inicio > timeoutMs) throw new Error(`replicate: tiempo agotado (${timeoutMs} ms)`);
        await dormir(2000);
        ({ data: pred } = await http.get(pred.urls.get, { headers, timeout: 15000 }));
      }
      if (pred?.status !== 'succeeded') throw new Error(`replicate: ${pred?.status || 'sin respuesta'} ${pred?.error || ''}`.trim());
      const salida = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (typeof salida !== 'string') throw new Error('replicate: salida sin URL de imagen');
      // Las URLs de Replicate caducan: se descarga y se guarda en nuestro Storage.
      const { data: bytes } = await http.get(salida, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024 });
      const normal = await ajusteFinal(Buffer.from(bytes));
      return { ...normal, meta: { ...normal.meta, modelo, prediccion: pred.id, ms: Date.now() - inicio } };
    },
  };
}

// Salida de IA → mismo formato/tamaño web que el resto (sin "retoque" extra).
async function ajusteFinal(buffer) {
  const { data, info } = await sharp()(buffer, { failOn: 'none' })
    .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: CALIDAD_WEBP })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: 'image/webp', meta: { ancho: info.width, alto: info.height, bytes: info.size } };
}

function obtenerProveedor(nombre = (process.env.IMAGE_AI_PROVIDER || 'local').toLowerCase()) {
  if (nombre === 'none' || nombre === 'off') return proveedorNinguno;
  if (nombre === 'replicate') {
    if (process.env.REPLICATE_API_TOKEN) return crearProveedorReplicate();
    console.warn('[IMAGENES] IMAGE_AI_PROVIDER=replicate sin REPLICATE_API_TOKEN — se usa el ajuste local gratuito');
    return proveedorLocal;
  }
  if (nombre !== 'local') console.warn('[IMAGENES] proveedor desconocido "%s" — se usa local', nombre);
  return proveedorLocal;
}

module.exports = {
  PROMPT_COMIDA, LADO_MAX,
  proveedorLocal, proveedorNinguno, crearProveedorReplicate, obtenerProveedor, ajusteFotografico,
};
