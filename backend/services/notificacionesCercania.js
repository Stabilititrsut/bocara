// Handler del evento `publicacion.visible`: avisa de una Promoción o de un
// Tiempo limitado recién visible a los clientes a ≤ 10 km del negocio y a los
// que lo tienen en favoritos.
//
// Garantía: como mucho UNA notificación por usuario y ciclo de publicación.
// La barrera es el índice único de notificaciones.clave_idempotencia
// (migración 202610051400): primero se inserta la fila de la bandeja y solo
// si el INSERT gana (sin 23505) se manda el push. Un reintento del evento
// vuelve a recorrer a todos, pero los ya notificados chocan con la clave y
// no reciben un segundo push.
const { enqueueEventBestEffort } = require('./eventosDominio');
const { enviarPushEnLotes, construirMensaje } = require('./notificaciones');
const { motivosNoVisible } = require('./publicaciones');
const { tieneFoto } = require('./fotoObligatoria');
const { ahoraGuatemala, sumarDias } = require('./horarioGuatemala');
const { validarCoordenadasEntrada } = require('../utils/geo');

const EVENTO_PUBLICACION_VISIBLE = 'publicacion.visible';
const RADIO_KM = 10;
const MAX_EDAD_UBICACION_DIAS = 30;
// PostgREST corta las respuestas en 1000 filas (max-rows de Supabase): la RPC
// se pagina para no perder a nadie en zonas densas.
const PAGINA_RPC = 1000;
const CONCURRENCIA_INSERTS = 10;
const TIPO_NOTIFICACION = 'nueva_bolsa';
// Android NO muestra un push dirigido a un canal que el dispositivo no creó, y
// las versiones de la app anteriores a la Fase C solo tienen 'default'. Se usa
// 'default' hasta que la app con el canal 'promociones' esté adoptada; entonces
// PUSH_CANAL_CERCANIA=promociones lo cambia sin tocar código.
const CANAL_CERCANIA = process.env.PUSH_CANAL_CERCANIA === 'promociones' ? 'promociones' : 'default';

function db() { return require('../config/supabase'); }

// El ciclo distingue "la misma publicación vuelta a aprobar" (no re-notifica)
// de "la publicación republicada con otra fecha" (sí). fecha_disponible es la
// fecha de publicación (Promoción) o de inicio de vigencia (Tiempo limitado).
function cicloPublicacion(bolsa) {
  return bolsa?.fecha_disponible ? String(bolsa.fecha_disponible) : 'sin-fecha';
}

function claveNotificacion(bolsaId, ciclo, usuarioId) {
  return `geo:${bolsaId}:${ciclo}:${usuarioId}`;
}

// Punto único de emisión. La clave del evento incluye el ciclo, así que
// emitirlo dos veces (dos aprobaciones del mismo ciclo) colapsa en una fila.
function encolarPublicacionVisible(bolsa) {
  const ciclo = cicloPublicacion(bolsa);
  enqueueEventBestEffort({
    eventType: EVENTO_PUBLICACION_VISIBLE, aggregateType: 'bolsa', aggregateId: bolsa.id,
    discriminator: ciclo,
    payload: { negocio_id: bolsa.negocio_id, ciclo },
  });
}

// Copy por producto (tipo 'cupon' = Promoción, 'bolsa' = Tiempo limitado):
// nunca "bolsa" para una Promoción. "Cerca de ti" solo si el cliente entró
// por radio; a un favorito que está lejos se le nombra el negocio.
function textos(bolsa, nombreNegocio, { cercano = true } = {}) {
  const esPromocion = bolsa.tipo === 'cupon';
  const donde = cercano ? 'cerca de ti' : `en ${nombreNegocio}`;
  return {
    tipoPayload: esPromocion ? 'promocion' : 'tiempo_limitado',
    titulo: esPromocion ? `🏷️ Nueva promoción ${donde}` : `⏱️ Tiempo limitado ${donde}`,
    cuerpo: `${nombreNegocio} publicó: ${bolsa.nombre}`,
  };
}

function esClienteNotificable(u) {
  return !!u && u.rol === 'cliente' && u.activo !== false && u.notif_promociones !== false && !!u.expo_push_token;
}

async function clientesEnRadio(cliente, lat, lng) {
  const filas = [];
  for (let desde = 0; ; desde += PAGINA_RPC) {
    const { data, error } = await cliente
      .rpc('usuarios_en_radio', { p_lat: lat, p_lng: lng, p_radio_km: RADIO_KM, p_max_edad_dias: MAX_EDAD_UBICACION_DIAS })
      .range(desde, desde + PAGINA_RPC - 1);
    if (error) throw new Error(`usuarios_en_radio falló: ${error.message}`);
    filas.push(...(data || []));
    if (!data || data.length < PAGINA_RPC) break;
  }
  // Defensa en profundidad: la RPC ya acota a 10 km, pero la regla de negocio
  // no depende de que nadie cambie la función sin cambiar este código.
  return filas.filter(f => f?.usuario_id && f.expo_push_token && Number(f.distancia_km) <= RADIO_KM);
}

// Esquema real de favoritos (routes/favoritos.js): (usuario_id, tipo,
// referencia_id) — un negocio favorito es tipo='negocio' con referencia_id =
// negocio. No hay FK hacia usuarios, así que no se puede embeber
// `usuarios(...)`: dos consultas (favoritos → usuarios por id), no N+1.
async function favoritosNotificables(cliente, negocioId) {
  const { data, error } = await cliente
    .from('favoritos')
    .select('usuario_id')
    .eq('tipo', 'negocio')
    .eq('referencia_id', negocioId);
  if (error) {
    // Tabla ausente en despliegues viejos: no hay favoritos que avisar.
    if (error.code === '42P01') return [];
    throw new Error(`favoritos falló: ${error.message}`);
  }
  const ids = [...new Set((data || []).map(f => f.usuario_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: usuarios, error: errU } = await cliente
    .from('usuarios')
    .select('id,rol,activo,notif_promociones,expo_push_token')
    .in('id', ids);
  if (errU) throw new Error(`usuarios de favoritos falló: ${errU.message}`);
  return (usuarios || [])
    .filter(esClienteNotificable)
    .map(u => ({ usuario_id: u.id, expo_push_token: u.expo_push_token }));
}

// Inserta una fila por destinatario con concurrencia acotada. Devuelve qué
// usuarios ganaron el INSERT (a esos, y solo a esos, se les manda push).
async function insertarIdempotentes(cliente, destinatarios, construirFila) {
  const ganadores = [];
  const errores = [];
  let duplicadas = 0;
  for (let i = 0; i < destinatarios.length; i += CONCURRENCIA_INSERTS) {
    const tanda = destinatarios.slice(i, i + CONCURRENCIA_INSERTS);
    const resultados = await Promise.all(tanda.map(async (d) => {
      try {
        const { error } = await cliente.from('notificaciones').insert(construirFila(d));
        return { d, error };
      } catch (err) {
        return { d, error: { message: err.message } };
      }
    }));
    for (const { d, error } of resultados) {
      if (!error) ganadores.push(d);
      else if (error.code === '23505') duplicadas += 1;
      else errores.push(error.message);
    }
  }
  return { ganadores, duplicadas, errores };
}

async function manejarPublicacionVisible(evento, { cliente = db(), enviarPush = enviarPushEnLotes } = {}) {
  const bolsaId = evento?.aggregate_id;
  const { data: bolsa, error } = await cliente
    .from('bolsas')
    .select('*, negocios(id,nombre,latitud,longitud,activo,estado_verificacion)')
    .eq('id', bolsaId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la publicación ${bolsaId}: ${error.message}`);
  if (!bolsa) {
    console.warn('[CERCANIA] Publicación inexistente, evento cerrado sin envío:', bolsaId);
    return { omitido: 'no_existe' };
  }

  // El evento pudo procesarse tarde (reintentos, backend caído): se vuelve a
  // comprobar con la misma regla que el feed antes de avisar a nadie.
  const motivos = motivosNoVisible(bolsa);
  if (motivos.length) {
    console.warn('[CERCANIA] Publicación %s ya no es visible (%s): sin envío', bolsaId, motivos.join(','));
    return { omitido: 'no_visible', motivos };
  }
  // Foto obligatoria (services/fotoObligatoria.js): una heredada sin foto no
  // se aprueba, pero si alguna llegara aquí no se anuncia.
  if (!tieneFoto(bolsa.imagen_url)) {
    console.warn('[CERCANIA] Publicación %s sin foto: sin envío', bolsaId);
    return { omitido: 'sin_foto' };
  }

  const negocio = bolsa.negocios || {};
  const negocioId = bolsa.negocio_id;
  const ciclo = evento.payload?.ciclo || cicloPublicacion(bolsa);

  // Sin coordenadas válidas no hay radio que calcular, pero los favoritos no
  // dependen de la ubicación: se les sigue avisando.
  const { lat, lng, ok: coordsOk } = validarCoordenadasEntrada(negocio.latitud, negocio.longitud);
  let cercanos = [];
  if (coordsOk) {
    cercanos = await clientesEnRadio(cliente, lat, lng);
  } else {
    console.warn('[CERCANIA] Negocio %s sin coordenadas válidas: solo se avisa a favoritos', negocioId);
  }
  const favoritos = await favoritosNotificables(cliente, negocioId);

  // Un usuario elegible por radio Y por favorito es UNA entrada: la clave
  // geo:<bolsa>:<ciclo>:<usuario> no depende de la razón.
  const porUsuario = new Map();
  for (const f of cercanos) porUsuario.set(f.usuario_id, { token: f.expo_push_token, cercano: true });
  for (const f of favoritos) {
    if (!porUsuario.has(f.usuario_id)) porUsuario.set(f.usuario_id, { token: f.expo_push_token, cercano: false });
  }
  const nombreNegocio = negocio.nombre || 'Un restaurante cercano';
  const destinatarios = [...porUsuario].map(([usuarioId, { token, cercano }]) => ({
    usuarioId, token, ...textos(bolsa, nombreNegocio, { cercano }),
  }));
  const dataDe = (d) => ({ tipo: d.tipoPayload, bolsaId, negocioId });

  const { ganadores, duplicadas, errores } = await insertarIdempotentes(cliente, destinatarios, (d) => ({
    usuario_id: d.usuarioId,
    tipo: TIPO_NOTIFICACION,
    titulo: d.titulo,
    cuerpo: d.cuerpo,
    data: dataDe(d),
    leida: false,
    clave_idempotencia: claveNotificacion(bolsaId, ciclo, d.usuarioId),
  }));

  const push = ganadores.length
    ? await enviarPush(ganadores.map(d => construirMensaje(d.token, d.titulo, d.cuerpo, dataDe(d), CANAL_CERCANIA)), { cliente })
    : null;

  const resumen = {
    bolsaId, ciclo, cercanos: cercanos.length, favoritos: favoritos.length,
    destinatarios: destinatarios.length, insertadas: ganadores.length, duplicadas, errores: errores.length, push,
  };
  console.log('[CERCANIA] publicación %s ciclo %s:', bolsaId, ciclo, JSON.stringify(resumen));

  // Fallos no-duplicado (BD transitoria): el evento se reintenta. Los que ya
  // recibieron su notificación chocarán con 23505 y no se les duplica nada.
  if (errores.length) {
    throw new Error(`${errores.length} notificación(es) no se pudieron guardar: ${errores[0]}`);
  }
  return resumen;
}

// Publicaciones aprobadas cuya fecha_disponible llegó (hoy, o ayer si el
// proceso estuvo caído a medianoche). Al aprobarlas con fecha futura no eran
// visibles y no se emitió nada; aquí se emite cuando de verdad lo son.
// fecha_disponible tiene granularidad de día (horarioGuatemala#noHaIniciado),
// así que un barrido cada pocos minutos es exacto sin polling agresivo.
// Volver a encolar es inocuo: la clave del evento
// (bolsa:<id>:publicacion.visible:<ciclo>) es UNIQUE en eventos_dominio.
async function emitirPublicacionesQueInician({ cliente = db(), ahora = ahoraGuatemala(), encolar = encolarPublicacionVisible } = {}) {
  const { data, error } = await cliente
    .from('bolsas')
    .select('*, negocios(id,activo,estado_verificacion)')
    .eq('estado_aprobacion', 'aprobado')
    .eq('activo', true)
    .is('eliminado_en', null)
    .gte('fecha_disponible', sumarDias(ahora.fecha, -1))
    .lte('fecha_disponible', ahora.fecha)
    .limit(200);
  if (error) {
    console.warn('[CERCANIA] Barrido de publicaciones que inician falló:', error.message);
    return { revisadas: 0, encoladas: 0, error: error.message };
  }
  let encoladas = 0;
  for (const bolsa of data || []) {
    if (motivosNoVisible(bolsa, { ahora }).length || !tieneFoto(bolsa.imagen_url)) continue;
    encolar(bolsa);
    encoladas += 1;
  }
  return { revisadas: (data || []).length, encoladas };
}

module.exports = {
  EVENTO_PUBLICACION_VISIBLE, RADIO_KM, MAX_EDAD_UBICACION_DIAS, PAGINA_RPC, TIPO_NOTIFICACION, CANAL_CERCANIA,
  cicloPublicacion, claveNotificacion, encolarPublicacionVisible, manejarPublicacionVisible,
  emitirPublicacionesQueInician,
};
