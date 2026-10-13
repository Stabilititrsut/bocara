// Desglose contable Tiempo Limitado (25%) vs Promoción (20%) — fuente única
// para el dashboard admin (GET /admin/stats, GET /admin/financiero) y las
// ganancias del restaurante (GET /negocios/mi-negocio/ganancias), para que
// las tres pantallas no puedan sumar distinto.
//
// Fuente de cada cifra: el snapshot financiero que se fijó al cobrar el pedido
// (snapshot_financiero.lineas[], ver services/finanzasSnapshot.js). Cada línea
// trae su tipo_financiero ('merma' = Tiempo Limitado, 'promocion') y la
// comisión que se le aplicó — nunca se recalcula con el % configurado hoy, así
// que un cambio de tarifa no mueve cifras de ventas pasadas.
//
// Pedidos heredados sin líneas en el snapshot: todo el pedido se asigna a un
// tipo según su bolsa (bolsas.tipo / es_promocion, igual que esPromocion). Si
// la bolsa ya no existe se cuenta como Tiempo Limitado — la única tarifa que
// existía antes de la de promoción — y queda contado en `pedidos_tipo_inferido`.

const { aNumero, redondearMoneda } = require('./finanzas');
const { esPromocion } = require('./finanzasSnapshot');
const { ahoraGuatemala, hoyGuatemala, sumarDias, rangoDiaGuatemalaUTC, rangoMesGuatemalaUTC } = require('./horarioGuatemala');
const { montosPedido } = require('./liquidaciones');

const TIPOS = Object.freeze({ TIEMPO_LIMITADO: 'tiempo_limitado', PROMOCION: 'promocion' });
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

// snapshot 'merma' (nombre contable histórico) y 'bolsa' → Tiempo Limitado.
function tipoDeLinea(tipoFinanciero) {
  return tipoFinanciero === 'promocion' ? TIPOS.PROMOCION : TIPOS.TIEMPO_LIMITADO;
}

// Desglose de UN pedido. `bolsasPorId` (Map id → { tipo, es_promocion }) solo
// se usa para pedidos heredados sin líneas en el snapshot.
function desglosarPedido(p = {}, bolsasPorId = new Map()) {
  const m = montosPedido(p);
  const d = {
    unidades_tiempo_limitado: 0, unidades_promocion: 0,
    ventas_tiempo_limitado: 0, ventas_promocion: 0,
    comision_tiempo_limitado: 0, comision_promocion: 0,
    cargo_plataforma: m.plataforma, propinas: m.propina, envios: m.envio,
    // monto_neto_restaurante: producto − comisión + envío + propina (lo que se le paga).
    pago_restaurante: m.neto == null ? 0 : m.neto,
    descuento_cupon: aNumero(p.descuento_cupon),
    total_cobrado: aNumero(p.total),
    sin_desglose: m.neto == null,
    tipo_inferido: false,
  };
  const lineas = Array.isArray(p.snapshot_financiero?.lineas) ? p.snapshot_financiero.lineas : [];
  if (lineas.length > 0) {
    for (const l of lineas) {
      const sufijo = tipoDeLinea(l.tipo_financiero);
      d[`unidades_${sufijo}`] += aNumero(l.cantidad);
      d[`ventas_${sufijo}`] += aNumero(l.subtotal_productos);
      d[`comision_${sufijo}`] += aNumero(l.comision_bocara);
    }
  } else {
    const bolsa = bolsasPorId.get(p.bolsa_id);
    const sufijo = bolsa && esPromocion(bolsa) ? TIPOS.PROMOCION : TIPOS.TIEMPO_LIMITADO;
    d.tipo_inferido = !bolsa;
    d[`unidades_${sufijo}`] += Math.max(1, aNumero(p.cantidad) || 1);
    d[`ventas_${sufijo}`] += m.bruto;
    d[`comision_${sufijo}`] += m.comision;
  }
  return d;
}

const CAMPOS_SUMA = [
  'unidades_tiempo_limitado', 'unidades_promocion', 'ventas_tiempo_limitado', 'ventas_promocion',
  'comision_tiempo_limitado', 'comision_promocion', 'cargo_plataforma', 'propinas', 'envios',
  'pago_restaurante', 'descuento_cupon', 'total_cobrado',
];

function acumuladorVacio() {
  const a = Object.fromEntries(CAMPOS_SUMA.map((c) => [c, 0]));
  a.pedidos = 0;
  a.pedidos_sin_desglose = 0;
  a.pedidos_tipo_inferido = 0;
  return a;
}

function acumular(a, d) {
  for (const c of CAMPOS_SUMA) a[c] += d[c];
  a.pedidos += 1;
  if (d.sin_desglose) a.pedidos_sin_desglose += 1;
  if (d.tipo_inferido) a.pedidos_tipo_inferido += 1;
}

// % efectivo de comisión de un tipo (1 decimal), derivado de los montos — null
// si no hubo ventas de ese tipo. Así la etiqueta "(25%)" refleja lo cobrado de
// verdad aunque la tarifa configurada haya cambiado entre ventas.
function porcentaje(comision, ventas) {
  return ventas > 0 ? Math.round((comision / ventas) * 1000) / 10 : null;
}

// Totales redondeados + campos derivados. Contrato expuesto por las rutas.
function cerrar(a) {
  const r = { ...a };
  for (const c of CAMPOS_SUMA) if (!c.startsWith('unidades_')) r[c] = redondearMoneda(a[c]);
  r.ventas_totales = redondearMoneda(a.ventas_tiempo_limitado + a.ventas_promocion);
  r.comision_bocara = redondearMoneda(a.comision_tiempo_limitado + a.comision_promocion);
  // Ingreso Bocara: comisiones (25% + 20%) + cargo al cliente (3.5%), ANTES de cupones.
  r.total_bocara = redondearMoneda(r.comision_bocara + a.cargo_plataforma);
  // Bocara absorbe los cupones: neto puede ser negativo y se muestra como pérdida.
  r.total_bocara_neto = redondearMoneda(r.total_bocara - a.descuento_cupon);
  // Lo que gana el restaurante por producto, por tipo (75% / 80%).
  r.neto_tiempo_limitado = redondearMoneda(a.ventas_tiempo_limitado - a.comision_tiempo_limitado);
  r.neto_promocion = redondearMoneda(a.ventas_promocion - a.comision_promocion);
  // Pago a restaurantes sin propinas (producto neto + envíos) y con propinas.
  r.pago_restaurante_sin_propinas = redondearMoneda(a.pago_restaurante - a.propinas);
  r.porcentaje_tiempo_limitado = porcentaje(a.comision_tiempo_limitado, a.ventas_tiempo_limitado);
  r.porcentaje_promocion = porcentaje(a.comision_promocion, a.ventas_promocion);
  return r;
}

// Resume una lista de pedidos YA filtrados (ventas válidas). Devuelve los
// totales y, si se pide, el desglose por negocio ordenado por ventas.
function resumirFinanzas(pedidos = [], { bolsasPorId = new Map(), porNegocio = false, nombreNegocio = () => ({}) } = {}) {
  const total = acumuladorVacio();
  const negocios = new Map();
  for (const p of pedidos) {
    const d = desglosarPedido(p, bolsasPorId);
    acumular(total, d);
    if (porNegocio) {
      if (!negocios.has(p.negocio_id)) negocios.set(p.negocio_id, { negocio_id: p.negocio_id, ...nombreNegocio(p), ...acumuladorVacio() });
      acumular(negocios.get(p.negocio_id), d);
    }
  }
  const resultado = { totales: cerrar(total) };
  if (porNegocio) {
    resultado.negocios = [...negocios.values()].map(cerrar).sort((a, b) => b.ventas_totales - a.ventas_totales);
  }
  return resultado;
}

// IDs de bolsas que hace falta consultar: solo las de pedidos heredados sin líneas.
function bolsasSinSnapshot(pedidos = []) {
  return [...new Set(pedidos
    .filter((p) => !(Array.isArray(p.snapshot_financiero?.lineas) && p.snapshot_financiero.lineas.length > 0))
    .map((p) => p.bolsa_id).filter(Boolean))];
}

// Carga { tipo, es_promocion } de esas bolsas. Si falla, se sigue sin ellas
// (esos pedidos se cuentan como Tiempo Limitado y quedan en pedidos_tipo_inferido).
async function cargarBolsasPorId(cliente, pedidos) {
  const ids = bolsasSinSnapshot(pedidos);
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await cliente.from('bolsas').select('id,tipo,es_promocion').in('id', ids);
    if (error) throw new Error(error.message);
    return new Map((data || []).map((b) => [b.id, b]));
  } catch (err) {
    console.warn('[FINANZAS] no se pudieron leer los tipos de bolsa de pedidos heredados:', err.message);
    return new Map();
  }
}

// Periodos (hora de Guatemala). Rango [desde, hasta) en UTC sobre created_at;
// null en desde/hasta = sin límite. Alias heredados: 'dia' = 'hoy',
// 'semana' = '7d'. 'mes' = mes calendario en curso, o el de `mes` (AAAA-MM).
const PERIODOS_FINANCIEROS = ['hoy', 'dia', 'semana', '7d', '30d', 'mes', 'mes_actual', 'mes_especifico', 'todo'];

function resolverPeriodoFinanciero({ periodo, mes } = {}, { ahora = new Date(), porDefecto = 'todo' } = {}) {
  const p = periodo || porDefecto;
  const hoy = hoyGuatemala(ahora);
  const ultimosDias = (n) => ({
    desde: rangoDiaGuatemalaUTC(sumarDias(hoy, -(n - 1))).desde, hasta: rangoDiaGuatemalaUTC(hoy).hasta,
  });
  switch (p) {
    case 'hoy':
    case 'dia':
      return { periodo: 'hoy', ...rangoDiaGuatemalaUTC(hoy) };
    case 'semana':
    case '7d':
      return { periodo: p, ...ultimosDias(7) };
    case '30d':
      return { periodo: '30d', ...ultimosDias(30) };
    case 'mes':
    case 'mes_actual':
    case 'mes_especifico': {
      const m = mes || (p === 'mes_especifico' ? null : hoy.slice(0, 7));
      if (!RE_MES.test(m || '')) return { error: 'mes debe tener formato AAAA-MM' };
      if (m > hoy.slice(0, 7)) return { error: 'mes no puede ser futuro' };
      return { periodo: 'mes', mes: m, ...rangoMesGuatemalaUTC(m) };
    }
    case 'todo':
      return { periodo: 'todo', desde: null, hasta: null };
    default:
      return { error: `periodo debe ser uno de: ${PERIODOS_FINANCIEROS.join(', ')}` };
  }
}

// Serie "Cobrado a clientes" del gráfico del dashboard, con los mismos cortes
// que el periodo (hora de Guatemala) para que la gráfica y su total cuadren con
// las tarjetas:
//   hoy        → 8 tramos de 3 horas
//   7d / 30d   → un punto por día
//   mes        → un punto por día del mes (hasta hoy si es el mes en curso)
//   todo       → un punto por mes, desde la primera venta (últimos 24 meses)
// `pedidos` ya filtrados (ventas válidas del rango). Etiquetas listas para pintar.
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function serieCobrado(pedidos = [], rango = {}, { ahora = new Date() } = {}) {
  const hoy = hoyGuatemala(ahora);
  const fechaGT = (iso) => ahoraGuatemala(new Date(iso));
  const valores = new Map();
  let claves = [];
  let claveDe;
  let etiqueta;

  const dias = (desde, hasta) => {
    const r = [];
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) r.push(d);
    return r;
  };

  if (rango.periodo === 'hoy') {
    claves = [0, 3, 6, 9, 12, 15, 18, 21].map(String);
    claveDe = (iso) => String(Math.floor(Number(fechaGT(iso).hora.slice(0, 2)) / 3) * 3);
    etiqueta = (c) => `${c}h`;
  } else if (rango.periodo === 'mes' && rango.mes) {
    const ultimoDelMes = sumarDias(`${mesSiguienteISO(rango.mes)}-01`, -1);
    claves = dias(`${rango.mes}-01`, ultimoDelMes < hoy ? ultimoDelMes : hoy);
    claveDe = (iso) => fechaGT(iso).fecha;
    etiqueta = (c) => String(Number(c.slice(8, 10)));
  } else if (rango.periodo === 'todo') {
    const meses = pedidos.map((p) => fechaGT(p.created_at).fecha.slice(0, 7)).sort();
    const actual = hoy.slice(0, 7);
    for (let m = meses[0] || actual; m <= actual; m = mesSiguienteISO(m)) claves.push(m);
    claves = claves.slice(-24);
    claveDe = (iso) => fechaGT(iso).fecha.slice(0, 7);
    etiqueta = (c) => `${MESES_CORTOS[Number(c.slice(5, 7)) - 1]} ${c.slice(2, 4)}`;
  } else {
    const n = rango.periodo === '30d' ? 30 : 7;
    claves = dias(sumarDias(hoy, -(n - 1)), hoy);
    claveDe = (iso) => fechaGT(iso).fecha;
    etiqueta = n === 7
      ? (c) => DIAS_CORTOS[new Date(`${c}T12:00:00Z`).getUTCDay()]
      : (c) => String(Number(c.slice(8, 10)));
  }

  for (const c of claves) valores.set(c, 0);
  for (const p of pedidos) {
    if (!p.created_at) continue;
    const c = claveDe(p.created_at);
    if (valores.has(c)) valores.set(c, valores.get(c) + aNumero(p.total));
  }
  return claves.map((c) => ({ clave: c, etiqueta: etiqueta(c), valor: redondearMoneda(valores.get(c)) }));
}

function mesSiguienteISO(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
}

// Aplica el rango a una consulta de Supabase sobre created_at.
function aplicarRango(query, rango) {
  let q = query;
  if (rango?.desde) q = q.gte('created_at', rango.desde);
  if (rango?.hasta) q = q.lt('created_at', rango.hasta);
  return q;
}

module.exports = {
  TIPOS, PERIODOS_FINANCIEROS,
  desglosarPedido, resumirFinanzas, bolsasSinSnapshot, cargarBolsasPorId,
  resolverPeriodoFinanciero, aplicarRango, serieCobrado,
};
