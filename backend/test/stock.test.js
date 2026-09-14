const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESERVA_TTL_MINUTOS,
  RESERVA_TTL_MS,
  instanteReserva,
  reservaVigente,
  reservaPagable,
  disponibilidadReal,
  getReservadoPendiente,
  getReservasMap,
  getDisponibilidadRealBolsa,
  reservarStockPedido,
} = require('../services/stock');

// ════════════════════════════════════════════════════════════════════════════
// Dobles de prueba
//
// Ninguna de estas pruebas abre una conexión: services/stock.js resuelve su
// cliente Supabase de forma perezosa y todas sus funciones aceptan uno
// inyectado. `ahora` también se inyecta, así que la expiración se comprueba con
// relojes exactos en vez de con esperas reales.
// ════════════════════════════════════════════════════════════════════════════

const BOLSA_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOLSA_2 = 'bbbbbbbb-2222-4222-8222-222222222222';

// Reloj fijo para todas las pruebas: 2026-09-12 12:00:00Z
const AHORA = Date.parse('2026-09-12T12:00:00.000Z');
const haceMinutos = (m) => new Date(AHORA - m * 60 * 1000).toISOString();

/** Cliente Supabase falso sobre tablas en memoria. */
function crearCliente(tablas, { sinColumnaReservadoAt = false, rpc = {} } = {}) {
  function consulta(nombreTabla) {
    const q = { campos: '', filtros: [] };
    q.select = (campos) => { q.campos = campos || ''; return q; };
    q.eq = (campo, valor) => { q.filtros.push((f) => f[campo] === valor); return q; };
    q.in = (campo, valores) => { q.filtros.push((f) => valores.includes(f[campo])); return q; };
    q.not = (campo, op, lista) => {
      assert.equal(op, 'in', 'el doble solo implementa .not(campo, "in", …)');
      const excluidos = String(lista).replace(/^\(|\)$/g, '').split(',').filter(Boolean);
      q.filtros.push((f) => !excluidos.includes(f[campo]));
      return q;
    };
    q.then = (resolver, rechazar) => ejecutar(nombreTabla, q).then(resolver, rechazar);
    return q;
  }

  async function ejecutar(nombreTabla, q) {
    // PostgREST devuelve 42703 al pedir una columna que no existe. Así se
    // reproduce el despliegue en el que la migración 202609121200 aún no corrió.
    if (sinColumnaReservadoAt && q.campos.includes('reservado_at')) {
      return { data: null, error: { code: '42703', message: 'column pedidos.reservado_at does not exist' } };
    }
    const pedidas = q.campos.split(',').map((c) => c.trim()).filter(Boolean);
    const filas = (tablas[nombreTabla] || [])
      .filter((f) => q.filtros.every((cumple) => cumple(f)))
      .map((f) => Object.fromEntries(pedidas.map((c) => [c, f[c]])));
    return { data: filas, error: null };
  }

  return {
    from: (tabla) => consulta(tabla),
    rpc: async (nombre, params) => {
      const manejador = rpc[nombre];
      if (!manejador) {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${nombre}` } };
      }
      return manejador(params);
    },
  };
}

/** Pedido en estado de reserva viva, con `reservado_at` a X minutos. */
function reserva(id, bolsaId, cantidad, minutosDeAntiguedad) {
  return {
    id,
    bolsa_id: bolsaId,
    cantidad,
    estado: 'pendiente',
    estado_pago: 'pendiente',
    created_at: haceMinutos(minutosDeAntiguedad),
    reservado_at: haceMinutos(minutosDeAntiguedad),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. La fórmula
// ════════════════════════════════════════════════════════════════════════════

test('disponibilidadReal resta las reservas y nunca baja de cero', () => {
  assert.equal(disponibilidadReal(10, 3), 7);
  assert.equal(disponibilidadReal(3, 3), 0);
  assert.equal(disponibilidadReal(3, 8), 0, 'jamás debe devolver stock negativo');
  assert.equal(disponibilidadReal(0, 0), 0);
});

test('disponibilidadReal tolera los tipos que devuelve PostgREST', () => {
  assert.equal(disponibilidadReal('10', '4'), 6, 'numeric llega como string');
  assert.equal(disponibilidadReal(null, 2), 0);
  assert.equal(disponibilidadReal(5, null), 5);
  assert.equal(disponibilidadReal(5, undefined), 5);
  assert.equal(disponibilidadReal('no-es-un-numero', 1), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Vigencia de la reserva — la frontera de los 15 minutos
// ════════════════════════════════════════════════════════════════════════════

test('el TTL de reserva es de 15 minutos', () => {
  assert.equal(RESERVA_TTL_MINUTOS, 15);
  assert.equal(RESERVA_TTL_MS, 15 * 60 * 1000);
});

test('una reserva de 14 min 59 s sigue bloqueando stock', () => {
  const p = { reservado_at: new Date(AHORA - (15 * 60 * 1000 - 1000)).toISOString() };
  assert.equal(reservaVigente(p, AHORA), true);
});

test('a los 15 minutos exactos la reserva ya expiró', () => {
  const p = { reservado_at: new Date(AHORA - 15 * 60 * 1000).toISOString() };
  assert.equal(reservaVigente(p, AHORA), false, 'la frontera es estricta: 15:00 ya no cuenta');
});

test('una reserva de 15 min 1 s está expirada', () => {
  const p = { reservado_at: new Date(AHORA - (15 * 60 * 1000 + 1000)).toISOString() };
  assert.equal(reservaVigente(p, AHORA), false);
});

test('sin marca temporal la reserva se considera vigente (fail-closed)', () => {
  assert.equal(reservaVigente({}, AHORA), true);
  assert.equal(reservaVigente({ reservado_at: null, created_at: null }, AHORA), true);
  assert.equal(reservaVigente({ reservado_at: 'no-es-una-fecha' }, AHORA), true,
    'ante un dato ilegible se prefiere bloquear stock antes que sobrevender');
});

// ── Las dos caras del fail-closed ───────────────────────────────────────────
//
// reservaVigente responde "¿libero stock?" y reservaPagable "¿confirmo el
// pago?". Comparten ventana y discrepan solo ante un dato ilegible, porque el
// riesgo es el contrario en cada caso: ninguna de las dos puede terminar
// vendiendo la misma bolsa dos veces.

test('reservaPagable usa la misma ventana de 15 minutos', () => {
  const dentro = { reservado_at: new Date(AHORA - (15 * 60 * 1000 - 1000)).toISOString() };
  const justo  = { reservado_at: new Date(AHORA - 15 * 60 * 1000).toISOString() };
  const fuera  = { reservado_at: haceMinutos(40) };

  assert.equal(reservaPagable(dentro, AHORA), true, 'a 14:59 el cliente todavía tiene su bolsa');
  assert.equal(reservaPagable(justo, AHORA), false, 'a los 15:00 exactos ya no se confirma');
  assert.equal(reservaPagable(fuera, AHORA), false);
});

test('sin marca temporal NO se confirma el pago, aunque el stock sí siga bloqueado', () => {
  for (const pedido of [{}, { reservado_at: null, created_at: null }, { reservado_at: 'ayer' }]) {
    assert.equal(reservaVigente(pedido, AHORA), true,
      'para el catálogo, un dato ilegible mantiene la unidad reservada');
    assert.equal(reservaPagable(pedido, AHORA), false,
      'para el cobro, lo que no se puede demostrar no se confirma');
  }
});

test('reservaPagable también mide desde reservado_at, no desde created_at', () => {
  const p = { created_at: haceMinutos(60), reservado_at: haceMinutos(2) };
  assert.equal(reservaPagable(p, AHORA), true, 'el carrito es viejo, la reserva no');
});

test('reservado_at manda sobre created_at', () => {
  // Carrito creado hace una hora, pero que llegó a la pasarela hace 2 minutos:
  // la reserva nació hace 2 minutos y está viva. Medir desde created_at la
  // habría dado por muerta y habría vendido la unidad dos veces.
  const p = { created_at: haceMinutos(60), reservado_at: haceMinutos(2) };
  assert.equal(instanteReserva(p), p.reservado_at);
  assert.equal(reservaVigente(p, AHORA), true);

  // Y al revés: borrador reciente cuya reserva ya venció.
  const q = { created_at: haceMinutos(1), reservado_at: haceMinutos(30) };
  assert.equal(reservaVigente(q, AHORA), false);
});

test('sin reservado_at se mide desde created_at', () => {
  assert.equal(reservaVigente({ created_at: haceMinutos(5) }, AHORA), true);
  assert.equal(reservaVigente({ created_at: haceMinutos(20) }, AHORA), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Cálculo de stock: reservas vigentes vs expiradas
// ════════════════════════════════════════════════════════════════════════════

test('getReservadoPendiente cuenta las reservas vigentes e ignora las expiradas', async () => {
  const cliente = crearCliente({
    pedidos: [
      reserva('p-viva-1', BOLSA_1, 1, 2),    // vigente
      reserva('p-viva-2', BOLSA_1, 1, 14),   // vigente (al filo)
      reserva('p-muerta-1', BOLSA_1, 1, 16), // expirada
      reserva('p-muerta-2', BOLSA_1, 1, 90), // expirada hace rato
    ],
    pedido_items: [
      { pedido_id: 'p-viva-1', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p-viva-2', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p-muerta-1', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p-muerta-2', bolsa_id: BOLSA_1, cantidad: 1 },
    ],
  });

  const reservado = await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA });
  assert.equal(reservado, 2, 'solo las dos reservas de menos de 15 min bloquean stock');
});

test('getReservadoPendiente suma cantidades, no pedidos', async () => {
  const cliente = crearCliente({
    pedidos: [reserva('p1', BOLSA_1, 3, 1), reserva('p2', BOLSA_1, 2, 1)],
    pedido_items: [
      { pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 3 },
      { pedido_id: 'p2', bolsa_id: BOLSA_1, cantidad: 2 },
    ],
  });
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 5);
});

test('getReservadoPendiente cuenta pedidos heredados sin pedido_items', async () => {
  const cliente = crearCliente({
    pedidos: [
      reserva('p-legacy', BOLSA_1, 2, 3),        // sin items → cuenta por bolsa_id
      reserva('p-legacy-viejo', BOLSA_1, 5, 40), // sin items y expirado → no cuenta
    ],
    pedido_items: [],
  });
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 2);
});

test('un pedido con items no se cuenta dos veces por su bolsa_id', async () => {
  const cliente = crearCliente({
    pedidos: [reserva('p1', BOLSA_1, 1, 1)],
    pedido_items: [{ pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 1 }],
  });
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 1,
    'pedido_items es la fuente primaria; bolsa_id solo cubre a los heredados');
});

test('solo cuentan los pedidos pendientes: pagados y cancelados no reservan', async () => {
  const pagado = { ...reserva('p-pagado', BOLSA_1, 1, 1), estado: 'confirmado', estado_pago: 'pagado' };
  const cancelado = { ...reserva('p-cancelado', BOLSA_1, 1, 1), estado: 'cancelado', estado_pago: 'fallido' };
  const cliente = crearCliente({
    pedidos: [pagado, cancelado, reserva('p-vivo', BOLSA_1, 1, 1)],
    pedido_items: [
      { pedido_id: 'p-pagado', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p-cancelado', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p-vivo', bolsa_id: BOLSA_1, cantidad: 1 },
    ],
  });
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 1);
});

test('excluirPedidoId deja fuera la propia reserva', async () => {
  const cliente = crearCliente({
    pedidos: [reserva('mio', BOLSA_1, 2, 1), reserva('ajeno', BOLSA_1, 1, 1)],
    pedido_items: [
      { pedido_id: 'mio', bolsa_id: BOLSA_1, cantidad: 2 },
      { pedido_id: 'ajeno', bolsa_id: BOLSA_1, cantidad: 1 },
    ],
  });
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 3);
  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA, excluirPedidoId: 'mio' }), 1);
});

test('si la columna reservado_at no existe todavía, se mide desde created_at', async () => {
  const cliente = crearCliente({
    pedidos: [
      { id: 'p-viva', bolsa_id: BOLSA_1, cantidad: 1, estado: 'pendiente', estado_pago: 'pendiente', created_at: haceMinutos(5) },
      { id: 'p-muerta', bolsa_id: BOLSA_1, cantidad: 1, estado: 'pendiente', estado_pago: 'pendiente', created_at: haceMinutos(45) },
    ],
    pedido_items: [],
  }, { sinColumnaReservadoAt: true });

  assert.equal(await getReservadoPendiente(BOLSA_1, { cliente, ahora: AHORA }), 1,
    'el despliegue previo a la migración sigue calculando disponibilidad');
});

test('getReservasMap aplica la misma vigencia y agrupa por bolsa', async () => {
  const cliente = crearCliente({
    pedidos: [
      reserva('p1', BOLSA_1, 1, 1),
      reserva('p2', BOLSA_2, 4, 3),
      reserva('p3', BOLSA_1, 9, 30),      // expirada
      reserva('p-legacy', BOLSA_2, 2, 2), // sin items
    ],
    pedido_items: [
      { pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'p2', bolsa_id: BOLSA_2, cantidad: 4 },
      { pedido_id: 'p3', bolsa_id: BOLSA_1, cantidad: 9 },
    ],
  });

  const mapa = await getReservasMap({ cliente, ahora: AHORA });
  assert.deepEqual(mapa, { [BOLSA_1]: 1, [BOLSA_2]: 6 });
});

test('catálogo y checkout obtienen exactamente el mismo número', async () => {
  const tablas = {
    pedidos: [reserva('p1', BOLSA_1, 2, 4), reserva('p2', BOLSA_1, 3, 25)],
    pedido_items: [
      { pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 2 },
      { pedido_id: 'p2', bolsa_id: BOLSA_1, cantidad: 3 },
    ],
  };
  const cliente = crearCliente(tablas);
  const bolsa = { id: BOLSA_1, cantidad_disponible: 10 };

  // Camino del detalle de catálogo (GET /bolsas/:id)
  const detalle = await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA });
  // Camino del feed (GET /bolsas) — pasa por getReservasMap
  const mapa = await getReservasMap({ cliente, ahora: AHORA });
  const feed = disponibilidadReal(bolsa.cantidad_disponible, mapa[BOLSA_1] || 0);

  assert.equal(detalle.disponible, 8, '10 en BD − 2 reservados vigentes (los 3 de hace 25 min expiraron)');
  assert.equal(feed, detalle.disponible, 'feed y detalle no pueden divergir');
  assert.equal(detalle.reservado, 2);
  assert.equal(detalle.enBaseDeDatos, 10);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Liberación: el stock vuelve en cuanto la reserva muere
// ════════════════════════════════════════════════════════════════════════════

test('al expirar la reserva, la disponibilidad se recupera en el mismo instante', async () => {
  const tablas = {
    pedidos: [reserva('p1', BOLSA_1, 3, 0)], // reservado justo ahora
    pedido_items: [{ pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 3 }],
  };
  const cliente = crearCliente(tablas);
  const bolsa = { id: BOLSA_1, cantidad_disponible: 3 };

  const alReservar = await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA });
  assert.equal(alReservar.disponible, 0, 'las 3 unidades quedan bloqueadas');

  // Un segundo antes de cumplirse el plazo: sigue bloqueado.
  const justoAntes = await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA + RESERVA_TTL_MS - 1000 });
  assert.equal(justoAntes.disponible, 0);

  // Al cumplirse: las 3 vuelven al catálogo sin que corra ningún cron ni se
  // toque una sola fila. La expiración es de lectura.
  const alExpirar = await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA + RESERVA_TTL_MS });
  assert.equal(alExpirar.disponible, 3, 'el stock se recupera solo, sin barrido previo');
});

test('al cancelarse el pedido, la disponibilidad se recupera de inmediato', async () => {
  const pedido = reserva('p1', BOLSA_1, 2, 1);
  const tablas = { pedidos: [pedido], pedido_items: [{ pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 2 }] };
  const cliente = crearCliente(tablas);
  const bolsa = { id: BOLSA_1, cantidad_disponible: 2 };

  assert.equal((await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA })).disponible, 0);

  // Lo que hace liberarInventarioPedido: mover el estado. No suma unidades a
  // `bolsas.cantidad_disponible` porque un pedido pendiente nunca las restó.
  pedido.estado = 'cancelado';
  pedido.estado_pago = 'fallido';

  assert.equal((await getDisponibilidadRealBolsa(bolsa, { cliente, ahora: AHORA })).disponible, 2,
    'cancelar libera la reserva implícita al instante');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. AC-03 — 10 clientes simultáneos, 3 unidades
//
// La RPC reservar_stock_pedido se reproduce aquí sobre un almacén en memoria
// con bloqueo de fila (cola FIFO por recurso) y lectura READ COMMITTED: al
// conceder el lock, la transacción re-lee lo que la anterior ya commiteó. Es la
// semántica de `SELECT … FOR UPDATE` que implementa la migración
// 202609121200; lo que se está probando es el CONTRATO de la reserva atómica.
// ════════════════════════════════════════════════════════════════════════════

function crearMotorReservas({ bolsas, pedidos, items, bloqueos = true }) {
  const db = {
    bolsas: new Map(bolsas.map((b) => [b.id, { ...b }])),
    pedidos: new Map(pedidos.map((p) => [p.id, { ...p }])),
    items: items.map((i) => ({ ...i })),
    locks: new Map(),
    esperas: 0,
  };

  async function conLock(clave, fn) {
    if (!bloqueos) { await new Promise((r) => setImmediate(r)); return fn(); }
    const cola = db.locks.get(clave);
    if (cola) {
      db.esperas += 1;
      await new Promise((resolver) => cola.push(resolver));
    } else {
      db.locks.set(clave, []);
    }
    try {
      return await fn();
    } finally {
      const siguiente = (db.locks.get(clave) || []).shift();
      if (siguiente) siguiente();
      else db.locks.delete(clave);
    }
  }

  function reservasVigentes(bolsaId, ttlMinutos, excluir, ahora) {
    const ttlMs = ttlMinutos * 60 * 1000;
    let total = 0;
    for (const p of db.pedidos.values()) {
      if (p.id === excluir) continue;
      if (p.estado !== 'pendiente' || p.estado_pago !== 'pendiente') continue;
      if (!reservaVigente(p, ahora, ttlMs)) continue;
      const suyos = db.items.filter((i) => i.pedido_id === p.id);
      if (suyos.length > 0) {
        total += suyos.filter((i) => i.bolsa_id === bolsaId).reduce((s, i) => s + i.cantidad, 0);
      } else if (p.bolsa_id === bolsaId) {
        total += p.cantidad || 1;
      }
    }
    return total;
  }

  // Transcripción de reservar_stock_pedido (migración 202609121200, BLOQUE 3)
  async function reservar({ p_pedido_id, p_ttl_minutos }, ahora) {
    return conLock(`pedidos:${p_pedido_id}`, async () => {
      const pedido = db.pedidos.get(p_pedido_id);
      if (!pedido) return { data: { resultado: 'pedido_no_encontrado' }, error: null };
      if (pedido.estado === 'pendiente') {
        return { data: { resultado: 'ya_reservado', pedido_id: p_pedido_id }, error: null };
      }
      if (pedido.estado !== 'borrador') {
        return { data: { resultado: 'estado_invalido', estado: pedido.estado }, error: null };
      }

      // Paso 3: agregar por bolsa, ORDER BY bolsa_id (orden de bloqueo determinista)
      const agregado = new Map();
      for (const i of db.items.filter((x) => x.pedido_id === p_pedido_id)) {
        agregado.set(i.bolsa_id, (agregado.get(i.bolsa_id) || 0) + i.cantidad);
      }
      if (agregado.size === 0 && pedido.bolsa_id) {
        agregado.set(pedido.bolsa_id, pedido.cantidad || 1);
      }
      const pares = [...agregado.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (pares.length === 0) return { data: { resultado: 'items_ausentes' }, error: null };

      // Paso 4: bloquear cada bolsa y verificar. RETURN al primer fallo.
      const verificar = async (idx) => {
        if (idx >= pares.length) return null;
        const [bolsaId, cantidad] = pares[idx];
        return conLock(`bolsas:${bolsaId}`, async () => {
          const bolsa = db.bolsas.get(bolsaId);
          if (!bolsa) return { resultado: 'bolsa_no_encontrada', bolsa_id: bolsaId };
          // READ COMMITTED: se re-lee con el lock ya concedido
          const reservado = reservasVigentes(bolsaId, p_ttl_minutos, p_pedido_id, ahora);
          const disponible = disponibilidadReal(bolsa.cantidad_disponible, reservado);
          if (disponible < cantidad) {
            return { resultado: 'stock_insuficiente', bolsa_id: bolsaId, disponible, solicitado: cantidad };
          }
          const fallo = await verificar(idx + 1);
          if (fallo) return fallo;
          // Paso 5: la reserva nace aquí, con las bolsas todavía bloqueadas.
          //
          // El await modela el viaje a la base que separa la comprobación de la
          // escritura — en la RPC real son sentencias distintas de la misma
          // transacción. Con el lock tomado da igual que otra tarea se cuele en
          // esa rendija; sin lock, es exactamente por donde entra la sobreventa.
          await new Promise((r) => setImmediate(r));
          pedido.estado = 'pendiente';
          pedido.reservado_at = new Date(ahora).toISOString();
          return null;
        });
      };

      const fallo = await verificar(0);
      if (fallo) return { data: fallo, error: null };
      return { data: { resultado: 'reservado', pedido_id: p_pedido_id }, error: null };
    });
  }

  return { db, reservar, reservasVigentes };
}

test('AC-03: 10 reservas simultáneas sobre 3 unidades → 3 reservan y 7 chocan', async () => {
  const pedidos = Array.from({ length: 10 }, (_, i) => ({
    id: `pedido-${i + 1}`,
    estado: 'borrador',
    estado_pago: 'pendiente',
    bolsa_id: BOLSA_1,
    cantidad: 1,
    created_at: haceMinutos(0),
    reservado_at: null,
  }));
  const items = pedidos.map((p) => ({ pedido_id: p.id, bolsa_id: BOLSA_1, cantidad: 1 }));

  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 3 }],
    pedidos,
    items,
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  // Los 10 checkouts salen a la vez
  const resultados = await Promise.all(
    pedidos.map((p) => reservarStockPedido(p.id, { cliente })),
  );

  const reservados = resultados.filter((r) => r.ok && r.tipo === 'reservado');
  const rechazados = resultados.filter((r) => !r.ok && r.tipo === 'stock_insuficiente');

  assert.equal(reservados.length, 3, 'exactamente 3 clientes se llevan las 3 unidades');
  assert.equal(rechazados.length, 7, 'los otros 7 reciben conflicto, no una reserva fantasma');
  assert.equal(resultados.length, reservados.length + rechazados.length,
    'ninguna llamada acaba en un estado distinto de reservado/sin stock');

  for (const r of rechazados) {
    assert.equal(r.status, 409);
    assert.equal(r.disponible, 0, 'el rechazado ve 0 disponibles, nunca un número negativo');
  }

  // Estado final de la base
  const pendientes = [...motor.db.pedidos.values()].filter((p) => p.estado === 'pendiente');
  assert.equal(pendientes.length, 3, 'solo 3 filas quedaron en pendiente');
  assert.equal([...motor.db.pedidos.values()].filter((p) => p.estado === 'borrador').length, 7);

  const reservadoFinal = motor.reservasVigentes(BOLSA_1, RESERVA_TTL_MINUTOS, null, AHORA);
  assert.equal(reservadoFinal, 3);
  assert.equal(disponibilidadReal(3, reservadoFinal), 0, 'stock real 0, jamás negativo');
  assert.ok(motor.db.esperas >= 1, 'hubo contención real de locks, no ejecución secuencial');

  // Todas las reservas ganadoras quedaron selladas con su instante
  for (const p of pendientes) {
    assert.ok(p.reservado_at, 'reservado_at es el reloj del TTL — no puede quedar nulo');
    assert.equal(reservaVigente(p, AHORA), true);
  }
});

test('AC-03 (control): sin el bloqueo de fila, las 10 reservan y hay sobreventa', async () => {
  const pedidos = Array.from({ length: 10 }, (_, i) => ({
    id: `pedido-${i + 1}`, estado: 'borrador', estado_pago: 'pendiente',
    bolsa_id: BOLSA_1, cantidad: 1, created_at: haceMinutos(0), reservado_at: null,
  }));
  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 3 }],
    pedidos,
    items: pedidos.map((p) => ({ pedido_id: p.id, bolsa_id: BOLSA_1, cantidad: 1 })),
    bloqueos: false,
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  const resultados = await Promise.all(pedidos.map((p) => reservarStockPedido(p.id, { cliente })));
  const reservados = resultados.filter((r) => r.ok).length;

  // Este es el comportamiento ANTERIOR a la migración: la comprobación en Node
  // no serializa nada. Se deja como prueba de que el test discrimina de verdad.
  assert.ok(reservados > 3,
    `sin FOR UPDATE se sobrevende (${reservados} reservas sobre 3 unidades); con lock son exactamente 3`);
});

test('AC-03 con carritos de 2 unidades: 1 reserva y el resto choca', async () => {
  const pedidos = Array.from({ length: 5 }, (_, i) => ({
    id: `pedido-${i + 1}`, estado: 'borrador', estado_pago: 'pendiente',
    bolsa_id: BOLSA_1, cantidad: 2, created_at: haceMinutos(0), reservado_at: null,
  }));
  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 3 }],
    pedidos,
    items: pedidos.map((p) => ({ pedido_id: p.id, bolsa_id: BOLSA_1, cantidad: 2 })),
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  const resultados = await Promise.all(pedidos.map((p) => reservarStockPedido(p.id, { cliente })));
  assert.equal(resultados.filter((r) => r.ok).length, 1, '3 unidades no dan para dos carritos de 2');
  const rechazado = resultados.find((r) => !r.ok);
  assert.equal(rechazado.disponible, 1);
  assert.equal(rechazado.solicitado, 2, 'el error dice cuánto había y cuánto se pedía');
});

test('una reserva expirada deja sitio a un checkout nuevo', async () => {
  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 1 }],
    pedidos: [
      { id: 'abandonado', estado: 'pendiente', estado_pago: 'pendiente', bolsa_id: BOLSA_1, cantidad: 1, created_at: haceMinutos(40), reservado_at: haceMinutos(40) },
      { id: 'nuevo', estado: 'borrador', estado_pago: 'pendiente', bolsa_id: BOLSA_1, cantidad: 1, created_at: haceMinutos(0), reservado_at: null },
    ],
    items: [
      { pedido_id: 'abandonado', bolsa_id: BOLSA_1, cantidad: 1 },
      { pedido_id: 'nuevo', bolsa_id: BOLSA_1, cantidad: 1 },
    ],
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  const r = await reservarStockPedido('nuevo', { cliente });
  assert.equal(r.ok, true);
  assert.equal(r.tipo, 'reservado',
    'la única unidad la bloqueaba una reserva de hace 40 min: ya no cuenta');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Contrato del envoltorio reservarStockPedido
// ════════════════════════════════════════════════════════════════════════════

test('reservarStockPedido traduce cada resultado de la RPC a un status HTTP', async () => {
  const casos = [
    [{ resultado: 'reservado' }, { ok: true, tipo: 'reservado', status: 200 }],
    [{ resultado: 'ya_reservado' }, { ok: true, tipo: 'ya_reservado', status: 200 }],
    [{ resultado: 'stock_insuficiente', bolsa_id: BOLSA_1, disponible: 0, solicitado: 1 }, { ok: false, tipo: 'stock_insuficiente', status: 409 }],
    [{ resultado: 'estado_invalido', estado: 'cancelado' }, { ok: false, tipo: 'estado_invalido', status: 409 }],
    [{ resultado: 'carrera' }, { ok: false, tipo: 'carrera', status: 409 }],
    [{ resultado: 'pedido_no_encontrado' }, { ok: false, tipo: 'pedido_no_encontrado', status: 404 }],
    [{ resultado: 'items_ausentes' }, { ok: false, tipo: 'items_ausentes', status: 422 }],
  ];

  for (const [respuesta, esperado] of casos) {
    const cliente = crearCliente({}, {
      rpc: { reservar_stock_pedido: async () => ({ data: respuesta, error: null }) },
    });
    const r = await reservarStockPedido('p1', { cliente });
    assert.equal(r.ok, esperado.ok, `ok para ${respuesta.resultado}`);
    assert.equal(r.tipo, esperado.tipo);
    assert.equal(r.status, esperado.status, `status para ${respuesta.resultado}`);
  }
});

// ── Fail-closed estricto ────────────────────────────────────────────────────
//
// El fallback `rpc_ausente` (comprobar en Node y marcar 'pendiente' a mano
// cuando la migración no estaba aplicada) se eliminó: era el TOCTOU que
// reservar_stock_pedido cierra, y devolvía la sobreventa por la puerta de
// atrás. Estas pruebas fijan que NO puede volver.

/** Ejecuta `fn` capturando las líneas de log estructurado (y silenciándolas). */
async function capturandoLogs(fn) {
  const lineas = [];
  const originales = { log: console.log, warn: console.warn, error: console.error };
  const capturar = (linea) => { lineas.push(linea); };
  console.log = capturar; console.warn = capturar; console.error = capturar;
  try {
    const valor = await fn();
    return { valor, lineas: lineas.map((l) => { try { return JSON.parse(l); } catch { return { crudo: l }; } }) };
  } finally {
    Object.assign(console, originales);
  }
}

test('si la RPC no está desplegada el checkout se corta con 503 — sin camino degradado', async () => {
  // Sin manejador registrado, el doble responde PGRST202 como PostgREST.
  const cliente = crearCliente({});
  const { valor: r, lineas } = await capturandoLogs(() => reservarStockPedido('p1', { cliente }));

  assert.equal(r.ok, false);
  assert.equal(r.status, 503, 'sin reserva atómica no se vende: 503, nunca una reserva a medias');
  assert.equal(r.tipo, 'error_bd',
    'no hay un tipo propio para "falta la migración": ninguna ruta puede ramificar para degradar');
  assert.equal(r.migracionPendiente, true, 'el diagnóstico viaja como dato, no como tipo');

  const log = lineas.find((l) => l.evento === 'reserva_atomica_no_disponible');
  assert.ok(log, 'la caída se registra en una línea estructurada, no en texto suelto');
  assert.equal(log.origen, 'stock');
  assert.equal(log.pedido_id, 'p1');
  assert.equal(log.migracion_pendiente, true);
  assert.match(log.accion, /202609121200/, 'el log dice exactamente qué hay que ejecutar');
});

test('un error de BD cualquiera también es 503 y nunca ok', async () => {
  const cliente = crearCliente({}, {
    rpc: {
      reservar_stock_pedido: async () => ({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }),
    },
  });
  const { valor: r, lineas } = await capturandoLogs(() => reservarStockPedido('p1', { cliente }));

  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'error_bd');
  assert.equal(r.status, 503);
  assert.equal(r.migracionPendiente, false, 'un timeout no es una migración pendiente');
  assert.equal(lineas.find((l) => l.evento === 'reserva_atomica_no_disponible')?.codigo, '57014');
});

test('si la RPC lanza, la reserva falla cerrada', async () => {
  const cliente = {
    from: () => { throw new Error('no debería consultarse nada'); },
    rpc: async () => { throw new Error('socket hang up'); },
  };
  const { valor: r } = await capturandoLogs(() => reservarStockPedido('p1', { cliente }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.tipo, 'error_bd');
});

test('un resultado que la RPC no documenta no se interpreta como reserva', async () => {
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: async () => ({ data: { resultado: 'algo_nuevo' }, error: null }) },
  });
  const { valor: r } = await capturandoLogs(() => reservarStockPedido('p1', { cliente }));
  assert.equal(r.ok, false, 'ante la duda no se reserva');
  assert.equal(r.status, 503);
  assert.equal(r.tipo, 'error_bd');
});

test('ningún resultado de reservarStockPedido puede volver a significar "sigue sin reservar"', async () => {
  // Contrato con las rutas: o hay reserva (ok:true) o hay error. No existe un
  // tercer estado del que routes/pagos.js pueda tirar para continuar igualmente.
  const respuestas = [
    { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.reservar_stock_pedido' } },
    { data: null, error: { code: '42883', message: 'function reservar_stock_pedido does not exist' } },
    { data: { resultado: 'estado_invalido', estado: 'cancelado' }, error: null },
    { data: { resultado: 'carrera' }, error: null },
    { data: {}, error: null },
  ];
  for (const respuesta of respuestas) {
    const cliente = crearCliente({}, { rpc: { reservar_stock_pedido: async () => respuesta } });
    const { valor: r } = await capturandoLogs(() => reservarStockPedido('p1', { cliente }));
    assert.equal(r.ok, false);
    assert.ok(r.status === 409 || r.status === 503, `status de corte para ${JSON.stringify(respuesta)}`);
    assert.notEqual(r.tipo, 'rpc_ausente', 'el tipo que habilitaba el fallback ya no existe');
  }
});

test('un pedido que ya no es borrador no puede reservar', async () => {
  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 5 }],
    pedidos: [{ id: 'p1', estado: 'cancelado', estado_pago: 'fallido', bolsa_id: BOLSA_1, cantidad: 1 }],
    items: [{ pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 1 }],
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  const r = await reservarStockPedido('p1', { cliente });
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'estado_invalido',
    'el barrido pudo cancelarlo mientras se generaba el link de pago');
});

test('reservar dos veces el mismo pedido es idempotente', async () => {
  const motor = crearMotorReservas({
    bolsas: [{ id: BOLSA_1, cantidad_disponible: 1 }],
    pedidos: [{ id: 'p1', estado: 'borrador', estado_pago: 'pendiente', bolsa_id: BOLSA_1, cantidad: 1, created_at: haceMinutos(0), reservado_at: null }],
    items: [{ pedido_id: 'p1', bolsa_id: BOLSA_1, cantidad: 1 }],
  });
  const cliente = crearCliente({}, {
    rpc: { reservar_stock_pedido: (params) => motor.reservar(params, AHORA) },
  });

  const primera = await reservarStockPedido('p1', { cliente });
  const segunda = await reservarStockPedido('p1', { cliente });

  assert.equal(primera.tipo, 'reservado');
  assert.equal(segunda.tipo, 'ya_reservado', 'un reintento no consume una segunda unidad');
  assert.equal(segunda.ok, true);
  assert.equal(motor.reservasVigentes(BOLSA_1, RESERVA_TTL_MINUTOS, null, AHORA), 1);
});
