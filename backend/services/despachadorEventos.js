// Consumidor de la cola durable eventos_dominio.
//
// Solo toca los event_type que tienen handler registrado: el resto de la
// tabla (pagos, cancelaciones, auditoría de publicaciones) sigue siendo
// bitácora y nunca se reclama ni se marca fallido desde aquí.
//
// El reclamo es el CAS de processEvent ('pendiente' → 'procesando'): dos
// workers (o dos instancias del backend) sobre el mismo evento, como mucho
// uno ejecuta el handler.
const { processEvent, MAX_ATTEMPTS } = require('./eventosDominio');
const { EVENTO_PUBLICACION_VISIBLE, manejarPublicacionVisible } = require('./notificacionesCercania');

const ABANDONO_MS = 10 * 60 * 1000;
const LOTE = 20;

const HANDLERS = Object.freeze({
  [EVENTO_PUBLICACION_VISIBLE]: manejarPublicacionVisible,
});

function db() { return require('../config/supabase'); }

// Un evento en 'procesando' por más de ABANDONO_MS es de un proceso que murió
// a mitad del handler. Vuelve a 'pendiente' contando el intento (un handler
// que tumba el proceso siempre no queda en bucle infinito: al llegar a
// MAX_ATTEMPTS pasa a 'fallido'). CAS sobre processing_at: si otro worker ya
// lo recuperó, este UPDATE no afecta nada.
async function recuperarAbandonados({ cliente = db(), handlers = HANDLERS, ahora = Date.now() } = {}) {
  const limite = new Date(ahora - ABANDONO_MS).toISOString();
  const { data, error } = await cliente
    .from('eventos_dominio')
    .select('id, attempts, processing_at')
    .eq('status', 'procesando')
    .in('event_type', Object.keys(handlers))
    .lt('processing_at', limite)
    .limit(LOTE);
  if (error) throw new Error(`No se pudieron leer eventos abandonados: ${error.message}`);

  let recuperados = 0;
  for (const ev of data || []) {
    const attempts = (ev.attempts || 0) + 1;
    const { error: upErr } = await cliente.from('eventos_dominio').update({
      status: attempts >= MAX_ATTEMPTS ? 'fallido' : 'pendiente',
      attempts,
      processing_at: null,
      last_error: 'abandonado en procesando (proceso interrumpido)',
    }).eq('id', ev.id).eq('status', 'procesando').eq('processing_at', ev.processing_at);
    if (upErr) console.error('[DESPACHADOR] No se pudo recuperar evento %s: %s', ev.id, upErr.message);
    else recuperados += 1;
  }
  if (recuperados) console.warn('[DESPACHADOR] Eventos abandonados recuperados:', recuperados);
  return recuperados;
}

async function procesarPendientes({ cliente = db(), handlers = HANDLERS, lote = LOTE } = {}) {
  const { data, error } = await cliente
    .from('eventos_dominio')
    .select('*')
    .eq('status', 'pendiente')
    .in('event_type', Object.keys(handlers))
    .order('created_at', { ascending: true })
    .limit(lote);
  if (error) throw new Error(`No se pudieron leer eventos pendientes: ${error.message}`);

  const resumen = { leidos: (data || []).length, procesados: 0, fallidos: 0, ajenos: 0 };
  for (const evento of data || []) {
    const handler = handlers[evento.event_type];
    try {
      const r = await processEvent(evento, (reclamado) => handler(reclamado, { cliente }), cliente);
      if (!r.claimed) resumen.ajenos += 1;
      else if (r.processed) resumen.procesados += 1;
      else resumen.fallidos += 1;
    } catch (err) {
      // Error de BD al reclamar/cerrar: no aborta el resto del lote.
      resumen.fallidos += 1;
      console.error('[DESPACHADOR] Evento %s (%s): %s', evento.id, evento.event_type, err.message);
    }
  }
  return resumen;
}

// Un tick del cron. El flag evita solapar ticks dentro del mismo proceso si
// uno tarda más que el intervalo (entre procesos lo cubre el CAS).
let corriendo = false;
async function ejecutarDespachador(opciones = {}) {
  if (corriendo) return { omitido: 'en_curso' };
  corriendo = true;
  try {
    await recuperarAbandonados(opciones);
    return await procesarPendientes(opciones);
  } catch (err) {
    console.error('[DESPACHADOR] Tick fallido:', err.message);
    return { error: err.message };
  } finally {
    corriendo = false;
  }
}

module.exports = { ABANDONO_MS, HANDLERS, recuperarAbandonados, procesarPendientes, ejecutarDespachador };
