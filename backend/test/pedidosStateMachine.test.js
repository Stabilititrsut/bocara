const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ESTADOS,
  ESTADOS_TERMINALES,
  TRANSICIONES,
  TRANSICIONES_OPERATIVAS,
  ERRORES,
  puedeTransicionar,
  validarTransicion,
  validarConfirmacionPago,
  esTerminal,
  transicionesDesde,
  estadosCancelables,
  requiereDevolucionDeStock,
} = require('../services/orderStateMachine');

// Prueba de pago verificada: cubo_payment_intent_token y cubo_identifier solo se
// escriben juntos dentro de la RPC confirmar_pago_cubo, después de que el
// webhook consultó a Cubo por su cuenta.
const PAGADO = { cubo_payment_intent_token: 'tok_abc', cubo_identifier: 'tok_abc' };
const REEMBOLSO = {
  monto_reembolsado:    35.5,
  referencia_reembolso: 'TRX-90210',
  fecha_reembolso:      '2026-09-11',
};

// ════════════════════════════════════════════════════════════════════════════
// REGLA CRÍTICA — 'pendiente' nunca llega directo a 'confirmado'
// ════════════════════════════════════════════════════════════════════════════

test('pendiente NO puede pasar directamente a confirmado', () => {
  assert.equal(puedeTransicionar('pendiente', 'confirmado', { pedido: PAGADO }), false);
});

test('el rechazo de pendiente → confirmado usa el contrato TRANSICION_INVALIDA', () => {
  const r = validarTransicion('pendiente', 'confirmado');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRANSICION_INVALIDA');
  assert.equal(r.status, 400);
  assert.match(r.detalle, /Transición prohibida/);
  assert.match(r.detalle, /pagado/);
});

test('pendiente → confirmado sigue prohibido aunque el pago esté verificado', () => {
  // La prohibición es estructural, no condicional: ni con la prueba de pago en
  // la mano se salta el paso por 'pagado'.
  const r = validarTransicion('pendiente', 'confirmado', { pedido: PAGADO, pagoVerificado: true });
  assert.equal(r.ok, false);
  assert.match(r.detalle, /Transición prohibida/);
});

test('borrador tampoco puede saltar a confirmado ni a pagado', () => {
  assert.equal(puedeTransicionar('borrador', 'confirmado', { pagoVerificado: true }), false);
  assert.equal(puedeTransicionar('borrador', 'pagado', { pagoVerificado: true }), false);
});

test('la matriz canónica no declara la arista pendiente → confirmado', () => {
  // Cinturón sobre el tirante: si alguien la añadiera a la matriz, este test
  // cae antes de que llegue a producción.
  assert.equal(TRANSICIONES.pendiente.includes('confirmado'), false);
  assert.equal(TRANSICIONES_OPERATIVAS.pendiente.includes('confirmado'), false);
});

test('el único camino hasta confirmado pasa por pagado', () => {
  const via = validarConfirmacionPago('pendiente', { pagoVerificado: true });
  assert.equal(via.ok, true);
  assert.equal(via.nuevoEstado, 'confirmado');
  assert.equal(via.via, 'pagado');
});

test('validarConfirmacionPago rechaza si no hay prueba de pago', () => {
  const r = validarConfirmacionPago('pendiente', {});
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.PAGO_NO_VERIFICADO);
});

test('validarConfirmacionPago acepta un pedido que ya está en pagado', () => {
  assert.equal(validarConfirmacionPago('pagado', { pedido: PAGADO }).ok, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Transiciones válidas
// ════════════════════════════════════════════════════════════════════════════

test('pendiente avanza a pagado con verificación de Cubo', () => {
  assert.equal(puedeTransicionar('pendiente', 'pagado', { pedido: PAGADO }), true);
});

test('pagado avanza a confirmado, cancelado y reembolsado', () => {
  assert.equal(puedeTransicionar('pagado', 'confirmado', { pedido: PAGADO }), true);
  assert.equal(puedeTransicionar('pagado', 'cancelado'), true);
  assert.equal(puedeTransicionar('pagado', 'reembolsado', { reembolso: REEMBOLSO }), true);
});

test('confirmado avanza a completado, cancelado y reembolsado', () => {
  assert.equal(puedeTransicionar('confirmado', 'completado'), true);
  assert.equal(puedeTransicionar('confirmado', 'cancelado'), true);
  assert.equal(puedeTransicionar('confirmado', 'reembolsado', { reembolso: REEMBOLSO }), true);
});

test('el tramo operativo del restaurante sigue funcionando', () => {
  // confirmado → en_preparacion → listo → completado es el flujo real del panel.
  assert.equal(puedeTransicionar('confirmado', 'en_preparacion'), true);
  assert.equal(puedeTransicionar('en_preparacion', 'listo'), true);
  assert.equal(puedeTransicionar('listo', 'completado'), true);
});

test('listo solo puede avanzar a completado; no puede cancelarse automáticamente', () => {
  assert.deepEqual(transicionesDesde('listo'), ['completado']);
  assert.equal(puedeTransicionar('listo', 'completado'), true);

  const r = validarTransicion('listo', 'cancelado');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRANSICION_INVALIDA');
  assert.equal(r.status, 400);
  assert.deepEqual(r.transicionesPermitidas, ['completado']);
});

test('borrador solo avanza a pendiente o cancelado', () => {
  assert.deepEqual(transicionesDesde('borrador'), ['pendiente', 'cancelado']);
});

// ════════════════════════════════════════════════════════════════════════════
// Transiciones inválidas
// ════════════════════════════════════════════════════════════════════════════

test('no se puede retroceder de confirmado a pendiente', () => {
  const r = validarTransicion('confirmado', 'pendiente');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRANSICION_INVALIDA');
});

test('no se puede saltar de pendiente directo a completado', () => {
  assert.equal(puedeTransicionar('pendiente', 'completado'), false);
});

test('no se puede saltar de en_preparacion a completado sin pasar por listo', () => {
  assert.equal(puedeTransicionar('en_preparacion', 'completado'), false);
});

test('un estado desconocido se rechaza en vez de adivinarse', () => {
  const origen = validarTransicion('entregando', 'completado');
  assert.equal(origen.ok, false);
  assert.equal(origen.codigo, ERRORES.ESTADO_DESCONOCIDO);

  const destino = validarTransicion('confirmado', 'archivado');
  assert.equal(destino.ok, false);
  assert.equal(destino.codigo, ERRORES.ESTADO_DESCONOCIDO);
});

test('quedarse en el mismo estado no es una transición', () => {
  const r = validarTransicion('confirmado', 'confirmado');
  assert.equal(r.ok, false);
  assert.match(r.detalle, /ya está en estado/);
});

test('el rechazo informa qué transiciones sí eran posibles', () => {
  const r = validarTransicion('en_preparacion', 'completado');
  assert.deepEqual(r.transicionesPermitidas, ['listo', 'cancelado', 'reembolsado']);
});

// ── Condiciones ─────────────────────────────────────────────────────────────

test('confirmar sin prueba de pago de Cubo se rechaza con PAGO_NO_VERIFICADO', () => {
  const r = validarTransicion('pagado', 'confirmado', { pedido: {} });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.PAGO_NO_VERIFICADO);
});

test('estado_pago=pagado por sí solo no es prueba de pago suficiente', () => {
  // El webhook legacy de PayU y la ruta retirada /pedidos/crear escribían
  // estado_pago='pagado' sin verificar que el dinero se hubiera movido.
  const r = validarTransicion('pagado', 'confirmado', { pedido: { estado_pago: 'pagado' } });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.PAGO_NO_VERIFICADO);
});

test('un token de Cubo sin identifier no basta para confirmar', () => {
  const r = validarTransicion('pagado', 'confirmado', {
    pedido: { cubo_payment_intent_token: 'tok_abc' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.PAGO_NO_VERIFICADO);
});

test('reembolsar sin registrar el reembolso se rechaza', () => {
  const r = validarTransicion('confirmado', 'reembolsado');
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.REEMBOLSO_NO_REGISTRADO);
});

test('un reembolso incompleto no alcanza', () => {
  const r = validarTransicion('confirmado', 'reembolsado', {
    reembolso: { monto_reembolsado: 35.5, referencia_reembolso: 'TRX-90210' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.REEMBOLSO_NO_REGISTRADO);
});

test('omitirCondiciones valida solo la forma de la matriz', () => {
  assert.equal(
    puedeTransicionar('pagado', 'confirmado', { omitirCondiciones: true }),
    true,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Estados terminales — un pedido cerrado no se revive
// ════════════════════════════════════════════════════════════════════════════

test('cancelado, completado, recogido y reembolsado son terminales', () => {
  for (const estado of ESTADOS_TERMINALES) {
    assert.equal(esTerminal(estado), true, `${estado} debería ser terminal`);
    assert.deepEqual(transicionesDesde(estado), [], `${estado} no debería tener salidas`);
  }
});

test('un pedido cancelado no se puede revivir a ningún estado', () => {
  for (const destino of ESTADOS.filter((e) => e !== 'cancelado')) {
    const r = validarTransicion('cancelado', destino, { pedido: PAGADO, reembolso: REEMBOLSO });
    assert.equal(r.ok, false, `cancelado → ${destino} no debería permitirse`);
    assert.equal(r.codigo, ERRORES.ESTADO_TERMINAL);
    assert.equal(r.status, 400);
  }
});

test('un pedido completado no se puede descompletar ni cancelar', () => {
  assert.equal(puedeTransicionar('completado', 'cancelado'), false);
  assert.equal(puedeTransicionar('completado', 'confirmado', { pedido: PAGADO }), false);
  assert.equal(validarTransicion('completado', 'cancelado').codigo, ERRORES.ESTADO_TERMINAL);
});

test('un pedido reembolsado no vuelve a confirmado', () => {
  const r = validarTransicion('reembolsado', 'confirmado', { pedido: PAGADO });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.ESTADO_TERMINAL);
});

test('recogido (nombre legacy de completado) también es terminal', () => {
  assert.equal(puedeTransicionar('recogido', 'cancelado'), false);
  assert.equal(validarTransicion('recogido', 'completado').codigo, ERRORES.ESTADO_TERMINAL);
});

test('ningún estado terminal aparece como origen con salidas en la matriz', () => {
  for (const [origen, destinos] of Object.entries(TRANSICIONES_OPERATIVAS)) {
    if (esTerminal(origen)) {
      assert.deepEqual(destinos, [], `la matriz da salidas al estado terminal ${origen}`);
    }
  }
});

test('toda transición declarada apunta a un estado que la matriz conoce', () => {
  for (const [origen, destinos] of Object.entries(TRANSICIONES_OPERATIVAS)) {
    for (const destino of destinos) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(TRANSICIONES_OPERATIVAS, destino),
        `${origen} → ${destino}: el destino no existe en la matriz`,
      );
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Idempotencia de la cancelación
// ════════════════════════════════════════════════════════════════════════════

test('estadosCancelables no incluye ningún estado terminal', () => {
  for (const estado of estadosCancelables()) {
    assert.equal(esTerminal(estado), false, `${estado} es terminal y no debería ser cancelable`);
  }
});

test('un pedido no cobrado libera su reserva sin devolver unidades', () => {
  // 'borrador' y 'pendiente' solo ocupan una reserva implícita: services/stock.js
  // los cuenta como reservados sin que nadie haya tocado cantidad_disponible.
  // Sumar unidades ahí duplicaría el stock.
  assert.equal(requiereDevolucionDeStock('borrador'), false);
  assert.equal(requiereDevolucionDeStock('pendiente'), false);
});

test('un pedido ya cobrado sí devuelve unidades al cancelarse', () => {
  // A partir de confirmar_pago_cubo, cantidad_disponible ya fue descontada.
  assert.equal(requiereDevolucionDeStock('pagado'), true);
  assert.equal(requiereDevolucionDeStock('confirmado'), true);
  assert.equal(requiereDevolucionDeStock('en_preparacion'), true);
});

// ── liberarInventarioPedido contra un doble de Supabase ─────────────────────
//
// El doble reproduce lo que importa del cliente real: el UPDATE con
// `.in('estado', …)` solo afecta la fila si su estado sigue dentro de esa lista,
// y devuelve null cuando no coincide nada. Ese compare-and-swap es exactamente
// lo que hace que la liberación ocurra una sola vez.

function crearSupabaseFalso({ pedido, items = [], bolsas = {} }) {
  const estado = {
    pedido: { ...pedido },
    bolsas: { ...bolsas },
    updatesDePedido: 0,
    sumasDeStock: [],
  };

  // Cada consulta acumula lo que se le encadena y se resuelve al await — sea
  // por `.maybeSingle()` o por await directo sobre la consulta (supabase-js
  // permite las dos formas, y liberarInventarioPedido usa ambas).
  function consulta(tabla) {
    const q = { tabla, payload: null, estadosAceptados: null, id: null };
    q.select = () => q;
    q.update = (p) => { q.payload = p; return q; };
    q.eq = (campo, valor) => { if (campo === 'id') q.id = valor; return q; };
    q.in = (_campo, valores) => { q.estadosAceptados = valores; return q; };
    q.maybeSingle = () => ejecutar(q);
    q.then = (resolver, rechazar) => ejecutar(q).then(resolver, rechazar);
    return q;
  }

  async function ejecutar(q) {
    if (q.tabla === 'pedidos') {
      if (!q.payload) return { data: estado.pedido, error: null };
      // El corazón del compare-and-swap: si el estado actual ya no está en la
      // lista del .in(), el UPDATE no afecta ninguna fila y devuelve null.
      if (q.estadosAceptados && !q.estadosAceptados.includes(estado.pedido.estado)) {
        return { data: null, error: null };
      }
      estado.pedido = { ...estado.pedido, ...q.payload };
      estado.updatesDePedido += 1;
      return { data: { id: estado.pedido.id }, error: null };
    }

    if (q.tabla === 'pedido_items') return { data: items, error: null };

    if (q.tabla === 'bolsas') {
      if (!q.payload) {
        const disponible = estado.bolsas[q.id];
        return {
          data: disponible == null ? null : { cantidad_disponible: disponible },
          error: null,
        };
      }
      estado.bolsas[q.id] = q.payload.cantidad_disponible;
      estado.sumasDeStock.push({ bolsaId: q.id, nuevo: q.payload.cantidad_disponible });
      return { data: null, error: null };
    }

    throw new Error(`tabla no simulada: ${q.tabla}`);
  }

  return { cliente: { from: consulta }, estado };
}

test('cancelar dos veces un pedido cobrado devuelve el stock una sola vez', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-1', estado: 'confirmado', estado_pago: 'pagado', bolsa_id: 'bolsa-1', cantidad: 2 },
    items: [{ bolsa_id: 'bolsa-1', cantidad: 2 }],
    bolsas: { 'bolsa-1': 5 },
  });

  const primera = await liberarInventarioPedido('ped-1', { cliente, canceladoPor: 'admin' });
  assert.equal(primera.ok, true);
  assert.equal(primera.tipo, 'cancelado');
  assert.equal(primera.stockDevuelto, true);
  assert.equal(estado.bolsas['bolsa-1'], 7);

  const segunda = await liberarInventarioPedido('ped-1', { cliente, canceladoPor: 'admin' });
  assert.equal(segunda.ok, true, 'la segunda llamada no es un error, es un no-op');
  assert.equal(segunda.tipo, 'ya_cancelado');
  assert.equal(segunda.stockDevuelto, false);

  assert.equal(estado.bolsas['bolsa-1'], 7, 'el stock se duplicó en la segunda cancelación');
  assert.equal(estado.sumasDeStock.length, 1, 'la devolución de stock corrió más de una vez');
});

test('un tercer y cuarto reintento tampoco mueven el stock', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-2', estado: 'en_preparacion', estado_pago: 'pagado', bolsa_id: 'bolsa-2', cantidad: 1 },
    items: [{ bolsa_id: 'bolsa-2', cantidad: 1 }],
    bolsas: { 'bolsa-2': 0 },
  });

  // Cubo reintenta sus webhooks: cuatro entregas del mismo evento.
  for (let i = 0; i < 4; i++) {
    const r = await liberarInventarioPedido('ped-2', { cliente, canceladoPor: 'sistema' });
    assert.equal(r.ok, true);
  }
  assert.equal(estado.bolsas['bolsa-2'], 1);
  assert.equal(estado.sumasDeStock.length, 1);
});

test('dos cancelaciones simultáneas: solo la que gana el CAS devuelve stock', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  // Las dos llamadas leen el pedido en 'confirmado' antes de que ninguna
  // escriba — la ventana exacta que el chequeo inicial de estado NO cubre. Lo
  // que salva aquí es el `.in('estado', …)` del UPDATE: la segunda no encuentra
  // fila y no llega a tocar el stock.
  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-carrera', estado: 'confirmado', estado_pago: 'pagado', bolsa_id: 'bolsa-c', cantidad: 2 },
    items: [{ bolsa_id: 'bolsa-c', cantidad: 2 }],
    bolsas: { 'bolsa-c': 1 },
  });

  const [a, b] = await Promise.all([
    liberarInventarioPedido('ped-carrera', { cliente, canceladoPor: 'admin' }),
    liberarInventarioPedido('ped-carrera', { cliente, canceladoPor: 'sistema' }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const devolvieron = [a, b].filter((r) => r.stockDevuelto === true);
  assert.equal(devolvieron.length, 1, 'exactamente una de las dos debe devolver stock');
  assert.equal(estado.bolsas['bolsa-c'], 3);
  assert.equal(estado.sumasDeStock.length, 1);
  assert.equal(estado.updatesDePedido, 1, 'el pedido solo debe cancelarse una vez');
});

test('cancelar un pedido sin cobrar no suma unidades', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-3', estado: 'pendiente', estado_pago: 'pendiente', bolsa_id: 'bolsa-3', cantidad: 3 },
    items: [{ bolsa_id: 'bolsa-3', cantidad: 3 }],
    bolsas: { 'bolsa-3': 4 },
  });

  const r = await liberarInventarioPedido('ped-3', { cliente, canceladoPor: 'sistema' });
  assert.equal(r.ok, true);
  assert.equal(r.tipo, 'cancelado');
  assert.equal(r.stockDevuelto, false);
  assert.equal(estado.bolsas['bolsa-3'], 4, 'la reserva implícita no debe sumarse al stock');
  assert.equal(estado.sumasDeStock.length, 0);
});

test('no se cancela un pedido en estado terminal', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-4', estado: 'completado', estado_pago: 'pagado', bolsa_id: 'bolsa-4', cantidad: 1 },
    items: [{ bolsa_id: 'bolsa-4', cantidad: 1 }],
    bolsas: { 'bolsa-4': 2 },
  });

  const r = await liberarInventarioPedido('ped-4', { cliente });
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'transicion_invalida');
  assert.equal(r.codigo, ERRORES.ESTADO_TERMINAL);
  assert.equal(estado.bolsas['bolsa-4'], 2);
  assert.equal(estado.updatesDePedido, 0, 'no debió tocarse la fila del pedido');
});

test('la política general no cancela un pedido listo ni devuelve stock', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-listo', estado: 'listo', estado_pago: 'pagado', bolsa_id: 'bolsa-listo', cantidad: 1 },
    items: [{ bolsa_id: 'bolsa-listo', cantidad: 1 }],
    bolsas: { 'bolsa-listo': 0 },
  });

  const r = await liberarInventarioPedido('ped-listo', { cliente });
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'transicion_invalida');
  assert.equal(r.error, 'TRANSICION_INVALIDA');
  assert.equal(estado.pedido.estado, 'listo');
  assert.equal(estado.bolsas['bolsa-listo'], 0);
  assert.equal(estado.sumasDeStock.length, 0);
  assert.equal(estado.updatesDePedido, 0, 'no debió tocarse la fila del pedido');
});

test('estadosPermitidos no permite eludir el bloqueo de un pedido listo', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  // Soporte no cancela pedidos ya 'listo': el cliente puede estar en la puerta.
  const { cliente, estado } = crearSupabaseFalso({
    pedido: { id: 'ped-5', estado: 'listo', estado_pago: 'pagado', bolsa_id: 'bolsa-5', cantidad: 1 },
    items: [{ bolsa_id: 'bolsa-5', cantidad: 1 }],
    bolsas: { 'bolsa-5': 0 },
  });

  const r = await liberarInventarioPedido('ped-5', {
    cliente,
    estadosPermitidos: ['confirmado', 'en_preparacion'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, ERRORES.TRANSICION_INVALIDA);
  assert.equal(estado.bolsas['bolsa-5'], 0);
  assert.equal(estado.updatesDePedido, 0);
});

test('un pedido inexistente devuelve 404 sin tocar stock', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const cliente = {
    from: () => ({
      select: function () { return this; },
      eq: function () { return this; },
      maybeSingle: async () => ({ data: null, error: null }),
    }),
  };

  const r = await liberarInventarioPedido('ped-inexistente', { cliente });
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'no_encontrado');
  assert.equal(r.status, 404);
});

test('un fallo de BD al leer responde 503 controlado, no una excepción', async () => {
  const { liberarInventarioPedido } = require('../services/stock');

  const cliente = {
    from: () => ({
      select: function () { return this; },
      eq: function () { return this; },
      maybeSingle: async () => { throw new Error('connection terminated unexpectedly'); },
    }),
  };

  const r = await liberarInventarioPedido('ped-6', { cliente });
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'error_bd');
  assert.equal(r.status, 503);
});
