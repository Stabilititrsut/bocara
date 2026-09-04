const supabase = require('../config/supabase');

/**
 * Returns units of bolsaId reserved by pending (unpaid) orders.
 * - Primary source: pedido_items (new multi-bolsa cart orders)
 * - Fallback source: pedidos.bolsa_id for legacy orders that have no pedido_items
 * Double-counting is avoided: legacy pedidos already covered by pedido_items are excluded.
 */
async function getReservadoPendiente(bolsaId) {
  const { data: piRows } = await supabase
    .from('pedido_items')
    .select('pedido_id, cantidad')
    .eq('bolsa_id', bolsaId);

  const pedidoIdsFromItems = (piRows || []).map(r => r.pedido_id);
  let fromItems = 0;

  if (pedidoIdsFromItems.length > 0) {
    const { data: pedsPend } = await supabase
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
  let q = supabase
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
  const { data: pedsPend } = await supabase
    .from('pedidos')
    .select('id, bolsa_id, cantidad')
    .eq('estado', 'pendiente')
    .eq('estado_pago', 'pendiente');

  if (!pedsPend || pedsPend.length === 0) return {};

  const pedidoIdsPend = pedsPend.map(p => p.id);

  const { data: piRows } = await supabase
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

module.exports = { getReservadoPendiente, getReservasMap };
