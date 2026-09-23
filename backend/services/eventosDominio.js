// Cola durable canónica. La clave determinista es la barrera de duplicados;
// nunca se usa un UUID aleatorio como idempotencia.
const MAX_ATTEMPTS = 5;
function db() { return require('../config/supabase'); }

function claveEvento({ eventType, aggregateType, aggregateId, discriminator = '' }) {
  return [aggregateType, aggregateId, eventType, discriminator].filter(Boolean).join(':');
}

// `cliente` es inyectable (mismo patrón que services/stock.js) para que los
// puntos de emisión que ya reciben un Supabase de prueba (p. ej. cuboWebhook)
// lo reutilicen en vez de abrir el cliente real dentro de una prueba unitaria.
async function enqueueEvent({ eventType, aggregateType, aggregateId, payload = {}, idempotencyKey, discriminator, cliente }) {
  const key = idempotencyKey || claveEvento({ eventType, aggregateType, aggregateId, discriminator });
  const { data, error } = await (cliente || db()).from('eventos_dominio').insert({
    event_type: eventType, aggregate_type: aggregateType, aggregate_id: aggregateId,
    idempotency_key: key, payload,
  }).select().maybeSingle();
  if (!error) return { ok: true, duplicate: false, event: data };
  if (error.code === '23505') return { ok: true, duplicate: true, idempotencyKey: key };
  throw new Error(`No se pudo encolar evento ${eventType}: ${error.message}`);
}

// Encola sin bloquear al llamador, pero registrando cualquier fallo en los logs
// estructurados para auditoría y depuración sin suprimir errores a ciegas.
function enqueueEventBestEffort(args) {
  enqueueEvent(args).catch((err) => {
    console.error('[EVENTOS_DOMINIO] Fallo al encolar evento best-effort:', {
      tipo: args?.eventType,
      id: args?.aggregateId,
      error: err.message,
    });
  });
}

async function markProcessed(id, cliente) {
  const { error } = await (cliente || db()).from('eventos_dominio').update({
    status: 'procesado', processed_at: new Date().toISOString(), processing_at: null, last_error: null,
  }).eq('id', id);
  if (error) throw new Error(`No se pudo cerrar evento: ${error.message}`);
}

async function markFailed(event, error, cliente) {
  const attempts = event.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'fallido' : 'pendiente';
  const { error: dbError } = await (cliente || db()).from('eventos_dominio').update({
    status, attempts, processing_at: null, last_error: String(error.message || error).slice(0, 500),
  }).eq('id', event.id).eq('status', 'procesando');
  if (dbError) throw new Error(`No se pudo marcar fallo: ${dbError.message}`);
}

// Bloqueo optimista: solo reclama la fila si sigue 'pendiente' — dos llamadas
// concurrentes sobre el mismo evento (reinicio del backend a mitad de proceso,
// o dos workers) hacen que como mucho una gane el UPDATE condicionado; la otra
// recibe `claimed: false` y no ejecuta el handler ni lo cuenta como intento.
async function processEvent(event, handler, cliente) {
  const { data: claimed, error } = await (cliente || db()).from('eventos_dominio').update({
    status: 'procesando', processing_at: new Date().toISOString(),
  }).eq('id', event.id).eq('status', 'pendiente').select().maybeSingle();
  if (error) throw new Error(`No se pudo reclamar evento: ${error.message}`);
  if (!claimed) return { claimed: false };
  try { await handler(claimed); await markProcessed(claimed.id, cliente); return { claimed: true, processed: true }; }
  catch (err) { await markFailed(claimed, err, cliente); return { claimed: true, processed: false }; }
}

module.exports = { MAX_ATTEMPTS, claveEvento, enqueueEvent, enqueueEventBestEffort, processEvent, markProcessed, markFailed };
