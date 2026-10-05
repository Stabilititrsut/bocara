// Regresiones de la tarea "Publicaciones — ajustes post prueba manual":
//   DELETE-1..4 — eliminación lógica de una publicación
//   VIS-1..5    — el toggle "activo" nunca hace pública una no aprobada
//   TIME-1..2   — hora_recogida_inicio/fin obligatorias al crear
//
// Mismo harness que publicacionesCiclo.test.js: routers reales (bolsas,
// negocios, admin) sobre un doble en memoria de Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');

const HOY = fechaGuatemala(0);
const MANANA = fechaGuatemala(1);
const HORARIO_VIGENTE = {
  hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00',
  fecha_disponible: HOY, fecha_caducidad: MANANA,
};

function promo(extra = {}) {
  return {
    nombre: '2x1 Ceviche', contenido: 'OLA2X1', tipo: 'cupon', categoria: '2x1',
    descripcion: 'Dos ceviches por el precio de uno', precio_original: 120, precio_descuento: 60,
    cantidad_disponible: 5, ...HORARIO_VIGENTE, ...extra,
  };
}
function bolsaTiempoLimitado(extra = {}) {
  return {
    nombre: 'Bolsa sorpresa', tipo: 'bolsa', descripcion: 'Pan del día', precio_original: 80,
    precio_descuento: 35, cantidad_disponible: 3, peso_estimado_kg: 1.2,
    categoria_alimento: 'cereales', ...HORARIO_VIGENTE, ...extra,
  };
}

async function crear(datos, como = IDS.restaurante) {
  const r = await pedir('POST', '/api/bolsas', { como, body: datos });
  assert.equal(r.status, 201, `crear debió responder 201: ${JSON.stringify(r.body)}`);
  return r.body;
}
const aprobar = (id, como = IDS.admin) => pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como });
const rechazar = (id, motivo, como = IDS.admin) => pedir('PUT', `/api/admin/bolsas/${id}/rechazar`, { como, body: { motivo } });
const editar = (id, body, como = IDS.restaurante) => pedir('PUT', `/api/bolsas/${id}`, { como, body });
const eliminar = (id, como = IDS.restaurante) => pedir('DELETE', `/api/bolsas/${id}`, { como });
const fila = (id) => fake.tabla('bolsas').find(b => b.id === id);
const propiasDelRestaurante = async (como = IDS.restaurante) =>
  (await pedir('GET', '/api/bolsas?mi_negocio=true', { como })).body;
const colaAdmin = async () => (await pedir('GET', '/api/admin/contenido/pendiente', { como: IDS.admin })).body;

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

// ════════════════════════════════════════════════════════════════════════════
// DELETE-1/2/3/4 — eliminación lógica
// ════════════════════════════════════════════════════════════════════════════

test('DELETE-1: restaurante elimina una promoción sin relaciones históricas — desaparece de restaurante, admin y cliente', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  assert.equal((await pedir('GET', '/api/bolsas')).body.some(b => b.id === p.id), true, 'antes de eliminar, es pública');

  const r = await eliminar(p.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.tipo, 'eliminada');

  assert.equal((await pedir('GET', '/api/bolsas')).body.some(b => b.id === p.id), false, 'ya no aparece en el feed público (cliente)');
  assert.equal((await pedir('GET', `/api/bolsas/${p.id}`)).status, 404, 'el detalle público ya no es accesible');
  assert.equal((await propiasDelRestaurante()).some(b => b.id === p.id), false, 'ya no aparece en el panel del restaurante');
  assert.equal((await colaAdmin()).some(b => b.id === p.id), false, 'ya no aparece en la cola del admin');

  // La fila sigue existiendo (eliminación lógica, no DELETE físico).
  assert.ok(fila(p.id), 'la fila se conserva internamente (auditoría/historial)');
  assert.ok(fila(p.id).eliminado_en, 'eliminado_en queda registrado');
});

test('DELETE-2: tiempo limitado eliminado tampoco aparece públicamente (mismo comportamiento que una promoción)', async () => {
  const b = await crear(bolsaTiempoLimitado());
  await aprobar(b.id);
  await eliminar(b.id);

  assert.equal((await pedir('GET', '/api/bolsas')).body.some(x => x.id === b.id), false);
  assert.equal((await pedir('GET', `/api/bolsas/${b.id}`)).status, 404);
  assert.equal((await pedir('GET', '/api/negocios/feed')).body.some(n => n.id === IDS.olaAzul), false,
    'sin ninguna otra publicación visible, el negocio tampoco sale en el Home');
});

test('DELETE-3: si hay pedido_items históricos, se conserva la integridad — nunca un DELETE físico', async () => {
  const p = await crear(promo());
  await aprobar(p.id);

  // Pedido histórico real: pedido_items.bolsa_id referencia esta publicación.
  fake.tabla('pedidos').push({ id: 'pedido-historico', negocio_id: IDS.olaAzul, usuario_id: IDS.cliente, estado: 'completado' });
  fake.tabla('pedido_items').push({ id: 'item-historico', pedido_id: 'pedido-historico', bolsa_id: p.id, cantidad: 1 });

  const r = await eliminar(p.id);
  assert.equal(r.status, 200, 'eliminar no debe fallar por tener historial (es lógica, no física)');

  // La fila de bolsas sigue existiendo (si fuera DELETE físico, pedido_items
  // quedaría con una FK rota, o la fila desaparecería).
  assert.ok(fila(p.id), 'la bolsa no se borra físicamente');
  assert.equal(fake.tabla('pedido_items').find(i => i.id === 'item-historico')?.bolsa_id, p.id,
    'el pedido histórico conserva su referencia intacta');

  // Y queda fuera de todos los flujos operativos igual que DELETE-1.
  assert.equal((await pedir('GET', '/api/bolsas')).body.some(x => x.id === p.id), false);
  assert.equal((await propiasDelRestaurante()).some(x => x.id === p.id), false);
  assert.equal((await colaAdmin()).some(x => x.id === p.id), false);
});

test('DELETE-4: una eliminada no puede reactivarse ni por PUT (toggle) ni repitiendo el DELETE ni por aprobar/rechazar', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  await eliminar(p.id);

  // Intento directo por API: activo=true sobre la eliminada.
  const put = await editar(p.id, { activo: true });
  assert.equal(put.status, 410, JSON.stringify(put.body));
  assert.equal(fila(p.id).activo, false, 'activo no cambió');

  // Repetir el DELETE es idempotente, no un error, y no re-audita.
  const otraVez = await eliminar(p.id);
  assert.equal(otraVez.status, 200);
  assert.equal(otraVez.body.tipo, 'ya_eliminada');

  // El admin tampoco puede "resucitarla" aprobando o rechazando.
  const ap = await aprobar(p.id);
  assert.equal(ap.status, 410);
  const rc = await rechazar(p.id, 'motivo');
  assert.equal(rc.status, 410);

  assert.ok(fila(p.id).eliminado_en, 'sigue eliminada después de todos los intentos');
});

// ════════════════════════════════════════════════════════════════════════════
// VIS-1/2/3/4/5 — el toggle nunca hace pública una no aprobada
// ════════════════════════════════════════════════════════════════════════════

test('VIS-2: PUT { activo: true } sobre una RECHAZADA falla (409), sin cambiar nada', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'precio mal');
  assert.equal(fila(p.id).activo, false);

  const r = await editar(p.id, { activo: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(fila(p.id).activo, false, 'el intento no cambió nada');
  assert.equal(fila(p.id).estado_aprobacion, 'rechazado');
});

test('VIS-3: PUT { activo: true } sobre una PENDIENTE (nunca revisada aún) también falla', async () => {
  const p = await crear(promo());
  assert.equal(fila(p.id).estado_aprobacion, 'pendiente');
  // Primera revisión sin decisión: el restaurante ni puede editar (409 propio,
  // ver bloqueadaParaEditar) — el mismo 409 cubre también el intento de activar.
  const r = await editar(p.id, { activo: true });
  assert.equal(r.status, 409);
  await assertOcultaSimple(p.id);
});

test('VIS-3b: PENDIENTE con "pedir cambios" ya resuelto (editable) tampoco se puede activar con el switch', async () => {
  const p = await crear(promo());
  // Llega a pendiente+motivo sin pasar por el endpoint retirado: una corrección
  // sobre una rechazada vuelve a pendiente con motivo limpiado a null — se
  // fuerza el campo directamente en la fake DB para simular el estado legado
  // "pendiente con motivo" sin depender de un endpoint que ya no existe.
  fake.tabla('bolsas').find(b => b.id === p.id).motivo_rechazo = 'corrige esto';
  const r = await editar(p.id, { activo: true });
  assert.equal(r.status, 409, JSON.stringify(r.body));
});

test('VIS-1/VIS-4: corregir una rechazada vuelve a pendiente y SIGUE no visible (aunque activo quede true)', async () => {
  const p = await crear(promo({ precio_descuento: 100 }));
  await rechazar(p.id, 'precio mal');

  const ed = await editar(p.id, { precio_descuento: 60 });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.estado_aprobacion, 'pendiente', 'vuelve a pendiente, no queda rechazada');
  assert.equal(ed.body.activo, true, 'el reenvío restaura activo (comportamiento ya validado, PM3)');
  await assertOcultaSimple(p.id); // sigue sin verse: pendiente nunca es pública, sin importar `activo`

  // Y mientras siga pendiente, el switch directo tampoco puede "adelantar" la visibilidad.
  const r = await editar(p.id, { activo: true });
  assert.equal(r.status, 409);
});

test('VIS-5: después de aprobar la corrección, entra al flujo normal de visibilidad', async () => {
  const p = await crear(promo({ precio_descuento: 100 }));
  await rechazar(p.id, 'precio mal');
  await editar(p.id, { precio_descuento: 60 });

  const ap = await aprobar(p.id);
  assert.equal(ap.status, 200);
  assert.equal(ap.body.visible_cliente, true, JSON.stringify(ap.body));
  assert.equal((await pedir('GET', '/api/bolsas')).body.some(b => b.id === p.id), true, 'ya es pública');

  // Y ahora el switch sí puede operar con normalidad (aprobada).
  const off = await editar(p.id, { activo: false });
  assert.equal(off.status, 200);
  const on = await editar(p.id, { activo: true });
  assert.equal(on.status, 200);
});

async function assertOcultaSimple(id) {
  assert.equal((await pedir('GET', '/api/bolsas')).body.some(b => b.id === id), false);
  assert.equal((await pedir('GET', `/api/bolsas/${id}`)).status, 404);
}

// ════════════════════════════════════════════════════════════════════════════
// TIME-1/2 — hora_recogida_inicio/fin obligatorias al crear
// ════════════════════════════════════════════════════════════════════════════

test('TIME-1: crear sin hora_recogida_inicio responde 400, no crea nada', async () => {
  const { hora_recogida_inicio, ...sinInicio } = promo();
  const r = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: sinInicio });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /hora_recogida_inicio/);
});

test('TIME-2: crear sin hora_recogida_fin responde 400, no crea nada', async () => {
  const { hora_recogida_fin, ...sinFin } = bolsaTiempoLimitado();
  const r = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: sinFin });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /hora_recogida_fin/);
});

test('TIME: con ambas horas presentes, crear sigue funcionando igual que antes', async () => {
  const p = await crear(promo());
  assert.equal(p.hora_recogida_inicio, '08:00');
  assert.equal(p.hora_recogida_fin, '22:00');
});

test('TIME: una hora vacía explícita ("") se rechaza igual que ausente', async () => {
  const r = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ hora_recogida_inicio: '' }) });
  assert.equal(r.status, 400);
});

// ════════════════════════════════════════════════════════════════════════════
// DATE-7 — backend rechaza fecha fin anterior a fecha inicio (crear y editar)
// ════════════════════════════════════════════════════════════════════════════

test('DATE-7: crear Tiempo limitado con fecha_caducidad anterior a fecha_disponible → 400', async () => {
  const r = await pedir('POST', '/api/bolsas', {
    como: IDS.restaurante,
    body: bolsaTiempoLimitado({ fecha_disponible: fechaGuatemala(5), fecha_caducidad: fechaGuatemala(1) }),
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /fecha de fin/i);
});

test('DATE-7: editar y mover fecha_caducidad antes de fecha_disponible → 400, no se guarda', async () => {
  const p = await crear(bolsaTiempoLimitado());
  await aprobar(p.id); // sale de "revisión inicial" (409) para poder editarla
  const r = await editar(p.id, { fecha_caducidad: fechaGuatemala(-1) }); // antes de fecha_disponible=HOY
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(fila(p.id).fecha_caducidad, MANANA, 'la fila conserva el valor anterior, no el inválido');
});

test('DATE-7: fecha_disponible == fecha_caducidad (un solo día) es válido', async () => {
  const r = await pedir('POST', '/api/bolsas', {
    como: IDS.restaurante,
    body: bolsaTiempoLimitado({ fecha_disponible: MANANA, fecha_caducidad: MANANA }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('Promoción: el backend ignora fecha_caducidad aunque llegue en el body (crear y editar)', async () => {
  const p = await crear(promo({ fecha_caducidad: fechaGuatemala(10) }));
  assert.equal(fila(p.id).fecha_caducidad, null);
  await aprobar(p.id); // sale de "revisión inicial" (409) para poder editarla
  const ed = await editar(p.id, { fecha_caducidad: fechaGuatemala(20), descripcion: 'otra' });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(fila(p.id).fecha_caducidad, null, 'sigue sin fecha fin tras editar');
});
