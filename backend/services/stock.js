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

/**
 * Returns units of bolsaId reserved by pending (unpaid) orders.
 * - Primary source: pedido_items (new multi-bolsa cart orders)
 * - Fallback source: pedidos.bolsa_id for legacy orders that have no pedido_items
 * Double-counting is avoided: legacy pedidos already covered by pedido_items are excluded.
 */
async function getReservadoPendiente(bolsaId) {
  const { data: piRows } = await supabasePorDefecto()
    .from('pedido_items')
    .select('pedido_id, cantidad')
    .eq('bolsa_id', bolsaId);

  const pedidoIdsFromItems = (piRows || []).map(r => r.pedido_id);
  let fromItems = 0;

  if (pedidoIdsFromItems.length > 0) {
    const { data: pedsPend } = await supabasePorDefecto()
      .from('pedidos')
      .select('id')
      .in('id', pedidoIdsFromItems)
      .eq('estado', 'pendiente')
      .eq('estado_pago', 'pendiente');
    const pendSet = new Set((pedsPend || []).map(p => p.id));
    fromItems = (piRows || [])
      .filter(r => pendSet.has(r.pedido_id))
      .reduce((sum, r) => sum + r.cantidad, 0);
  }

  // Legacy pedidos: bolsa_id direct, no pedido_items row
  let q = supabasePorDefecto()
    .from('pedidos')
    .select('id, cantidad')
    .eq('bolsa_id', bolsaId)
    .eq('estado', 'pendiente')
    .eq('estado_pago', 'pendiente');
  if (pedidoIdsFromItems.length > 0) {
    q = q.not('id', 'in', `(${pedidoIdsFromItems.join(',')})`);
  }
  const { data: leg } = await q;
  const fromLegacy = (leg || []).reduce((sum, p) => sum + (p.cantidad || 1), 0);

  return fromItems + fromLegacy;
}

/**
 * Returns { bolsaId → reservado } for ALL pending pedidos in two queries.
 * Used by the bolsas list endpoint to compute cantidad_disponible_real efficiently.
 */
async function getReservasMap() {
  const { data: pedsPend } = await supabasePorDefecto()
    .from('pedidos')
    .select('id, bolsa_id, cantidad')
    .eq('estado', 'pendiente')
    .eq('estado_pago', 'pendiente');

  if (!pedsPend || pedsPend.length === 0) return {};

  const pedidoIdsPend = pedsPend.map(p => p.id);

  const { data: piRows } = await supabasePorDefecto()
    .from('pedido_items')
    .select('pedido_id, bolsa_id, cantidad')
    .in('pedido_id', pedidoIdsPend);

  const pedidoIdsConItems = new Set((piRows || []).map(r => r.pedido_id));
  const reservaMap = {};

  for (const r of piRows || []) {
    reservaMap[r.bolsa_id] = (reservaMap[r.bolsa_id] || 0) + r.cantidad;
  }

  for (const p of pedsPend) {
    if (!pedidoIdsConItems.has(p.id) && p.bolsa_id) {
      reservaMap[p.bolsa_id] = (reservaMap[p.bolsa_id] || 0) + (p.cantidad || 1);
    }
  }

  return reservaMap;
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
 * PATCH /pedidos/:id/cancelar, el webhook de Cubo al recibir REJECTED, el
 * rollback de /pagos/preparar y el barrido de borradores abandonados) y Cubo
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
  getReservadoPendiente,
  getReservasMap,
  unidadesDePedido,
  liberarInventarioPedido,
};
