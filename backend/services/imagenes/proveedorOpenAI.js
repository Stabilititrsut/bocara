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
//   2. la foto entra completa, centrada (ampliada si es pequeña), sobre un
//      fondo hecho con ella misma ampliada y muy desenfocada;
//   3. según contexto.encuadre:
//      · 'original' (fotos de negocio): del resultado se recorta exactamente
//        el rectángulo de la foto → misma proporción y encuadre.
//      · 'comercial' (publicaciones): el modelo reemplaza el relleno por la
//        continuación del fondo y se entrega el lienzo COMPLETO (lado menor
//        1024 px, formato estándar). meta.region dice dónde quedó la foto
//        original (fracciones 0–1) para validar que la comida no cambió. Si
//        la foto venía cortada o muy cerrada, entra con margen
//        (MARGEN_RECOMPONER) para que el modelo pueda recomponerla.
//      · 'perfil' / 'portada' (imágenes del restaurante): igual que
//        'comercial' pero con lienzo fijo: 1024x1024 (avatar) o 1536x1024 (banner).
//   `encuadres` declara cuáles soporta: trabajos.js no manda perfil ni portada
//   a un proveedor que no los declare (Replicate usa el prompt de comida).
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

// Fracción del lienzo que ocupa una foto cortada/cerrada en encuadre comercial.
const MARGEN_RECOMPONER = 0.84;
const PROBLEMAS_RECOMPONER = new Set(['recortada']);

// Encuadres que entregan el lienzo COMPLETO (con el fondo extendido) y el
// tamaño fijo que usan los del restaurante: perfil cuadrado, portada horizontal.
const LIENZO_COMPLETO = new Set(['comercial', 'perfil', 'portada']);
const TAMANO_FIJO = Object.freeze({ perfil: TAMANOS[0], portada: TAMANOS[1] });

// Lienzo del tamaño de salida con la foto completa centrada (ampliada con
// lanczos si es pequeña) y un fondo desenfocado de la misma foto. `margen` < 1
// deja espacio alrededor; `tamano` fija el lienzo (si no, el más parecido a la
// foto). Devuelve el lienzo JPEG y el rectángulo útil.
async function prepararLienzo(buffer, { margen = 1, tamano = null } = {}) {
  const base = sharp()(buffer, { failOn: 'none' }).rotate();
  const { data: plano, info } = await base.toBuffer({ resolveWithObject: true });
  const t = tamano || elegirTamano(info.width, info.height);
  const escala = Math.min(t.ancho / info.width, t.alto / info.height) * margen;
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

// Códigos de OpenAI que significan "la cuenta no tiene saldo": reintentar no
// sirve, hay que recargar créditos.
const CODIGOS_SIN_CREDITO = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active']);

// Clasifica errores del SDK: reintentar solo lo transitorio y decir el motivo.
function clasificarError(err) {
  const status = err?.status;
  const codigo = err?.code || err?.error?.code;
  let motivo = 'otro';
  if (CODIGOS_SIN_CREDITO.has(codigo)) motivo = 'sin_credito';
  else if (status === 401 || status === 403 || codigo === 'invalid_api_key') motivo = 'clave_invalida';
  else if (status === 404 || codigo === 'model_not_found') motivo = 'modelo';
  else if (status === 429) motivo = 'limite';
  else if (err?.name === 'APIConnectionTimeoutError' || status === 408) motivo = 'timeout';
  else if (err?.name === 'APIConnectionError') motivo = 'red';
  const transitorio = motivo === 'limite' || motivo === 'timeout' || motivo === 'red'
    || status === 409 || (status >= 500);
  const msg = err?.error?.message || err?.message || 'error desconocido';
  return new ErrorProveedor(`openai ${status || err?.name || ''}${codigo ? ` (${codigo})` : ''}: ${msg}`.trim(),
    { reintentable: !!transitorio, motivo });
}

function crearProveedorOpenAI({
  apiKey = process.env.OPENAI_API_KEY,
  modelo = process.env.OPENAI_IMAGE_MODEL || MODELO_POR_DEFECTO,
  calidad = process.env.OPENAI_IMAGE_QUALITY || 'medium',
  // input_fidelity 'high' conserva mejor la foto de entrada; los modelos *-mini
  // solo admiten 'low', así que con ellos no se envía. OPENAI_IMAGE_INPUT_FIDELITY=low|high lo fuerza.
  fidelidad = process.env.OPENAI_IMAGE_INPUT_FIDELITY || (/mini/i.test(modelo) ? null : 'high'),
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
    encuadres: LIENZO_COMPLETO,
    async mejorar({ buffer, contexto = {} }) {
      const inicio = Date.now();
      const { toFile } = require('openai');
      const problemas = contexto.problemas || [];
      const encuadre = LIENZO_COMPLETO.has(contexto.encuadre) ? contexto.encuadre : 'original';
      const completo = encuadre !== 'original';
      const margen = completo && problemas.some((c) => PROBLEMAS_RECOMPONER.has(c)) ? MARGEN_RECOMPONER : 1;
      const { lienzo, tamano, rect } = await prepararLienzo(buffer, { margen, tamano: TAMANO_FIJO[encuadre] || null });

      console.log('[IMAGEN_IA] OpenAI images.edit → modelo=%s size=%s calidad=%s encuadre=%s', modelo, tamano.size, calidad, encuadre);
      let respuesta;
      try {
        respuesta = await obtenerCliente().images.edit({
          model: modelo,
          image: await toFile(lienzo, 'foto.jpg', { type: 'image/jpeg' }),
          prompt: promptMejora({ problemas, encuadre }),
          size: tamano.size,
          quality: calidad,
          output_format: 'png',
          n: 1,
          ...(fidelidad ? { input_fidelity: fidelidad } : {}),
        });
      } catch (err) {
        const e = clasificarError(err);
        console.error('[IMAGEN_IA] OpenAI images.edit FALLÓ en %d ms (motivo=%s): %s', Date.now() - inicio, e.motivo, e.message);
        throw e;
      }
      console.log('[IMAGEN_IA] OpenAI images.edit respondió en %d ms', Date.now() - inicio);

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
        // Comercial / perfil / portada: el lienzo completo (el fondo extendido es parte de la foto).
        const img2 = sharp()(Buffer.from(b64, 'base64'));
        const { data, info } = await (completo ? img2 : img2.extract(recorte))
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
          ia: true, proveedor: 'openai', modelo, calidad, input_fidelity: fidelidad || null, size: tamano.size,
          relleno: rect.width !== tamano.ancho || rect.height !== tamano.alto,
          encuadre,
          // Dónde quedó la foto original dentro del resultado (fracciones 0–1).
          region: completo ? {
            left: rect.left / tamano.ancho, top: rect.top / tamano.alto,
            width: rect.width / tamano.ancho, height: rect.height / tamano.alto,
          } : null,
          ancho: salida.info.width, alto: salida.info.height, bytes: salida.info.size,
          uso: respuesta.usage || null, ms: Date.now() - inicio,
        },
      };
    },
  };
}

module.exports = { MODELO_POR_DEFECTO, TAMANOS, TAMANO_FIJO, MARGEN_RECOMPONER, elegirTamano, prepararLienzo, clasificarError, crearProveedorOpenAI };
