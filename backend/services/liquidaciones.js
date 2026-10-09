// Liquidaciones mensuales a restaurantes (Fase B, Semana 2).
//
// El dinero se mueve SOLO dentro de la RPC crear_liquidacion_mensual_atomica
// (supabase/migrations/202610061200_liquidaciones_mensuales_y_resenas.sql):
// bloquea los pedidos, suma desde el snapshot financiero inmutable, inserta la
// liquidación y vincula los pedidos en una sola transacción. Este servicio solo
// decide QUÉ mes pedirle, en qué orden, y produce/sirve el comprobante PDF.
//
// Corte mensual: mes calendario en hora de Guatemala por fecha de pago
// confirmado (pagado_en, o created_at en pedidos viejos sin pagado_en). La RPC
// arrastra hacia adelante cualquier pedido pendiente pagado antes del cierre
// del mes pedido, así que liquidar fuera de orden (agosto antes que mayo)
// metería ventas de mayo en "agosto". Por eso planDeLiquidacion() exige ir del
// mes más antiguo al más reciente.

const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');
const { aNumero, redondearMoneda } = require('./finanzas');
const { ahoraGuatemala, hoyGuatemala, sumarDias, rangoDiaGuatemalaUTC, rangoMesGuatemalaUTC } = require('./horarioGuatemala');

const BUCKET_COMPROBANTES = 'bocara-comprobantes';
const URL_FIRMADA_SEGUNDOS = 10 * 60; // dentro de la ventana pedida de 5–15 min
const DIAS_HABILES_PAGO = 3;
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

// Resultado de la RPC → status HTTP. 'creada' es el único éxito.
const STATUS_POR_RESULTADO = Object.freeze({
  creada: 201,
  mes_invalido: 400,
  no_autorizado: 403,
  negocio_no_encontrado: 404,
  mes_ya_liquidado: 409,
  sin_pedidos_pendientes: 409,
  mes_en_curso: 422,
});

const MENSAJES_RESULTADO = Object.freeze({
  mes_invalido: 'El mes debe tener formato YYYY-MM',
  no_autorizado: 'Solo un administrador puede generar liquidaciones',
  negocio_no_encontrado: 'Negocio no encontrado',
  mes_ya_liquidado: 'Ese mes ya tiene una liquidación para este negocio',
  sin_pedidos_pendientes: 'No hay pedidos completados pendientes de liquidar hasta el cierre de ese mes',
  mes_en_curso: 'El mes aún no termina; solo se liquidan meses cerrados',
});

// ── Calendario ───────────────────────────────────────────────────────────────

function esMesValido(mes) {
  return typeof mes === 'string' && RE_MES.test(mes);
}

function mesSiguiente(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m, 1)); // m es 1-based → Date.UTC(a, m) = mes siguiente
  return d.toISOString().slice(0, 7);
}

function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

// Mes (YYYY-MM) en Guatemala del instante dado.
function mesDeInstante(instante) {
  if (instante == null) return null;
  const fecha = new Date(instante);
  if (Number.isNaN(fecha.getTime())) return null;
  return ahoraGuatemala(fecha).fecha.slice(0, 7);
}

// Mes al que pertenece un pedido para el corte (mismo criterio que la RPC).
function mesDePedido(pedido) {
  return mesDeInstante(pedido?.pagado_en || pedido?.created_at);
}

function ultimoMesCerrado(referencia = new Date()) {
  return mesAnterior(hoyGuatemala(referencia).slice(0, 7));
}

// Domingo de Pascua (algoritmo gregoriano anónimo) → 'YYYY-MM-DD'.
function domingoDePascua(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Asuetos nacionales de día completo en Guatemala (Código de Trabajo, art. 127).
// 24 y 31 de diciembre son medio día: cuentan como hábiles para el pago.
function feriadosGuatemala(anio) {
  const pascua = domingoDePascua(anio);
  return new Set([
    `${anio}-01-01`, sumarDias(pascua, -3), sumarDias(pascua, -2),
    `${anio}-05-01`, `${anio}-06-30`, `${anio}-09-15`, `${anio}-10-20`,
    `${anio}-11-01`, `${anio}-12-25`,
  ]);
}

function esDiaHabil(fechaISO, feriados) {
  const dia = new Date(`${fechaISO}T12:00:00Z`).getUTCDay();
  return dia !== 0 && dia !== 6 && !feriados.has(fechaISO);
}

// Fecha límite de pago de la liquidación de `mes`: fin del 3er día hábil
// (lun–vie, sin asuetos) del mes siguiente, 23:59:59 hora de Guatemala.
function fechaLimitePago(mes, { diasHabiles = DIAS_HABILES_PAGO, feriadosExtra = [] } = {}) {
  if (!esMesValido(mes)) return null;
  const siguiente = mesSiguiente(mes);
  const feriados = feriadosGuatemala(Number(siguiente.slice(0, 4)));
  for (const f of feriadosExtra) feriados.add(f);
  let fecha = `${siguiente}-01`;
  let contados = 0;
  for (;;) {
    if (esDiaHabil(fecha, feriados) && ++contados === diasHabiles) break;
    fecha = sumarDias(fecha, 1);
  }
  const finDia = new Date(new Date(rangoDiaGuatemalaUTC(fecha).hasta).getTime() - 1000);
  return { fecha, limiteISO: finDia.toISOString() };
}

// ── Orden de liquidación ─────────────────────────────────────────────────────

// Qué meses hay que liquidar, en orden, para cubrir los pedidos pendientes.
//   mesesConPedidos : meses (YYYY-MM) de los pedidos elegibles sin liquidar
//   mesesLiquidados : meses con liquidación viva (estado <> 'anulado')
//   ultimoCerrado   : último mes ya terminado
// Un pedido de un mes ya liquidado (entregado después del corte) cae en el
// siguiente mes sin liquidar; si ese mes aún no cierra, todavía no es liquidable.
function planDeLiquidacion({ mesesConPedidos = [], mesesLiquidados = [], ultimoCerrado }) {
  const liquidados = new Set(mesesLiquidados);
  const destinos = new Set();
  for (const mes of [...new Set(mesesConPedidos)].filter(esMesValido).sort()) {
    let destino = mes;
    while (liquidados.has(destino)) destino = mesSiguiente(destino);
    if (destino <= ultimoCerrado) destinos.add(destino);
  }
  const mesesAGenerar = [...destinos].sort();
  return { mesesAGenerar, mesRequerido: mesesAGenerar[0] || null };
}

// null si se puede pedir `mes`; si hay un mes anterior pendiente, cuál es.
function validarOrdenLiquidacion(mes, plan) {
  if (plan.mesRequerido && mes > plan.mesRequerido) return { mes_requerido: plan.mesRequerido };
  return null;
}

// ── Montos (espejo exacto de la RPC, para mostrar pendientes) ────────────────

function montosPedido(p = {}) {
  const sf = p.snapshot_financiero || {};
  const pick = (clave, columna) => (sf[clave] != null ? aNumero(sf[clave]) : columna);
  const neto = sf.monto_neto_restaurante != null
    ? aNumero(sf.monto_neto_restaurante)
    : (p.monto_neto_restaurante == null ? null : aNumero(p.monto_neto_restaurante));
  const comision = pick('comision_bocara', aNumero(p.comision_bocara));
  const plataforma = pick('comision_pasarela', aNumero(p.comision_pasarela));
  const propina = pick('propina', aNumero(p.propina));
  const envio = pick('costo_envio', aNumero(p.costo_envio));
  const bruto = sf.subtotal_productos != null
    ? aNumero(sf.subtotal_productos)
    : (neto == null ? 0 : neto - propina - envio + comision);
  return { neto, comision, plataforma, propina, envio, bruto };
}

// Agrupa por negocio lo que se pagaría HOY si el admin confirma: pedidos de
// meses cerrados liquidables + liquidaciones mensuales ya generadas y sin
// pagar. Conserva los campos que ya consume la app admin (bruto, neto,
// comisionBocara, cargoPlataforma, propinas, pedidos, pedidosSinDesglose).
function resumirPendientes({ pedidos = [], liquidacionesVivas = [], ultimoCerrado }) {
  const porNegocio = new Map();
  const asegurar = (negocioId, negocio) => {
    if (!porNegocio.has(negocioId)) {
      porNegocio.set(negocioId, {
        negocio_id: negocioId,
        nombre: negocio?.nombre || 'Sin nombre',
        datos_bancarios: negocio?.datos_bancarios || null,
        propietario_id: negocio?.propietario_id,
        pedidos: 0, bruto: 0, comisionBocara: 0, cargoPlataforma: 0, propinas: 0, envios: 0, neto: 0,
        pedidosSinDesglose: 0,
        pedidosNoLiquidablesAun: 0, netoNoLiquidableAun: 0,
        meses_a_liquidar: [], mes_requerido: null,
        liquidaciones_pendientes: [],
        _pedidos: [],
      });
    }
    const r = porNegocio.get(negocioId);
    if (negocio && r.nombre === 'Sin nombre') {
      r.nombre = negocio.nombre || r.nombre;
      r.datos_bancarios = negocio.datos_bancarios || r.datos_bancarios;
      r.propietario_id = negocio.propietario_id || r.propietario_id;
    }
    return r;
  };

  for (const p of pedidos) asegurar(p.negocio_id, p.negocios)._pedidos.push(p);
  for (const l of liquidacionesVivas) {
    const r = asegurar(l.negocio_id, l.negocios);
    if (l.estado === 'pendiente') r.liquidaciones_pendientes.push(l);
  }

  for (const r of porNegocio.values()) {
    const vivasDelNegocio = liquidacionesVivas.filter((l) => l.negocio_id === r.negocio_id && l.mes);
    const plan = planDeLiquidacion({
      mesesConPedidos: r._pedidos.map(mesDePedido),
      mesesLiquidados: vivasDelNegocio.map((l) => l.mes),
      ultimoCerrado,
    });
    r.meses_a_liquidar = plan.mesesAGenerar;
    r.mes_requerido = plan.mesRequerido;
    const mesesVivos = new Set(vivasDelNegocio.map((l) => l.mes));

    for (const p of r._pedidos) {
      // Liquidable hoy ⇔ el primer mes sin liquidar ≥ su mes ya cerró (mismo
      // destino que calcula planDeLiquidacion).
      let destino = mesDePedido(p);
      while (destino && mesesVivos.has(destino)) destino = mesSiguiente(destino);
      const m = montosPedido(p);
      if (!destino || destino > ultimoCerrado) {
        r.pedidosNoLiquidablesAun += 1;
        r.netoNoLiquidableAun += m.neto || 0;
        continue;
      }
      if (m.neto == null) { r.pedidosSinDesglose += 1; continue; }
      r.pedidos += 1;
      r.bruto += m.bruto; r.comisionBocara += m.comision; r.cargoPlataforma += m.plataforma;
      r.propinas += m.propina; r.envios += m.envio; r.neto += m.neto;
    }
    for (const l of r.liquidaciones_pendientes) {
      r.pedidos += aNumero(l.total_pedidos);
      r.bruto += aNumero(l.ventas_brutas); r.comisionBocara += aNumero(l.comision_bocara);
      r.cargoPlataforma += aNumero(l.comision_plataforma); r.propinas += aNumero(l.propinas);
      r.envios += aNumero(l.costo_envio); r.neto += aNumero(l.monto);
    }
    for (const k of ['bruto', 'comisionBocara', 'cargoPlataforma', 'propinas', 'envios', 'neto', 'netoNoLiquidableAun']) {
      r[k] = redondearMoneda(r[k]);
    }
    r.liquidaciones_pendientes = r.liquidaciones_pendientes.map((l) => ({
      id: l.id, mes: l.mes, folio: l.folio, monto: aNumero(l.monto), fecha_limite_pago: l.fecha_limite_pago,
    }));
    delete r._pedidos;
  }

  return [...porNegocio.values()]
    .filter((r) => r.neto > 0 || r.pedidosSinDesglose > 0)
    .sort((a, b) => b.neto - a.neto);
}

// ── Acceso a datos ───────────────────────────────────────────────────────────

const COLUMNAS_PEDIDO = 'id,negocio_id,pagado_en,created_at,snapshot_financiero,monto_neto_restaurante,comision_bocara,comision_pasarela,propina,costo_envio,negocios(id,nombre,datos_bancarios,propietario_id)';

// Mismo filtro de elegibilidad que la RPC (sin el corte de fecha, que en
// PostgREST no se puede expresar con COALESCE y se aplica en memoria).
async function cargarPedidosPendientes(negocioId = null) {
  let q = supabase
    .from('pedidos')
    .select(COLUMNAS_PEDIDO)
    .in('estado', ['completado', 'recogido'])
    .eq('estado_pago', 'pagado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null)
    .is('liquidacion_id', null);
  if (negocioId) q = q.eq('negocio_id', negocioId);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer los pedidos pendientes: ${error.message}`);
  return data || [];
}

async function cargarLiquidacionesVivas(negocioId = null) {
  let q = supabase
    .from('liquidaciones')
    .select('id,negocio_id,mes,estado,folio,monto,ventas_brutas,comision_bocara,comision_plataforma,propinas,costo_envio,total_pedidos,fecha_limite_pago,negocios(id,nombre,datos_bancarios,propietario_id)')
    .neq('estado', 'anulado');
  if (negocioId) q = q.eq('negocio_id', negocioId);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer las liquidaciones: ${error.message}`);
  return data || [];
}

async function planParaNegocio(negocioId, referencia = new Date()) {
  const [pedidos, vivas] = await Promise.all([cargarPedidosPendientes(negocioId), cargarLiquidacionesVivas(negocioId)]);
  return planDeLiquidacion({
    mesesConPedidos: pedidos.map(mesDePedido),
    mesesLiquidados: vivas.filter((l) => l.mes).map((l) => l.mes),
    ultimoCerrado: ultimoMesCerrado(referencia),
  });
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const fmtQ = (v) => `Q${aNumero(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtFecha = (iso) => (iso ? ahoraGuatemala(new Date(iso)).fecha.split('-').reverse().join('/') : '—');
const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtMes = (mes) => (esMesValido(mes) ? `${NOMBRES_MES[Number(mes.slice(5)) - 1]} ${mes.slice(0, 4)}` : 'Liquidación sin mes (histórica)');

function folioDe(liq) {
  return liq.folio || `LIQ-HIST-${String(liq.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Comprobante oficial en memoria. Solo imprime montos guardados en la fila de
// la liquidación (los que calculó la RPC); nunca recalcula porcentajes.
function generarPdfLiquidacion(liq, negocio = {}, { compress = true, generadoEn = new Date() } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER', margin: 56, compress,
      info: { Title: `Comprobante ${folioDe(liq)}`, Author: 'Bocara', CreationDate: generadoEn },
    });
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const pagado = liq.estado === 'pagado' || liq.estado === 'liquidado';
    const ancho = doc.page.width - 112;
    const fila = (etiqueta, valor, { negrita = false, color = '#222222' } = {}) => {
      const y = doc.y;
      doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(11).fillColor(color)
        .text(etiqueta, 56, y, { width: ancho - 140 })
        .text(valor, 56 + ancho - 140, y, { width: 140, align: 'right' });
      doc.moveDown(0.5);
    };
    const linea = () => { doc.moveTo(56, doc.y).lineTo(56 + ancho, doc.y).strokeColor('#DDDDDD').stroke(); doc.moveDown(0.6); };

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#3E2723').text('Bocara');
    doc.font('Helvetica').fontSize(10).fillColor('#666666').text('Comprobante oficial de liquidación a comercio');
    doc.moveDown(1.2);

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#222222').text(`Folio ${folioDe(liq)}`);
    doc.font('Helvetica').fontSize(10).fillColor('#444444')
      .text(`Comercio: ${negocio.nombre || '—'}`)
      .text(`Periodo: ${fmtMes(liq.mes)}${liq.periodo_inicio ? ` (${fmtFecha(liq.periodo_inicio)} al ${fmtFecha(new Date(new Date(liq.periodo_fin).getTime() - 1000))})` : ''}`)
      .text(`Pedidos incluidos: ${aNumero(liq.total_pedidos)}`)
      .text(`Estado: ${pagado ? 'Pagado' : 'Pendiente de pago'}`)
      .text(pagado
        ? `Pagado el ${fmtFecha(liq.pagado_en)}${liq.datos_transferencia?.referencia ? ` · Referencia ${liq.datos_transferencia.referencia}` : ''}`
        : `Fecha límite de pago: ${fmtFecha(liq.fecha_limite_pago)}`);
    doc.moveDown(1);
    linea();

    fila('Ventas brutas (productos)', fmtQ(liq.ventas_brutas));
    fila('(-) Comisión Bocara', `-${fmtQ(liq.comision_bocara)}`);
    fila('(+) Propinas (100% del comercio)', fmtQ(liq.propinas));
    fila('(+) Costo de envío', fmtQ(liq.costo_envio));
    linea();
    fila('Neto a pagar al comercio', fmtQ(liq.monto), { negrita: true });
    doc.moveDown(0.6);
    fila('Cargo de plataforma / pasarela (pagado por el cliente, informativo)', fmtQ(liq.comision_plataforma), { color: '#777777' });

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#888888').text(
      `Montos calculados al confirmar cada pago y consolidados de forma atómica. Incluye pedidos pendientes de meses anteriores entregados después de su corte. Generado el ${fmtFecha(generadoEn)}. ID ${liq.id}.`,
      { width: ancho },
    );
    doc.end();
  });
}

// Cuadre neto = bruto − comisión + propinas + envío (aviso, no bloquea: la
// fila guardada por la RPC es la fuente de verdad).
function cuadraLiquidacion(liq) {
  const esperado = aNumero(liq.ventas_brutas) - aNumero(liq.comision_bocara) + aNumero(liq.propinas) + aNumero(liq.costo_envio);
  return Math.abs(redondearMoneda(esperado) - aNumero(liq.monto)) <= 0.01;
}

function rutaComprobante(liq) {
  return `${liq.negocio_id}/${liq.mes || 'historico'}/${folioDe(liq)}.pdf`;
}

async function guardarComprobante(liq, negocio) {
  if (!cuadraLiquidacion(liq)) {
    console.warn('[LIQUIDACIONES] montos guardados no cuadran (se imprime lo guardado):', liq.id);
  }
  const buffer = await generarPdfLiquidacion(liq, negocio);
  const path = rutaComprobante(liq);
  const { error: upErr } = await supabase.storage
    .from(BUCKET_COMPROBANTES)
    .upload(path, buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`No se pudo subir el comprobante: ${upErr.message}`);
  const generadoEn = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('liquidaciones')
    .update({ comprobante_path: path, comprobante_generado_en: generadoEn })
    .eq('id', liq.id);
  if (updErr) throw new Error(`No se pudo registrar el comprobante: ${updErr.message}`);
  return { path, generadoEn };
}

// Best-effort: la liquidación ya existe aunque el PDF falle; se regenera al
// pedir la URL firmada.
async function guardarComprobanteSeguro(liq, negocio) {
  try {
    return await guardarComprobante(liq, negocio);
  } catch (err) {
    console.warn('[LIQUIDACIONES] comprobante no generado (se reintenta al descargar):', liq.id, err.message);
    return null;
  }
}

async function cargarNegocio(negocioId) {
  const { data } = await supabase.from('negocios').select('id,nombre').eq('id', negocioId).maybeSingle();
  return data || { id: negocioId };
}

async function urlFirmadaComprobante(liq, { descargar = false, segundos = URL_FIRMADA_SEGUNDOS } = {}) {
  let path = liq.comprobante_path;
  if (!path) path = (await guardarComprobante(liq, await cargarNegocio(liq.negocio_id))).path;
  const opciones = descargar ? { download: `${folioDe(liq)}.pdf` } : undefined;
  const { data, error } = await supabase.storage.from(BUCKET_COMPROBANTES).createSignedUrl(path, segundos, opciones);
  if (error || !data?.signedUrl) throw new Error(`No se pudo firmar el comprobante: ${error?.message || 'sin URL'}`);
  return {
    url: data.signedUrl,
    expira_en: new Date(Date.now() + segundos * 1000).toISOString(),
    folio: folioDe(liq),
    path,
  };
}

// ── Orquestación ─────────────────────────────────────────────────────────────

// Genera la liquidación de `mes` vía la RPC atómica y su comprobante.
// Devuelve { status, body } listo para la ruta.
async function crearLiquidacionMensual({ negocioId, mes, adminId, referencia = new Date(), validarOrden = true }) {
  if (!negocioId) return { status: 400, body: { error: 'negocio_id es requerido' } };
  if (!esMesValido(mes)) return { status: 400, body: { error: MENSAJES_RESULTADO.mes_invalido, resultado: 'mes_invalido' } };
  // La RPC lo vuelve a verificar; aquí va primero para que "el mes no ha
  // terminado" no quede tapado por el aviso de orden.
  if (mes > ultimoMesCerrado(referencia)) {
    return { status: 422, body: { error: MENSAJES_RESULTADO.mes_en_curso, resultado: 'mes_en_curso' } };
  }

  if (validarOrden) {
    const bloqueo = validarOrdenLiquidacion(mes, await planParaNegocio(negocioId, referencia));
    if (bloqueo) {
      return {
        status: 409,
        body: {
          error: `Primero liquida ${bloqueo.mes_requerido}: las liquidaciones van del mes más antiguo al más reciente`,
          resultado: 'mes_anterior_pendiente',
          mes_requerido: bloqueo.mes_requerido,
        },
      };
    }
  }

  const limite = fechaLimitePago(mes);
  const { data, error } = await supabase.rpc('crear_liquidacion_mensual_atomica', {
    p_negocio_id: negocioId, p_mes: mes, p_admin_id: adminId, p_fecha_limite: limite.limiteISO,
  });
  if (error) {
    // 40001 = la RPC abortó por una carrera no prevista (nada quedó a medias).
    const status = error.code === '40001' ? 503 : 500;
    return { status, body: { error: status === 503 ? 'Conflicto concurrente, intenta de nuevo' : error.message } };
  }

  const resultado = data?.resultado;
  const status = STATUS_POR_RESULTADO[resultado] || 500;
  if (resultado !== 'creada') {
    return { status, body: { error: MENSAJES_RESULTADO[resultado] || 'Respuesta inesperada de la base de datos', ...data } };
  }

  const liq = data.liquidacion;
  const comprobante = await guardarComprobanteSeguro(liq, await cargarNegocio(negocioId));
  return {
    status: 201,
    body: {
      ok: true,
      liquidacion: comprobante ? { ...liq, comprobante_path: comprobante.path, comprobante_generado_en: comprobante.generadoEn } : liq,
      comprobante: comprobante ? { path: comprobante.path } : null,
      pedidos_excluidos_sin_desglose: data.pedidos_excluidos_sin_desglose || [],
    },
  };
}

module.exports = {
  BUCKET_COMPROBANTES,
  URL_FIRMADA_SEGUNDOS,
  STATUS_POR_RESULTADO,
  esMesValido,
  mesSiguiente,
  mesAnterior,
  mesDeInstante,
  mesDePedido,
  ultimoMesCerrado,
  rangoMes: rangoMesGuatemalaUTC,
  domingoDePascua,
  feriadosGuatemala,
  fechaLimitePago,
  planDeLiquidacion,
  validarOrdenLiquidacion,
  montosPedido,
  resumirPendientes,
  cargarPedidosPendientes,
  cargarLiquidacionesVivas,
  planParaNegocio,
  generarPdfLiquidacion,
  cuadraLiquidacion,
  folioDe,
  rutaComprobante,
  guardarComprobante,
  guardarComprobanteSeguro,
  urlFirmadaComprobante,
  crearLiquidacionMensual,
};
