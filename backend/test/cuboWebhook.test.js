const test = require('node:test');
const assert = require('node:assert/strict');
const {
  procesarWebhookCubo, validarWebhookCubo, esReintentoDeUnPagoYaRegistrado,
  normalizarEstadoCubo, ESTADOS_FALLIDO,
} = require('../services/cuboWebhook');

// ════════════════════════════════════════════════════════════════════════════
// Dobles de prueba
//
// Todas las dependencias de procesarWebhookCubo se inyectan, así que estas
// pruebas no abren conexiones, no llaman a Cubo y no tocan la base de datos.
// El doble de Supabase reproduce lo que importa del cliente real:
//   · buscarPedido hace DOS selects (el segundo pide las columnas cubo_*)
//   · el UPDATE con .neq() no afecta la fila si la condición no se cumple
//   · .rpc() devuelve una promesa encadenable con .then() y .catch()
// ════════════════════════════════════════════════════════════════════════════

const PEDIDO_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN     = 'tok_cubo_abc123';

// confirmar_pago_cubo reproducida: bloquea la fila, comprueba idempotencia y,
// solo si no estaba pagada, descuenta stock y la marca. Es el punto donde el
// PostgreSQL real serializa con FOR UPDATE.
function rpcConfirmarPagoCubo(params, st) {
  if (!st.pedido) return { data: { resultado: 'pedido_no_encontrado' }, error: null };
  if (st.pedido.estado_pago === 'pagado') return { data: { resultado: 'duplicado' }, error: null };
  st.pedido.estado_pago      = 'pagado';
  st.pedido.estado           = 'confirmado';
  st.pedido.cubo_identifier  = params.p_cubo_identifier;
  st.vecesStockDescontado   += 1;
  return { data: { resultado: 'procesado', codigo_recogida: 'BOC-8842' }, error: null };
}

function crearEntorno({ pedido = null, rpc = {}, consulta, errorConsulta = null, columnasCuboFaltan = false } = {}) {
  const st = {
    pedido: pedido ? { ...pedido } : null,
    updates: [],
    rpcLlamadas: [],
    liberaciones: [],
    vecesStockDescontado: 0,
    vecesStockLiberado: 0,
    vecesConsultaCubo: 0,
    vecesEventos: 0,
  };

  function consultaPedidos() {
    const q = { campos: '', payload: null, excluir: null };
    q.select = (campos) => { q.campos = campos || ''; return q; };
    q.update = (p) => { q.payload = p; return q; };
    q.eq = () => q;
    q.neq = (campo, valor) => { q.excluir = { campo, valor }; return q; };
    q.single = () => ejecutar(q);
    q.maybeSingle = () => ejecutar(q);
    q.then = (resolver, rechazar) => ejecutar(q).then(resolver, rechazar);
    return q;
  }

  async function ejecutar(q) {
    if (q.payload) {
      st.updates.push({ payload: q.payload, excluir: q.excluir });
      if (!st.pedido) return { data: null, error: null };
      // .neq('estado_pago','pagado') → no afecta la fila si ya está pagada
      if (q.excluir && st.pedido[q.excluir.campo] === q.excluir.valor) {
        return { data: null, error: null };
      }
      Object.assign(st.pedido, q.payload);
      return { data: null, error: null };
    }
    if (!st.pedido) return { data: null, error: null };
    // Segundo select de buscarPedido: solo las columnas de verificación Cubo
    if (q.campos.includes('cubo_payment_intent_token')) {
      if (columnasCuboFaltan) {
        return { data: null, error: { message: 'column "cubo_payment_intent_token" does not exist' } };
      }
      return {
        data: {
          cubo_payment_intent_token: st.pedido.cubo_payment_intent_token ?? null,
          monto_esperado_centavos:   st.pedido.monto_esperado_centavos ?? null,
        },
        error: null,
      };
    }
    const { cubo_payment_intent_token, monto_esperado_centavos, ...resto } = st.pedido;
    return { data: resto, error: null };
  }

  const supabase = {
    from: () => consultaPedidos(),
    rpc: (nombre, params) => {
      st.rpcLlamadas.push({ nombre, params });
      const manejador = rpc[nombre];
      const salida = typeof manejador === 'function'
        ? manejador(params, st)
        : (manejador ?? { data: null, error: null });
      return Promise.resolve(salida);
    },
  };

  const deps = {
    supabase,
    monedaEsperada: 'GTQ',
    consultarTransaccionCubo: async () => {
      st.vecesConsultaCubo += 1;
      if (errorConsulta) throw errorConsulta;
      return consulta;
    },
    procesarEventosPedido: async () => { st.vecesEventos += 1; },
    // Reproduce el compare-and-swap de services/stock.js: solo la primera
    // llamada encuentra el pedido en un estado cancelable y devuelve stock.
    liberarInventarioPedido: async (pedidoId, opciones) => {
      st.liberaciones.push({ pedidoId, opciones });
      if (!st.pedido) return { ok: false, tipo: 'no_encontrado', status: 404 };
      if (st.pedido.estado === 'cancelado') {
        return { ok: true, tipo: 'ya_cancelado', status: 200, stockDevuelto: false };
      }
      const cobrado = st.pedido.estado_pago === 'pagado';
      st.pedido.estado = 'cancelado';
      if (cobrado) st.vecesStockLiberado += 1;
      return { ok: true, tipo: 'cancelado', status: 200, stockDevuelto: cobrado };
    },
  };

  return { st, deps };
}

const pedidoPendiente = () => ({
  id: PEDIDO_ID,
  codigo_recogida: 'BOC-8842',
  estado: 'pendiente',
  estado_pago: 'pendiente',
  usuario_id: 'usr-1',
  negocio_id: 'neg-1',
  bolsa_id: 'bolsa-1',
  cantidad: 2,
  total: 50,
  cubo_payment_intent_token: TOKEN,
  monto_esperado_centavos: 5000,
});

const consultaSucceeded = () => ({
  status: 'SUCCEEDED',
  paymentIntentToken: TOKEN,
  currency: 'GTQ',
  amount: '50.00',
});

const webhook = (status, extra = {}) => ({
  status,
  identifier: TOKEN,
  referenceId: 'ref-1',
  authorizationCode: 'auth-1',
  processedAt: '2026-09-11T10:00:00Z',
  metadata: { orderId: PEDIDO_ID },
  ...extra,
});

// Captura las líneas de log estructurado y silencia la salida.
async function capturandoLogs(fn) {
  const lineas = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const captura = (l) => { try { lineas.push(JSON.parse(l)); } catch { /* no estructurada */ } };
  console.log = captura; console.warn = captura; console.error = captura;
  try {
    const resultado = await fn();
    return { resultado, lineas };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. SUCCEEDED — idempotencia absoluta
// ════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED tres veces seguidas: el stock se descuenta una sola vez', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  const respuestas = [];
  await capturandoLogs(async () => {
    for (let i = 0; i < 3; i++) {
      respuestas.push(await procesarWebhookCubo(webhook('SUCCEEDED'), deps));
    }
  });

  // Las tres entregas se confirman a Cubo: ninguna debe provocar reintentos.
  assert.deepEqual(respuestas.map(r => r.statusCode), [200, 200, 200]);

  // La primera procesa; las dos siguientes son no-ops declarados.
  assert.equal(respuestas[0].tipo, 'procesado');
  assert.equal(respuestas[1].tipo, 'duplicado');
  assert.equal(respuestas[2].tipo, 'duplicado');

  // Lo que de verdad importa: el inventario se movió una vez.
  assert.equal(st.vecesStockDescontado, 1, 'el stock se descontó más de una vez');

  // Y la transacción no se duplicó: confirmar_pago_cubo solo se invocó en la primera.
  const confirmaciones = st.rpcLlamadas.filter(r => r.nombre === 'confirmar_pago_cubo');
  assert.equal(confirmaciones.length, 1, 'la RPC de confirmación se llamó más de una vez');

  // El pedido quedó confirmado y pagado.
  assert.equal(st.pedido.estado, 'confirmado');
  assert.equal(st.pedido.estado_pago, 'pagado');
});

test('un reintento de SUCCEEDED no vuelve a llamar a la API de Cubo', async () => {
  // Antes, cada reintento salía a la red ANTES de comprobar idempotencia. Si
  // Cubo estaba caído en ese momento se devolvía 502 y Cubo reintentaba en
  // bucle un cobro ya cerrado.
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  await capturandoLogs(async () => {
    await procesarWebhookCubo(webhook('SUCCEEDED'), deps);
    await procesarWebhookCubo(webhook('SUCCEEDED'), deps);
    await procesarWebhookCubo(webhook('SUCCEEDED'), deps);
  });

  assert.equal(st.vecesConsultaCubo, 1, 'los reintentos siguen consultando a Cubo');
});

test('un duplicado responde 200 aunque Cubo esté caído', async () => {
  const { st, deps } = crearEntorno({
    pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pagado' },
    errorConsulta: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.tipo, 'duplicado');
  assert.equal(st.vecesConsultaCubo, 0);
  assert.equal(st.vecesStockDescontado, 0);
});

test('el duplicado sí reintenta los eventos post-pago que quedaron pendientes', async () => {
  // Reintentar la cola NO es re-disparar eventos: solo toma los que siguen en
  // 'pendiente' y los reclama con un CAS. Es el mecanismo de recuperación de
  // una notificación que falló en el primer intento.
  const { st, deps } = crearEntorno({
    pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pagado' },
    consulta: consultaSucceeded(),
  });

  await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));
  assert.equal(st.vecesEventos, 1);
});

test('un SUCCEEDED con OTRO token sobre un pedido pagado NO se toma por duplicado', async () => {
  // Es un segundo cobro sobre el mismo pedido, no un reintento. Tiene que
  // llegar al 409 para que quede visible en vez de confirmarse en silencio.
  const { st, deps } = crearEntorno({
    pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pagado' },
    consulta: { status: 'SUCCEEDED', paymentIntentToken: 'tok_OTRO', currency: 'GTQ', amount: '50.00' },
  });

  const { resultado } = await capturandoLogs(
    () => procesarWebhookCubo(webhook('SUCCEEDED', { identifier: 'tok_OTRO' }), deps));

  assert.equal(resultado.statusCode, 409);
  assert.equal(st.vecesStockDescontado, 0);
});

test('esReintentoDeUnPagoYaRegistrado exige pedido pagado Y token coincidente', () => {
  const base = { estado_pago: 'pagado', cubo_payment_intent_token: TOKEN };
  assert.equal(esReintentoDeUnPagoYaRegistrado(base, TOKEN), true);
  assert.equal(esReintentoDeUnPagoYaRegistrado(base, 'otro'), false);
  assert.equal(esReintentoDeUnPagoYaRegistrado({ ...base, estado_pago: 'pendiente' }, TOKEN), false);
  assert.equal(esReintentoDeUnPagoYaRegistrado({ ...base, cubo_payment_intent_token: null }, TOKEN), false);
  assert.equal(esReintentoDeUnPagoYaRegistrado({ ...base, _cuboColumnsMissing: true }, TOKEN), false);
  assert.equal(esReintentoDeUnPagoYaRegistrado(null, TOKEN), false);
});

test('dos webhooks simultáneos: la RPC serializa y solo uno descuenta stock', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  const { resultado: ambas } = await capturandoLogs(() => Promise.all([
    procesarWebhookCubo(webhook('SUCCEEDED'), deps),
    procesarWebhookCubo(webhook('SUCCEEDED'), deps),
  ]));

  assert.deepEqual(ambas.map(r => r.statusCode), [200, 200]);
  assert.equal(st.vecesStockDescontado, 1);
  assert.equal(ambas.filter(r => r.tipo === 'procesado').length, 1);
  assert.equal(ambas.filter(r => r.tipo === 'duplicado').length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. REJECTED / FAILED / DECLINED — el rechazo se registra y libera la reserva
// ════════════════════════════════════════════════════════════════════════════

test('REJECTED libera la reserva de inventario y marca el pedido', async () => {
  const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('REJECTED'), deps));

  assert.equal(resultado.statusCode, 200);
  assert.equal(resultado.tipo, 'rechazado');

  // La liberación pasa por liberarInventarioPedido, no por un UPDATE suelto.
  assert.equal(st.liberaciones.length, 1);
  assert.equal(st.liberaciones[0].pedidoId, PEDIDO_ID);
  assert.equal(st.liberaciones[0].opciones.canceladoPor, 'sistema');
  assert.match(st.liberaciones[0].opciones.motivo, /rechazado por Cubo/);

  // El pedido queda cancelado y con el pago marcado como fallido.
  assert.equal(st.pedido.estado, 'cancelado');
  assert.equal(st.pedido.estado_pago, 'fallido');

  // Y se libera la reserva del cupón.
  assert.ok(st.rpcLlamadas.some(r => r.nombre === 'liberar_reserva_cupon'));
});

test('REJECTED repetido: la reserva se libera una sola vez', async () => {
  const { st, deps } = crearEntorno({
    pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pendiente' },
  });

  const respuestas = [];
  await capturandoLogs(async () => {
    for (let i = 0; i < 3; i++) respuestas.push(await procesarWebhookCubo(webhook('REJECTED'), deps));
  });

  assert.deepEqual(respuestas.map(r => r.statusCode), [200, 200, 200]);
  assert.deepEqual(respuestas.map(r => r.liberacion), ['cancelado', 'ya_cancelado', 'ya_cancelado']);
  assert.equal(st.pedido.estado, 'cancelado');
});

test('un rechazo nunca se ignora en silencio: queda registrado', async () => {
  const { deps } = crearEntorno({ pedido: pedidoPendiente() });
  const { lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook('REJECTED'), deps));

  const registro = lineas.find(l => l.evento === 'pago_rechazado_registrado');
  assert.ok(registro, 'el rechazo no quedó registrado');
  assert.equal(registro.pedido_id, PEDIDO_ID);
  assert.equal(registro.status, 'REJECTED');
});

test('REJECTED que llega tarde NO cancela un pedido ya cobrado', async () => {
  const { st, deps } = crearEntorno({
    pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pagado' },
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('REJECTED'), deps));

  assert.equal(resultado.statusCode, 200);
  assert.equal(st.liberaciones.length, 0, 'se intentó liberar inventario de un pedido pagado');
  assert.equal(st.pedido.estado, 'confirmado');
  assert.equal(st.pedido.estado_pago, 'pagado');
});

test('si la liberación falla se responde 503 para que Cubo reintente', async () => {
  const { deps } = crearEntorno({ pedido: pedidoPendiente() });
  deps.liberarInventarioPedido = async () => ({ ok: false, tipo: 'error_bd', status: 503, detalle: 'sin conexión' });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('REJECTED'), deps));

  assert.equal(resultado.statusCode, 503);
});

// ────────────────────────────────────────────────────────────────────────────
// 2b. Equivalencia REJECTED ≡ FAILED ≡ DECLINED
//
// Cubo documenta REJECTED, pero contratos y pasarelas emiten también FAILED y
// DECLINED para el mismo hecho (no hubo cargo). Los tres deben entrar por la
// misma rama y producir exactamente el mismo resultado observable.
// ────────────────────────────────────────────────────────────────────────────

const ESTADOS_RECHAZO = ['REJECTED', 'FAILED', 'DECLINED'];

test('normalizarEstadoCubo agrupa REJECTED, FAILED y DECLINED como "fallido"', () => {
  for (const estado of ESTADOS_RECHAZO) {
    assert.ok(ESTADOS_FALLIDO.has(estado), `${estado} no está en ESTADOS_FALLIDO`);
    assert.deepEqual(normalizarEstadoCubo(estado), { raw: estado, estado: 'fallido' });
    // tolera minúsculas y espacios: los payloads reales no son uniformes
    assert.deepEqual(normalizarEstadoCubo(`  ${estado.toLowerCase()} `), { raw: estado, estado: 'fallido' });
  }
  assert.deepEqual(normalizarEstadoCubo('SUCCEEDED'), { raw: 'SUCCEEDED', estado: 'aprobado' });
  for (const otro of ['PENDING', 'REFUNDED', 'CANCELLED', '', null, undefined]) {
    assert.equal(normalizarEstadoCubo(otro).estado, 'desconocido', String(otro));
  }
});

test('validarWebhookCubo acepta FAILED y DECLINED igual que REJECTED, sin exigir monto ni token', () => {
  for (const estado of ESTADOS_RECHAZO) {
    const r = validarWebhookCubo({ body: webhook(estado), pedido: null, consulta: null, monedaEsperada: 'GTQ' });
    assert.equal(r.ok, true, estado);
    assert.equal(r.statusCode, 200, estado);
    assert.equal(r.tipo, 'fallido', estado);
    assert.equal(r.status, estado);
  }
});

for (const estado of ESTADOS_RECHAZO) {
  test(`${estado} libera la reserva de inventario vía liberarInventarioPedido y marca el pedido`, async () => {
    const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });

    const { resultado, lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook(estado), deps));

    assert.equal(resultado.statusCode, 200);
    assert.equal(resultado.tipo, 'rechazado');
    assert.equal(resultado.status, estado);
    assert.equal(resultado.liberacion, 'cancelado');

    // Exactamente una liberación, por el liberador idempotente, con auditoría del estado crudo.
    assert.equal(st.liberaciones.length, 1);
    assert.equal(st.liberaciones[0].pedidoId, PEDIDO_ID);
    assert.equal(st.liberaciones[0].opciones.canceladoPor, 'sistema');
    assert.match(st.liberaciones[0].opciones.motivo, /rechazado por Cubo/);
    assert.match(st.liberaciones[0].opciones.motivo, new RegExp(`status:${estado}`));

    assert.equal(st.pedido.estado, 'cancelado');
    assert.equal(st.pedido.estado_pago, 'fallido');
    assert.ok(st.rpcLlamadas.some(r => r.nombre === 'liberar_reserva_cupon'));

    // Nunca se consulta a Cubo ni se descuenta stock por un rechazo.
    assert.equal(st.vecesConsultaCubo, 0);
    assert.equal(st.vecesStockDescontado, 0);

    // Log estructurado con el estado crudo y el normalizado.
    const registro = lineas.find(l => l.evento === 'pago_rechazado_registrado');
    assert.ok(registro, 'el rechazo no quedó registrado');
    assert.equal(registro.pedido_id, PEDIDO_ID);
    assert.equal(registro.status, estado);
    assert.equal(registro.estado_normalizado, 'fallido');
    const recibido = lineas.find(l => l.evento === 'recibido');
    assert.equal(recibido.estado_normalizado, 'fallido');
  });

  test(`${estado} repetido: la reserva se libera una sola vez`, async () => {
    const { st, deps } = crearEntorno({
      pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pendiente' },
    });

    const respuestas = [];
    await capturandoLogs(async () => {
      for (let i = 0; i < 3; i++) respuestas.push(await procesarWebhookCubo(webhook(estado), deps));
    });

    assert.deepEqual(respuestas.map(r => r.statusCode), [200, 200, 200]);
    assert.deepEqual(respuestas.map(r => r.liberacion), ['cancelado', 'ya_cancelado', 'ya_cancelado']);
    assert.equal(st.liberaciones.length, 3, 'cada reintento pasa por el liberador idempotente');
    assert.equal(st.pedido.estado, 'cancelado');
  });

  test(`${estado} que llega tarde NO cancela un pedido ya cobrado`, async () => {
    const { st, deps } = crearEntorno({
      pedido: { ...pedidoPendiente(), estado: 'confirmado', estado_pago: 'pagado' },
    });

    const { resultado, lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook(estado), deps));

    assert.equal(resultado.statusCode, 200);
    assert.match(resultado.warning, new RegExp(`${estado} ignorado`));
    assert.equal(st.liberaciones.length, 0, 'se intentó liberar inventario de un pedido pagado');
    assert.equal(st.pedido.estado, 'confirmado');
    assert.equal(st.pedido.estado_pago, 'pagado');
    assert.equal(lineas.find(l => l.evento === 'rechazo_sobre_pedido_pagado_ignorado')?.status, estado);
  });

  test(`${estado}: si la liberación falla se responde 503 para que Cubo reintente`, async () => {
    const { deps } = crearEntorno({ pedido: pedidoPendiente() });
    deps.liberarInventarioPedido = async () => ({ ok: false, tipo: 'error_bd', status: 503, detalle: 'sin conexión' });

    const { resultado, lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook(estado), deps));

    assert.equal(resultado.statusCode, 503);
    assert.equal(lineas.find(l => l.evento === 'liberacion_inventario_fallo')?.status, estado);
  });
}

test('REJECTED, FAILED y DECLINED producen exactamente el mismo resultado observable', async () => {
  const ejecutar = async (estado) => {
    const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });
    const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook(estado), deps));
    const { status, ...resto } = resultado;
    return {
      resultado: resto,
      pedido: { estado: st.pedido.estado, estado_pago: st.pedido.estado_pago },
      liberaciones: st.liberaciones.map(l => ({ pedidoId: l.pedidoId, canceladoPor: l.opciones.canceladoPor })),
      rpcs: st.rpcLlamadas.map(r => r.nombre),
    };
  };
  const [rejected, failed, declined] = await Promise.all(ESTADOS_RECHAZO.map(ejecutar));
  assert.deepEqual(failed, rejected);
  assert.deepEqual(declined, rejected);
});

test('el estado de rechazo se normaliza aunque llegue en minúsculas o con espacios', async () => {
  const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });
  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('  failed '), deps));
  assert.equal(resultado.tipo, 'rechazado');
  assert.equal(resultado.status, 'FAILED');
  assert.equal(st.liberaciones.length, 1);
  assert.equal(st.pedido.estado, 'cancelado');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Payloads corruptos y estados desconocidos
// ════════════════════════════════════════════════════════════════════════════

const payloadsInvalidos = [
  ['sin identifier',          { status: 'SUCCEEDED', metadata: { orderId: PEDIDO_ID } }],
  ['sin metadata.orderId',    { status: 'SUCCEEDED', identifier: TOKEN }],
  ['sin metadata',            { status: 'SUCCEEDED', identifier: TOKEN, metadata: undefined }],
  ['objeto vacío',            {}],
  ['metadata no es objeto',   { status: 'SUCCEEDED', identifier: TOKEN, metadata: 'no-soy-un-objeto' }],
  ['identifier vacío',        { status: 'SUCCEEDED', identifier: '', metadata: { orderId: PEDIDO_ID } }],
];

for (const [descripcion, cuerpo] of payloadsInvalidos) {
  test(`payload inválido (${descripcion}) responde 400 sin tocar la BD`, async () => {
    const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });

    const { resultado } = await capturandoLogs(() => procesarWebhookCubo(cuerpo, deps));

    assert.equal(resultado.statusCode, 400);
    assert.match(resultado.error, /payload incompleto/);

    // Nada de red, nada de escrituras, nada de RPC.
    assert.equal(st.vecesConsultaCubo, 0);
    assert.equal(st.updates.length, 0);
    assert.equal(st.rpcLlamadas.length, 0);
    assert.equal(st.liberaciones.length, 0);
    assert.equal(st.vecesStockDescontado, 0);
    assert.deepEqual(st.pedido, pedidoPendiente(), 'el pedido fue modificado');
  });
}

test('un payload inválido no tumba el proceso y queda logueado de forma estructurada', async () => {
  const { deps } = crearEntorno({ pedido: pedidoPendiente() });
  const { resultado, lineas } = await capturandoLogs(
    () => procesarWebhookCubo({ status: 'SUCCEEDED' }, deps));

  assert.equal(resultado.statusCode, 400);
  const registro = lineas.find(l => l.evento === 'payload_invalido');
  assert.ok(registro, 'no se registró payload_invalido');
  assert.deepEqual(registro.faltan, ['identifier', 'metadata.orderId']);
  assert.equal(registro.origen, 'cubo_webhook');
});

test('procesarWebhookCubo tolera que no le pasen cuerpo', async () => {
  const { deps } = crearEntorno({ pedido: pedidoPendiente() });
  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(undefined, deps));
  assert.equal(resultado.statusCode, 400);
});

test('un estado no documentado por Cubo responde 200 y no altera nada', async () => {
  for (const estado of ['PENDING', 'REFUNDED', 'CHARGEBACK', 'lo-que-sea', '']) {
    const { st, deps } = crearEntorno({ pedido: pedidoPendiente() });
    const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook(estado), deps));

    // 200 a propósito: no es un error del emisor, y así Cubo no reintenta en bucle.
    assert.equal(resultado.statusCode, 200, `estado ${estado}`);
    assert.equal(st.updates.length, 0);
    assert.equal(st.vecesConsultaCubo, 0);
    assert.equal(st.vecesStockDescontado, 0);
  }
});

test('un estado desconocido queda registrado para poder detectarlo', async () => {
  const { deps } = crearEntorno({ pedido: pedidoPendiente() });
  const { lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook('REFUNDED'), deps));

  const registro = lineas.find(l => l.evento === 'estado_desconocido');
  assert.ok(registro);
  assert.equal(registro.status, 'REFUNDED');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Fail-closed: sin verificación no se cobra
// ════════════════════════════════════════════════════════════════════════════

test('si no se puede consultar a Cubo se responde 502 y no se escribe nada', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    errorConsulta: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  // 502 para que Cubo reintente — el pago puede ser bueno, solo no pudimos verificarlo.
  assert.equal(resultado.statusCode, 502);
  assert.equal(st.vecesStockDescontado, 0);
  assert.equal(st.pedido.estado_pago, 'pendiente');
});

test('si Cubo no conoce la transacción se responde 409 sin cobrar', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    errorConsulta: Object.assign(new Error('no existe'), { code: 'NOT_FOUND' }),
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 409);
  assert.equal(st.vecesStockDescontado, 0);
});

test('un monto que no coincide no confirma el pedido', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),                     // espera 5000¢
    consulta: { ...consultaSucceeded(), amount: '5.00' },  // llegan 500¢
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 409);
  assert.equal(st.vecesStockDescontado, 0);
  assert.equal(st.pedido.estado_pago, 'pendiente');
});

test('una moneda distinta de la esperada no confirma el pedido', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: { ...consultaSucceeded(), currency: 'USD' },
    rpc: { confirmar_pago_cubo: rpcConfirmarPagoCubo },
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 409);
  assert.equal(st.vecesStockDescontado, 0);
});

test('sin CUBO_CURRENCY configurada no se procesa ningún pago', async () => {
  const { st, deps } = crearEntorno({ pedido: pedidoPendiente(), consulta: consultaSucceeded() });
  deps.monedaEsperada = '';

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 503);
  assert.equal(st.vecesStockDescontado, 0);
});

test('si faltan las columnas de verificación Cubo se falla cerrado', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    columnasCuboFaltan: true,
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 503);
  assert.equal(st.vecesStockDescontado, 0);
});

test('un orderId que no es UUID no llega a la base de datos', async () => {
  const { st, deps } = crearEntorno({ pedido: pedidoPendiente(), consulta: consultaSucceeded() });

  const { resultado } = await capturandoLogs(
    () => procesarWebhookCubo(webhook('SUCCEEDED', { metadata: { orderId: 'no-es-uuid' } }), deps));

  // Sin pedido que verificar, validarWebhookCubo corta con 200 sin escribir.
  assert.equal(resultado.statusCode, 200);
  assert.equal(st.vecesStockDescontado, 0);
  assert.equal(st.updates.length, 0);
});

test('si la RPC de confirmación falla se responde 503 para reintentar', async () => {
  const { st, deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    rpc: { confirmar_pago_cubo: () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }) },
  });

  const { resultado } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 503);
  assert.equal(st.pedido.estado_pago, 'pendiente');
});

test('stock insuficiente con el pago ya cobrado se marca para intervención manual', async () => {
  const { deps } = crearEntorno({
    pedido: pedidoPendiente(),
    consulta: consultaSucceeded(),
    rpc: { confirmar_pago_cubo: () => ({ data: { resultado: 'stock_insuficiente', bolsa_id: 'bolsa-1' }, error: null }) },
  });

  const { resultado, lineas } = await capturandoLogs(() => procesarWebhookCubo(webhook('SUCCEEDED'), deps));

  assert.equal(resultado.statusCode, 409);
  const registro = lineas.find(l => l.evento === 'stock_insuficiente_con_pago_cobrado');
  assert.ok(registro);
  assert.equal(registro.accion, 'intervencion_manual');
});
