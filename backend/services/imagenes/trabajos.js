// Trabajos de imagen PREVIOS a publicar (Promoción / Tiempo limitado).
//
//   subida → analizando → mejorando → validando → lista
//                ↘ rechazada        ↘ fallida    ↘ rechazada | fallida
//
//   analizando  ¿hay información visual suficiente para una foto comercial
//               fiel? SOLO se rechaza: archivo ilegible/no imagen, resolución
//               tan baja que no se reconoce (< 200 px, calidad.js
//               analizarRecuperable), no es comida, captura/collage o
//               producto irreconocible (revisión con visión). Oscura, borrosa,
//               pequeña, mal proporcionada, cortada, close-up o desordenada
//               PASA a la mejora con la lista de qué corregir.
//   mejorando   OpenAI GPT Image en encuadre 'comercial': lienzo estándar
//               (≥ 1024 px), fondo extendido para recomponer, sin inventar comida.
//   validando   la comida (región de la original) debe seguir siendo la misma
//               (validacion.js), el resultado cumplir la calidad 'publicable'
//               y la revisión con visión comparar original vs. resultado
//               (fidelidad + presentable; un close-up no es defecto):
//                 · pasa todo               → lista (se publica la mejorada)
//                 · no se parece / no llega a la calidad / cambió el producto
//                   (fidelidad), pero la ORIGINAL ya era publicable
//                                           → lista con la original (fallback
//                                             seguro, usa_original=true)
//                 · lo mismo sin fallback   → fallida (reintentable)
//                 · fiel pero no presentable → rechazada con motivos
//   lista       única condición para que POST/PUT /api/bolsas acepten la foto.
//
// Sin IA configurada, o si el proveedor falla (sin créditos, clave inválida,
// caída), el trabajo termina en 'fallida' con un error_codigo que dice el
// motivo exacto: nunca se "aprueba" una foto sin IA ni se aparenta una mejora.
// La original nunca se toca: la mejorada es un archivo nuevo en Storage.
//
// Usos (mismo flujo, distinto encuadre, revisión y calidad mínima):
//   publicacion  foto de Promoción / Tiempo limitado   bolsas/<negocio>_…
//   perfil       foto de perfil / logo del restaurante negocios/<negocio>/perfil_…
//   portada      portada / banner del restaurante      negocios/<negocio>/portada_…
// El uso sale de la ruta en Storage (la valida crearTrabajo), así que no hace
// falta columna nueva y un trabajo de perfil nunca sirve para una publicación.
// Perfil y portada: la IA es solo restauración técnica (prompts.js) y el
// resultado pasa una validación de fidelidad ESTRICTA (validacion.js: formas,
// letras y colores; revisionIA.js: marca_alterada / elemento_inventado).
// Si el resultado falla por lo que sea y la original es válida (pasó el
// análisis con IA y cumple la calidad mínima de su uso:
// calidad_original.original_aceptable), queda 'lista' con la ORIGINAL. Si
// la original tampoco es válida: fallida (reintentable) o rechazada.
const { ErrorProveedor } = require('./errores');
const { prepararEntrada, validarResultado, ErrorValidacion } = require('./validacion');
const { analizarCalidad, analizarRecuperable } = require('./calidad');
const { crearRevisorIA, INFIDELIDAD, irreparablesDe } = require('./revisionIA');
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

const USOS = Object.freeze({
  publicacion: { carpeta: (negocioId) => `/bocara-images/bolsas/${negocioId}_`, encuadre: 'comercial', nivel: 'publicable' },
  perfil: { carpeta: (negocioId) => `/bocara-images/negocios/${negocioId}/perfil_`, encuadre: 'perfil', nivel: 'perfil' },
  portada: { carpeta: (negocioId) => `/bocara-images/negocios/${negocioId}/portada_`, encuadre: 'portada', nivel: 'portada' },
});
// Problemas de la revisión que impiden usar la original sin IA.
const BLOQUEAN_ORIGINAL = new Set(['muy_oscura', 'borrosa', 'baja_calidad']);

function usoDeUrl(url) {
  try {
    const m = /\/bocara-images\/negocios\/[^/]+\/(perfil|portada)_[^/]*$/.exec(new URL(url).pathname);
    return m ? m[1] : 'publicacion';
  } catch { return 'publicacion'; }
}

// Mensajes para el restaurante según error_codigo (el detalle técnico va aparte).
const MENSAJES_FALLO = Object.freeze({
  ia_no_configurada: 'La mejora con IA no está configurada en el servidor.',
  proveedor: 'El servicio de IA no respondió. Intenta de nuevo en unos segundos.',
  proveedor_sin_credito: 'La IA no pudo procesar la foto: la cuenta de OpenAI de Bocara no tiene créditos. Avísale al administrador para recargarla.',
  proveedor_clave: 'La IA no pudo procesar la foto: la clave de OpenAI del servidor no es válida. Avísale al administrador.',
  proveedor_modelo: 'La IA no pudo procesar la foto: el modelo configurado en el servidor no está disponible. Avísale al administrador.',
  proveedor_no_soporta: 'La IA configurada en el servidor no admite fotos de perfil ni portada. Avísale al administrador.',
  validacion: 'La versión mejorada no se parecía lo suficiente a tu foto, así que no la usamos.',
  calidad_resultado: 'Aun después de mejorarla con IA, la foto no alcanzó la calidad mínima para Bocara.',
  fidelidad: 'La versión con IA cambió tu producto (por ejemplo, agregó o quitó ingredientes), así que no la usamos. Reintenta para generar otra versión.',
  fidelidad_marca: 'La versión con IA no conservaba tu imagen tal cual (letras, logo, colores o elementos), así que no la usamos. Reintenta o cambia la foto.',
  resultado_no_apto: 'La versión con IA no quedó presentable, así que no la usamos.',
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

// error_codigo según el motivo del fallo del proveedor (errores.js).
const CODIGO_POR_MOTIVO = Object.freeze({ sin_credito: 'proveedor_sin_credito', clave_invalida: 'proveedor_clave', modelo: 'proveedor_modelo' });
function codigoProveedor(err) {
  return CODIGO_POR_MOTIVO[err?.motivo] || 'proveedor';
}

// Paso del proceso donde terminó una rechazada/fallida (para que la app marque
// el paso correcto). Se deduce de la fila: 'proveedor' se fija al pasar a
// mejorando y 'calidad_resultado' solo existe si se llegó a validar.
function pasoError(t) {
  if (t.estado === ESTADOS.RECHAZADA) return t.proveedor ? ESTADOS.VALIDANDO : ESTADOS.ANALIZANDO;
  if (t.estado !== ESTADOS.FALLIDA) return null;
  if (t.error_codigo === 'interrumpido') return /desde (\w+)/.exec(t.error || '')?.[1] || ESTADOS.ANALIZANDO;
  if (['validacion', 'calidad_resultado', 'fidelidad', 'fidelidad_marca'].includes(t.error_codigo) || t.calidad_resultado) return ESTADOS.VALIDANDO;
  if (String(t.error_codigo || '').startsWith('proveedor') && t.proveedor) return ESTADOS.MEJORANDO;
  return ESTADOS.ANALIZANDO;
}

// Lo que ve la app. `detalle` (técnico) solo cuando expone=true (desarrollo).
function serializar(t, { expone = process.env.NODE_ENV !== 'production' } = {}) {
  if (!t) return null;
  const uso = usoDeUrl(t.original_url);
  return {
    id: t.id,
    uso,
    estado: t.estado,
    // Perfil / portada: la original pasó el análisis y cumple la calidad mínima.
    puede_usar_original: puedeUsarOriginal(t, uso),
    original_url: t.original_url,
    mejorada_url: t.estado === ESTADOS.LISTA ? t.mejorada_url : null,
    // Lista con la foto original (la mejorada no pasó y la original ya cumplía).
    usa_original: t.estado === ESTADOS.LISTA && !!t.calidad_resultado?.fallback_original,
    motivos: Array.isArray(t.motivos) ? t.motivos : [],
    // Lo que la IA corrigió (o intentó corregir) de la original.
    problemas_corregidos: Array.isArray(t.revision_ia?.problemas_previos) ? t.revision_ia.problemas_previos : [],
    paso_error: pasoError(t),
    error_codigo: t.error_codigo || null,
    error: t.estado === ESTADOS.FALLIDA ? (MENSAJES_FALLO[t.error_codigo] || MENSAJES_FALLO.interno) : null,
    detalle: expone ? (t.error || null) : null,
    puede_reintentar: t.estado === ESTADOS.FALLIDA,
    proveedor: t.proveedor || null,
    modelo: t.modelo || null,
    usada: !!t.bolsa_id,
  };
}

function puedeUsarOriginal(t, uso = usoDeUrl(t?.original_url)) {
  return uso !== 'publicacion' && t?.calidad_original?.original_aceptable === true
    && [ESTADOS.LISTA, ESTADOS.FALLIDA, ESTADOS.RECHAZADA].includes(t.estado);
}

// ── Crear ───────────────────────────────────────────────────────────────────
// La foto debe estar en NUESTRO Storage y en la carpeta del negocio para su
// uso (routes/uploads.js: publicaciones `bolsas/<negocio>_...`, perfil y
// portada `negocios/<negocio>/perfil_...` / `negocios/<negocio>/portada_...`).
function urlDelNegocio(url, negocioId, hosts, uso = 'publicacion') {
  if (!pipeline.origenPermitido(url, hosts)) return false;
  try { return new URL(url).pathname.includes(USOS[uso].carpeta(negocioId)) && usoDeUrl(url) === uso; } catch { return false; }
}

async function crearTrabajo({ usuario, negocioId, imagenUrl, uso = 'publicacion' }, {
  cliente = db(), hosts = pipeline.hostsPermitidos(), ahora = Date.now(), procesar = true, deps,
} = {}) {
  if (!Object.hasOwn(USOS, uso)) return { ok: false, status: 400, error: 'uso inválido (publicacion, perfil o portada)' };
  if (typeof imagenUrl !== 'string' || !imagenUrl.trim()) return { ok: false, status: 400, error: 'imagen_url es requerida' };
  const url = imagenUrl.trim();
  if (!urlDelNegocio(url, negocioId, hosts, uso)) {
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
  console.log('[IMAGEN_IA] %s imagen subida (negocio %s, uso %s): trabajo creado', data.id, negocioId, uso);
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
  // Se limpia todo lo de un intento anterior (reintento): pasoError() lee estas columnas.
  if (!(await mover(cliente, id, ESTADOS.SUBIDA, {
    estado: ESTADOS.ANALIZANDO, iniciado_at: ahoraIso(), intentos: (t.intentos || 0) + 1,
    motivos: null, error: null, error_codigo: null, mejorada_url: null,
    proveedor: null, modelo: null, revision_ia: null, calidad_resultado: null,
  }))) return null;
  const inicio = Date.now();
  const uso = usoDeUrl(t.original_url);
  const cfg = USOS[uso];
  console.log('[IMAGEN_IA] %s analizando calidad (%s, intento %d)', id, uso, (t.intentos || 0) + 1);

  let estadoActual = ESTADOS.ANALIZANDO;
  const fallar = async (codigo, detalle, extra = {}) => {
    await mover(cliente, id, estadoActual, { estado: ESTADOS.FALLIDA, error_codigo: codigo, error: String(detalle || '').slice(0, 400), ...extra });
    console.error('[IMAGEN_IA] %s FALLIDA en %s (%s): %s', id, estadoActual, codigo, detalle);
    return ESTADOS.FALLIDA;
  };
  const rechazar = async (motivos, extra = {}) => {
    await mover(cliente, id, estadoActual, { estado: ESTADOS.RECHAZADA, motivos, ...extra });
    console.warn('[IMAGEN_IA] %s RECHAZADA en %s: [%s]', id, estadoActual, motivos.map((m) => m.codigo).join(','));
    return ESTADOS.RECHAZADA;
  };

  try {
    if (deps.configError) return await fallar('ia_no_configurada', deps.configError);
    const { proveedor, revisor } = deps;
    if (!proveedor?.ia || !revisor) return await fallar('ia_no_configurada', 'proveedor sin IA real');
    if (uso !== 'publicacion' && !proveedor.encuadres?.has(cfg.encuadre)) {
      return await fallar('proveedor_no_soporta', `${proveedor.nombre} no soporta el encuadre ${cfg.encuadre}`);
    }

    // 1. Analizar la original: solo se rechaza lo irreparable.
    if (!pipeline.origenPermitido(t.original_url, hosts)) return await fallar('descarga', 'origen no permitido');
    let original;
    try { original = (await descargar(t.original_url)).buffer; } catch (err) { return await fallar('descarga', err.message); }
    if (!original?.length || original.length > pipeline.MAX_BYTES_ORIGINAL) return await fallar('descarga', 'imagen vacía o demasiado grande');

    const calidad = await analizarRecuperable(original, { nivel: uso === 'publicacion' ? 'original' : cfg.nivel });
    console.log('[IMAGEN_IA] %s calidad original: %s', id, JSON.stringify(calidad.metricas));
    if (!calidad.ok) return await rechazar(calidad.motivos, { calidad_original: calidad.metricas });
    const prep = await prepararEntrada(original);
    let revision;
    try {
      revision = await conReintento(() => revisor.revisar(prep.buffer, { modo: 'original', uso }), dormir);
    } catch (err) {
      if (err instanceof ErrorProveedor) return await fallar(codigoProveedor(err), err.message, { calidad_original: calidad.metricas });
      throw err;
    }
    if (revision.irreparable) {
      const irreparables = irreparablesDe(uso);
      return await rechazar(revision.problemas.filter((p) => irreparables.has(p.codigo)), {
        calidad_original: calidad.metricas,
        revision_ia: { modelo: revisor.modelo, resumen: revision.resumen, problemas: revision.problemas.map((p) => p.codigo) },
      });
    }
    // Lo que la IA debe corregir: métricas técnicas + lo que vio la revisión.
    const problemasPrevios = [...new Set([...calidad.problemas, ...revision.problemas].map((p) => p.codigo))];
    console.log('[IMAGEN_IA] %s original recuperable; a corregir con IA: [%s]', id, problemasPrevios.join(','));
    // Perfil / portada: ¿la original se podría usar tal cual si la IA no sirve?
    let calidadOriginal = calidad.metricas;
    // (calidad ya se midió con los umbrales del uso: sin problemas = cumple el mínimo).
    if (uso !== 'publicacion') {
      const aceptable = !calidad.problemas.length && !revision.problemas.some((p) => BLOQUEAN_ORIGINAL.has(p.codigo));
      calidadOriginal = { ...calidad.metricas, original_aceptable: aceptable };
    }

    // 2. Mejorar con IA (siempre que la original sea recuperable).
    if (!(await mover(cliente, id, ESTADOS.ANALIZANDO, {
      estado: ESTADOS.MEJORANDO, calidad_original: calidadOriginal,
      revision_ia: { modelo: revisor.modelo, resumen: revision.resumen, apta: revision.apta, problemas_previos: problemasPrevios },
      proveedor: proveedor.nombre, modelo: proveedor.modelo || null,
    }))) return null;
    estadoActual = ESTADOS.MEJORANDO;
    console.log('[IMAGEN_IA] %s mejorando con %s (%s)', id, proveedor.nombre, proveedor.modelo || '-');
    let urlEntrada = t.original_url;
    if (prep.requiereCopia && proveedor.necesitaUrl) {
      urlEntrada = await almacenamiento.subir(`preparadas/trabajos/${id}/${Date.now()}.jpg`, prep.buffer, prep.contentType);
    }
    let resultado;
    try {
      resultado = await conReintento(() => proveedor.mejorar({
        buffer: prep.buffer, urlEntrada, urlOriginal: t.original_url,
        // Comercial: formato estándar (≥ 1024 px) con el fondo extendido si hace falta.
        // Perfil: cuadrado; portada: horizontal (proveedorOpenAI.js).
        contexto: { trabajo: id, uso, problemas: problemasPrevios, encuadre: cfg.encuadre },
      }), dormir);
    } catch (err) {
      return await fallar(codigoProveedor(err), err.message);
    }

    // 3. Validar el resultado y decidir:
    //    a) la comida (región de la foto original) sigue siendo la misma,
    //    b) calidad y resolución publicables,
    //    c) revisión IA comparando original vs. resultado: fiel y presentable.
    if (!(await mover(cliente, id, ESTADOS.MEJORANDO, { estado: ESTADOS.VALIDANDO }))) return null;
    estadoActual = ESTADOS.VALIDANDO;
    console.log('[IMAGEN_IA] %s validando resultado', id);
    let fallo = null; // por qué la mejorada no sirve (reintentable)
    let similitud = null;
    // Perfil / portada: además, fidelidad estricta (formas, letras y colores).
    const negocio = uso !== 'publicacion';
    try {
      similitud = await validarResultado(prep.buffer, resultado.buffer, { region: resultado.meta?.region || null, uso: negocio ? uso : null });
    } catch (err) {
      if (!(err instanceof ErrorValidacion)) throw err;
      fallo = { codigo: err.fidelidad ? 'fidelidad_marca' : 'validacion', detalle: err.message, motivos: null, metricas: err.metricas || {} };
    }
    let calidadFinal = null;
    if (!fallo) {
      calidadFinal = await analizarCalidad(resultado.buffer, { nivel: cfg.nivel });
      if (!calidadFinal.ok) {
        fallo = { codigo: 'calidad_resultado', detalle: calidadFinal.motivos.map((m) => m.codigo).join(','),
          motivos: calidadFinal.motivos, metricas: { ...similitud, ...calidadFinal.metricas } };
      }
    }
    let revisionFinal = null;
    let revisionIA = { modelo: revisor.modelo, resumen: revision.resumen, apta: revision.apta, problemas_previos: problemasPrevios };
    if (!fallo) {
      const metricas = { ...similitud, ...calidadFinal.metricas, meta_proveedor: resultado.meta || null };
      try {
        revisionFinal = await conReintento(() => revisor.revisar(resultado.buffer, { modo: 'resultado', original: prep.buffer, uso }), dormir);
      } catch (err) {
        if (err instanceof ErrorProveedor) return await fallar(codigoProveedor(err), err.message, { calidad_resultado: metricas });
        throw err;
      }
      revisionIA = { ...revisionIA, resultado: { apta: revisionFinal.apta, resumen: revisionFinal.resumen, problemas: revisionFinal.problemas.map((p) => p.codigo) } };
      if (revisionFinal.infiel) {
        // La IA cambió el producto (agregó/quitó ingredientes, cambió la cantidad):
        // ese resultado nunca se publica. Reintentar genera otra versión.
        const motivos = revisionFinal.problemas.filter((p) => INFIDELIDAD.has(p.codigo));
        fallo = { codigo: negocio ? 'fidelidad_marca' : 'fidelidad', detalle: motivos.map((m) => m.codigo).join(','), motivos, metricas };
      } else if (!revisionFinal.apta) {
        // Perfil / portada con una original válida: no se rechaza, se usa la original.
        if (!(negocio && calidadOriginal.original_aceptable)) {
          return await rechazar(revisionFinal.problemas, { calidad_resultado: metricas, revision_ia: revisionIA });
        }
        fallo = { codigo: 'resultado_no_apto', detalle: revisionFinal.problemas.map((p) => p.codigo).join(','), motivos: revisionFinal.problemas, metricas };
      }
    }
    if (fallo) {
      console.warn('[IMAGEN_IA] %s la mejorada no pasó la validación (%s): %s', id, fallo.codigo, fallo.detalle);
      // Fallback seguro: se publica la original tal cual si ya era válida.
      //   publicación: sin problemas en el análisis ni en la revisión y publicable.
      //   perfil / portada: la original pasó la revisión IA y cumple el mínimo
      //   de su uso (original_aceptable). Ante cualquier cambio de marca,
      //   texto o color en el resultado, la prioridad es conservar la original.
      const originalValida = negocio
        ? calidadOriginal.original_aceptable === true
        : !problemasPrevios.length && (await analizarCalidad(original, { nivel: cfg.nivel })).ok;
      if (originalValida) {
        await mover(cliente, id, ESTADOS.VALIDANDO, {
          estado: ESTADOS.LISTA, mejorada_url: t.original_url, revision_ia: revisionIA,
          calidad_resultado: { ...fallo.metricas, fallback_original: true, motivo_fallback: fallo.detalle },
        });
        console.log('[IMAGEN_IA] %s LISTA con la original (ya cumplía la calidad) en %d ms', id, Date.now() - inicio);
        return ESTADOS.LISTA;
      }
      return await fallar(fallo.codigo, fallo.detalle, { motivos: fallo.motivos, calidad_resultado: fallo.metricas, revision_ia: revisionIA });
    }

    const ruta = `mejoradas/trabajos/${id}/${Date.now()}.webp`;
    const url = await almacenamiento.subir(ruta, resultado.buffer, resultado.contentType || 'image/webp');
    await mover(cliente, id, ESTADOS.VALIDANDO, {
      estado: ESTADOS.LISTA, mejorada_url: url, revision_ia: revisionIA,
      calidad_resultado: { ...similitud, ...calidadFinal.metricas, meta_proveedor: resultado.meta || null, ruta },
    });
    console.log('[IMAGEN_IA] %s LISTA para publicar (%s, %dx%d, similitud %s) en %d ms', id, proveedor.nombre,
      calidadFinal.metricas.ancho, calidadFinal.metricas.alto, similitud.similitud, Date.now() - inicio);
    return ESTADOS.LISTA;
  } catch (err) {
    return fallar(err instanceof ErrorProveedor ? codigoProveedor(err) : 'interno', err.message);
  }
}

// Disparo inmediato (fire-and-forget) registrado para que las pruebas esperen.
const enCurso = new Set();
function programarTrabajo(id, opciones = {}) {
  const p = procesarTrabajo(id, opciones)
    .catch((err) => console.error('[IMAGEN_IA] programarTrabajo:', err.message))
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
  // Un trabajo de foto de perfil o portada nunca autoriza una publicación.
  if (!t || String(t.negocio_id) !== String(negocioId) || (usuario.rol !== 'admin' && t.usuario_id !== usuario.id)
    || usoDeUrl(t.original_url) !== 'publicacion') {
    return rechazo(400, 'IMAGEN_NO_PROCESADA');
  }
  if (EN_CURSO.has(t.estado)) return rechazo(409, 'IMAGEN_EN_PROCESO');
  if (t.estado === ESTADOS.RECHAZADA) return rechazo(422, 'IMAGEN_RECHAZADA');
  if (t.estado === ESTADOS.FALLIDA) return rechazo(422, 'IMAGEN_FALLIDA');
  if (t.estado !== ESTADOS.LISTA || !t.mejorada_url) return rechazo(400, 'IMAGEN_NO_PROCESADA');
  if (t.bolsa_id && t.bolsa_id !== bolsaId) return rechazo(409, 'IMAGEN_YA_USADA');
  return { ok: true, trabajo: t };
}

// ── Regla de la foto de perfil / portada del restaurante ───────────────────
const CODIGOS_NEGOCIO = Object.freeze({
  IMAGEN_NO_PROCESADA: 'La imagen debe pasar por la mejora con IA antes de guardarla. Sube o cambia la foto.',
  IMAGEN_EN_PROCESO: 'La imagen todavía se está procesando. Espera a que esté lista para guardar.',
  IMAGEN_RECHAZADA: 'Esta imagen no cumple la calidad mínima para Bocara. Cambia la foto.',
  IMAGEN_FALLIDA: 'No se pudo mejorar la imagen. Reintenta o cambia la foto.',
  ORIGINAL_NO_PERMITIDA: 'Tu imagen original no cumple la calidad mínima para usarla sin la mejora con IA. Reintenta o cambia la foto.',
});
const rechazoNegocio = (status, codigo) => ({ ok: false, status, codigo, error: CODIGOS_NEGOCIO[codigo] });

// ¿Este trabajo autoriza la foto de perfil o la portada del negocio?
// usarOriginal: el restaurante elige su original (si la IA falló, la rechazó
// o prefiere la suya); solo se permite si la original pasó el análisis y
// cumple la calidad mínima del uso. → { ok, trabajo, usarOriginal } | rechazo
async function trabajoParaNegocio(trabajoId, { usuario, negocioId, uso, usarOriginal = false }, { cliente = db() } = {}) {
  if (!trabajoId || typeof trabajoId !== 'string' || !['perfil', 'portada'].includes(uso)) return rechazoNegocio(400, 'IMAGEN_NO_PROCESADA');
  const { data: t, error } = await cliente.from('trabajos_imagen').select('*').eq('id', trabajoId).maybeSingle();
  if (error) return errorTabla(error);
  if (!t || String(t.negocio_id) !== String(negocioId) || (usuario.rol !== 'admin' && t.usuario_id !== usuario.id)
    || usoDeUrl(t.original_url) !== uso) {
    return rechazoNegocio(400, 'IMAGEN_NO_PROCESADA');
  }
  if (EN_CURSO.has(t.estado)) return rechazoNegocio(409, 'IMAGEN_EN_PROCESO');
  if (usarOriginal) {
    return puedeUsarOriginal(t, uso) ? { ok: true, trabajo: t, usarOriginal: true } : rechazoNegocio(422, 'ORIGINAL_NO_PERMITIDA');
  }
  if (t.estado === ESTADOS.RECHAZADA) return rechazoNegocio(422, 'IMAGEN_RECHAZADA');
  if (t.estado === ESTADOS.FALLIDA) return rechazoNegocio(422, 'IMAGEN_FALLIDA');
  if (t.estado !== ESTADOS.LISTA || !t.mejorada_url) return rechazoNegocio(400, 'IMAGEN_NO_PROCESADA');
  return { ok: true, trabajo: t, usarOriginal: false };
}

// Columnas de imagen (bolsas o portada de negocios) que fija una foto validada.
// Con fallback a la original, o si el restaurante eligió su original, queda
// 'descartada' (se muestra la original, que ya pasó el análisis y la revisión
// IA); la mejorada, si existe, se conserva para poder volver a ella.
function columnasImagenValidada(t, { usarOriginal = false } = {}) {
  const fallback = !!t.calidad_resultado?.fallback_original;
  const hayMejorada = t.estado === ESTADOS.LISTA && !!t.mejorada_url && !fallback;
  const original = usarOriginal || fallback;
  return {
    imagen_url: original ? t.original_url : t.mejorada_url,
    imagen_original_url: t.original_url,
    imagen_mejorada_url: hayMejorada ? t.mejorada_url : null,
    estado_procesamiento_imagen: original ? 'descartada' : 'completada',
    proveedor_imagen_ia: t.proveedor || null,
    error_procesamiento_imagen: null,
    imagen_procesamiento_meta: {
      trabajo_id: t.id, uso: usoDeUrl(t.original_url), modelo: t.modelo || null, ia: true,
      original_aceptable: original || t.calidad_original?.original_aceptable === true,
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
  ESTADOS, EN_CURSO, USOS, MENSAJES_FALLO, CODIGOS_PUBLICAR, CODIGOS_NEGOCIO,
  dependenciasIA, serializar, pasoError, codigoProveedor, usoDeUrl, puedeUsarOriginal,
  crearTrabajo, procesarTrabajo, programarTrabajo, esperarTrabajosEnCurso,
  procesarTrabajosPendientes, leerTrabajoPropio, reintentarTrabajo,
  trabajoParaPublicar, trabajoParaNegocio, columnasImagenValidada, bolsaTieneImagenValidada, marcarUsado,
};
