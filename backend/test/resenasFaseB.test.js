// Reseñas verificadas (Fase B, Semana 2):
//   · validaciones: calificación entera 1–5, comentario ≤ 500 caracteres
//     (contados como char_length de Postgres);
//   · 409 ante pedido ya calificado (pre-chequeo y carrera contra UNIQUE);
//   · el promedio ya NO se escribe desde Node (lo hace el trigger de la base);
//   · respuesta del comercio, auditoría y moderación del admin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, reiniciar, iniciar, detener, pedir, pedidoPagado } = require('./helpers/appLiquidaciones');
const R = require('../services/resenas');

// ── Validaciones (unidad) ────────────────────────────────────────────────────

test('validarCalificacion: solo enteros 1–5 (acepta "5" de formularios)', () => {
  for (const ok of [1, 3, 5, '4', ' 2 ']) assert.ok(R.validarCalificacion(ok).valor >= 1, String(ok));
  assert.equal(R.validarCalificacion('5').valor, 5);
  for (const mal of [0, 6, 4.5, '4.5', '', 'cinco', true, null, NaN, -1, [5]]) {
    assert.ok(R.validarCalificacion(mal).error, String(mal));
  }
});

test('validarComentario: opcional, recorta, ≤ 500 caracteres como char_length', () => {
  assert.deepEqual(R.validarComentario(undefined), { valor: null });
  assert.deepEqual(R.validarComentario('   '), { valor: null });
  assert.deepEqual(R.validarComentario('  rico  '), { valor: 'rico' });
  assert.equal(R.validarComentario('a'.repeat(500)).valor.length, 500);
  assert.ok(R.validarComentario('a'.repeat(501)).error);
  // 500 emojis son 1000 unidades UTF-16 pero 500 caracteres para Postgres
  assert.ok(R.validarComentario('😀'.repeat(500)).valor);
  assert.ok(R.validarComentario('😀'.repeat(501)).error);
  assert.ok(R.validarComentario(123).error);
});

test('validarRespuesta: obligatoria y ≤ 500', () => {
  assert.ok(R.validarRespuesta('').error);
  assert.ok(R.validarRespuesta(null).error);
  assert.ok(R.validarRespuesta('x'.repeat(501)).error);
  assert.deepEqual(R.validarRespuesta(' ¡Gracias! '), { valor: '¡Gracias!' });
});

test('validarModeracion: visible booleano; ocultar exige motivo', () => {
  assert.ok(R.validarModeracion({ visible: 'false' }).error);
  assert.ok(R.validarModeracion({ visible: false }).error);
  assert.ok(R.validarModeracion({ visible: false, motivo: '   ' }).error);
  assert.deepEqual(R.validarModeracion({ visible: false, motivo: ' spam ' }).valor, { visible: false, motivo: 'spam' });
  assert.deepEqual(R.validarModeracion({ visible: true }).valor, { visible: true, motivo: null });
  assert.ok(R.validarModeracion({ visible: true, motivo: 'x'.repeat(301) }).error);
});

// ── Rutas (HTTP) ─────────────────────────────────────────────────────────────

test.before(iniciar);
test.after(detener);
test.beforeEach(reiniciar);

const negocio = (id = IDS.olaAzul) => fake.tabla('negocios').find((n) => n.id === id);
function pedidoEntregado(extra = {}) {
  const p = pedidoPagado({ mes: '2026-09', ...extra });
  fake.tabla('pedidos').push(p);
  return p;
}
const resenar = (body, como = IDS.cliente) => pedir('POST', '/api/resenas', { como, body });
function sembrarResena(extra = {}) {
  const r = {
    id: `00000000-0000-4000-a000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    pedido_id: null, usuario_id: IDS.cliente, negocio_id: IDS.olaAzul, calificacion: 4, comentario: 'ok',
    visible: true, created_at: new Date().toISOString(), ...extra,
  };
  fake.tabla('resenas').push(r);
  return r;
}

test('POST /resenas: crea la reseña y NO toca calificacion_promedio/total_resenas (lo hace el trigger)', async () => {
  const p = pedidoEntregado();
  const r = await resenar({ pedido_id: p.id, negocio_id: IDS.olaAzul, calificacion: 1, comentario: '  frío  ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.calificacion, 1);
  assert.equal(r.body.comentario, 'frío');
  assert.equal(r.body.usuario_id, IDS.cliente);
  // Valores sembrados intactos: Node ya no recalcula (antes los habría pisado con 1.0 / 1)
  assert.equal(negocio().calificacion_promedio, 4.5);
  assert.equal(negocio().total_resenas, 2);
});

test('POST /resenas: validaciones de calificación y comentario → 400', async () => {
  const p = pedidoEntregado();
  const base = { pedido_id: p.id, negocio_id: IDS.olaAzul };
  for (const calificacion of [4.5, 0, 6, 'abc', true]) {
    const r = await resenar({ ...base, calificacion });
    assert.equal(r.status, 400, `calificacion=${calificacion}`);
  }
  assert.equal((await resenar({ ...base, calificacion: 5, comentario: 'x'.repeat(501) })).status, 400);
  assert.equal((await resenar({ negocio_id: IDS.olaAzul, calificacion: 5 })).status, 400);
  assert.equal(fake.tabla('resenas').length, 0);
  assert.equal((await resenar({ ...base, calificacion: '5', comentario: '😀'.repeat(500) })).status, 201);
});

test('POST /resenas: pedido ajeno, de otro negocio o no entregado → 403', async () => {
  const ajeno = pedidoEntregado({ usuario_id: IDS.otroRestaurante });
  const noEntregado = pedidoEntregado({ estado: 'confirmado' });
  const p = pedidoEntregado();
  assert.equal((await resenar({ pedido_id: ajeno.id, negocio_id: IDS.olaAzul, calificacion: 5 })).status, 403);
  assert.equal((await resenar({ pedido_id: noEntregado.id, negocio_id: IDS.olaAzul, calificacion: 5 })).status, 403);
  assert.equal((await resenar({ pedido_id: p.id, negocio_id: IDS.otroNegocio, calificacion: 5 })).status, 403);
  const legacy = pedidoEntregado({ estado: 'recogido' });
  assert.equal((await resenar({ pedido_id: legacy.id, negocio_id: IDS.olaAzul, calificacion: 5 })).status, 201, "'recogido' es el nombre antiguo de completado");
});

test('POST /resenas: pedido ya calificado → 409', async () => {
  const p = pedidoEntregado();
  assert.equal((await resenar({ pedido_id: p.id, negocio_id: IDS.olaAzul, calificacion: 5 })).status, 201);
  const otra = await resenar({ pedido_id: p.id, negocio_id: IDS.olaAzul, calificacion: 2 });
  assert.equal(otra.status, 409);
  assert.equal(otra.body.error, 'Ya calificaste este pedido');
  assert.ok(otra.body.resena_id);
  assert.equal(fake.tabla('resenas').length, 1);
});

test('POST /resenas: carrera entre el pre-chequeo y el insert (UNIQUE 23505) → 409, no 400', async () => {
  const p = pedidoEntregado();
  // Simula que otra petición insertó entre el pre-chequeo y el insert: el
  // pre-chequeo no ve nada y el insert choca con UNIQUE(pedido_id).
  const original = fake.from;
  fake.from = (tabla) => {
    const q = original(tabla);
    if (tabla !== 'resenas') return q;
    const insert = q.insert.bind(q);
    q.insert = (filas) => { insert(filas); q._ejecutar = () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "resenas_pedido_id_key"' } }); return q; };
    return q;
  };
  try {
    const r = await resenar({ pedido_id: p.id, negocio_id: IDS.olaAzul, calificacion: 5 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'Ya calificaste este pedido');
  } finally {
    fake.from = original;
  }
});

test('GET /resenas/:negocio_id (público): solo reseñas visibles, con respuesta del comercio', async () => {
  sembrarResena({ comentario: 'visible', respuesta_restaurante: '¡Gracias!' });
  sembrarResena({ comentario: 'spam', visible: false });
  const r = await pedir('GET', `/api/resenas/${IDS.olaAzul}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.comentario), ['visible']);
  assert.equal(r.body[0].respuesta_restaurante, '¡Gracias!');
  assert.ok(!('usuario_id' in r.body[0]) && !('motivo_moderacion' in r.body[0]), 'no expone datos internos');
});

test('GET /resenas/mis-resenas: el cliente ve también las suyas ocultas', async () => {
  sembrarResena({ visible: false });
  sembrarResena();
  const r = await pedir('GET', '/api/resenas/mis-resenas', { como: IDS.cliente });
  assert.equal(r.body.length, 2);
});

test('GET /resenas/restaurante: comercio ve las suyas; admin debe indicar negocio_id (antes 404)', async () => {
  sembrarResena();
  sembrarResena({ negocio_id: IDS.otroNegocio });
  const propio = await pedir('GET', '/api/resenas/restaurante', { como: IDS.restaurante });
  assert.equal(propio.status, 200);
  assert.equal(propio.body.length, 1);
  assert.equal((await pedir('GET', '/api/resenas/restaurante', { como: IDS.admin })).status, 400);
  const admin = await pedir('GET', `/api/resenas/restaurante?negocio_id=${IDS.otroNegocio}`, { como: IDS.admin });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.length, 1);
  assert.equal((await pedir('GET', '/api/resenas/restaurante', { como: IDS.cliente })).status, 403);
});

test('PATCH /resenas/:id/respuesta: el comercio responde las suyas', async () => {
  const r = sembrarResena();
  const ok = await pedir('PATCH', `/api/resenas/${r.id}/respuesta`, { como: IDS.restaurante, body: { respuesta: ' ¡Gracias por venir! ' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.respuesta_restaurante, '¡Gracias por venir!');
  assert.ok(ok.body.respondida_en);
  // Editar la respuesta
  const editada = await pedir('PATCH', `/api/resenas/${r.id}/respuesta`, { como: IDS.restaurante, body: { respuesta: 'Editada' } });
  assert.equal(editada.body.respuesta_restaurante, 'Editada');
});

test('PATCH /resenas/:id/respuesta: ajena → 404, cliente → 403, vacía o larga → 400', async () => {
  const ajena = sembrarResena({ negocio_id: IDS.otroNegocio });
  const propia = sembrarResena();
  const patch = (id, body, como = IDS.restaurante) => pedir('PATCH', `/api/resenas/${id}/respuesta`, { como, body });
  assert.equal((await patch(ajena.id, { respuesta: 'hola' })).status, 404);
  assert.equal(fake.tabla('resenas').find((x) => x.id === ajena.id).respuesta_restaurante, undefined);
  assert.equal((await patch(propia.id, { respuesta: 'hola' }, IDS.cliente)).status, 403);
  assert.equal((await patch(propia.id, { respuesta: '   ' })).status, 400);
  assert.equal((await patch(propia.id, { respuesta: 'x'.repeat(501) })).status, 400);
  assert.equal((await patch('no-existe', { respuesta: 'hola' })).status, 404);
});

test('GET /admin/resenas: auditoría con filtros por negocio y visibilidad', async () => {
  sembrarResena();
  sembrarResena({ visible: false });
  sembrarResena({ negocio_id: IDS.otroNegocio });
  const todas = await pedir('GET', '/api/admin/resenas', { como: IDS.admin });
  assert.equal(todas.status, 200);
  assert.equal(todas.body.length, 3);
  assert.equal(todas.body[0].negocios.nombre !== undefined, true);
  assert.equal((await pedir('GET', `/api/admin/resenas?negocio_id=${IDS.olaAzul}`, { como: IDS.admin })).body.length, 2);
  assert.equal((await pedir('GET', '/api/admin/resenas?visible=false', { como: IDS.admin })).body.length, 1);
  assert.equal((await pedir('GET', '/api/admin/resenas?visible=quizas', { como: IDS.admin })).status, 400);
  assert.equal((await pedir('GET', '/api/admin/resenas', { como: IDS.restaurante })).status, 403);
});

test('PATCH /admin/resenas/:id/moderar: oculta con motivo y deja rastro de auditoría', async () => {
  const r = sembrarResena();
  const moderar = (body, id = r.id, como = IDS.admin) => pedir('PATCH', `/api/admin/resenas/${id}/moderar`, { como, body });
  assert.equal((await moderar({ visible: false })).status, 400, 'motivo obligatorio para ocultar');
  assert.equal((await moderar({ visible: 'no' })).status, 400);
  assert.equal((await moderar({ visible: false, motivo: 'x' }, r.id, IDS.restaurante)).status, 403);
  assert.equal((await moderar({ visible: false, motivo: 'x' }, 'no-existe')).status, 404);

  const oculta = await moderar({ visible: false, motivo: ' Lenguaje ofensivo ' });
  assert.equal(oculta.status, 200, JSON.stringify(oculta.body));
  const fila = fake.tabla('resenas').find((x) => x.id === r.id);
  assert.equal(fila.visible, false);
  assert.equal(fila.motivo_moderacion, 'Lenguaje ofensivo');
  assert.equal(fila.moderada_por, IDS.admin);
  assert.ok(fila.moderada_en);
  assert.equal((await pedir('GET', `/api/resenas/${IDS.olaAzul}`)).body.length, 0, 'ya no es pública');

  const visible = await moderar({ visible: true });
  assert.equal(visible.body.visible, true);
  assert.equal((await pedir('GET', `/api/resenas/${IDS.olaAzul}`)).body.length, 1);
});
