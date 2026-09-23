const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claveEvento, enqueueEvent, processEvent, markProcessed, markFailed, MAX_ATTEMPTS,
} = require('../services/eventosDominio');

// ════════════════════════════════════════════════════════════════════════════
// Doble de Supabase para la tabla eventos_dominio, en memoria.
//
// Reproduce lo único que estas pruebas necesitan del cliente real:
//   · INSERT choca con 23505 si el idempotency_key ya existe (índice UNIQUE)
//   · UPDATE con .eq('status', X) no afecta la fila si el status no coincide
//     (así se modela el bloqueo optimista de processEvent/markFailed)
// ════════════════════════════════════════════════════════════════════════════
function crearCliente(filas = []) {
  let seq = filas.length;
  const tabla = filas;

  function porId(id) { return tabla.find((f) => f.id === id); }

  const cliente = {
    from(nombre) {
      assert.equal(nombre, 'eventos_dominio');
      return {
        insert(payload) {
          const yaExiste = tabla.find((f) => f.idempotency_key === payload.idempotency_key);
          if (yaExiste) {
            return {
              select: () => ({
                maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
              }),
            };
          }
          const fila = {
            id: `evt-${++seq}`, status: 'pendiente', attempts: 0, last_error: null,
            processed_at: null, processing_at: null, ...payload,
          };
          tabla.push(fila);
          return { select: () => ({ maybeSingle: async () => ({ data: { ...fila }, error: null }) }) };
        },
        update(cambios) {
          const filtros = [];
          const q = {
            eq(campo, valor) { filtros.push([campo, valor]); return q; },
            select: () => ({
              maybeSingle: async () => {
                const fila = tabla.find((f) => filtros.every(([c, v]) => f[c] === v));
                if (!fila) return { data: null, error: null };
                Object.assign(fila, cambios);
                return { data: { ...fila }, error: null };
              },
            }),
            // update(...).eq(...) sin .select() — usado por markProcessed/markFailed
            then(resolver, rechazar) {
              const fila = tabla.find((f) => filtros.every(([c, v]) => f[c] === v));
              if (fila) Object.assign(fila, cambios);
              return Promise.resolve({ data: null, error: null }).then(resolver, rechazar);
            },
          };
          return q;
        },
      };
    },
  };
  return { cliente, tabla, porId };
}

const AGG = { aggregateType: 'pedido', aggregateId: '11111111-1111-1111-1111-111111111111' };

test('la clave de evento es determinista y distingue la transacción', () => {
  const base = { eventType: 'pedido.pago_confirmado', ...AGG, discriminator: 'tx-1' };
  assert.equal(claveEvento(base), claveEvento(base));
  assert.notEqual(claveEvento(base), claveEvento({ ...base, discriminator: 'tx-2' }));
  assert.equal(claveEvento(base), 'pedido:11111111-1111-1111-1111-111111111111:pedido.pago_confirmado:tx-1');
});

test('insertar el mismo evento dos veces solo crea una fila (duplicado)', async () => {
  const { cliente, tabla } = crearCliente();
  const args = { eventType: 'pedido.pago_confirmado', ...AGG, discriminator: 'tx-1', cliente };

  const primero = await enqueueEvent(args);
  const segundo = await enqueueEvent(args);

  assert.equal(primero.duplicate, false);
  assert.equal(segundo.duplicate, true);
  assert.equal(tabla.length, 1);
});

test('un webhook SUCCEEDED repetido con el mismo identifier no duplica el evento', async () => {
  const { cliente, tabla } = crearCliente();
  // Dos llamadas del mismo webhook reintentado — mismo paymentIntentToken como discriminador
  await enqueueEvent({ eventType: 'pedido.pago_confirmado', ...AGG, discriminator: 'tok_abc', cliente });
  await enqueueEvent({ eventType: 'pedido.pago_confirmado', ...AGG, discriminator: 'tok_abc', cliente });
  assert.equal(tabla.filter((f) => f.event_type === 'pedido.pago_confirmado').length, 1);
});

test('una cancelación repetida (usuario, restaurante, admin) no duplica el evento pedido.cancelado', async () => {
  const { cliente, tabla } = crearCliente();
  await enqueueEvent({ eventType: 'pedido.cancelado', ...AGG, discriminator: 'restaurante', cliente });
  // Un segundo actor intentando cancelar el mismo pedido ya cancelado — el
  // choke point (liberarInventarioPedido) no vuelve a llamar con éxito porque
  // el CAS ya perdió, pero si algo reintentara la clave sigue colapsando:
  await enqueueEvent({ eventType: 'pedido.cancelado', ...AGG, discriminator: 'restaurante', cliente });
  assert.equal(tabla.length, 1);
});

test('processEvent ejecuta el handler una sola vez y lo marca procesado', async () => {
  const { cliente, tabla } = crearCliente();
  await enqueueEvent({ eventType: 'publicacion.creada', ...AGG, cliente });
  const evento = tabla[0];

  let llamadas = 0;
  const r1 = await processEvent(evento, async () => { llamadas += 1; }, cliente);
  assert.equal(r1.claimed, true);
  assert.equal(r1.processed, true);
  assert.equal(llamadas, 1);
  assert.equal(tabla[0].status, 'procesado');
  assert.ok(tabla[0].processed_at);

  // Reintentar sobre el mismo evento (ya 'procesado', no 'pendiente'): el
  // bloqueo optimista no lo reclama y el handler no se ejecuta de nuevo —
  // "evento procesado una sola vez".
  const r2 = await processEvent(evento, async () => { llamadas += 1; }, cliente);
  assert.equal(r2.claimed, false);
  assert.equal(llamadas, 1);
});

test('dos workers reclamando el mismo evento pendiente: solo uno ejecuta el handler', async () => {
  const { cliente, tabla } = crearCliente();
  await enqueueEvent({ eventType: 'reserva.expirada', ...AGG, cliente });
  const evento = tabla[0];

  let ejecuciones = 0;
  const handler = async () => { ejecuciones += 1; };

  // Concurrencia real necesitaría dos conexiones; aquí se simula reclamando
  // dos veces en secuencia sin resetear el status, que es lo que garantiza el
  // UPDATE...WHERE status='pendiente' en Postgres: solo el primero gana.
  const [r1, r2] = [
    await processEvent(evento, handler, cliente),
    await processEvent({ ...evento, id: evento.id }, handler, cliente),
  ];
  assert.equal(r1.claimed, true);
  assert.equal(r2.claimed, false);
  assert.equal(ejecuciones, 1);
});

test('un handler que falla dentro del límite queda pendiente para reintentar', async () => {
  const { cliente, tabla } = crearCliente();
  await enqueueEvent({ eventType: 'publicacion.aprobada', ...AGG, cliente });
  const evento = tabla[0];

  const r = await processEvent(evento, async () => { throw new Error('SMTP caído'); }, cliente);
  assert.equal(r.claimed, true);
  assert.equal(r.processed, false);
  assert.equal(tabla[0].status, 'pendiente');
  assert.equal(tabla[0].attempts, 1);
  assert.equal(tabla[0].last_error, 'SMTP caído');
});

test('agotar los reintentos marca el evento como fallido definitivamente', async () => {
  const { cliente, tabla } = crearCliente([
    { id: 'evt-x', status: 'procesando', attempts: MAX_ATTEMPTS - 1, idempotency_key: 'k', event_type: 'e', aggregate_type: 'pedido', aggregate_id: '1' },
  ]);
  await markFailed(tabla[0], new Error('definitivo'), cliente);
  assert.equal(tabla[0].status, 'fallido');
  assert.equal(tabla[0].attempts, MAX_ATTEMPTS);
});

test('un reinicio del backend a mitad de proceso dispensa el "crash": el evento sigue pendiente en BD y se reclama de nuevo', async () => {
  const { cliente, tabla } = crearCliente();
  await enqueueEvent({ eventType: 'pedido.completado', ...AGG, cliente });
  // El proceso "muere" justo después de encolar: no llegó a llamar processEvent.
  // Al reiniciar, el evento sigue 'pendiente' en la fila durable (no se perdió,
  // a diferencia de una notificación disparada en memoria) y un nuevo barrido
  // lo reclama y procesa con normalidad.
  assert.equal(tabla[0].status, 'pendiente');
  let ejecutado = false;
  const r = await processEvent(tabla[0], async () => { ejecutado = true; }, cliente);
  assert.equal(r.processed, true);
  assert.ok(ejecutado);
});

test('markProcessed limpia last_error y processing_at', async () => {
  const { cliente, tabla } = crearCliente([
    { id: 'evt-y', status: 'procesando', attempts: 1, last_error: 'fallo previo', processing_at: new Date().toISOString(), idempotency_key: 'k2', event_type: 'e', aggregate_type: 'pedido', aggregate_id: '1' },
  ]);
  await markProcessed('evt-y', cliente);
  assert.equal(tabla[0].status, 'procesado');
  assert.equal(tabla[0].last_error, null);
  assert.equal(tabla[0].processing_at, null);
});
