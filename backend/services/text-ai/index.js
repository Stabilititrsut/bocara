// IA de texto: descripción propuesta para una Promoción o Tiempo limitado.
//
// Flujo: validarEntrada (lista blanca + límites) → construirHechos (solo datos
// públicos del producto, saneados) → proveedor.generar → limpiarSalida →
// verificarCifras (toda cifra de la salida debe venir de los hechos).
// Nada se guarda en BD: la ruta devuelve la propuesta y el restaurante decide.
//
// TEXT_AI_PROVIDER:
//   gemini  (principal) — Gemini 2.5 Flash-Lite por defecto (providers/gemini.js)
//   openai  — reservado: aún no implementado para texto, se trata como none
//   none    — función apagada (la ruta responde 503 y la app lo informa)
//   (sin definir) — gemini si hay GEMINI_API_KEY; si no, none.
// Agregar un proveedor = un archivo en providers/ con { nombre, modelo,
// generar({ sistema, usuario, temperatura, maxTokens, timeoutMs }) → { texto, finCorte, uso } }
// y una línea en obtenerProveedorTexto.
const { INSTRUCCION_SISTEMA, ETIQUETA_TIPO, mensajeUsuario } = require('./prompts');
const { ErrorTextoIA } = require('./errores');
const { crearProveedorGemini, MODELO_POR_DEFECTO: MODELO_GEMINI } = require('./providers/gemini');

// Mismos valores que CATEGORIAS_ALIMENTO en bocara-mobile/app/restaurante/bolsas.tsx.
const CATEGORIAS_ALIMENTO = Object.freeze({
  cereales: 'Cereales y panadería', frutas: 'Frutas', verduras: 'Verduras',
  raices_tuberculos: 'Raíces y tubérculos', legumbres: 'Legumbres', lacteos: 'Lácteos',
  huevos: 'Huevos', pollo: 'Pollo', cerdo: 'Cerdo', carne_bovina: 'Carne bovina',
  pescado_mariscos: 'Pescado y mariscos', comida_mixta: 'Comida mixta', otro: null,
});

const LIMITES = Object.freeze({
  nombre: { min: 2, max: 120 }, // igual que validarDatosBolsa (routes/bolsas.js)
  descripcion: 600,
  contenido: 400,
  categoriaNegocio: 60,
  precioMax: 100000,
});
const MAX_CARACTERES_SALIDA = 300;
// Emojis y el selector de variación que los acompaña (U+FE0F).
const RE_EMOJI = new RegExp(`\\p{Extended_Pictographic}|${String.fromCharCode(0xfe0f)}`, 'gu');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

function numeroEnv(nombre, porDefecto, min, max) {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && process.env[nombre] !== '' ? Math.min(max, Math.max(min, n)) : porDefecto;
}

function configuracion() {
  return {
    timeoutMs: numeroEnv('TEXT_AI_TIMEOUT_MS', 10000, 2000, 30000),
    maxTokens: numeroEnv('TEXT_AI_MAX_OUTPUT_TOKENS', 160, 32, 400),
    temperatura: numeroEnv('TEXT_AI_TEMPERATURE', 0.4, 0, 1),
  };
}

// ── Proveedor ───────────────────────────────────────────────────────────────
// Devuelve null cuando la función está apagada o sin credencial.
function obtenerProveedorTexto(nombre = process.env.TEXT_AI_PROVIDER) {
  const n = String(nombre || (process.env.GEMINI_API_KEY ? 'gemini' : 'none')).toLowerCase().trim();
  if (n === 'none' || n === 'off') return null;
  if (n === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error('[TEXTO_IA] TEXT_AI_PROVIDER=gemini SIN GEMINI_API_KEY — función desactivada.');
      return null;
    }
    return crearProveedorGemini();
  }
  if (n === 'openai') {
    console.warn('[TEXTO_IA] TEXT_AI_PROVIDER=openai aún no está implementado para texto — función desactivada.');
    return null;
  }
  console.warn('[TEXTO_IA] proveedor desconocido "%s" — función desactivada.', n);
  return null;
}

// ── Saneamiento ─────────────────────────────────────────────────────────────
// Texto libre del restaurante: sin HTML, caracteres de control ni datos de
// contacto (no son parte del producto y no deben salir hacia el proveedor).
// Rangos por código para que el archivo no lleve invisibles literales.
const cc = (n) => String.fromCharCode(n);
const RE_INVISIBLES = new RegExp(`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}${cc(0x200b)}-${cc(0x200f)}${cc(0x2028)}-${cc(0x202e)}${cc(0x2060)}-${cc(0x206f)}${cc(0xfeff)}]`, 'g');
function sanear(texto, max) {
  if (texto === undefined || texto === null) return '';
  return String(texto)
    .normalize('NFC')
    .replace(/<[^>]*>/g, ' ')
    .replace(RE_INVISIBLES, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, ' ')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/(\+?502[\s-]?)?\b\d{4}[\s-]?\d{4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function aPrecio(v) {
  if (v === undefined || v === null || v === '') return { ok: true, valor: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > LIMITES.precioMax) return { ok: false };
  return { ok: true, valor: Math.round(n * 100) / 100 };
}

// ── Validación ──────────────────────────────────────────────────────────────
// → { datos } | { error }. Solo se leen los campos de la lista blanca; el
// resto del body se ignora y nunca llega al proveedor.
function validarEntrada(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Datos inválidos' };
  const tipo = body.tipo;
  if (tipo !== 'cupon' && tipo !== 'bolsa') return { error: 'tipo debe ser "cupon" (Promoción) o "bolsa" (Tiempo limitado)' };

  for (const [campo, max] of [['nombre', LIMITES.nombre.max], ['descripcion', LIMITES.descripcion], ['contenido', LIMITES.contenido]]) {
    const v = body[campo];
    if (v !== undefined && v !== null && typeof v !== 'string') return { error: `${campo} debe ser texto` };
    if (typeof v === 'string' && v.length > max) return { error: `${campo} admite máximo ${max} caracteres` };
  }
  const nombre = sanear(body.nombre, LIMITES.nombre.max);
  if (nombre.length < LIMITES.nombre.min) return { error: 'Escribe al menos el nombre del producto para generar la descripción' };

  const po = aPrecio(body.precio_original);
  const pd = aPrecio(body.precio_descuento);
  if (!po.ok || !pd.ok) return { error: `Los precios deben ser números entre 0 y ${LIMITES.precioMax}` };

  const categoria = body.categoria_alimento;
  if (categoria !== undefined && categoria !== null && categoria !== '' && !(categoria in CATEGORIAS_ALIMENTO)) {
    return { error: 'categoria_alimento inválida' };
  }
  for (const campo of ['hora_recogida_inicio', 'hora_recogida_fin']) {
    const v = body[campo];
    if (v !== undefined && v !== null && v !== '' && !RE_HORA.test(String(v))) return { error: `${campo} debe tener formato HH:MM` };
  }
  for (const campo of ['fecha_disponible', 'fecha_caducidad']) {
    const v = body[campo];
    if (v !== undefined && v !== null && v !== '' && !RE_FECHA.test(String(v))) return { error: `${campo} debe tener formato AAAA-MM-DD` };
  }

  return {
    datos: {
      tipo,
      nombre,
      descripcion: sanear(body.descripcion, LIMITES.descripcion),
      // En una Promoción `contenido` es el código del cupón, no un dato del producto.
      contenido: tipo === 'bolsa' ? sanear(body.contenido, LIMITES.contenido) : '',
      categoria_alimento: categoria || null,
      precio_original: po.valor,
      precio_descuento: pd.valor,
      hora_inicio: body.hora_recogida_inicio ? String(body.hora_recogida_inicio).slice(0, 5) : null,
      hora_fin: body.hora_recogida_fin ? String(body.hora_recogida_fin).slice(0, 5) : null,
      fecha_inicio: body.fecha_disponible || null,
      fecha_fin: tipo === 'bolsa' ? (body.fecha_caducidad || null) : null,
    },
  };
}

// ── Hechos para el prompt ───────────────────────────────────────────────────
const q = (n) => `Q${n.toFixed(2)}`;
function fechaLegible(iso) {
  const m = RE_FECHA.exec(iso || '');
  if (!m) return null;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes}` : null;
}

// El descuento se calcula aquí (no se confía en el cliente) y solo si ambos
// precios son coherentes.
function construirHechos(datos, { categoriaNegocio } = {}) {
  const { precio_original: po, precio_descuento: pd } = datos;
  const descuento = po > 0 && pd !== null && pd < po ? Math.round((1 - pd / po) * 100) : null;
  const horario = datos.hora_inicio && datos.hora_fin ? `${datos.hora_inicio} a ${datos.hora_fin}` : null;
  const desde = fechaLegible(datos.fecha_inicio);
  const hasta = fechaLegible(datos.fecha_fin);
  let fecha = null;
  if (datos.tipo === 'bolsa' && desde && hasta) fecha = desde === hasta ? `el ${desde}` : `del ${desde} al ${hasta}`;
  else if (desde) fecha = `desde el ${desde}`;

  return {
    tipo: ETIQUETA_TIPO[datos.tipo],
    nombre: datos.nombre,
    descripcion_actual: datos.descripcion || null,
    contenido: datos.contenido || null,
    categoria_alimento: CATEGORIAS_ALIMENTO[datos.categoria_alimento] || null,
    precio_original: po !== null && po > 0 ? q(po) : null,
    precio_bocara: pd !== null ? q(pd) : null,
    descuento: descuento && descuento > 0 ? `${descuento}%` : null,
    horario_recogida: horario,
    fecha,
    categoria_negocio: sanear(categoriaNegocio, LIMITES.categoriaNegocio) || null,
  };
}

// ── Salida ──────────────────────────────────────────────────────────────────
function cortarEnFrase(texto, max) {
  if (texto.length <= max && /[.!?]$/.test(texto)) return texto;
  const corte = texto.slice(0, max);
  const fin = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
  if (fin > 40) return corte.slice(0, fin + 1);
  if (/[.!?]$/.test(corte) && corte.length > 40) return corte;
  return null;
}

function limpiarSalida(texto, { finCorte = false } = {}) {
  let t = String(texto || '')
    .replace(RE_EMOJI, '')
    .replace(/[*_#`]/g, '')
    .replace(/^\s*(descripci[oó]n( propuesta)?\s*:\s*)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .trim();
  if (finCorte || t.length > MAX_CARACTERES_SALIDA) t = cortarEnFrase(t, MAX_CARACTERES_SALIDA) || '';
  else if (t && !/[.!?]$/.test(t)) t = `${t}.`;
  return t;
}

// Toda cifra de la propuesta debe existir en los hechos (precio, %, hora,
// día). Una cifra nueva = dato inventado → se descarta la propuesta entera.
function valoresNumericos(texto) {
  return (String(texto).match(/\d+(?:[.,]\d+)?/g) || []).map((s) => Number(s.replace(',', '.')));
}
function cifrasPermitidas(hechos) {
  const permitidas = new Set();
  for (const v of Object.values(hechos)) {
    if (typeof v !== 'string') continue;
    for (const n of valoresNumericos(v)) permitidas.add(n);
  }
  // Horas: "18:00" también puede escribirse "18 h", "6 p. m." o "6:00".
  for (const m of String(hechos.horario_recogida || '').matchAll(/(\d{2}):(\d{2})/g)) {
    const h = Number(m[1]);
    for (const hora of h > 12 ? [h, h - 12] : [h]) {
      permitidas.add(hora);
      permitidas.add(Number(`${hora}.${m[2]}`)); // "6:30" se lee como 6.30
    }
  }
  return permitidas;
}
function verificarCifras(texto, hechos) {
  const permitidas = cifrasPermitidas(hechos);
  return valoresNumericos(texto).filter((n) => !permitidas.has(n));
}

// ── Servicio ────────────────────────────────────────────────────────────────
// → { descripcion, meta }. Lanza ErrorTextoIA.
async function generarDescripcion(datos, { proveedor = obtenerProveedorTexto(), categoriaNegocio = null, config = configuracion() } = {}) {
  if (!proveedor) throw new ErrorTextoIA('IA de texto no configurada', { codigo: 'no_configurado' });
  const hechos = construirHechos(datos, { categoriaNegocio });
  const inicio = Date.now();
  const r = await proveedor.generar({
    sistema: INSTRUCCION_SISTEMA,
    usuario: mensajeUsuario(hechos),
    temperatura: config.temperatura,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  });
  const descripcion = limpiarSalida(r.texto, { finCorte: r.finCorte });
  if (descripcion.length < 20) throw new ErrorTextoIA('salida vacía o incompleta', { codigo: 'salida_invalida' });
  const ajenas = verificarCifras(descripcion, hechos);
  if (ajenas.length) throw new ErrorTextoIA(`salida con ${ajenas.length} cifra(s) no presentes en los datos`, { codigo: 'salida_invalida' });
  return { descripcion, meta: { proveedor: proveedor.nombre, modelo: proveedor.modelo, ms: Date.now() - inicio, uso: r.uso || null } };
}

module.exports = {
  MODELO_GEMINI, LIMITES, MAX_CARACTERES_SALIDA, CATEGORIAS_ALIMENTO,
  configuracion, obtenerProveedorTexto, sanear, validarEntrada, construirHechos,
  limpiarSalida, verificarCifras, generarDescripcion, ErrorTextoIA,
};
