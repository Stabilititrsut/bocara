// El cliente por defecto se resuelve al usarlo, no al importar este módulo: así
// quien inyecta su propio cliente (las pruebas, vía la opción `cliente`) puede
// cargar services/stock.js sin que config/supabase intente abrir una conexión.
let _supabase = null;
function supabasePorDefecto() {
  if (!_supabase) _supabase = require('../config/supabase');
  return _supabase;
}

const {
  validarTransicion,
  puedeTransicionar,
  estadosCancelables,
  requiereDevolucionDeStock,
} = require('./orderStateMachine');

// ── Log estructurado ────────────────────────────────────────────────────────
//
// Una línea JSON por decisión, con el mismo juego de campos siempre — mismo
// formato que services/cuboWebhook.js. El checkout y el webhook son las dos
// mitades de la misma historia (se reservó / se cobró) y en los logs de Render
// se leen juntos filtrando por `pedido_id`.
function registrar(nivel, evento, datos = {}) {
  const linea = JSON.stringify({
    ts: new Date().toISOString(),
    origen: 'stock',
    evento,
    ...datos,
  });
  if (nivel === 'error') console.error(linea);
  else if (nivel === 'warn') console.warn(linea);
  else console.log(linea);
}

// ── Reservas con expiración ─────────────────────────────────────────────────
//
// Un pedido en 'pendiente' (link de pago abierto, sin cobrar) es una RESERVA
// implícita: no descuenta `bolsas.cantidad_disponible` —eso solo lo hace
// confirmar_pago_cubo— pero sí se resta al calcular la disponibilidad real.
//
// Hasta la migración 202609121200 esa resta no caducaba nunca: quien abría el
// link de Cubo y cerraba la pestaña dejaba la unidad bloqueada indefinidamente.
// A partir de aquí una reserva vive RESERVA_TTL_MINUTOS y después deja de
// contar. La expiración es de LECTURA: el stock vuelve a estar disponible en el
// mismo instante en que se cumple el plazo, sin depender de ningún cron. El
// barrido (RPC expirar_reservas_vencidas) solo pone al día la columna `estado`
// para que el panel no muestre reservas zombis.
const RESERVA_TTL_MINUTOS = 15;
const RESERVA_TTL_MS = RESERVA_TTL_MINUTOS * 60 * 1000;

/**
 * Instante en que nació la reserva.
 *
 * `reservado_at` lo escribe reservar_stock_pedido al pasar a 'pendiente'.
 * `created_at` es el respaldo para pedidos anteriores a la migración y para el
 * flujo POST /pagos/cubopago heredado, que insertaba directamente en
 * 'pendiente' (ahí ambos instantes coinciden).
 */
function instanteReserva(pedido) {
  return pedido?.reservado_at || pedido?.created_at || null;
}

/**
 * ¿Esta reserva sigue bloqueando stock?
 *
 * Sin marca temporal utilizable se responde que SÍ. Es la decisión fail-closed:
 * ante un dato incompleto se prefiere no vender de más. Un pedido con fecha
 * ilegible bloquea una unidad hasta que alguien lo cancele — molesto, pero
 * infinitamente más barato que cobrar una bolsa que no existe.
 */
function reservaVigente(pedido, ahora = Date.now(), ttlMs = RESERVA_TTL_MS) {
  const marca = instanteReserva(pedido);
  if (!marca) return true;
  const ms = Date.parse(marca);
  if (Number.isNaN(ms)) return true;
  // Estrictamente menor: a los 15:00 exactos la reserva ya expiró.
  return (ahora - ms) < ttlMs;
}

/**
 * ¿Esta reserva todavía habilita un COBRO?
 *
 * Misma ventana que reservaVigente y la decisión contraria ante un dato
 * ilegible, porque el riesgo también es el contrario:
 *
 *   · reservaVigente  → ¿libero stock?  Sin fecha utilizable: NO (sigue viva).
 *   · reservaPagable  → ¿confirmo pago? Sin fecha utilizable: NO (se da por vencida).
 *
 * Las dos son la misma decisión fail-closed vista desde sus dos lados: ante un
 * dato incompleto, nunca vender de más. Confirmar un pago cuya vigencia no se
 * puede demostrar es exactamente lo que produce la sobreventa que AC-03
 * prohíbe; el cliente recupera su dinero, pero la bolsa no se duplica.
 *
 * Su gemela en SQL es la puerta del paso 6 de confirmar_pago_cubo (migración
 * 202609141200), que aplica la misma regla con la fila bloqueada.
 */
function reservaPagable(pedido, ahora = Date.now(), ttlMs = RESERVA_TTL_MS) {
  const marca = instanteReserva(pedido);
  if (!marca) return false;
  const ms = Date.parse(marca);
  if (Number.isNaN(ms)) return false;
  return (ahora - ms) < ttlMs;
}

/**
 * LA fórmula de disponibilidad real. Único sitio donde se resta.
 *
 * Catálogo (GET /bolsas, GET /bolsas/:id) y checkout (POST /pagos/cubopago,
 * /preparar, /generar-link) la comparten: antes cada uno repetía
 * `Math.max(0, cantidad_disponible - reservado)` por su cuenta y ya habían
 * empezado a divergir en el casteo y en los mensajes de error.
 *
 * Su gemela en SQL es disponibilidad_real_bolsa() — misma regla, para que el
 * chequeo de Node y el de la RPC no puedan contradecirse.
 */
function disponibilidadReal(cantidadDisponible, reservado) {
  const disp = Number(cantidadDisponible);
  const res = Number(reservado);
  return Math.max(
    0,
    (Number.isFinite(disp) ? disp : 0) - (Number.isFinite(res) ? res : 0),
  );
}

/**
 * SELECT tolerante a que `reservado_at` no exista todavía.
 *
 * La columna llega en la migración 202609121200 y este código puede desplegarse
 * antes de que se aplique. PostgREST devuelve error 42703 al pedir una columna
 * inexistente, así que se reintenta sin ella y el cálculo cae a `created_at`.
 * Mismo criterio que la cancelación con columnas de auditoría, más abajo.
 */
async function pedidosConMarcaDeReserva(construir, campos) {
  const { data, error } = await construir(`${campos}, reservado_at`);
  if (!error) return data || [];
  console.warn('[STOCK] reservado_at no disponible, se usa created_at:', error.message);
  const { data: sinColumna } = await construir(campos);
  return sinColumna || [];
}

/**
 * Unidades de `bolsaId` bloqueadas por reservas VIGENTES.
 *
 * Modelo híbrido:
 *   · fuente primaria : pedido_items (carritos multi-bolsa)
 *   · fuente heredada : pedidos.bolsa_id, solo si el pedido no tiene items
 *     (así un mismo pedido nunca se cuenta dos veces)
 *
 * @param {string} bolsaId
 * @param {object} [opciones]
 *   @param {object} [opciones.cliente]         cliente Supabase (inyectable en pruebas)
 *   @param {number} [opciones.ahora]           epoch ms, para pruebas deterministas
 *   @param {number} [opciones.ttlMs]           ventana de vigencia
 *   @param {string} [opciones.excluirPedidoId] no contar este pedido (el propio)
 */
async function getReservadoPendiente(bolsaId, opciones = {}) {
  const cliente = opciones.cliente || supabasePorDefecto();
  const ahora = opciones.ahora ?? Date.now();
  const ttlMs = opciones.ttlMs ?? RESERVA_TTL_MS;
  const excluir = opciones.excluirPedidoId || null;

  const { data: piRows } = await cliente
    .from('pedido_items')
    .select('pedido_id, cantidad')
    .eq('bolsa_id', bolsaId);

  const pedidoIdsFromItems = [...new Set((piRows || []).map(r => r.pedido_id))];
  let fromItems = 0;

  if (pedidoIdsFromItems.length > 0) {
    const pedsPend = await pedidosConMarcaDeReserva(
      (campos) => cliente
        .from('pedidos')
        .select(campos)
        .in('id', pedidoIdsFromItems)
        .eq('estado', 'pendiente')
        .eq('estado_pago', 'pendiente'),
      'id, created_at',
    );
    const vigentes = new Set(
      pedsPend
        .filter(p => p.id !== excluir && reservaVigente(p, ahora, ttlMs))
        .map(p => p.id),
    );
    fromItems = (piRows || [])
      .filter(r => vigentes.has(r.pedido_id))
      .reduce((sum, r) => sum + (r.cantidad || 0), 0);
  }

  // Pedidos heredados: bolsa_id directo, sin fila en pedido_items
  const leg = await pedidosConMarcaDeReserva(
    (campos) => {
      let q = cliente
        .from('pedidos')
        .select(campos)
        .eq('bolsa_id', bolsaId)
        .eq('estado', 'pendiente')
        .eq('estado_pago', 'pendiente');
      if (pedidoIdsFromItems.length > 0) {
        q = q.not('id', 'in', `(${pedidoIdsFromItems.join(',')})`);
      }
      return q;
    },
    'id, cantidad, created_at',
  );
  const fromLegacy = leg
    .filter(p => p.id !== excluir && reservaVigente(p, ahora, ttlMs))
    .reduce((sum, p) => sum + (p.cantidad || 1), 0);

  return fromItems + fromLegacy;
}

/**
 * { bolsaId → reservado vigente } para TODAS las bolsas, en dos consultas.
 * Lo usa el feed de bolsas, que no puede permitirse una consulta por fila.
 * Misma regla de vigencia que getReservadoPendiente.
 */
async function getReservasMap(opciones = {}) {
  const cliente = opciones.cliente || supabasePorDefecto();
  const ahora = opciones.ahora ?? Date.now();
  const ttlMs = opciones.ttlMs ?? RESERVA_TTL_MS;

  const todos = await pedidosConMarcaDeReserva(
    (campos) => cliente
      .from('pedidos')
      .select(campos)
      .eq('estado', 'pendiente')
      .eq('estado_pago', 'pendiente'),
    'id, bolsa_id, cantidad, created_at',
  );

  const pedsPend = todos.filter(p => reservaVigente(p, ahora, ttlMs));
  if (pedsPend.length === 0) return {};

  const { data: piRows } = await cliente
    .from('pedido_items')
    .select('pedido_id, bolsa_id, cantidad')
    .in('pedido_id', pedsPend.map(p => p.id));

  const pedidoIdsConItems = new Set((piRows || []).map(r => r.pedido_id));
  const reservaMap = {};

  for (const r of piRows || []) {
    reservaMap[r.bolsa_id] = (reservaMap[r.bolsa_id] || 0) + (r.cantidad || 0);
  }

  for (const p of pedsPend) {
    if (!pedidoIdsConItems.has(p.id) && p.bolsa_id) {
      reservaMap[p.bolsa_id] = (reservaMap[p.bolsa_id] || 0) + (p.cantidad || 1);
    }
  }

  return reservaMap;
}

/**
 * Disponibilidad real de UNA bolsa ya leída de la BD.
 * Punto de entrada único para catálogo y checkout.
 *
 * @param {{id: string, cantidad_disponible: number}} bolsa
 * @returns {Promise<{ disponible: number, reservado: number, enBaseDeDatos: number }>}
 */
async function getDisponibilidadRealBolsa(bolsa, opciones = {}) {
  const reservado = await getReservadoPendiente(bolsa.id, opciones);
  return {
    disponible: disponibilidadReal(bolsa.cantidad_disponible, reservado),
    reservado,
    enBaseDeDatos: Number(bolsa.cantidad_disponible) || 0,
  };
}

/**
 * Convierte un borrador en reserva ('borrador' → 'pendiente') de forma atómica.
 *
 * Delega en la RPC reservar_stock_pedido, que bloquea las bolsas con FOR UPDATE
 * antes de contar. Es lo que hace que 10 checkouts simultáneos sobre 3 unidades
 * terminen en 3 reservas y 7 conflictos (AC-03) en vez de en 10 reservas y una
 * sobreventa que solo se descubre al cobrar.
 *
 * Comprobar la disponibilidad desde Node NO sustituye a esta llamada: entre el
 * SELECT y el UPDATE no hay nada que impida que otro cliente se cuele.
 *
 * FAIL-CLOSED ESTRICTO: si la RPC no existe, falla o devuelve algo que no
 * entendemos, esto responde 503 y punto. No hay camino alternativo. Ver
 * fallaDeReserva.
 *
 * @returns {Promise<{ ok: boolean, tipo: string, status: number, ... }>}
 *   tipo: 'reservado' | 'ya_reservado' | 'stock_insuficiente' | 'estado_invalido'
 *       | 'pedido_no_encontrado' | 'items_ausentes' | 'bolsa_no_encontrada'
 *       | 'carrera' | 'error_bd'
 */
async function reservarStockPedido(pedidoId, opciones = {}) {
  const cliente = opciones.cliente || supabasePorDefecto();
  const ttlMinutos = opciones.ttlMinutos ?? RESERVA_TTL_MINUTOS;

  let data;
  let error;
  try {
    ({ data, error } = await cliente.rpc('reservar_stock_pedido', {
      p_pedido_id: pedidoId,
      p_ttl_minutos: ttlMinutos,
    }));
  } catch (err) {
    return fallaDeReserva(pedidoId, { detalle: err.message, codigo: err.code ?? null });
  }

  if (error) {
    return fallaDeReserva(pedidoId, {
      detalle: error.message,
      codigo: error.code ?? null,
      migracionPendiente: rpcNoDesplegada(error),
    });
  }

  const resultado = data?.resultado;

  switch (resultado) {
    case 'reservado':
    case 'ya_reservado':
      return { ok: true, tipo: resultado, status: 200, pedidoId, detalle: data };

    case 'stock_insuficiente':
      return {
        ok: false,
        tipo: 'stock_insuficiente',
        status: 409,
        pedidoId,
        bolsaId: data.bolsa_id,
        disponible: data.disponible,
        solicitado: data.solicitado,
        detalle: data,
      };

    case 'estado_invalido':
    case 'carrera':
      return { ok: false, tipo: resultado, status: 409, pedidoId, detalle: data };

    case 'pedido_no_encontrado':
      return { ok: false, tipo: resultado, status: 404, pedidoId, detalle: data };

    case 'items_ausentes':
    case 'bolsa_no_encontrada':
    case 'parametro_invalido':
      return { ok: false, tipo: resultado, status: 422, pedidoId, detalle: data };

    default:
      // Un resultado que este código no sabe interpretar tampoco se degrada:
      // no reservar es la única respuesta segura.
      return fallaDeReserva(pedidoId, {
        detalle: `resultado inesperado de reservar_stock_pedido: ${JSON.stringify(data)}`,
      });
  }
}

/** ¿El error dice que reservar_stock_pedido no está desplegada? */
function rpcNoDesplegada(error) {
  return error.code === 'PGRST202'
    || error.code === '42883'
    || /reservar_stock_pedido/i.test(error.message || '');
}

/**
 * Único final para toda falla de la reserva atómica: 503, sin alternativa.
 *
 * Hasta AC-03 este camino distinguía `rpc_ausente` (migración sin aplicar) para
 * que las rutas cayeran a "comprobar en Node y hacer el UPDATE a mano". Ese
 * fallback ERA exactamente el TOCTOU que reservar_stock_pedido vino a cerrar:
 * sin FOR UPDATE, la lectura de disponibilidad y la escritura del pedido
 * vuelven a ser dos operaciones separadas y 10 checkouts simultáneos reservan
 * 10 unidades sobre 3. Que la migración falte no es una excusa para reabrirlo:
 * sin reserva atómica no se vende.
 *
 * El diagnóstico (¿falta la migración? ¿se cayó la BD?) va al log estructurado,
 * no a un `tipo` que alguna ruta pueda usar para degradar el checkout.
 */
function fallaDeReserva(pedidoId, { detalle, codigo = null, migracionPendiente = false }) {
  registrar('error', 'reserva_atomica_no_disponible', {
    pedido_id: pedidoId,
    codigo,
    detalle,
    migracion_pendiente: migracionPendiente,
    accion: migracionPendiente
      ? 'aplicar migración 202609121200 (crea reservar_stock_pedido)'
      : 'revisar disponibilidad de la base de datos',
  });
  return { ok: false, tipo: 'error_bd', status: 503, detalle, pedidoId, migracionPendiente };
}

/**
 * Devuelve las unidades que un pedido ocupa, por bolsa: { bolsaId → cantidad }.
 * Mismo modelo híbrido que getReservadoPendiente — pedido_items primero, y
 * pedidos.bolsa_id solo si el pedido es legacy y no tiene items.
 */
async function unidadesDePedido(pedido, cliente = supabasePorDefecto()) {
  const { data: items } = await cliente
    .from('pedido_items')
    .select('bolsa_id, cantidad')
    .eq('pedido_id', pedido.id);

  if (items && items.length > 0) {
    const mapa = {};
    for (const it of items) {
      if (!it.bolsa_id) continue;
      mapa[it.bolsa_id] = (mapa[it.bolsa_id] || 0) + (it.cantidad || 0);
    }
    return mapa;
  }

  if (!pedido.bolsa_id) return {};
  return { [pedido.bolsa_id]: pedido.cantidad || 1 };
}

/**
 * Cancela un pedido liberando su inventario EXACTAMENTE UNA VEZ.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────
 * La cancelación se dispara desde sitios distintos (soporte vía
 * PATCH /pedidos/:id/cancelar, el webhook de Cubo al recibir REJECTED / FAILED / DECLINED,
 * el rollback de /pagos/preparar y el barrido de borradores abandonados) y Cubo
 * reintenta sus webhooks. Sin un único punto de entrada, dos llamadas
 * concurrentes o repetidas devolvían el stock dos veces y el negocio terminaba
 * con más unidades disponibles de las que realmente tenía.
 *
 * ── Cómo se garantiza el "exactamente una vez" ──────────────────────────────
 * El UPDATE que mueve el pedido a 'cancelado' lleva `.in('estado', cancelables)`
 * y `.select().maybeSingle()`: es un compare-and-swap. Solo la primera llamada
 * encuentra el pedido en un estado cancelable y recibe una fila de vuelta; las
 * siguientes lo encuentran ya en 'cancelado' y reciben null. La devolución de
 * stock cuelga de ese resultado, así que corre solo para el ganador. El propio
 * `estado` es la marca de idempotencia — no hace falta columna ni tabla extra.
 *
 * ── Qué se libera ───────────────────────────────────────────────────────────
 * Ver orderStateMachine.requiereDevolucionDeStock: un pedido no cobrado
 * ('borrador' / 'pendiente') solo tenía una reserva implícita, y el cambio de
 * estado ya la libera — sumar unidades ahí duplicaría el stock. Solo se
 * devuelven unidades de pedidos que ya pasaron por confirmar_pago_cubo, que es
 * donde `bolsas.cantidad_disponible` se descontó de verdad.
 *
 * Limitación conocida: la devolución se hace fila por fila desde Node, no en
 * una transacción. Si el proceso muere a mitad, parte del stock queda sin
 * devolver (nunca duplicado). El pedido ya está cancelado y el faltante se
 * corrige a mano. Moverlo a una RPC `liberar_stock_pedido` es la mejora
 * pendiente anotada en docs/STATE_MACHINE_Y_CONTRATOS.md.
 *
 * @param {string} pedidoId
 * @param {object} [opciones]
 *   @param {string} [opciones.canceladoPor] 'cliente' | 'restaurante' | 'admin' | 'sistema'
 *   @param {string} [opciones.motivo]       texto de auditoría
 *   @param {string[]} [opciones.estadosPermitidos] restringe desde qué estados se acepta
 *   @param {object} [opciones.cliente]      cliente Supabase (inyectable en pruebas)
 *
 * @returns {Promise<{ ok: boolean, tipo: string, status: number, ... }>}
 *   tipo: 'cancelado' | 'ya_cancelado' | 'no_encontrado' | 'transicion_invalida' | 'carrera' | 'error_bd'
 */
async function liberarInventarioPedido(pedidoId, opciones = {}) {
  const cliente = opciones.cliente || supabasePorDefecto();
  const {
    canceladoPor = 'sistema',
    motivo = null,
    estadosPermitidos = null,
  } = opciones;

  let pedido;
  try {
    const { data, error } = await cliente
      .from('pedidos')
      .select('id, estado, estado_pago, bolsa_id, cantidad')
      .eq('id', pedidoId)
      .maybeSingle();
    if (error) {
      console.error('[STOCK] liberarInventarioPedido — lectura falló:', error.message);
      return { ok: false, tipo: 'error_bd', status: 503, detalle: error.message };
    }
    pedido = data;
  } catch (err) {
    console.error('[STOCK] liberarInventarioPedido — lectura no disponible:', err.message);
    return { ok: false, tipo: 'error_bd', status: 503, detalle: err.message };
  }

  if (!pedido) return { ok: false, tipo: 'no_encontrado', status: 404 };

  // Idempotencia en la puerta: una segunda llamada no es un error, es un no-op.
  // Responder ok:true permite que el webhook de Cubo confirme el reintento sin
  // que Cubo lo siga reenviando.
  if (pedido.estado === 'cancelado') {
    return { ok: true, tipo: 'ya_cancelado', status: 200, pedidoId, stockDevuelto: false };
  }

  const validacion = validarTransicion(pedido.estado, 'cancelado', { pedido });
  if (!validacion.ok) {
    return { ...validacion, tipo: 'transicion_invalida', pedidoId };
  }

  // Ventana de estados sobre la que se hace el compare-and-swap. Por defecto,
  // todos los que la máquina considera cancelables; una ruta puede estrecharla
  // (soporte, por ejemplo, no cancela pedidos ya 'listo').
  const cancelables = estadosPermitidos && estadosPermitidos.length
    ? estadosPermitidos.filter((e) => puedeTransicionar(e, 'cancelado', { pedido }))
    : estadosCancelables();

  if (!cancelables.includes(pedido.estado)) {
    return {
      ok: false,
      tipo: 'transicion_invalida',
      error: 'TRANSICION_INVALIDA',
      codigo: 'ESTADO_NO_CANCELABLE',
      status: 400,
      detalle: `El pedido en estado "${pedido.estado}" no puede cancelarse desde este flujo.`,
      pedidoId,
    };
  }

  const ahora = new Date().toISOString();
  const cas = async (payload) => cliente
    .from('pedidos')
    .update(payload)
    .eq('id', pedido.id)
    .in('estado', cancelables)
    .select('id')
    .maybeSingle();

  let ganador;
  try {
    let { data, error } = await cas({
      estado: 'cancelado',
      cancelado_por: canceladoPor,
      cancelado_at: ahora,
      ...(motivo ? { motivo_cancelacion: motivo } : {}),
    });

    // Las columnas de auditoría llegaron en sql/cancelacion-auditoria.sql y la
    // migración puede no haber corrido todavía. Cancelar importa más que
    // auditar: se reintenta sin ellas antes de rendirse.
    if (error) {
      console.warn('[STOCK] cancelación sin columnas de auditoría:', error.message);
      const r = await cas({ estado: 'cancelado' });
      data = r.data; error = r.error;
    }

    if (error) {
      console.error('[STOCK] liberarInventarioPedido — UPDATE falló:', error.message);
      return { ok: false, tipo: 'error_bd', status: 503, detalle: error.message, pedidoId };
    }
    ganador = data;
  } catch (err) {
    console.error('[STOCK] liberarInventarioPedido — UPDATE no disponible:', err.message);
    return { ok: false, tipo: 'error_bd', status: 503, detalle: err.message, pedidoId };
  }

  // Otra llamada ganó el CAS entre el SELECT y el UPDATE. Esa otra ya devolvió
  // el stock; aquí no se toca nada. Desde fuera el resultado es el mismo pedido
  // cancelado una sola vez, así que es un éxito idempotente, no un conflicto.
  if (!ganador) {
    return { ok: true, tipo: 'ya_cancelado', status: 200, pedidoId, stockDevuelto: false };
  }

  if (!requiereDevolucionDeStock(pedido.estado)) {
    return {
      ok: true,
      tipo: 'cancelado',
      status: 200,
      pedidoId,
      stockDevuelto: false,
      detalle: 'Reserva implícita liberada por el cambio de estado; no había stock descontado.',
    };
  }

  const unidades = await unidadesDePedido(pedido, cliente);
  const devueltas = {};

  for (const [bolsaId, cantidad] of Object.entries(unidades)) {
    if (!cantidad) continue;
    try {
      const { data: bolsa, error: leerErr } = await cliente
        .from('bolsas')
        .select('cantidad_disponible')
        .eq('id', bolsaId)
        .maybeSingle();
      if (leerErr || !bolsa) {
        console.error('[STOCK] no se pudo leer bolsa', bolsaId, 'del pedido', pedidoId, ':', leerErr?.message || 'no encontrada');
        continue;
      }
      const { error: sumarErr } = await cliente
        .from('bolsas')
        .update({ cantidad_disponible: (bolsa.cantidad_disponible || 0) + cantidad })
        .eq('id', bolsaId);
      if (sumarErr) {
        console.error('[STOCK] no se pudo devolver stock a bolsa', bolsaId, ':', sumarErr.message);
        continue;
      }
      devueltas[bolsaId] = cantidad;
    } catch (err) {
      console.error('[STOCK] devolución de stock falló para bolsa', bolsaId, ':', err.message);
    }
  }

  console.log('[STOCK] pedido', pedidoId, 'cancelado por', canceladoPor, '| stock devuelto:', JSON.stringify(devueltas));
  return { ok: true, tipo: 'cancelado', status: 200, pedidoId, stockDevuelto: true, unidades: devueltas };
}

module.exports = {
  registrar,
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
  unidadesDePedido,
  liberarInventarioPedido,
};
