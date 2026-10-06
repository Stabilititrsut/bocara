// Proveedores de mejora de imagen (patrón adapter).
//
// Contrato:
//   { nombre, ia, modelo?, mejorar({ buffer, urlEntrada, urlOriginal, contexto })
//       → { buffer, contentType, meta } }
// Debe LANZAR si no pudo mejorar: el pipeline decide reintento / fallida y la
// publicación sigue mostrando la original.
//
// IMAGE_AI_PROVIDER:
//   replicate (principal) — IA REAL de edición de imagen: FLUX.1 Kontext [pro]
//              de Black Forest Labs vía Replicate, image-to-image sobre la foto
//              original con un prompt estricto de fidelidad.
//   local      — ajuste técnico con sharp (contraste/color/nitidez). NO es IA y
//              no logra un acabado comercial: sirve para desarrollo sin costo,
//              pruebas y como respaldo explícito.
//   none       — pipeline apagado.
//   (sin definir) — replicate si hay REPLICATE_API_TOKEN; si no, local.
const axios = require('axios');

const LADO_MAX = 1600;
const CALIDAD_WEBP = 88;
const MODELO_POR_DEFECTO = 'black-forest-labs/flux-kontext-pro';
// Con imagen de entrada, FLUX Kontext acepta safety_tolerance ≤ 2.
const SAFETY_TOLERANCE = 2;
// Solo se descargan resultados de la CDN de Replicate (anti-SSRF).
const HOSTS_SALIDA = /(^|\.)replicate\.delivery$/;

function sharp() { return require('sharp'); }

// Prompt de fotografía gastronómica comercial. Pide una mejora VISIBLE de
// presentación y prohíbe explícitamente todo lo que cambiaría el producto.
// Sobrescribible con IMAGE_AI_PROMPT.
const PROMPT_COMIDA = [
  'Enhance this real food photograph for a professional restaurant marketplace.',
  'Preserve exactly the same food, ingredients, portions, packaging, plates, text, logos and physical composition, in the same positions and from the same camera angle.',
  'Do not add, remove or replace any food item or ingredient. Do not change quantities or portion sizes.',
  'Do not invent garnishes, sauces, steam, props or decorations that are not in the original.',
  'Do not alter branding, labels or written text; keep them legible and identical.',
  'Do not replace the background; you may only make the existing surroundings look slightly cleaner and less distracting.',
  'Improve only presentation quality: natural soft restaurant lighting, correct white balance, balanced exposure that recovers shadows and highlights,',
  'appetizing but realistic color, improved clarity and texture definition, subtle contrast, cleaner visual appearance, natural depth,',
  'and the look of professional commercial food photography.',
  'Keep the image photorealistic and faithful to the original product.',
  'Avoid artificial HDR, oversaturation, plastic-looking food, unrealistic textures, cartoon or illustration style.',
].join(' ');

class ErrorProveedor extends Error {
  constructor(mensaje, { reintentable = true } = {}) { super(mensaje); this.reintentable = reintentable; }
}

async function aWebp(buffer) {
  const { data, info } = await sharp()(buffer, { failOn: 'none' })
    .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: CALIDAD_WEBP })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, contentType: 'image/webp', meta: { ancho: info.width, alto: info.height, bytes: info.size } };
}

// ── local: ajuste técnico (no IA) ───────────────────────────────────────────
const proveedorLocal = {
  nombre: 'local',
  ia: false,
  async mejorar({ buffer }) {
    const { data, info } = await sharp()(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
      .normalise({ lower: 1, upper: 99 })
      .modulate({ brightness: 1.03, saturation: 1.12 })
      .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.5 })
      .webp({ quality: CALIDAD_WEBP })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data, contentType: 'image/webp',
      meta: { ia: false, preset: 'ajuste_tecnico_v1', ancho: info.width, alto: info.height, bytes: info.size },
    };
  },
};

const proveedorNinguno = { nombre: 'none', ia: false, async mejorar() { throw new ErrorProveedor('pipeline desactivado', { reintentable: false }); } };

// ── replicate: IA real (FLUX.1 Kontext [pro]) ──────────────────────────────
function crearProveedorReplicate({
  token = process.env.REPLICATE_API_TOKEN,
  modelo = process.env.REPLICATE_IMAGE_MODEL || MODELO_POR_DEFECTO,
  prompt = process.env.IMAGE_AI_PROMPT || PROMPT_COMIDA,
  timeoutMs = Number(process.env.IMAGE_AI_TIMEOUT_MS) || 120000,
  http = axios,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!token) throw new Error('REPLICATE_API_TOKEN no configurado');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function llamar(fn) {
    try { return await fn(); } catch (err) {
      const status = err?.response?.status;
      // 4xx (salvo 408/429) = la petición es inválida: reintentar no sirve.
      const reintentable = !status || status === 408 || status === 429 || status >= 500;
      const detalle = err?.response?.data?.detail || err?.response?.data?.title || err.message;
      throw new ErrorProveedor(`replicate ${status || err.code || ''}: ${detalle}`.trim(), { reintentable });
    }
  }

  return {
    nombre: 'replicate',
    ia: true,
    modelo,
    async mejorar({ urlEntrada }) {
      if (!urlEntrada) throw new ErrorProveedor('replicate: falta la URL de la imagen de entrada', { reintentable: false });
      const inicio = Date.now();
      let pred = (await llamar(() => http.post(
        `https://api.replicate.com/v1/models/${modelo}/predictions`,
        {
          input: {
            prompt,
            input_image: urlEntrada,
            aspect_ratio: 'match_input_image',
            output_format: 'png',
            safety_tolerance: SAFETY_TOLERANCE,
            prompt_upsampling: false,
          },
        },
        { headers: { ...headers, Prefer: 'wait=60' }, timeout: 75000 },
      ))).data;

      while (pred && !['succeeded', 'failed', 'canceled'].includes(pred.status)) {
        if (Date.now() - inicio > timeoutMs) throw new ErrorProveedor(`replicate: tiempo agotado (${timeoutMs} ms)`);
        if (!pred.urls?.get) throw new ErrorProveedor('replicate: predicción sin URL de consulta');
        await dormir(2000);
        pred = (await llamar(() => http.get(pred.urls.get, { headers, timeout: 15000 }))).data;
      }
      if (pred?.status !== 'succeeded') {
        // failed por filtro de contenido o entrada inválida no mejora reintentando.
        throw new ErrorProveedor(`replicate: ${pred?.status || 'sin respuesta'} ${pred?.error || ''}`.trim(),
          { reintentable: pred?.status !== 'failed' });
      }
      const salida = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      let host = '';
      try { const u = new URL(salida); host = u.protocol === 'https:' ? u.host : ''; } catch { /* inválida */ }
      if (!HOSTS_SALIDA.test(host)) throw new ErrorProveedor('replicate: URL de salida inesperada', { reintentable: false });

      // Las URLs de salida de Replicate caducan: se descarga y se guarda en nuestro Storage.
      const bytes = (await llamar(() => http.get(salida, {
        responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024, maxRedirects: 0,
      }))).data;
      let webp;
      try { webp = await aWebp(Buffer.from(bytes)); } catch (err) {
        throw new ErrorProveedor(`replicate: la salida no es una imagen válida (${err.message})`, { reintentable: false });
      }
      return {
        ...webp,
        meta: { ...webp.meta, ia: true, modelo, prediccion: pred.id, ms: Date.now() - inicio, metricas_replicate: pred.metrics || null },
      };
    },
  };
}

function obtenerProveedor(nombre = process.env.IMAGE_AI_PROVIDER) {
  const n = String(nombre || (process.env.REPLICATE_API_TOKEN ? 'replicate' : 'local')).toLowerCase();
  if (n === 'none' || n === 'off') return proveedorNinguno;
  if (n === 'replicate') {
    if (process.env.REPLICATE_API_TOKEN) return crearProveedorReplicate();
    console.error('[IMAGENES] IMAGE_AI_PROVIDER=replicate SIN REPLICATE_API_TOKEN — se usa el ajuste técnico local (NO es IA). Configura el token.');
    return proveedorLocal;
  }
  if (n !== 'local') console.warn('[IMAGENES] proveedor desconocido "%s" — se usa el ajuste técnico local (no IA)', n);
  return proveedorLocal;
}

module.exports = {
  PROMPT_COMIDA, LADO_MAX, MODELO_POR_DEFECTO, SAFETY_TOLERANCE, ErrorProveedor,
  proveedorLocal, proveedorNinguno, crearProveedorReplicate, obtenerProveedor,
};
