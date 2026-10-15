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

// Fidelidad ESTRICTA (foto de perfil / portada del restaurante): la IA solo
// puede restaurar, así que el resultado tiene que ser casi la misma imagen.
//   similitudDetalleMin  correlación de luminancia a 96×96 (formas del logo).
//   similitudZonaMin     la PEOR correlación entre zonas con contenido
//                        (cuadrícula 8×8 sobre 128×128): un cambio pequeño
//                        (letras redibujadas, un símbolo) apenas mueve la
//                        similitud global pero hunde la de su zona.
//   derivaTonoLocalMax   cambio de TONO (grados) de los píxeles con color,
//                        DESCONTANDO el cambio global: corregir una dominante
//                        (balance de blancos) mueve todo igual y no cuenta;
//                        recolorear el logo o un elemento sí. Contraste y
//                        exposición no cambian el tono.
//   derivaTonoGlobalMax  cuánto puede girar el tono de toda la imagen.
//   cambioSaturacionMax  cambio relativo de la saturación de esos píxeles.
function umbralesEstrictos(uso) {
  const n = (v, d) => (Number.isFinite(Number(process.env[v])) && process.env[v] ? Number(process.env[v]) : d);
  if (uso === 'perfil') {
    return {
      similitudMin: n('IMAGE_AI_PERFIL_MIN_SIMILITUD', 0.85),
      similitudDetalleMin: n('IMAGE_AI_PERFIL_MIN_SIMILITUD_DETALLE', 0.8),
      similitudZonaMin: n('IMAGE_AI_PERFIL_MIN_SIMILITUD_ZONA', 0.6),
      derivaTonoLocalMax: n('IMAGE_AI_PERFIL_MAX_DERIVA_TONO', 8),
      derivaTonoGlobalMax: n('IMAGE_AI_PERFIL_MAX_DERIVA_TONO_GLOBAL', 8),
      cambioSaturacionMax: n('IMAGE_AI_PERFIL_MAX_CAMBIO_SATURACION', 0.25),
    };
  }
  if (uso === 'portada') {
    return {
      similitudMin: n('IMAGE_AI_PORTADA_MIN_SIMILITUD', 0.75),
      similitudDetalleMin: n('IMAGE_AI_PORTADA_MIN_SIMILITUD_DETALLE', 0.7),
      similitudZonaMin: n('IMAGE_AI_PORTADA_MIN_SIMILITUD_ZONA', 0.45),
      derivaTonoLocalMax: n('IMAGE_AI_PORTADA_MAX_DERIVA_TONO', 12),
      derivaTonoGlobalMax: n('IMAGE_AI_PORTADA_MAX_DERIVA_TONO_GLOBAL', 15),
      cambioSaturacionMax: n('IMAGE_AI_PORTADA_MAX_CAMBIO_SATURACION', 0.35),
    };
  }
  return null;
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

// Tono (0–360) y saturación HSV de un píxel RGB.
function tonoSat(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return { h: 0, s: 0, v: max };
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s: d / max, v: max };
}
const difTono = (x, y) => { const d = ((y - x + 540) % 360) - 180; return d; };

// Cambio de color de los píxeles CON color (saturación ≥ 0.25 y no oscuros)
// en la original: giro de tono global, giro por píxel descontando el global
// (grados) y cambio relativo de saturación. Blancos, grises y negros no tienen
// tono fiable y se ignoran (su corrección es balance de blancos).
function derivaColor(a, b) {
  const n = a.length / 3;
  const pares = [];
  for (let i = 0; i < n; i++) {
    const o = tonoSat(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    if (o.s < 0.25 || o.v < 50) continue;
    pares.push([o, tonoSat(b[i * 3], b[i * 3 + 1], b[i * 3 + 2])]);
  }
  if (!pares.length) return { global: 0, local: 0, saturacion: 0, pixeles: 0 };
  // Media circular del giro de tono.
  let sx = 0, sy = 0, so = 0, sr = 0;
  for (const [o, r] of pares) {
    const d = (difTono(o.h, r.h) * Math.PI) / 180;
    sx += Math.cos(d); sy += Math.sin(d); so += o.s; sr += r.s;
  }
  const global = (Math.atan2(sy, sx) * 180) / Math.PI;
  let local = 0;
  for (const [o, r] of pares) local += Math.abs(difTono(global, difTono(o.h, r.h)));
  return { global: Math.abs(global), local: local / pares.length, saturacion: Math.abs(sr - so) / so, pixeles: pares.length };
}

// Peor correlación de luminancia entre zonas (lado×lado en una imagen
// tamaño×tamaño) donde la original tiene estructura (desviación > 8).
function similitudPorZonas(a, b, tamano, lado) {
  let peor = 1;
  for (let y0 = 0; y0 < tamano; y0 += lado) {
    for (let x0 = 0; x0 < tamano; x0 += lado) {
      const za = [], zb = [];
      for (let y = y0; y < y0 + lado; y++) for (let x = x0; x < x0 + lado; x++) { za.push(a[y * tamano + x]); zb.push(b[y * tamano + x]); }
      let m = 0; for (const v of za) m += v; m /= za.length;
      let d = 0; for (const v of za) d += (v - m) ** 2;
      if (Math.sqrt(d / za.length) <= 8) continue;
      peor = Math.min(peor, correlacion(za, zb));
    }
  }
  return peor;
}

function diferenciaMedia(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// Lanza ErrorValidacion si el resultado no debe publicarse. Devuelve métricas.
// `region` (fracciones 0–1, encuadre comercial): dónde quedó la foto original
// dentro del resultado. La comparación se hace SOLO ahí: el fondo extendido
// por la IA no cuenta, la comida tiene que seguir siendo la misma.
// `uso` 'perfil' | 'portada' agrega la fidelidad estricta (umbralesEstrictos).
async function validarResultado(entrada, resultadoCompleto, { region = null, uso = null } = {}) {
  const u = umbrales();
  const estricta = umbralesEstrictos(uso);
  const mCompleto = await sharp()(resultadoCompleto, { failOn: 'none' }).metadata().catch(() => ({}));
  if (!mCompleto.width || !mCompleto.height) throw new ErrorValidacion('el resultado no es una imagen válida');
  if (Math.min(mCompleto.width, mCompleto.height) < LADO_MIN_RESULTADO) throw new ErrorValidacion('resultado demasiado pequeño');
  let resultado = resultadoCompleto;
  if (region) {
    const recorte = {
      left: Math.max(0, Math.round(region.left * mCompleto.width)),
      top: Math.max(0, Math.round(region.top * mCompleto.height)),
    };
    recorte.width = Math.min(mCompleto.width - recorte.left, Math.round(region.width * mCompleto.width));
    recorte.height = Math.min(mCompleto.height - recorte.top, Math.round(region.height * mCompleto.height));
    resultado = await sharp()(resultadoCompleto).extract(recorte).png().toBuffer();
  }
  const [mE, mR] = await Promise.all([
    sharp()(entrada, { failOn: 'none' }).metadata(),
    sharp()(resultado, { failOn: 'none' }).metadata().catch(() => ({})),
  ]);
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
    ancho: mCompleto.width, alto: mCompleto.height, ...(region ? { region_comparada: { ancho: mR.width, alto: mR.height } } : {}),
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
  if (estricta) {
    const [e96, r96, e128, r128] = await Promise.all([miniatura(entrada, 96), miniatura(resultado, 96), miniatura(entrada, 128), miniatura(resultado, 128)]);
    const detalle = correlacion(luminancia(e96), luminancia(r96));
    const zona = similitudPorZonas(luminancia(e128), luminancia(r128), 128, 16);
    const color = derivaColor(e64, r64);
    Object.assign(metricas, {
      similitud_detalle: Number(detalle.toFixed(3)), similitud_zona_min: Number(zona.toFixed(3)),
      deriva_tono_local: Number(color.local.toFixed(2)), deriva_tono_global: Number(color.global.toFixed(2)),
      cambio_saturacion: Number(color.saturacion.toFixed(3)),
    });
    const fallo = (motivo) => Object.assign(new ErrorValidacion(motivo), { metricas, fidelidad: true });
    if (similitud < estricta.similitudMin || detalle < estricta.similitudDetalleMin || zona < estricta.similitudZonaMin) {
      throw fallo(`el resultado cambió formas, letras o elementos de la imagen (similitud ${metricas.similitud}, detalle ${metricas.similitud_detalle}, peor zona ${metricas.similitud_zona_min})`);
    }
    if (color.local > estricta.derivaTonoLocalMax || color.global > estricta.derivaTonoGlobalMax || color.saturacion > estricta.cambioSaturacionMax) {
      throw fallo(`el resultado cambió los colores de la imagen (tono local ${metricas.deriva_tono_local}°, global ${metricas.deriva_tono_global}°, saturación ${metricas.cambio_saturacion})`);
    }
  }
  if (diferencia < u.diferenciaMin) {
    throw Object.assign(new ErrorValidacion('el resultado no tiene una mejora visible'), { metricas });
  }
  return metricas;
}

module.exports = {
  LADO_MAX_ENTRADA, TOLERANCIA_PROPORCION, ErrorValidacion,
  prepararEntrada, validarResultado, correlacion, derivaColor, umbrales, umbralesEstrictos,
};
