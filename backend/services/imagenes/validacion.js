// Preprocesamiento y validación de imágenes con sharp. NO mejora nada: solo
// deja la entrada en condiciones para la IA y revisa la salida.
//
// Validación de la salida (controles defensivos, NO una garantía):
//   · decodificable, tamaño mínimo;
//   · misma proporción (±12 %): el modelo trabaja con match_input_image;
//   · similitud estructural: correlación de luminancia normalizada 32×32 con
//     la entrada. Un retoque de luz/color la mantiene alta; otra foto, otro
//     encuadre o un plato reemplazado la bajan. Umbral configurable;
//   · sobresaturación: la saturación media no puede subir más de lo razonable;
//   · cambio visible: si el resultado es prácticamente idéntico, no se publica
//     como "mejorada".
// Una IA generativa puede modificar detalles pequeños (una hoja, un reflejo,
// una letra) que estas métricas globales no detectan. Por eso el original se
// conserva siempre, el restaurante puede volver a él con un toque y cada
// resultado guarda proveedor, modelo y id de predicción para auditar.
function sharp() { return require('sharp'); }

const LADO_MAX_ENTRADA = 2048;
const BYTES_MAX_DIRECTO = 8 * 1024 * 1024;
const FORMATOS_IA = new Set(['jpeg', 'png', 'webp', 'gif']);
const TOLERANCIA_PROPORCION = 0.12;
const LADO_MIN_RESULTADO = 256;

function umbrales() {
  return {
    similitudMin: Number(process.env.IMAGE_AI_MIN_SIMILITUD) || 0.55,
    subidaSaturacionMax: Number(process.env.IMAGE_AI_MAX_SUBIDA_SATURACION) || 0.20,
    // Diferencia media por canal (0–255) en miniatura 64×64. Recomprimir la
    // misma foto da ~1–2; un retoque leve de luz ya da ~8.
    diferenciaMin: 3.0,
  };
}

class ErrorValidacion extends Error {}

// ¿La IA puede usar el original tal cual, o hay que mandarle una copia
// preparada (EXIF aplicado, ≤ 2048 px, formato aceptado)? El original nunca
// se modifica: la copia es un archivo aparte.
async function prepararEntrada(buffer) {
  const meta = await sharp()(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new ErrorValidacion('la imagen original no se puede leer');
  const motivos = [];
  if (!FORMATOS_IA.has(meta.format)) motivos.push(`formato ${meta.format}`);
  if (meta.orientation && meta.orientation !== 1) motivos.push('orientación EXIF');
  if (Math.max(meta.width, meta.height) > LADO_MAX_ENTRADA) motivos.push('tamaño');
  if (buffer.length > BYTES_MAX_DIRECTO) motivos.push('peso');
  if (!motivos.length) return { requiereCopia: false, buffer, contentType: `image/${meta.format}`, motivos };
  const copia = await sharp()(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: LADO_MAX_ENTRADA, height: LADO_MAX_ENTRADA, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { requiereCopia: true, buffer: copia, contentType: 'image/jpeg', motivos };
}

// Miniatura RGB fija para comparar (orientación EXIF ya aplicada).
async function miniatura(buffer, lado) {
  const { data } = await sharp()(buffer, { failOn: 'none' }).rotate()
    .resize(lado, lado, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}

function luminancia(rgb) {
  const l = new Float64Array(rgb.length / 3);
  for (let i = 0; i < l.length; i++) l[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return l;
}

// Correlación de Pearson: invariante a brillo y contraste globales (lo que
// un buen retoque cambia), sensible a la estructura (lo que no debe cambiar).
function correlacion(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; dbb += y * y;
  }
  if (da === 0 || dbb === 0) return da === dbb ? 1 : 0;
  return num / Math.sqrt(da * dbb);
}

function saturacionMedia(rgb) {
  let s = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    s += max === 0 ? 0 : (max - min) / max;
  }
  return s / n;
}

function diferenciaMedia(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// Lanza ErrorValidacion si el resultado no debe publicarse. Devuelve métricas.
async function validarResultado(entrada, resultado) {
  const u = umbrales();
  const [mE, mR] = await Promise.all([
    sharp()(entrada, { failOn: 'none' }).metadata(),
    sharp()(resultado, { failOn: 'none' }).metadata().catch(() => ({})),
  ]);
  if (!mR.width || !mR.height) throw new ErrorValidacion('el resultado no es una imagen válida');
  if (Math.min(mR.width, mR.height) < LADO_MIN_RESULTADO) throw new ErrorValidacion('resultado demasiado pequeño');
  const girada = (mE.orientation || 1) >= 5;
  const pE = girada ? mE.height / mE.width : mE.width / mE.height;
  const pR = mR.width / mR.height;
  if (Math.abs(pR - pE) / pE > TOLERANCIA_PROPORCION) {
    throw new ErrorValidacion(`cambió la proporción (${pE.toFixed(2)} → ${pR.toFixed(2)})`);
  }

  const [e32, r32, e64, r64] = await Promise.all([
    miniatura(entrada, 32), miniatura(resultado, 32), miniatura(entrada, 64), miniatura(resultado, 64),
  ]);
  const similitud = correlacion(luminancia(e32), luminancia(r32));
  const satE = saturacionMedia(e64), satR = saturacionMedia(r64);
  const diferencia = diferenciaMedia(e64, r64);
  const metricas = {
    ancho: mR.width, alto: mR.height,
    similitud: Number(similitud.toFixed(3)),
    saturacion_original: Number(satE.toFixed(3)), saturacion_resultado: Number(satR.toFixed(3)),
    diferencia_media: Number(diferencia.toFixed(2)),
  };
  if (similitud < u.similitudMin) {
    throw Object.assign(new ErrorValidacion(`el resultado no se parece lo suficiente a la foto original (similitud ${metricas.similitud})`), { metricas });
  }
  if (satR - satE > u.subidaSaturacionMax) {
    throw Object.assign(new ErrorValidacion(`resultado sobresaturado (${metricas.saturacion_original} → ${metricas.saturacion_resultado})`), { metricas });
  }
  if (diferencia < u.diferenciaMin) {
    throw Object.assign(new ErrorValidacion('el resultado no tiene una mejora visible'), { metricas });
  }
  return metricas;
}

module.exports = {
  LADO_MAX_ENTRADA, TOLERANCIA_PROPORCION, ErrorValidacion,
  prepararEntrada, validarResultado, correlacion, umbrales,
};
