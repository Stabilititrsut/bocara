// Diagnóstico de la IA de Bocara: qué está operativo y, si no, QUÉ falta.
// Una sola fuente para el log de arranque, GET /api/ia/estado y los errores
// de configuración (texto 503, trabajo de imagen "ia_no_configurada").
// Nunca devuelve valores de claves: solo nombres de variables y migraciones.
const { MODELO_POR_DEFECTO: MODELO_GEMINI, RESPALDO_POR_DEFECTO: RESPALDO_GEMINI } = require('./text-ai/providers/gemini');
const { MODELO_POR_DEFECTO: MODELO_OPENAI_IMAGEN } = require('./imagenes/proveedorOpenAI');
const { MODELO_VISION_POR_DEFECTO } = require('./imagenes/revisionIA');

const tiene = (v) => typeof process.env[v] === 'string' && process.env[v].trim() !== '';

function estadoIATexto() {
  const pedido = String(process.env.TEXT_AI_PROVIDER || '').trim().toLowerCase();
  const proveedor = pedido || (tiene('GEMINI_API_KEY') ? 'gemini' : '');
  if (!proveedor) {
    return { operativa: false, proveedor: null, modelo: null, faltan: ['TEXT_AI_PROVIDER', 'GEMINI_API_KEY'],
      mensaje: 'IA de texto no configurada: define TEXT_AI_PROVIDER=gemini y GEMINI_API_KEY en backend/.env.' };
  }
  if (proveedor === 'none' || proveedor === 'off') {
    return { operativa: false, proveedor: 'none', modelo: null, faltan: [],
      mensaje: 'IA de texto apagada a propósito (TEXT_AI_PROVIDER=none).' };
  }
  if (proveedor === 'gemini') {
    const modelo = process.env.GEMINI_TEXT_MODEL || MODELO_GEMINI;
    if (!tiene('GEMINI_API_KEY')) {
      return { operativa: false, proveedor, modelo, faltan: ['GEMINI_API_KEY'],
        mensaje: 'IA de texto no configurada: falta GEMINI_API_KEY en backend/.env (TEXT_AI_PROVIDER=gemini).' };
    }
    const r = process.env.GEMINI_TEXT_MODEL_FALLBACK ?? RESPALDO_GEMINI;
    const respaldo = r && !['none', 'off', modelo].includes(String(r).toLowerCase()) ? r : null;
    return { operativa: true, proveedor, modelo, modelo_respaldo: respaldo, faltan: [],
      mensaje: `IA de texto operativa: Gemini (${modelo}${respaldo ? `, respaldo ${respaldo}` : ''}).` };
  }
  return { operativa: false, proveedor, modelo: null, faltan: [],
    mensaje: `TEXT_AI_PROVIDER=${proveedor} no está implementado para texto. Usa gemini.` };
}

// La imagen necesita DOS piezas de IA: el proveedor que mejora la foto y la
// revisión con visión (OpenAI) que decide si la original es apta.
function estadoIAImagen() {
  const pedido = String(process.env.IMAGE_AI_PROVIDER || '').trim().toLowerCase();
  const proveedor = pedido || (tiene('OPENAI_API_KEY') ? 'openai' : tiene('REPLICATE_API_TOKEN') ? 'replicate' : '');
  const modeloRevision = process.env.OPENAI_VISION_MODEL || MODELO_VISION_POR_DEFECTO;
  const faltan = [];
  if (!proveedor) faltan.push('IMAGE_AI_PROVIDER');
  if (proveedor === 'none' || proveedor === 'off') {
    return { operativa: false, proveedor: 'none', modelo: null, modelo_revision: modeloRevision, faltan: [],
      mensaje: 'IA de imagen apagada a propósito (IMAGE_AI_PROVIDER=none): no se puede publicar sin foto validada.' };
  }
  if (proveedor === 'local') {
    return { operativa: false, proveedor, modelo: null, modelo_revision: modeloRevision, faltan: ['IMAGE_AI_PROVIDER=openai', 'OPENAI_API_KEY'],
      mensaje: 'IMAGE_AI_PROVIDER=local es un ajuste técnico (no IA) y no sirve para publicar. Usa IMAGE_AI_PROVIDER=openai con OPENAI_API_KEY.' };
  }
  if (proveedor && !['openai', 'replicate'].includes(proveedor)) {
    return { operativa: false, proveedor, modelo: null, modelo_revision: modeloRevision, faltan: ['IMAGE_AI_PROVIDER=openai'],
      mensaje: `IMAGE_AI_PROVIDER=${proveedor} no existe. Usa openai.` };
  }
  if (!tiene('OPENAI_API_KEY')) faltan.push('OPENAI_API_KEY');
  if (proveedor === 'replicate' && !tiene('REPLICATE_API_TOKEN')) faltan.push('REPLICATE_API_TOKEN');
  const modelo = proveedor === 'replicate'
    ? (process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-kontext-pro')
    : (process.env.OPENAI_IMAGE_MODEL || MODELO_OPENAI_IMAGEN);
  if (faltan.length) {
    return { operativa: false, proveedor: proveedor || null, modelo, modelo_revision: modeloRevision, faltan,
      mensaje: `IA de imagen no configurada: falta ${faltan.join(' y ')} en backend/.env. Sin ella no se puede publicar.` };
  }
  return { operativa: true, proveedor, modelo, modelo_revision: modeloRevision, faltan: [],
    mensaje: `IA de imagen operativa: ${proveedor} (${modelo}) + revisión ${modeloRevision}.` };
}

// Migraciones que la IA necesita. Se detectan pidiendo una columna de cada una.
const MIGRACIONES = Object.freeze([
  { archivo: 'backend/supabase/migrations/20261006100000_pipeline_imagenes.sql', tabla: 'bolsas', columnas: 'estado_procesamiento_imagen,imagen_original_url' },
  { archivo: 'backend/supabase/migrations/20261014100000_trabajos_imagen.sql', tabla: 'trabajos_imagen', columnas: 'id,estado,mejorada_url' },
]);

async function estadoMigraciones(cliente = require('../config/supabase')) {
  const pendientes = [];
  for (const m of MIGRACIONES) {
    try {
      const { error } = await cliente.from(m.tabla).select(m.columnas).limit(1);
      if (error) pendientes.push({ archivo: m.archivo, detalle: error.message });
    } catch (err) {
      pendientes.push({ archivo: m.archivo, detalle: err.message });
    }
  }
  return {
    ok: pendientes.length === 0,
    pendientes,
    mensaje: pendientes.length
      ? `Faltan migraciones: ${pendientes.map((p) => p.archivo.split('/').pop()).join(', ')}. Aplícalas en Supabase (SQL Editor) en ese orden.`
      : 'Migraciones de IA aplicadas.',
  };
}

async function diagnosticoIA({ cliente } = {}) {
  const migraciones = await estadoMigraciones(cliente);
  return { texto: estadoIATexto(), imagen: estadoIAImagen(), migraciones };
}

// ── Prueba en vivo ─────────────────────────────────────────────────────────
// La configuración puede estar completa y aun así fallar (modelo retirado,
// clave revocada, cuenta sin créditos). Esto hace UNA llamada mínima real a
// cada proveedor (costo prácticamente nulo; nunca genera una imagen):
//   Gemini  generateContent con un prompt de una palabra.
//   OpenAI  models.retrieve del modelo de imagen (gratis: clave y modelo) +
//           una respuesta mínima del modelo de revisión (detecta falta de créditos).
// → { estado: 'OK' | 'ERROR', motivo, ms }
async function probarTexto({ crear = () => require('./text-ai').obtenerProveedorTexto() } = {}) {
  const inicio = Date.now();
  try {
    const proveedor = crear();
    if (!proveedor) return { estado: 'ERROR', motivo: estadoIATexto().mensaje, ms: 0 };
    const r = await proveedor.generar({ sistema: 'Responde solo con la palabra: ok', usuario: 'ok', temperatura: 0, maxTokens: 16, timeoutMs: 20000 });
    const usado = r?.modelo || proveedor.modelo;
    return {
      estado: 'OK',
      motivo: usado === proveedor.modelo ? `Gemini respondió (${usado}).` : `Gemini respondió con el modelo de respaldo ${usado} (el principal ${proveedor.modelo} no respondió).`,
      ms: Date.now() - inicio,
    };
  } catch (err) {
    return { estado: 'ERROR', motivo: err.message, ms: Date.now() - inicio };
  }
}

async function probarImagen({ cliente } = {}) {
  const inicio = Date.now();
  const e = estadoIAImagen();
  if (!e.operativa) return { estado: 'ERROR', motivo: e.mensaje, ms: 0 };
  const { clasificarError } = require('./imagenes/proveedorOpenAI');
  try {
    const sdk = cliente || new (require('openai').OpenAI)({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 0 });
    if (e.proveedor === 'openai') await sdk.models.retrieve(e.modelo);
    await sdk.responses.create({ model: e.modelo_revision, input: 'Responde: ok', max_output_tokens: 16, reasoning: { effort: 'low' } });
    return { estado: 'OK', motivo: `OpenAI respondió (imagen ${e.modelo}, revisión ${e.modelo_revision}).`, ms: Date.now() - inicio };
  } catch (err) {
    const c = clasificarError(err);
    const explicacion = {
      sin_credito: 'la cuenta de OpenAI no tiene créditos: recárgala en platform.openai.com/settings/organization/billing.',
      clave_invalida: 'OPENAI_API_KEY no es válida o no tiene permisos.',
      modelo: `el modelo no existe o tu cuenta no tiene acceso (OPENAI_IMAGE_MODEL=${e.modelo}, OPENAI_VISION_MODEL=${e.modelo_revision}).`,
    }[c.motivo];
    return { estado: 'ERROR', motivo: explicacion ? `${explicacion} (${c.message})` : c.message, ms: Date.now() - inicio };
  }
}

// Resumen para GET /api/ia/status y scripts/verificar-ia.js.
async function estadoCompleto({ probar = false, cliente, probadores = {} } = {}) {
  const d = await diagnosticoIA({ cliente });
  const texto = { ...d.texto, prueba: probar ? await (probadores.texto || probarTexto)() : null };
  const imagen = { ...d.imagen, prueba: probar ? await (probadores.imagen || probarImagen)() : null };
  const ok = (x) => x.operativa && (!x.prueba || x.prueba.estado === 'OK');
  return {
    resumen: {
      gemini_texto: ok(texto) ? 'OK' : 'ERROR',
      openai_imagen: ok(imagen) ? 'OK' : 'ERROR',
      migraciones: d.migraciones.ok ? 'OK' : 'PENDIENTES',
    },
    modelos: { texto: texto.modelo, texto_respaldo: texto.modelo_respaldo || null, imagen: imagen.modelo, revision_imagen: imagen.modelo_revision },
    faltan_claves: [...new Set([...texto.faltan, ...imagen.faltan])],
    texto, imagen, migraciones: d.migraciones,
    probado_en_vivo: probar,
  };
}

// Una línea por pieza al arrancar el servidor: imposible no verla.
async function registrarDiagnosticoAlArrancar(log = console) {
  try {
    const d = await diagnosticoIA();
    const linea = (nombre, e) => `[IA] ${nombre}: ${e.operativa ?? e.ok ? 'OPERATIVA' : 'NO OPERATIVA'} — ${e.mensaje}`;
    (d.texto.operativa ? log.log : log.error)(linea('Texto', d.texto));
    (d.imagen.operativa ? log.log : log.error)(linea('Imagen', d.imagen));
    (d.migraciones.ok ? log.log : log.error)(`[IA] Migraciones: ${d.migraciones.ok ? 'OK' : 'PENDIENTES'} — ${d.migraciones.mensaje}`);
    return d;
  } catch (err) {
    log.error('[IA] no se pudo diagnosticar la configuración:', err.message);
    return null;
  }
}

module.exports = {
  estadoIATexto, estadoIAImagen, estadoMigraciones, diagnosticoIA, registrarDiagnosticoAlArrancar, MIGRACIONES,
  probarTexto, probarImagen, estadoCompleto,
};
