// Pipeline de imágenes: original → (cola) → proveedor → mejorada.
// Ver docs/PIPELINE_IMAGENES.md.
//
// Garantías:
//   · El original nunca se pierde: imagen_original_url se fija al pedir la
//     mejora y el pipeline jamás la escribe después; el archivo original en
//     Storage no se toca (la mejorada se sube como archivo NUEVO).
//   · imagen_url (lo que muestra toda la app) solo pasa a la mejorada con un
//     UPDATE condicionado a que la fila siga en 'procesando' con el MISMO
//     original: si el restaurante cambió la foto mientras se procesaba, el
//     resultado viejo se descarta y nunca pisa la foto nueva.
//   · Nunca bloquea ni rompe la operación que lo origina: pedir la mejora es
//     best-effort (si la migración no está aplicada, solo se registra).
//   · Un fallo deja la original visible; se reintenta hasta MAX_INTENTOS con
//     espera y luego queda 'fallida' (el restaurante puede reintentar).
//   · Reclamo con CAS (pendiente → procesando): el disparo inmediato y el job
//     periódico (o dos instancias) nunca procesan la misma foto dos veces.
const axios = require('axios');
const { obtenerProveedor } = require('./proveedores');

const ESTADOS = Object.freeze({
  PENDIENTE: 'pendiente', PROCESANDO: 'procesando', COMPLETADA: 'completada',
  FALLIDA: 'fallida', DESCARTADA: 'descartada',
});
const TABLAS = new Set(['bolsas', 'negocios']);
const MAX_INTENTOS = 3;
const ESPERA_REINTENTO_MS = 2 * 60 * 1000;
const ABANDONO_MS = 10 * 60 * 1000;
const MAX_BYTES_ORIGINAL = 10 * 1024 * 1024;
const BUCKET = 'bocara-images';
// La IA puede devolver otro encuadre, pero no otra foto: si la proporción
// cambia más que esto, el resultado se descarta (protege contra "inventar").
const TOLERANCIA_PROPORCION = 0.12;

function db() { return require('../../config/supabase'); }
function sharp() { return require('sharp'); }
const ahoraIso = () => new Date().toISOString();

function validarTabla(tabla) {
  if (!TABLAS.has(tabla)) throw new Error(`tabla no soportada por el pipeline: ${tabla}`);
}

function pipelineActivo() {
  return !['none', 'off'].includes(String(process.env.IMAGE_AI_PROVIDER || 'local').toLowerCase());
}

// Solo se descargan imágenes de nuestro propio Storage (o hosts listados en
// IMAGE_PIPELINE_ALLOWED_HOSTS): el backend nunca hace fetch a una URL
// arbitraria que mandó un cliente (SSRF).
function hostsPermitidos() {
  const hosts = new Set();
  try { if (process.env.SUPABASE_URL) hosts.add(new URL(process.env.SUPABASE_URL).host); } catch { /* sin URL válida */ }
  for (const h of String(process.env.IMAGE_PIPELINE_ALLOWED_HOSTS || '').split(',')) if (h.trim()) hosts.add(h.trim());
  return hosts;
}
function origenPermitido(url, hosts = hostsPermitidos()) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.has(u.host);
  } catch { return false; }
}

// Errores que no se arreglan reintentando.
class ErrorDefinitivo extends Error {}

const descargadorPorDefecto = async (url) => {
  const { data, headers } = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_BYTES_ORIGINAL, maxRedirects: 0,
  });
  return { buffer: Buffer.from(data), contentType: headers['content-type'] || 'application/octet-stream' };
};

const almacenamientoPorDefecto = {
  async subir(ruta, buffer, contentType) {
    const s = db().storage.from(BUCKET);
    const { error } = await s.upload(ruta, buffer, { contentType, upsert: false });
    if (error) throw new Error(`Storage: ${error.message}`);
    return s.getPublicUrl(ruta).data.publicUrl;
  },
};

// Validación de fidelidad básica: decodificable, tamaño razonable y misma
// proporción que el original (±12%).
async function validarResultado(original, mejorada) {
  const [a, b] = await Promise.all([
    sharp()(original, { failOn: 'none' }).rotate().metadata(),
    sharp()(mejorada).metadata(),
  ]);
  // rotate() en metadata no aplica EXIF: se corrige a mano la orientación 5–8.
  const girada = a.orientation >= 5;
  const anchoO = girada ? a.height : a.width;
  const altoO = girada ? a.width : a.height;
  if (!b.width || !b.height || b.width < 200 || b.height < 200) throw new ErrorDefinitivo('resultado demasiado pequeño');
  const pO = anchoO / altoO, pM = b.width / b.height;
  if (Math.abs(pM - pO) / pO > TOLERANCIA_PROPORCION) {
    throw new ErrorDefinitivo(`resultado descartado: cambió la proporción (${pO.toFixed(2)} → ${pM.toFixed(2)})`);
  }
  return { ancho: b.width, alto: b.height };
}

// Inicia (o reinicia) el ciclo para la foto actual de la fila. Best-effort:
// nunca lanza. Devuelve { ok, motivo? }.
async function solicitarMejora(tabla, id, imagenUrl, { cliente = db() } = {}) {
  try {
    validarTabla(tabla);
    if (!pipelineActivo()) return { ok: false, motivo: 'desactivado' };
    if (typeof imagenUrl !== 'string' || !imagenUrl.trim()) return { ok: false, motivo: 'sin_imagen' };
    const { error } = await cliente.from(tabla).update({
      imagen_original_url: imagenUrl.trim(),
      imagen_mejorada_url: null,
      estado_procesamiento_imagen: ESTADOS.PENDIENTE,
      proveedor_imagen_ia: null,
      error_procesamiento_imagen: null,
      imagen_procesamiento_meta: null,
      imagen_intentos: 0,
      imagen_solicitada_at: ahoraIso(),
      imagen_procesamiento_iniciado_at: null,
      imagen_procesada_at: null,
    }).eq('id', id).eq('imagen_url', imagenUrl.trim());
    if (error) {
      console.warn('[IMAGENES] no se pudo encolar %s/%s (¿migración 20261006100000 pendiente?): %s', tabla, id, error.message);
      return { ok: false, motivo: 'error_bd' };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[IMAGENES] solicitarMejora falló:', err.message);
    return { ok: false, motivo: 'error' };
  }
}

// ¿La URL que manda un formulario es una foto NUEVA? No lo es si coincide con
// la que ya se muestra, ni con la original guardada (un formulario con datos
// viejos que reenvía la original no debe "deshacer" la mejora ni reiniciar).
function esFotoNueva(urlEnviada, fila) {
  if (typeof urlEnviada !== 'string' || !urlEnviada.trim()) return false;
  const u = urlEnviada.trim();
  return u !== fila?.imagen_url && u !== fila?.imagen_original_url && u !== fila?.imagen_mejorada_url;
}

// Procesa UNA fila si logra reclamarla. Nunca lanza.
async function procesarFila(tabla, id, {
  cliente = db(), proveedor = obtenerProveedor(), descargar = descargadorPorDefecto,
  almacenamiento = almacenamientoPorDefecto, hosts = hostsPermitidos(),
} = {}) {
  validarTabla(tabla);
  const { data: fila, error: errLeer } = await cliente.from(tabla)
    .select('id, imagen_url, imagen_original_url, estado_procesamiento_imagen, imagen_intentos')
    .eq('id', id).maybeSingle();
  if (errLeer || !fila || fila.estado_procesamiento_imagen !== ESTADOS.PENDIENTE) return { reclamada: false };

  const intentos = (fila.imagen_intentos || 0) + 1;
  const { data: reclamada } = await cliente.from(tabla).update({
    estado_procesamiento_imagen: ESTADOS.PROCESANDO,
    imagen_procesamiento_iniciado_at: ahoraIso(),
    imagen_intentos: intentos,
  }).eq('id', id).eq('estado_procesamiento_imagen', ESTADOS.PENDIENTE)
    .eq('imagen_intentos', fila.imagen_intentos || 0).select('id').maybeSingle();
  if (!reclamada) return { reclamada: false };

  const original = fila.imagen_original_url || fila.imagen_url;
  try {
    if (!origenPermitido(original, hosts)) throw new ErrorDefinitivo('origen de la imagen no permitido (solo Storage propio)');
    const { buffer } = await descargar(original);
    if (!buffer?.length || buffer.length > MAX_BYTES_ORIGINAL) throw new ErrorDefinitivo('imagen original vacía o demasiado grande');

    const resultado = await proveedor.mejorar({ buffer, urlOriginal: original, contexto: { tabla, id } });
    const dims = await validarResultado(buffer, resultado.buffer);
    const ruta = `mejoradas/${tabla}/${id}/${Date.now()}.webp`;
    const urlMejorada = await almacenamiento.subir(ruta, resultado.buffer, resultado.contentType || 'image/webp');

    // CAS: solo publica si nadie cambió la foto ni el estado mientras tanto.
    const { data: publicada, error: errPub } = await cliente.from(tabla).update({
      imagen_mejorada_url: urlMejorada,
      imagen_url: urlMejorada,
      estado_procesamiento_imagen: ESTADOS.COMPLETADA,
      proveedor_imagen_ia: proveedor.nombre,
      error_procesamiento_imagen: null,
      imagen_procesamiento_meta: { ...(resultado.meta || {}), ...dims, bytes_original: buffer.length, ruta },
      imagen_procesada_at: ahoraIso(),
    }).eq('id', id).eq('estado_procesamiento_imagen', ESTADOS.PROCESANDO)
      .eq('imagen_original_url', original).select('id').maybeSingle();
    if (errPub) throw new Error(`no se pudo publicar la mejora: ${errPub.message}`);
    if (!publicada) {
      console.warn('[IMAGENES] %s/%s cambió de foto durante el proceso: resultado descartado', tabla, id);
      return { reclamada: true, resultado: 'obsoleta' };
    }
    console.log('[IMAGENES] %s/%s mejorada con %s', tabla, id, proveedor.nombre);
    return { reclamada: true, resultado: ESTADOS.COMPLETADA, url: urlMejorada };
  } catch (err) {
    const definitivo = err instanceof ErrorDefinitivo || intentos >= MAX_INTENTOS;
    const estado = definitivo ? ESTADOS.FALLIDA : ESTADOS.PENDIENTE;
    // La original sigue visible: imagen_url se restaura por si acaso.
    await cliente.from(tabla).update({
      estado_procesamiento_imagen: estado,
      imagen_url: original,
      proveedor_imagen_ia: proveedor.nombre,
      error_procesamiento_imagen: String(err.message || err).slice(0, 300),
    }).eq('id', id).eq('estado_procesamiento_imagen', ESTADOS.PROCESANDO).eq('imagen_original_url', original);
    console.warn('[IMAGENES] %s/%s intento %d falló (%s): %s', tabla, id, intentos, estado, err.message);
    return { reclamada: true, resultado: estado, error: err.message };
  }
}

// Un tick del job: recupera procesando abandonadas y procesa pendientes
// (incluye reintentos, respetando ESPERA_REINTENTO_MS). Secuencial a
// propósito: una imagen a la vez acota memoria en el plan gratuito de Render.
async function procesarPendientes({ cliente = db(), limite = 5, ahora = Date.now(), ...opts } = {}) {
  const resumen = { procesadas: 0, completadas: 0, fallidas: 0 };
  if (!pipelineActivo()) return resumen;
  for (const tabla of TABLAS) {
    const limiteAbandono = new Date(ahora - ABANDONO_MS).toISOString();
    await cliente.from(tabla).update({ estado_procesamiento_imagen: ESTADOS.PENDIENTE })
      .eq('estado_procesamiento_imagen', ESTADOS.PROCESANDO).lt('imagen_procesamiento_iniciado_at', limiteAbandono);

    const limiteEspera = new Date(ahora - ESPERA_REINTENTO_MS).toISOString();
    const { data, error } = await cliente.from(tabla).select('id')
      .eq('estado_procesamiento_imagen', ESTADOS.PENDIENTE)
      .or(`imagen_procesamiento_iniciado_at.is.null,imagen_procesamiento_iniciado_at.lt.${limiteEspera}`)
      .order('imagen_solicitada_at', { ascending: true })
      .limit(limite);
    if (error) {
      console.warn('[IMAGENES] cola %s no disponible (¿migración pendiente?): %s', tabla, error.message);
      continue;
    }
    for (const { id } of data || []) {
      const r = await procesarFila(tabla, id, { cliente, ...opts });
      if (!r.reclamada) continue;
      resumen.procesadas += 1;
      if (r.resultado === ESTADOS.COMPLETADA) resumen.completadas += 1;
      if (r.resultado === ESTADOS.FALLIDA) resumen.fallidas += 1;
    }
  }
  return resumen;
}

// Disparo inmediato tras guardar (además del job): la mejora suele estar en
// segundos sin esperar al próximo tick. Fire-and-forget, registrado para que
// las pruebas puedan esperarlo.
const enCurso = new Set();
function programarMejora(tabla, id, imagenUrl, opciones = {}) {
  const p = solicitarMejora(tabla, id, imagenUrl, opciones)
    .then((r) => (r.ok ? procesarFila(tabla, id, opciones) : r))
    .catch((err) => console.warn('[IMAGENES] programarMejora:', err.message))
    .finally(() => enCurso.delete(p));
  enCurso.add(p);
  return p;
}
async function esperarMejorasEnCurso() {
  while (enCurso.size) await Promise.allSettled([...enCurso]);
}

// ── Acciones del restaurante ────────────────────────────────────────────────

async function leerFila(cliente, tabla, id) {
  const { data, error } = await cliente.from(tabla)
    .select('id, imagen_url, imagen_original_url, imagen_mejorada_url, estado_procesamiento_imagen')
    .eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Reintentar: desde fallida (o sin procesar nunca) vuelve a la cola desde cero.
async function reintentar(tabla, id, { cliente = db() } = {}) {
  validarTabla(tabla);
  const fila = await leerFila(cliente, tabla, id);
  if (!fila) return { ok: false, status: 404, error: 'No encontrada' };
  if (![ESTADOS.FALLIDA, null, undefined].includes(fila.estado_procesamiento_imagen)) {
    return { ok: false, status: 409, error: 'Solo se puede reintentar una mejora fallida o sin procesar.' };
  }
  // En fallida (o sin procesar) imagen_url ya es la original: el CAS de
  // solicitarMejora sobre imagen_url aplica.
  const r = await solicitarMejora(tabla, id, fila.imagen_url, { cliente });
  return r.ok ? { ok: true } : { ok: false, status: 503, error: 'No se pudo encolar la mejora.' };
}

// Usar original: el restaurante prefiere su foto. La mejorada se conserva.
async function usarOriginal(tabla, id, { cliente = db() } = {}) {
  validarTabla(tabla);
  const fila = await leerFila(cliente, tabla, id);
  if (!fila) return { ok: false, status: 404, error: 'No encontrada' };
  if (fila.estado_procesamiento_imagen !== ESTADOS.COMPLETADA || !fila.imagen_original_url) {
    return { ok: false, status: 409, error: 'No hay una imagen mejorada activa.' };
  }
  const { data } = await cliente.from(tabla).update({
    imagen_url: fila.imagen_original_url, estado_procesamiento_imagen: ESTADOS.DESCARTADA,
  }).eq('id', id).eq('estado_procesamiento_imagen', ESTADOS.COMPLETADA).select('id').maybeSingle();
  return data ? { ok: true } : { ok: false, status: 409, error: 'La imagen cambió; recarga e intenta de nuevo.' };
}

async function usarMejorada(tabla, id, { cliente = db() } = {}) {
  validarTabla(tabla);
  const fila = await leerFila(cliente, tabla, id);
  if (!fila) return { ok: false, status: 404, error: 'No encontrada' };
  if (fila.estado_procesamiento_imagen !== ESTADOS.DESCARTADA || !fila.imagen_mejorada_url) {
    return { ok: false, status: 409, error: 'No hay una imagen mejorada guardada.' };
  }
  const { data } = await cliente.from(tabla).update({
    imagen_url: fila.imagen_mejorada_url, estado_procesamiento_imagen: ESTADOS.COMPLETADA,
  }).eq('id', id).eq('estado_procesamiento_imagen', ESTADOS.DESCARTADA).select('id').maybeSingle();
  return data ? { ok: true } : { ok: false, status: 409, error: 'La imagen cambió; recarga e intenta de nuevo.' };
}

module.exports = {
  ESTADOS, MAX_INTENTOS, ESPERA_REINTENTO_MS, ABANDONO_MS, TOLERANCIA_PROPORCION,
  origenPermitido, esFotoNueva, pipelineActivo,
  solicitarMejora, procesarFila, procesarPendientes, programarMejora, esperarMejorasEnCurso,
  reintentar, usarOriginal, usarMejorada,
};
