// Trabajos de imagen PREVIOS a publicar (Promoción / Tiempo limitado).
//
//   subida → analizando → mejorando → validando → lista
//                ↘ rechazada                ↘ fallida
//
//   analizando  calidad técnica de la original (calidad.js, nivel 'original')
//               + revisión con visión (revisionIA.js). Lo que la mejora no
//               puede arreglar → 'rechazada' con motivos: hay que cambiar la foto.
//   mejorando   proveedor de IA (OpenAI GPT Image por defecto).
//   validando   la mejorada debe parecerse a la original (validacion.js) y
//               cumplir la calidad 'publicable'. Si no → 'fallida' (reintentable).
//   lista       única condición para que POST/PUT /api/bolsas acepten la foto.
//
// Sin IA configurada el trabajo termina en 'fallida' con
// error_codigo='ia_no_configurada' y el mensaje exacto de qué falta: nunca se
// "aprueba" una foto sin IA ni se aparenta una mejora.
// La original nunca se toca: la mejorada es un archivo nuevo en Storage.
const { ErrorProveedor } = require('./errores');
const { prepararEntrada, validarResultado, ErrorValidacion } = require('./validacion');
const { analizarCalidad } = require('./calidad');
const { crearRevisorIA } = require('./revisionIA');
const { obtenerProveedor } = require('./proveedores');
const pipeline = require('./pipeline');
const { estadoIAImagen } = require('../iaEstado');

const ESTADOS = Object.freeze({
  SUBIDA: 'subida', ANALIZANDO: 'analizando', MEJORANDO: 'mejorando', VALIDANDO: 'validando',
  LISTA: 'lista', RECHAZADA: 'rechazada', FALLIDA: 'fallida',
});
const EN_CURSO = new Set([ESTADOS.SUBIDA, ESTADOS.ANALIZANDO, ESTADOS.MEJORANDO, ESTADOS.VALIDANDO]);
const INTERRUMPIDO_MS = 10 * 60 * 1000;
const HUERFANO_MS = 20 * 1000;
const ESPERA_REINTENTO_PROVEEDOR_MS = 3000;

// Mensajes para el restaurante según error_codigo (el detalle técnico va aparte).
const MENSAJES_FALLO = Object.freeze({
  ia_no_configurada: 'La mejora con IA no está configurada en el servidor.',
  proveedor: 'El servicio de IA no respondió. Intenta de nuevo en unos segundos.',
  validacion: 'La versión mejorada no se parecía lo suficiente a tu foto, así que no la usamos.',
  calidad_resultado: 'La versión mejorada no alcanzó la calidad mínima.',
  interrumpido: 'El procesamiento se interrumpió.',
  descarga: 'No pudimos leer la foto subida.',
  interno: 'Ocurrió un error inesperado al procesar la foto.',
});

function db() { return require('../../config/supabase'); }
const ahoraIso = () => new Date().toISOString();
const dormirPorDefecto = (ms) => new Promise((r) => setTimeout(r, ms));

function limites() {
  const n = (v, d) => { const x = Number.parseInt(process.env[v], 10); return Number.isFinite(x) && x > 0 ? x : d; };
  return { porHora: n('IMAGE_AI_MAX_TRABAJOS_POR_HORA', 20), porDia: n('IMAGE_AI_MAX_TRABAJOS_POR_DIA', 60) };
}

// Proveedor y revisor reales, o el motivo exacto por el que no hay IA.
function dependenciasIA() {
  const estado = estadoIAImagen();
  if (!estado.operativa) return { configError: estado.mensaje };
  return { proveedor: obtenerProveedor(), revisor: crearRevisorIA() };
}

// Lo que ve la app. `detalle` (técnico) solo cuando expone=true (desarrollo).
function serializar(t, { expone = process.env.NODE_ENV !== 'production' } = {}) {
  if (!t) return null;
  return {
    id: t.id,
    estado: t.estado,
    original_url: t.original_url,
    mejorada_url: t.estado === ESTADOS.LISTA ? t.mejorada_url : null,
    motivos: Array.isArray(t.motivos) ? t.motivos : [],
    error_codigo: t.error_codigo || null,
    error: t.estado === ESTADOS.FALLIDA ? (MENSAJES_FALLO[t.error_codigo] || MENSAJES_FALLO.interno) : null,
    detalle: expone ? (t.error || null) : null,
    puede_reintentar: t.estado === ESTADOS.FALLIDA,
    proveedor: t.proveedor || null,
    modelo: t.modelo || null,
    usada: !!t.bolsa_id,
  };
}

// ── Crear ───────────────────────────────────────────────────────────────────
// La foto debe estar en NUESTRO Storage y en la carpeta del negocio
// (routes/uploads.js nombra las fotos de publicaciones `bolsas/<negocio>_...`).
function urlDelNegocio(url, negocioId, hosts) {
  if (!pipeline.origenPermitido(url, hosts)) return false;
  try { return new URL(url).pathname.includes(`/bocara-images/bolsas/${negocioId}_`); } catch { return false; }
}

async function crearTrabajo({ usuario, negocioId, imagenUrl }, {
  cliente = db(), hosts = pipeline.hostsPermitidos(), ahora = Date.now(), procesar = true, deps,
} = {}) {
  if (typeof imagenUrl !== 'string' || !imagenUrl.trim()) return { ok: false, status: 400, error: 'imagen_url es requerida' };
  const url = imagenUrl.trim();
  if (!urlDelNegocio(url, negocioId, hosts)) {
    return { ok: false, status: 400, error: 'La foto debe subirse primero con la carga de imágenes de Bocara.' };
  }

  const l = limites();
  const desdeHora = new Date(ahora - 60 * 60 * 1000).toISOString();
  const desdeDia = new Date(ahora - 24 * 60 * 60 * 1000).toISOString();
  const [h, d] = await Promise.all([
    cliente.from('trabajos_imagen').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id).gte('created_at', desdeHora),
    cliente.from('trabajos_imagen').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id).gte('created_at', desdeDia),
  ]);
  if (h.error || d.error) return errorTabla(h.error || d.error);
  if ((h.count || 0) >= l.porHora || (d.count || 0) >= l.porDia) {
    return { ok: false, status: 429, error: 'Subiste demasiadas fotos en poco tiempo. Espera un momento e intenta de nuevo.' };
  }

  const { data, error } = await cliente.from('trabajos_imagen').insert([{
    usuario_id: usuario.id, negocio_id: negocioId, original_url: url, estado: ESTADOS.SUBIDA,
    created_at: new Date(ahora).toISOString(), updated_at: new Date(ahora).toISOString(),
  }]).select().single();
  if (error) return errorTabla(error);
  if (procesar) programarTrabajo(data.id, { cliente, hosts, deps });
  return { ok: true, trabajo: data };
}

function errorTabla(error) {
  console.error('[TRABAJOS_IMAGEN] tabla no disponible (¿migración 20261014100000 pendiente?): %s', error?.message);
  return {
    ok: false, status: 503, codigo: 'MIGRACION_PENDIENTE',
    error: 'El procesamiento de imágenes no está disponible: falta aplicar la migración 20261014100000_trabajos_imagen.sql.',
  };
}

// ── Procesar ────────────────────────────────────────────────────────────────
async function mover(cliente, id, desde, cambios) {
  const { data } = await cliente.from('trabajos_imagen').update({ ...cambios, updated_at: ahoraIso() })
    .eq('id', id).eq('estado', desde).select('id').maybeSingle();
  return !!data;
}

async function conReintento(fn, dormir) {
  try { return await fn(); } catch (err) {
    if (!(err instanceof ErrorProveedor) || err.reintentable === false) throw err;
    await dormir(ESPERA_REINTENTO_PROVEEDOR_MS);
    return fn();
  }
}

// Procesa un trabajo en 'subida'. Nunca lanza. → estado final o null si no lo reclamó.
async function procesarTrabajo(id, {
  cliente = db(), deps = dependenciasIA(), descargar = pipeline.descargadorPorDefecto,
  almacenamiento = pipeline.almacenamientoPorDefecto, hosts = pipeline.hostsPermitidos(), dormir = dormirPorDefecto,
} = {}) {
  const { data: t } = await cliente.from('trabajos_imagen').select('*').eq('id', id).maybeSingle();
  if (!t || t.estado !== ESTADOS.SUBIDA) return null;
  if (!(await mover(cliente, id, ESTADOS.SUBIDA, {
    estado: ESTADOS.ANALIZANDO, iniciado_at: ahoraIso(), intentos: (t.intentos || 0) + 1,
    motivos: null, error: null, error_codigo: null,
  }))) return null;

  let estadoActual = ESTADOS.ANALIZANDO;
  const fallar = async (codigo, detalle, extra = {}) => {
    await mover(cliente, id, estadoActual, { estado: ESTADOS.FALLIDA, error_codigo: codigo, error: String(detalle || '').slice(0, 400), ...extra });
    console.warn('[TRABAJOS_IMAGEN] %s fallida (%s): %s', id, codigo, detalle);
    return ESTADOS.FALLIDA;
  };

  try {
    if (deps.configError) return await fallar('ia_no_configurada', deps.configError);
    const { proveedor, revisor } = deps;
    if (!proveedor?.ia || !revisor) return await fallar('ia_no_configurada', 'proveedor sin IA real');

    // 1. Analizar la original.
    if (!pipeline.origenPermitido(t.original_url, hosts)) return await fallar('descarga', 'origen no permitido');
    let original;
    try { original = (await descargar(t.original_url)).buffer; } catch (err) { return await fallar('descarga', err.message); }
    if (!original?.length || original.length > pipeline.MAX_BYTES_ORIGINAL) return await fallar('descarga', 'imagen vacía o demasiado grande');

    const calidad = await analizarCalidad(original, { nivel: 'original' });
    if (!calidad.ok) {
      await mover(cliente, id, ESTADOS.ANALIZANDO, { estado: ESTADOS.RECHAZADA, motivos: calidad.motivos, calidad_original: calidad.metricas });
      return ESTADOS.RECHAZADA;
    }
    const prep = await prepararEntrada(original);
    const revision = await conReintento(() => revisor.revisar(prep.buffer), dormir);
    if (!revision.apta) {
      await mover(cliente, id, ESTADOS.ANALIZANDO, {
        estado: ESTADOS.RECHAZADA, motivos: revision.problemas, calidad_original: calidad.metricas,
        revision_ia: { modelo: revisor.modelo, resumen: revision.resumen, problemas: revision.problemas.map((p) => p.codigo) },
      });
      return ESTADOS.RECHAZADA;
    }

    // 2. Mejorar con IA.
    if (!(await mover(cliente, id, ESTADOS.ANALIZANDO, {
      estado: ESTADOS.MEJORANDO, calidad_original: calidad.metricas,
      revision_ia: { modelo: revisor.modelo, resumen: revision.resumen, apta: true },
      proveedor: proveedor.nombre, modelo: proveedor.modelo || null,
    }))) return null;
    estadoActual = ESTADOS.MEJORANDO;
    let urlEntrada = t.original_url;
    if (prep.requiereCopia && proveedor.necesitaUrl) {
      urlEntrada = await almacenamiento.subir(`preparadas/trabajos/${id}/${Date.now()}.jpg`, prep.buffer, prep.contentType);
    }
    let resultado;
    try {
      resultado = await conReintento(() => proveedor.mejorar({ buffer: prep.buffer, urlEntrada, urlOriginal: t.original_url, contexto: { trabajo: id } }), dormir);
    } catch (err) {
      return await fallar('proveedor', err.message);
    }

    // 3. Validar el resultado.
    if (!(await mover(cliente, id, ESTADOS.MEJORANDO, { estado: ESTADOS.VALIDANDO }))) return null;
    estadoActual = ESTADOS.VALIDANDO;
    let similitud;
    try { similitud = await validarResultado(prep.buffer, resultado.buffer); } catch (err) {
      if (err instanceof ErrorValidacion) return await fallar('validacion', err.message, { calidad_resultado: err.metricas || null });
      throw err;
    }
    const calidadFinal = await analizarCalidad(resultado.buffer, { nivel: 'publicable' });
    if (!calidadFinal.ok) {
      return await fallar('calidad_resultado', calidadFinal.motivos.map((m) => m.codigo).join(','), {
        motivos: calidadFinal.motivos, calidad_resultado: { ...similitud, ...calidadFinal.metricas },
      });
    }
    const ruta = `mejoradas/trabajos/${id}/${Date.now()}.webp`;
    const url = await almacenamiento.subir(ruta, resultado.buffer, resultado.contentType || 'image/webp');
    await mover(cliente, id, ESTADOS.VALIDANDO, {
      estado: ESTADOS.LISTA, mejorada_url: url,
      calidad_resultado: { ...similitud, ...calidadFinal.metricas, meta_proveedor: resultado.meta || null, ruta },
    });
    console.log('[TRABAJOS_IMAGEN] %s lista (%s)', id, proveedor.nombre);
    return ESTADOS.LISTA;
  } catch (err) {
    return fallar(err instanceof ErrorProveedor ? 'proveedor' : 'interno', err.message);
  }
}

// Disparo inmediato (fire-and-forget) registrado para que las pruebas esperen.
const enCurso = new Set();
function programarTrabajo(id, opciones = {}) {
  const p = procesarTrabajo(id, opciones)
    .catch((err) => console.warn('[TRABAJOS_IMAGEN] programarTrabajo:', err.message))
    .finally(() => enCurso.delete(p));
  enCurso.add(p);
  return p;
}
async function esperarTrabajosEnCurso() {
  while (enCurso.size) await Promise.allSettled([...enCurso]);
}

// Tick del job periódico (server.js): procesa los 'subida' huérfanos (p. ej.
// tras un reinicio) y marca 'fallida/interrumpido' lo que quedó a medias.
async function procesarTrabajosPendientes({ cliente = db(), ahora = Date.now(), limite = 5, ...opts } = {}) {
  const resumen = { procesados: 0, interrumpidos: 0 };
  const limiteInterrumpido = new Date(ahora - INTERRUMPIDO_MS).toISOString();
  const { data: colgados, error } = await cliente.from('trabajos_imagen').select('id, estado')
    .in('estado', [ESTADOS.ANALIZANDO, ESTADOS.MEJORANDO, ESTADOS.VALIDANDO]).lt('iniciado_at', limiteInterrumpido).limit(50);
  if (error) return resumen; // tabla ausente: lo reporta el diagnóstico de arranque
  for (const c of colgados || []) {
    if (await mover(cliente, c.id, c.estado, { estado: ESTADOS.FALLIDA, error_codigo: 'interrumpido', error: `sin avance desde ${c.estado}` })) {
      resumen.interrumpidos += 1;
    }
  }
  const limiteHuerfano = new Date(ahora - HUERFANO_MS).toISOString();
  const { data: huerfanos } = await cliente.from('trabajos_imagen').select('id')
    .eq('estado', ESTADOS.SUBIDA).lt('updated_at', limiteHuerfano).order('created_at', { ascending: true }).limit(limite);
  for (const { id } of huerfanos || []) {
    if (await procesarTrabajo(id, { cliente, ...opts })) resumen.procesados += 1;
  }
  return resumen;
}

// ── Consultas y acciones del restaurante ───────────────────────────────────
async function leerTrabajoPropio(id, usuario, { cliente = db() } = {}) {
  const { data, error } = await cliente.from('trabajos_imagen').select('*').eq('id', id).maybeSingle();
  if (error) return errorTabla(error);
  if (!data) return { ok: false, status: 404, error: 'Trabajo de imagen no encontrado' };
  if (usuario.rol !== 'admin' && data.usuario_id !== usuario.id) return { ok: false, status: 404, error: 'Trabajo de imagen no encontrado' };
  return { ok: true, trabajo: data };
}

async function reintentarTrabajo(id, usuario, { cliente = db(), procesar = true, deps, ...opts } = {}) {
  const r = await leerTrabajoPropio(id, usuario, { cliente });
  if (!r.ok) return r;
  if (r.trabajo.estado !== ESTADOS.FALLIDA) {
    return { ok: false, status: 409, error: r.trabajo.estado === ESTADOS.RECHAZADA
      ? 'Esta foto no cumple la calidad mínima. Cambia la foto.'
      : 'Solo se puede reintentar una foto cuyo procesamiento falló.' };
  }
  const ok = await mover(cliente, id, ESTADOS.FALLIDA, { estado: ESTADOS.SUBIDA, mejorada_url: null, motivos: null, error: null, error_codigo: null });
  if (!ok) return { ok: false, status: 409, error: 'La foto cambió de estado. Recarga e intenta de nuevo.' };
  if (procesar) programarTrabajo(id, { cliente, deps, ...opts });
  const { data } = await cliente.from('trabajos_imagen').select('*').eq('id', id).maybeSingle();
  return { ok: true, trabajo: data };
}

// ── Regla de publicación ───────────────────────────────────────────────────
const CODIGOS_PUBLICAR = Object.freeze({
  IMAGEN_NO_PROCESADA: 'La foto debe pasar por la mejora con IA antes de publicar. Sube o cambia la foto.',
  IMAGEN_EN_PROCESO: 'La foto todavía se está procesando. Espera a que esté lista para publicar.',
  IMAGEN_RECHAZADA: 'Esta imagen no cumple la calidad mínima para Bocara. Cambia la foto.',
  IMAGEN_FALLIDA: 'No se pudo mejorar la imagen. Reintenta o cambia la foto.',
  IMAGEN_YA_USADA: 'Esta foto ya se usó en otra publicación. Sube la foto de nuevo.',
  IMAGEN_SIN_VALIDAR: 'Esta publicación necesita una foto validada por IA. Cambia la foto para continuar.',
});
const rechazo = (status, codigo) => ({ ok: false, status, codigo, error: CODIGOS_PUBLICAR[codigo] });

// ¿Este trabajo autoriza la foto de una publicación del negocio?
async function trabajoParaPublicar(trabajoId, { usuario, negocioId, bolsaId = null }, { cliente = db() } = {}) {
  if (!trabajoId || typeof trabajoId !== 'string') return rechazo(400, 'IMAGEN_NO_PROCESADA');
  const { data: t, error } = await cliente.from('trabajos_imagen').select('*').eq('id', trabajoId).maybeSingle();
  if (error) return errorTabla(error);
  if (!t || String(t.negocio_id) !== String(negocioId) || (usuario.rol !== 'admin' && t.usuario_id !== usuario.id)) {
    return rechazo(400, 'IMAGEN_NO_PROCESADA');
  }
  if (EN_CURSO.has(t.estado)) return rechazo(409, 'IMAGEN_EN_PROCESO');
  if (t.estado === ESTADOS.RECHAZADA) return rechazo(422, 'IMAGEN_RECHAZADA');
  if (t.estado === ESTADOS.FALLIDA) return rechazo(422, 'IMAGEN_FALLIDA');
  if (t.estado !== ESTADOS.LISTA || !t.mejorada_url) return rechazo(400, 'IMAGEN_NO_PROCESADA');
  if (t.bolsa_id && t.bolsa_id !== bolsaId) return rechazo(409, 'IMAGEN_YA_USADA');
  return { ok: true, trabajo: t };
}

// Columnas de bolsas que fija una foto validada.
function columnasImagenValidada(t) {
  return {
    imagen_url: t.mejorada_url,
    imagen_original_url: t.original_url,
    imagen_mejorada_url: t.mejorada_url,
    estado_procesamiento_imagen: 'completada',
    proveedor_imagen_ia: t.proveedor || null,
    error_procesamiento_imagen: null,
    imagen_procesamiento_meta: {
      trabajo_id: t.id, modelo: t.modelo || null, ia: true,
      calidad_original: t.calidad_original || null, calidad_resultado: t.calidad_resultado || null,
      revision_ia: t.revision_ia || null,
    },
    imagen_procesada_at: ahoraIso(),
  };
}

// Una publicación ya guardada tiene foto validada si pasó por la IA:
// 'completada' (muestra la mejorada) o 'descartada' (el restaurante eligió su
// original, que ya había superado el análisis de calidad y la revisión IA).
function bolsaTieneImagenValidada(bolsa) {
  return ['completada', 'descartada'].includes(bolsa?.estado_procesamiento_imagen);
}

async function marcarUsado(trabajoId, bolsaId, { cliente = db() } = {}) {
  const { error } = await cliente.from('trabajos_imagen').update({ bolsa_id: bolsaId, usada_at: ahoraIso(), updated_at: ahoraIso() }).eq('id', trabajoId);
  if (error) console.warn('[TRABAJOS_IMAGEN] no se pudo marcar %s como usado: %s', trabajoId, error.message);
}

module.exports = {
  ESTADOS, EN_CURSO, MENSAJES_FALLO, CODIGOS_PUBLICAR,
  dependenciasIA, serializar, crearTrabajo, procesarTrabajo, programarTrabajo, esperarTrabajosEnCurso,
  procesarTrabajosPendientes, leerTrabajoPropio, reintentarTrabajo,
  trabajoParaPublicar, columnasImagenValidada, bolsaTieneImagenValidada, marcarUsado,
};
