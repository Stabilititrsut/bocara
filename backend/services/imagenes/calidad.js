// Calidad mínima de una foto de publicación — métricas técnicas reales (sharp).
//
// Dos niveles:
//   · 'original'  → ¿la foto es RECUPERABLE? Solo rechaza lo que la mejora con
//                   IA no puede arreglar: resolución baja, proporción extrema
//                   (mal recortada), desenfoque fuerte, tan oscura o quemada
//                   que no se distingue el producto.
//   · 'publicable'→ ¿el RESULTADO mejorado es presentable? Umbrales más
//                   exigentes de brillo, contraste y nitidez.
// La IA de revisión (revisionIA.js) cubre lo que estas métricas no ven
// (no es comida, producto cortado, presentación descuidada).
//
// Métricas sobre la foto con la orientación EXIF aplicada, reducida a ≤ 512 px
// (así la nitidez no depende del tamaño del archivo):
//   brillo     luminancia media (0–255)
//   contraste  desviación estándar de la luminancia
//   nitidez    varianza del laplaciano (bordes finos); una foto movida o
//              desenfocada la tiene baja
//   oscuros / quemados  fracción de píxeles casi negros / casi blancos
// Todos los umbrales se pueden ajustar por variable de entorno; calibrar con
// fotos reales: node scripts/probar-calidad-imagen.js <carpeta>
function sharp() { return require('sharp'); }

const LADO_ANALISIS = 512;

function num(nombre, porDefecto) {
  const n = Number(process.env[nombre]);
  return process.env[nombre] !== undefined && process.env[nombre] !== '' && Number.isFinite(n) ? n : porDefecto;
}

function umbralesCalidad() {
  return {
    original: {
      ladoMin: num('IMAGE_QUALITY_MIN_LADO', 600),
      proporcionMax: num('IMAGE_QUALITY_MAX_PROPORCION', 2.0),
      brilloMin: num('IMAGE_QUALITY_MIN_BRILLO', 35),
      brilloMax: num('IMAGE_QUALITY_MAX_BRILLO', 235),
      contrasteMin: num('IMAGE_QUALITY_MIN_CONTRASTE', 15),
      nitidezMin: num('IMAGE_QUALITY_MIN_NITIDEZ', 25),
      oscurosMax: 0.6,
      quemadosMax: 0.45,
    },
    publicable: {
      ladoMin: num('IMAGE_QUALITY_MIN_LADO', 600),
      proporcionMax: num('IMAGE_QUALITY_MAX_PROPORCION', 2.0),
      brilloMin: num('IMAGE_QUALITY_PUBLICABLE_MIN_BRILLO', 70),
      brilloMax: num('IMAGE_QUALITY_PUBLICABLE_MAX_BRILLO', 225),
      contrasteMin: num('IMAGE_QUALITY_PUBLICABLE_MIN_CONTRASTE', 28),
      nitidezMin: num('IMAGE_QUALITY_PUBLICABLE_MIN_NITIDEZ', 45),
      oscurosMax: 0.35,
      quemadosMax: 0.25,
    },
  };
}

// Mensajes para el restaurante (qué pasa y qué hacer).
const MENSAJES = Object.freeze({
  ilegible: 'No pudimos leer la imagen. Sube una foto JPG, PNG o WEBP.',
  resolucion: 'La foto tiene muy poca resolución. Usa una foto de al menos 600 px por lado.',
  proporcion: 'La foto está muy alargada o mal recortada. Usa una foto cuadrada o 4:3 con el producto completo.',
  oscura: 'La foto está demasiado oscura: no se distingue el producto. Tómala con más luz.',
  quemada: 'La foto está sobreexpuesta (demasiado clara). Evita el flash directo o la luz de frente.',
  sin_contraste: 'La foto está muy lavada o sin contraste. Tómala con mejor luz.',
  borrosa: 'La foto está borrosa o movida. Enfoca el producto y mantén el teléfono firme.',
});

function luminancia(raw, canales) {
  const n = raw.length / canales;
  const l = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * canales;
    l[i] = 0.299 * raw[j] + 0.587 * raw[j + 1] + 0.114 * raw[j + 2];
  }
  return l;
}

function media(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function desviacion(a, m = media(a)) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / a.length); }

// Varianza del laplaciano 4-vecinos sobre la luminancia.
function varianzaLaplaciano(l, ancho, alto) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < alto - 1; y++) {
    for (let x = 1; x < ancho - 1; x++) {
      const i = y * ancho + x;
      const v = l[i - ancho] + l[i + ancho] + l[i - 1] + l[i + 1] - 4 * l[i];
      s += v; s2 += v * v; n += 1;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

// → { ancho, alto, proporcion, brillo, contraste, nitidez, oscuros, quemados }
async function medir(buffer) {
  const base = sharp()(buffer, { failOn: 'error' }).rotate();
  const meta = await sharp()(buffer, { failOn: 'error' }).metadata();
  if (!meta.width || !meta.height) throw new Error('sin dimensiones');
  const girada = (meta.orientation || 1) >= 5;
  const ancho = girada ? meta.height : meta.width;
  const alto = girada ? meta.width : meta.height;
  const { data, info } = await base
    .resize({ width: LADO_ANALISIS, height: LADO_ANALISIS, fit: 'inside', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const l = luminancia(data, info.channels);
  const brillo = media(l);
  let oscuros = 0, quemados = 0;
  for (let i = 0; i < l.length; i++) { if (l[i] < 20) oscuros += 1; else if (l[i] > 245) quemados += 1; }
  return {
    ancho, alto,
    proporcion: Number((Math.max(ancho, alto) / Math.min(ancho, alto)).toFixed(3)),
    brillo: Number(brillo.toFixed(1)),
    contraste: Number(desviacion(l, brillo).toFixed(1)),
    nitidez: Number(varianzaLaplaciano(l, info.width, info.height).toFixed(1)),
    oscuros: Number((oscuros / l.length).toFixed(3)),
    quemados: Number((quemados / l.length).toFixed(3)),
  };
}

// → { ok, nivel, metricas, motivos: [{ codigo, mensaje }] }. Nunca lanza.
async function analizarCalidad(buffer, { nivel = 'original' } = {}) {
  const u = umbralesCalidad()[nivel];
  if (!u) throw new Error(`nivel de calidad desconocido: ${nivel}`);
  let m;
  try { m = await medir(buffer); } catch {
    return { ok: false, nivel, metricas: null, motivos: [{ codigo: 'ilegible', mensaje: MENSAJES.ilegible }] };
  }
  const motivos = [];
  const agregar = (codigo) => motivos.push({ codigo, mensaje: MENSAJES[codigo] });
  if (Math.min(m.ancho, m.alto) < u.ladoMin) agregar('resolucion');
  if (m.proporcion > u.proporcionMax) agregar('proporcion');
  if (m.brillo < u.brilloMin || m.oscuros > u.oscurosMax) agregar('oscura');
  else if (m.brillo > u.brilloMax || m.quemados > u.quemadosMax) agregar('quemada');
  else if (m.contraste < u.contrasteMin) agregar('sin_contraste');
  if (m.nitidez < u.nitidezMin) agregar('borrosa');
  return { ok: motivos.length === 0, nivel, metricas: m, motivos, umbrales: u };
}

module.exports = { MENSAJES, umbralesCalidad, medir, analizarCalidad, varianzaLaplaciano };
