// Liquidaciones mensuales (Fase B, Semana 2):
//   · calendario: corte por mes en hora de Guatemala, fecha límite de pago
//     (3er día hábil del mes siguiente, sin asuetos);
//   · orden: del mes más antiguo al más reciente, con arrastre de pedidos
//     entregados después del corte de su mes;
//   · comprobante PDF con los montos guardados, en el bucket privado, servido
//     solo por URL firmada;
//   · rutas admin y comercio por HTTP sobre Supabase en memoria (RPC emulada).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, storage, llamadasRpc, reiniciar, iniciar, detener, pedir, pedidoPagado, mesRelativo,
} = require('./helpers/appLiquidaciones');
const L = require('../services/liquidaciones');

// Texto visible de un PDF sin comprimir (pdfkit escribe hex partido por kerning).
function textoPdf(buffer) {
  return (buffer.toString('latin1').match(/\[[^\]]*\] TJ/g) || [])
    .map((tj) => (tj.match(/<([0-9a-f]+)>/g) || [])
      .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''))
    .join('\n');
}

const LIQ_BASE = {
  id: '11111111-2222-4333-8444-555555555555', negocio_id: IDS.olaAzul, mes: '2026-09',
  periodo_inicio: '2026-09-01T06:00:00.000Z', periodo_fin: '2026-10-01T06:00:00.000Z',
  folio: 'LIQ-202609-ABCDEF12', monto: 37.25, ventas_brutas: 45, comision_bocara: 11.25,
  comision_plataforma: 1.68, propinas: 2, costo_envio: 1.5, total_pedidos: 4,
  estado: 'pendiente', fecha_limite_pago: '2026-10-06T05:59:59.000Z',
};

// ── Calendario ───────────────────────────────────────────────────────────────

test('mesSiguiente / mesAnterior cruzan el cambio de año', () => {
  assert.equal(L.mesSiguiente('2026-12'), '2027-01');
  assert.equal(L.mesAnterior('2026-01'), '2025-12');
  assert.equal(L.mesSiguiente('2026-09'), '2026-10');
});

test('mesDeInstante usa la hora de Guatemala (UTC-6) en los bordes del mes', () => {
  assert.equal(L.mesDeInstante('2026-09-01T05:59:59Z'), '2026-08'); // 31-ago 23:59:59 GT
  assert.equal(L.mesDeInstante('2026-09-01T06:00:00Z'), '2026-09'); // 1-sep 00:00 GT
  assert.equal(L.mesDeInstante('2026-10-01T05:59:59Z'), '2026-09');
  assert.equal(L.mesDeInstante(null), null);
  assert.equal(L.mesDeInstante('no-es-fecha'), null);
});

test('mesDePedido corta por pagado_en y cae a created_at en pedidos viejos', () => {
  assert.equal(L.mesDePedido({ pagado_en: '2026-09-01T06:00:00Z', created_at: '2026-08-31T12:00:00Z' }), '2026-09');
  assert.equal(L.mesDePedido({ pagado_en: null, created_at: '2026-08-31T12:00:00Z' }), '2026-08');
});

test('ultimoMesCerrado es el mes anterior al actual en Guatemala', () => {
  assert.equal(L.ultimoMesCerrado(new Date('2026-10-06T12:00:00Z')), '2026-09');
  // 1-oct 03:00 UTC sigue siendo 30-sep en Guatemala → último cerrado = agosto
  assert.equal(L.ultimoMesCerrado(new Date('2026-10-01T03:00:00Z')), '2026-08');
  assert.equal(L.ultimoMesCerrado(new Date('2027-01-15T12:00:00Z')), '2026-12');
});

test('domingoDePascua coincide con fechas conocidas', () => {
  assert.equal(L.domingoDePascua(2024), '2024-03-31');
  assert.equal(L.domingoDePascua(2025), '2025-04-20');
  assert.equal(L.domingoDePascua(2026), '2026-04-05');
  assert.equal(L.domingoDePascua(2027), '2027-03-28');
});

test('feriadosGuatemala incluye Jueves y Viernes Santo y asuetos fijos', () => {
  const f = L.feriadosGuatemala(2026);
  for (const d of ['2026-01-01', '2026-04-02', '2026-04-03', '2026-05-01', '2026-06-30', '2026-09-15', '2026-10-20', '2026-11-01', '2026-12-25']) {
    assert.ok(f.has(d), d);
  }
  assert.ok(!f.has('2026-12-24'), '24-dic es medio día: cuenta como hábil');
});

test('fechaLimitePago: 3er día hábil del mes siguiente a las 23:59:59 GT', () => {
  // oct-2026: jue 1, vie 2, lun 5 → 5-oct
  assert.deepEqual(L.fechaLimitePago('2026-09'), { fecha: '2026-10-05', limiteISO: '2026-10-06T05:59:59.000Z' });
  // ene-2026: 1 feriado (jue); vie 2, lun 5, mar 6 → 6-ene
  assert.equal(L.fechaLimitePago('2025-12').fecha, '2026-01-06');
  // abr-2026: mié 1; jue 2 y vie 3 Santos; lun 6, mar 7 → 7-abr
  assert.equal(L.fechaLimitePago('2026-03').fecha, '2026-04-07');
  // may-2026: vie 1 feriado; lun 4, mar 5, mié 6 → 6-may
  assert.equal(L.fechaLimitePago('2026-04').fecha, '2026-05-06');
  // asueto extra configurable
  assert.equal(L.fechaLimitePago('2026-09', { feriadosExtra: ['2026-10-02'] }).fecha, '2026-10-06');
  assert.equal(L.fechaLimitePago('2026-13'), null);
});

// ── Orden y arrastre ─────────────────────────────────────────────────────────

test('planDeLiquidacion: meses con pedidos, en orden, solo cerrados', () => {
  const plan = L.planDeLiquidacion({
    mesesConPedidos: ['2026-08', '2026-06', '2026-08', '2026-10'], mesesLiquidados: [], ultimoCerrado: '2026-09',
  });
  assert.deepEqual(plan, { mesesAGenerar: ['2026-06', '2026-08'], mesRequerido: '2026-06' });
});

test('planDeLiquidacion: un pedido de un mes ya liquidado se arrastra al siguiente sin liquidar', () => {
  // Pagado en sep (ya liquidado), entregado en oct: va a octubre…
  const enCurso = L.planDeLiquidacion({ mesesConPedidos: ['2026-09'], mesesLiquidados: ['2026-09'], ultimoCerrado: '2026-09' });
  assert.deepEqual(enCurso, { mesesAGenerar: [], mesRequerido: null }, 'octubre aún no cierra');
  // …que es liquidable cuando octubre cierra.
  const cerrado = L.planDeLiquidacion({ mesesConPedidos: ['2026-09'], mesesLiquidados: ['2026-09'], ultimoCerrado: '2026-10' });
  assert.deepEqual(cerrado.mesesAGenerar, ['2026-10']);
  // Varios meses liquidados seguidos
  const saltos = L.planDeLiquidacion({ mesesConPedidos: ['2026-07'], mesesLiquidados: ['2026-07', '2026-08'], ultimoCerrado: '2026-09' });
  assert.deepEqual(saltos.mesesAGenerar, ['2026-09']);
});

test('validarOrdenLiquidacion bloquea saltarse un mes anterior pendiente', () => {
  const plan = { mesesAGenerar: ['2026-07', '2026-08'], mesRequerido: '2026-07' };
  assert.deepEqual(L.validarOrdenLiquidacion('2026-08', plan), { mes_requerido: '2026-07' });
  assert.equal(L.validarOrdenLiquidacion('2026-07', plan), null);
  assert.equal(L.validarOrdenLiquidacion('2026-06', plan), null, 'meses anteriores los resuelve la RPC');
  assert.equal(L.validarOrdenLiquidacion('2026-09', { mesesAGenerar: [], mesRequerido: null }), null);
});

// ── Montos ───────────────────────────────────────────────────────────────────

test('montosPedido: snapshot primero, columnas en pedidos viejos, null sin neto', () => {
  const conSnap = L.montosPedido({
    snapshot_financiero: { subtotal_productos: 20, comision_bocara: 5, comision_pasarela: 0.74, propina: 0, costo_envio: 1, monto_neto_restaurante: 16 },
    monto_neto_restaurante: 999, comision_bocara: 999,
  });
  assert.deepEqual(conSnap, { neto: 16, comision: 5, plataforma: 0.74, propina: 0, envio: 1, bruto: 20 });
  const legacy = L.montosPedido({ monto_neto_restaurante: 5.25, comision_bocara: 1.25, comision_pasarela: 0.2, propina: 1, costo_envio: 0.5 });
  assert.equal(legacy.neto, 5.25);
  assert.equal(legacy.bruto, 5); // 5.25 − 1 − 0.5 + 1.25
  assert.equal(L.montosPedido({ comision_bocara: 1 }).neto, null);
});

test('resumirPendientes: solo lo liquidable hoy, suma liquidaciones pendientes, campos de la app admin', () => {
  const ped = (mes, extra = {}) => ({
    negocio_id: 'n1', pagado_en: `${mes}-15T18:00:00Z`, negocios: { nombre: 'N1', datos_bancarios: { banco: 'BI' } },
    snapshot_financiero: { subtotal_productos: 10, comision_bocara: 2.5, comision_pasarela: 0.35, propina: 0, costo_envio: 0, monto_neto_restaurante: 7.5 },
    ...extra,
  });
  const [r] = L.resumirPendientes({
    pedidos: [
      ped('2026-08'), ped('2026-09'),
      ped('2026-10'),                                 // mes en curso → no liquidable aún
      ped('2026-07'),                                 // julio ya liquidado → arrastre a agosto
      ped('2026-08', { snapshot_financiero: null }),  // sin neto en ninguna fuente
    ],
    liquidacionesVivas: [
      { id: 'l7', negocio_id: 'n1', mes: '2026-07', estado: 'pagado', monto: 100 },
      { id: 'l6', negocio_id: 'n1', mes: '2026-06', estado: 'pendiente', monto: 20, ventas_brutas: 25, comision_bocara: 6.25, comision_plataforma: 0.9, propinas: 1, costo_envio: 0.25, total_pedidos: 2, folio: 'LIQ-202606-X' },
    ],
    ultimoCerrado: '2026-09',
  });
  assert.equal(r.nombre, 'N1');
  assert.deepEqual(r.datos_bancarios, { banco: 'BI' });
  assert.deepEqual(r.meses_a_liquidar, ['2026-08', '2026-09']);
  assert.equal(r.mes_requerido, '2026-08');
  assert.equal(r.pedidos, 3 + 2);                    // ago, sep, jul(arrastre) + 2 de la liquidación pendiente
  assert.equal(r.neto, 7.5 * 3 + 20);                // 42.5
  assert.equal(r.bruto, 30 + 25);
  assert.equal(r.comisionBocara, 7.5 + 6.25);
  assert.equal(r.cargoPlataforma, 1.95);             // 0.35 × 3 + 0.9, redondeado a centavos
  assert.equal(r.pedidosSinDesglose, 1);
  assert.equal(r.pedidosNoLiquidablesAun, 1);
  assert.equal(r.netoNoLiquidableAun, 7.5);
  assert.deepEqual(r.liquidaciones_pendientes.map((l) => l.id), ['l6']);
});

test('cuadraLiquidacion: neto = bruto − comisión + propinas + envío', () => {
  assert.equal(L.cuadraLiquidacion(LIQ_BASE), true); // 45 − 11.25 + 2 + 1.5 = 37.25
  assert.equal(L.cuadraLiquidacion({ ...LIQ_BASE, monto: 40 }), false);
});

test('folioDe y rutaComprobante: folio propio o derivado para liquidaciones históricas', () => {
  assert.equal(L.folioDe(LIQ_BASE), 'LIQ-202609-ABCDEF12');
  assert.equal(L.rutaComprobante(LIQ_BASE), `${IDS.olaAzul}/2026-09/LIQ-202609-ABCDEF12.pdf`);
  const historica = { id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111', negocio_id: 'n', mes: null, folio: null };
  assert.equal(L.folioDe(historica), 'LIQ-HIST-AAAABBBB');
  assert.equal(L.rutaComprobante(historica), 'n/historico/LIQ-HIST-AAAABBBB.pdf');
});

// ── PDF ──────────────────────────────────────────────────────────────────────

test('PDF pendiente: folio, comercio, periodo, montos exactos y fecha límite', async () => {
  const pdf = await L.generarPdfLiquidacion(LIQ_BASE, { nombre: 'Ola Azul' }, { compress: false });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const t = textoPdf(pdf);
  for (const esperado of [
    'Folio LIQ-202609-ABCDEF12', 'Ola Azul', 'septiembre 2026', '01/09/2026 al 30/09/2026',
    'Pedidos incluidos: 4', 'Pendiente de pago', 'Fecha límite de pago: 05/10/2026',
    'Q45.00', '-Q11.25', 'Q2.00', 'Q1.50', 'Neto a pagar al comercio', 'Q37.25', 'Q1.68',
  ]) {
    assert.ok(t.includes(esperado), `falta "${esperado}" en:\n${t}`);
  }
});

test('PDF pagado: muestra fecha de pago y referencia en lugar de fecha límite', async () => {
  const pdf = await L.generarPdfLiquidacion({
    ...LIQ_BASE, estado: 'pagado', pagado_en: '2026-10-03T16:00:00Z', datos_transferencia: { referencia: 'TRX-778' },
  }, { nombre: 'Ola Azul' }, { compress: false });
  const t = textoPdf(pdf);
  assert.ok(t.includes('Estado: Pagado'), t);
  assert.ok(t.includes('Pagado el 03/10/2026'), t);
  assert.ok(t.includes('Referencia TRX-778'), t);
  assert.ok(!t.includes('Fecha límite'), t);
});

// ── Rutas (HTTP) ─────────────────────────────────────────────────────────────

const M1 = mesRelativo(-1); // último mes cerrado
const M2 = mesRelativo(-2);
const M0 = mesRelativo(0);  // mes en curso
const sembrar = (...pedidos) => { fake.tabla('pedidos').push(...pedidos); return pedidos; };
const liquidaciones = () => fake.tabla('liquidaciones');
const crear = (body, como = IDS.admin) => pedir('POST', '/api/admin/liquidaciones', { como, body });

test.before(iniciar);
test.after(detener);
test.beforeEach(reiniciar);

test('POST /admin/liquidaciones: crea vía RPC, sube el PDF al bucket privado y guarda la ruta', async () => {
  sembrar(pedidoPagado({ mes: M1 }), pedidoPagado({ mes: M1, neto: 16 }));
  const r = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.liquidacion.estado, 'pendiente');
  assert.equal(r.body.liquidacion.monto, 23.5);
  assert.equal(r.body.liquidacion.total_pedidos, 2);

  const [llamada] = llamadasRpc;
  assert.equal(llamada.nombre, 'crear_liquidacion_mensual_atomica');
  assert.deepEqual(llamada.params, {
    p_negocio_id: IDS.olaAzul, p_mes: M1, p_admin_id: IDS.admin, p_fecha_limite: L.fechaLimitePago(M1).limiteISO,
  });

  const ruta = L.rutaComprobante(r.body.liquidacion);
  assert.equal(r.body.comprobante.path, ruta);
  const obj = storage.objetos.get(`${L.BUCKET_COMPROBANTES}/${ruta}`);
  assert.ok(obj, 'PDF subido');
  assert.equal(obj.contentType, 'application/pdf');
  assert.equal(obj.buffer.subarray(0, 5).toString(), '%PDF-');
  const fila = liquidaciones()[0];
  assert.equal(fila.comprobante_path, ruta);
  assert.ok(fila.comprobante_generado_en);
});

test('POST /admin/liquidaciones: exige ir del mes más antiguo al más reciente', async () => {
  sembrar(pedidoPagado({ mes: M2 }), pedidoPagado({ mes: M1 }));
  const saltado = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  assert.equal(saltado.status, 409);
  assert.equal(saltado.body.resultado, 'mes_anterior_pendiente');
  assert.equal(saltado.body.mes_requerido, M2);
  assert.equal(llamadasRpc.length, 0, 'no llega a la RPC');

  assert.equal((await crear({ negocio_id: IDS.olaAzul, mes: M2 })).status, 201);
  const siguiente = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  assert.equal(siguiente.status, 201);
  assert.equal(siguiente.body.liquidacion.total_pedidos, 1, 'cada mes con lo suyo');
});

test('POST /admin/liquidaciones: arrastre — pedido del mes ya liquidado entra en el siguiente', async () => {
  const [, tardio] = sembrar(pedidoPagado({ mes: M2 }), pedidoPagado({ mes: M2, estado: 'confirmado' }));
  assert.equal((await crear({ negocio_id: IDS.olaAzul, mes: M2 })).status, 201);
  tardio.estado = 'completado'; // se entrega después del corte
  const r = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(tardio.liquidacion_id, r.body.liquidacion.id);
});

test('POST /admin/liquidaciones: errores de la RPC → status HTTP claros', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  assert.equal((await crear({ negocio_id: IDS.olaAzul, mes: '2026-9' })).status, 400);
  assert.equal((await crear({ mes: M1 })).status, 400);
  const enCurso = await crear({ negocio_id: IDS.olaAzul, mes: M0 });
  assert.equal(enCurso.status, 422);
  assert.equal(enCurso.body.resultado, 'mes_en_curso');
  assert.equal((await crear({ negocio_id: '00000000-0000-4000-8000-00000000ffff', mes: M1 })).status, 404);
  assert.equal((await crear({ negocio_id: IDS.otroNegocio, mes: M1 })).body.resultado, 'sin_pedidos_pendientes');
  assert.equal((await crear({ negocio_id: IDS.olaAzul, mes: M1 })).status, 201);
  const repetida = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.body.resultado, 'mes_ya_liquidado');
});

test('POST /admin/liquidaciones: solo admin', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  assert.equal((await crear({ negocio_id: IDS.olaAzul, mes: M1 }, IDS.restaurante)).status, 403);
  assert.equal(liquidaciones().length, 0);
});

test('POST /admin/liquidaciones: si el Storage falla la liquidación queda creada y el PDF se genera al descargar', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  storage.fallarUpload = true;
  const warn = console.warn; console.warn = () => {};
  let r;
  try { r = await crear({ negocio_id: IDS.olaAzul, mes: M1 }); } finally { console.warn = warn; }
  assert.equal(r.status, 201);
  assert.equal(r.body.comprobante, null);
  assert.equal(liquidaciones()[0].comprobante_path, null);

  storage.fallarUpload = false;
  const c = await pedir('GET', `/api/admin/liquidaciones/${r.body.liquidacion.id}/comprobante`, { como: IDS.admin });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.ok(liquidaciones()[0].comprobante_path, 'generado bajo demanda');
});

test('GET /admin/liquidaciones/:id/comprobante: URL firmada de 10 min, con descarga opcional', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  const { body } = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  const r = await pedir('GET', `/api/admin/liquidaciones/${body.liquidacion.id}/comprobante?descargar=1`, { como: IDS.admin });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/storage\.test\/bocara-comprobantes\/.+\?token=firmado&expires=600&download=LIQ-/);
  assert.equal(r.body.folio, body.liquidacion.folio);
  const firma = storage.firmas.at(-1);
  assert.equal(firma.segundos, 600);
  assert.ok(firma.segundos >= 300 && firma.segundos <= 900);
  assert.deepEqual(firma.opciones, { download: `${body.liquidacion.folio}.pdf` });
  assert.equal((await pedir('GET', '/api/admin/liquidaciones/no-existe/comprobante', { como: IDS.admin })).status, 404);
  assert.equal((await pedir('GET', `/api/admin/liquidaciones/${body.liquidacion.id}/comprobante`, { como: IDS.restaurante })).status, 403);
});

test('GET /admin/liquidaciones: filtros por mes/estado y pendientes compatibles con la app admin', async () => {
  sembrar(pedidoPagado({ mes: M2 }), pedidoPagado({ mes: M1 }), pedidoPagado({ mes: M0 }));
  sembrar(pedidoPagado({ negocioId: IDS.otroNegocio, mes: M1, neto: 3 }));
  await crear({ negocio_id: IDS.olaAzul, mes: M2 });

  const todo = await pedir('GET', '/api/admin/liquidaciones', { como: IDS.admin });
  assert.equal(todo.status, 200);
  assert.equal(todo.body.ultimo_mes_cerrado, M1);
  const ola = todo.body.pendientes.find((p) => p.negocio_id === IDS.olaAzul);
  // M2 ya generada (pendiente de pago) + M1 liquidable; M0 aún no
  assert.equal(ola.neto, 15);
  assert.equal(ola.pedidos, 2);
  assert.equal(ola.netoNoLiquidableAun, 7.5);
  assert.deepEqual(ola.meses_a_liquidar, [M1]);
  for (const campo of ['nombre', 'bruto', 'comisionBocara', 'cargoPlataforma', 'propinas', 'pedidosSinDesglose', 'datos_bancarios']) {
    assert.ok(campo in ola, campo);
  }
  assert.equal(todo.body.historial.length, 1);

  const porMes = await pedir('GET', `/api/admin/liquidaciones?mes=${M1}`, { como: IDS.admin });
  assert.equal(porMes.body.liquidaciones.length, 0);
  const porEstado = await pedir('GET', '/api/admin/liquidaciones?estado=pendiente', { como: IDS.admin });
  assert.equal(porEstado.body.liquidaciones.length, 1);
  assert.equal((await pedir('GET', '/api/admin/liquidaciones?mes=2026-13', { como: IDS.admin })).status, 400);
  assert.equal((await pedir('GET', '/api/admin/liquidaciones?estado=raro', { como: IDS.admin })).status, 400);
});

test('POST /admin/liquidaciones/:negocio/pagar (contrato legacy): genera en orden vía RPC y paga lo que mostró pendientes', async () => {
  sembrar(pedidoPagado({ mes: M2 }), pedidoPagado({ mes: M1, neto: 16 }), pedidoPagado({ mes: M0 }));
  const antes = await pedir('GET', '/api/admin/liquidaciones', { como: IDS.admin });
  const mostrado = antes.body.pendientes.find((p) => p.negocio_id === IDS.olaAzul).neto;

  const r = await pedir('POST', `/api/admin/liquidaciones/${IDS.olaAzul}/pagar`, {
    como: IDS.admin, body: { datos_transferencia: { referencia: ' TRX-1 ', banco: 'BI' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.monto_total, mostrado, 'paga exactamente lo que la app mostró');
  assert.deepEqual(llamadasRpc.map((c) => c.params.p_mes), [M2, M1], 'del más antiguo al más reciente');
  assert.equal(r.body.liquidaciones.length, 2);
  for (const l of liquidaciones()) {
    assert.equal(l.estado, 'pagado');
    assert.equal(l.pagado_por, IDS.admin);
    assert.equal(l.datos_transferencia.referencia, 'TRX-1');
    assert.ok(l.comprobante_path, 'PDF regenerado como pagado');
  }
  const enCurso = fake.tabla('pedidos').find((p) => p.pagado_en.startsWith(M0));
  assert.equal(enCurso.liquidacion_id, null, 'el mes en curso no se paga');
  assert.ok(fake.tabla('notificaciones').some((n) => n.usuario_id === IDS.restaurante && n.tipo === 'liquidacion'));

  const otraVez = await pedir('POST', `/api/admin/liquidaciones/${IDS.olaAzul}/pagar`, {
    como: IDS.admin, body: { datos_transferencia: { referencia: 'TRX-2' } },
  });
  assert.equal(otraVez.status, 400);
});

test('POST /admin/liquidaciones/:liquidacion/pagar: paga una sola; segundo pago → 409', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  const { body } = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  const pagar = () => pedir('POST', `/api/admin/liquidaciones/${body.liquidacion.id}/pagar`, {
    como: IDS.admin, body: { datos_transferencia: { referencia: 'TRX-9' } },
  });
  const r = await pagar();
  assert.equal(r.status, 200);
  assert.equal(r.body.liquidacion.estado, 'pagado');
  assert.equal((await pagar()).status, 409);
});

test('POST pagar sin referencia → 400 y nada cambia', async () => {
  sembrar(pedidoPagado({ mes: M1 }));
  const r = await pedir('POST', `/api/admin/liquidaciones/${IDS.olaAzul}/pagar`, { como: IDS.admin, body: {} });
  assert.equal(r.status, 400);
  assert.equal(liquidaciones().length, 0);
});

test('el endpoint legacy nunca reasigna pedidos de una liquidación mensual existente', async () => {
  const [p] = sembrar(pedidoPagado({ mes: M1 }));
  const { body } = await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  await pedir('POST', `/api/admin/liquidaciones/${IDS.olaAzul}/pagar`, {
    como: IDS.admin, body: { datos_transferencia: { referencia: 'TRX-3' } },
  });
  assert.equal(p.liquidacion_id, body.liquidacion.id);
  assert.equal(liquidaciones().length, 1, 'no creó una liquidación paralela');
});

test('GET /negocios/mi-negocio/liquidaciones: solo las propias, sin campos internos', async () => {
  sembrar(pedidoPagado({ mes: M1 }), pedidoPagado({ negocioId: IDS.otroNegocio, mes: M1 }));
  await crear({ negocio_id: IDS.olaAzul, mes: M1 });
  await crear({ negocio_id: IDS.otroNegocio, mes: M1 });
  await pedir('POST', `/api/admin/liquidaciones/${IDS.olaAzul}/pagar`, {
    como: IDS.admin, body: { datos_transferencia: { referencia: 'TRX-5', banco: 'BI', cuenta: '123' } },
  });

  const r = await pedir('GET', '/api/negocios/mi-negocio/liquidaciones', { como: IDS.restaurante });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const [l] = r.body;
  assert.equal(l.mes, M1);
  assert.deepEqual(l.datos_transferencia, { referencia: 'TRX-5' });
  for (const interno of ['comprobante_path', 'creada_por', 'pagado_por', 'negocio_id']) assert.ok(!(interno in l), interno);
  assert.equal((await pedir('GET', `/api/negocios/mi-negocio/liquidaciones?mes=${M0}`, { como: IDS.restaurante })).body.length, 0);
  assert.equal((await pedir('GET', '/api/negocios/mi-negocio/liquidaciones?mes=x', { como: IDS.restaurante })).status, 400);
});

test('GET /negocios/mi-negocio/liquidaciones/:id/comprobante: ownership estricto', async () => {
  sembrar(pedidoPagado({ mes: M1 }), pedidoPagado({ negocioId: IDS.otroNegocio, mes: M1 }));
  const propia = (await crear({ negocio_id: IDS.olaAzul, mes: M1 })).body.liquidacion;
  const ajena = (await crear({ negocio_id: IDS.otroNegocio, mes: M1 })).body.liquidacion;

  const ok = await pedir('GET', `/api/negocios/mi-negocio/liquidaciones/${propia.id}/comprobante`, { como: IDS.restaurante });
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /expires=600/);
  assert.deepEqual(Object.keys(ok.body).sort(), ['expira_en', 'folio', 'url'], 'no expone la ruta interna');

  const otro = await pedir('GET', `/api/negocios/mi-negocio/liquidaciones/${ajena.id}/comprobante`, { como: IDS.restaurante });
  assert.equal(otro.status, 404);
  const firmasAntes = storage.firmas.length;
  await pedir('GET', `/api/negocios/mi-negocio/liquidaciones/${ajena.id}/comprobante`, { como: IDS.cliente });
  assert.equal(storage.firmas.length, firmasAntes, 'un cliente tampoco obtiene URL');

  const anulada = liquidaciones().find((l) => l.id === propia.id);
  anulada.estado = 'anulado';
  assert.equal((await pedir('GET', `/api/negocios/mi-negocio/liquidaciones/${propia.id}/comprobante`, { como: IDS.restaurante })).status, 404);
});
