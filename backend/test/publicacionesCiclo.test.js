// Ciclo de vida completo de una publicación (bolsa / promoción) por HTTP,
// con los routers reales y Supabase en memoria (test/helpers/appPublicaciones.js):
//
//   crear → pendiente → aprobar/rechazar → modificar → pendiente → aprobar → visible
//
// "Visible al cliente" se comprueba en TODOS los endpoints públicos que consume
// la app (feed de bolsas, pestaña Promociones, tienda, detalle de producto,
// feed de negocios del Home/Tiendas, ficha del negocio): la publicación tiene
// que aparecer o desaparecer en todos a la vez, nunca en unos sí y en otros no.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');

const MANANA = fechaGuatemala(1);
const AYER = fechaGuatemala(-1);

// Ventana que no vence durante la prueba: termina mañana.
const HORARIO_VIGENTE = { hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00', fecha_caducidad: MANANA };

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

const aprobar = (id) => pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
const rechazar = (id, motivo) => pedir('PUT', `/api/admin/bolsas/${id}/rechazar`, { como: IDS.admin, body: { motivo } });
const editar = (id, body, como = IDS.restaurante) => pedir('PUT', `/api/bolsas/${id}`, { como, body });
const fila = (id) => fake.tabla('bolsas').find(b => b.id === id);

// ¿Aparece la publicación `id` en cada superficie pública que usa la app del cliente?
async function visibilidad(id) {
  const { negocio_id: negocioId, tipo } = fila(id);
  const [feed, porTipo, tienda, detalle, feedNegocios, ficha, bolsasNegocio, negocio] = await Promise.all([
    pedir('GET', '/api/bolsas'),
    pedir('GET', `/api/bolsas?tipo=${tipo}`),
    pedir('GET', `/api/bolsas?negocio_id=${negocioId}`),
    pedir('GET', `/api/bolsas/${id}`),
    pedir('GET', '/api/negocios/feed'),
    pedir('GET', `/api/negocios/${negocioId}/detalle`),
    pedir('GET', `/api/negocios/${negocioId}/bolsas`),
    pedir('GET', `/api/negocios/${negocioId}`),
  ]);
  const contiene = (lista) => (lista || []).some(b => b.id === id);
  const seccion = tipo === 'cupon' ? 'promocion' : 'tiempo_limitado';
  const seccionBolsas = tipo === 'cupon' ? 'promociones' : 'tiempo_limitado';
  return {
    feed: contiene(feed.body),
    porTipo: contiene(porTipo.body),
    tienda: contiene(tienda.body),
    detalle: detalle.status === 200 && detalle.body?.id === id,
    ficha: contiene(ficha.body?.bolsas?.[seccion]),
    bolsasNegocio: contiene(bolsasNegocio.body?.[seccionBolsas]),
    negocio: contiene(negocio.body?.bolsas),
    // El Home lista negocios con ≥1 publicación visible; cuenta cuántas.
    cantidadEnHome: (feedNegocios.body || []).find(n => n.id === negocioId)?.cantidad_bolsas || 0,
  };
}

async function assertVisible(id, mensaje) {
  const v = await visibilidad(id);
  const { cantidadEnHome, ...superficies } = v;
  for (const [superficie, visible] of Object.entries(superficies)) {
    assert.equal(visible, true, `${mensaje}: debería verse en "${superficie}" — ${JSON.stringify(v)}`);
  }
  assert.ok(cantidadEnHome >= 1, `${mensaje}: el Home debería contar la publicación — ${JSON.stringify(v)}`);
}

// `detalleAccesible`: una publicación agotada no se lista, pero su detalle sigue
// respondiendo (la app muestra "agotado" en vez de un 404).
async function assertOculta(id, mensaje, { detalleAccesible = false } = {}) {
  const v = await visibilidad(id);
  const { cantidadEnHome, detalle, ...listados } = v;
  for (const [superficie, visible] of Object.entries(listados)) {
    assert.equal(visible, false, `${mensaje}: NO debería verse en "${superficie}" — ${JSON.stringify(v)}`);
  }
  assert.equal(detalle, detalleAccesible, `${mensaje}: detalle — ${JSON.stringify(v)}`);
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

// ════════════════════════════════════════════════════════════════════════════
// Publicación nueva
// ════════════════════════════════════════════════════════════════════════════

test('nueva: crear → pendiente, no visible; aprobar → visible en todas las superficies', async () => {
  const p = await crear(promo());
  assert.equal(p.estado_aprobacion, 'pendiente');
  assert.equal(fila(p.id).activo, true);
  await assertOculta(p.id, 'pendiente');

  const r = await aprobar(p.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.estado_aprobacion, 'aprobado');
  assert.equal(r.body.activo, true);
  assert.equal(r.body.visible_cliente, true, 'aprobar debe informar si queda visible');
  assert.deepEqual(r.body.motivos_no_visible, []);
  await assertVisible(p.id, 'aprobada');
});

test('nueva: el feed de negocios (Home) cuenta solo las publicaciones visibles', async () => {
  const p = await crear(promo());
  let home = (await pedir('GET', '/api/negocios/feed')).body;
  assert.equal(home.find(n => n.id === IDS.olaAzul), undefined, 'sin aprobadas el negocio no sale en el Home');
  await aprobar(p.id);
  home = (await pedir('GET', '/api/negocios/feed')).body;
  assert.equal(home.find(n => n.id === IDS.olaAzul)?.cantidad_bolsas, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// Rechazo
// ════════════════════════════════════════════════════════════════════════════

test('rechazo: pendiente → rechazado, no visible, motivo guardado y auditado', async () => {
  const p = await crear(promo());
  const r = await rechazar(p.id, 'El precio del 2x1 está mal');
  assert.equal(r.status, 200);
  assert.equal(fila(p.id).estado_aprobacion, 'rechazado');
  assert.equal(fila(p.id).motivo_rechazo, 'El precio del 2x1 está mal');
  await assertOculta(p.id, 'rechazada');

  const evento = fake.tabla('eventos_dominio').find(e => e.event_type === 'publicacion.rechazada');
  assert.equal(evento.aggregate_id, p.id);
  assert.equal(evento.payload.motivo, 'El precio del 2x1 está mal');
});

test('rechazo sin motivo explícito deja un motivo legible, nunca vacío ni el de una revisión anterior', async () => {
  const p = await crear(promo());
  await pedir('PUT', `/api/admin/bolsas/${p.id}/pedir-cambios`, { como: IDS.admin, body: { motivo: 'motivo viejo' } });
  await rechazar(p.id, '');
  assert.ok(fila(p.id).motivo_rechazo, 'motivo_rechazo presente');
  assert.notEqual(fila(p.id).motivo_rechazo, 'motivo viejo');
});

test('rechazo: el restaurante ve la rechazada con su motivo en su panel (mi_negocio)', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'Falta el código');
  const r = await pedir('GET', '/api/bolsas?mi_negocio=true', { como: IDS.restaurante });
  const propia = r.body.find(b => b.id === p.id);
  assert.equal(propia.estado_aprobacion, 'rechazado');
  assert.equal(propia.motivo_rechazo, 'Falta el código');
});

// ════════════════════════════════════════════════════════════════════════════
// Corrección de una rechazada
// ════════════════════════════════════════════════════════════════════════════

test('corrección: rechazado → modificar → pendiente → aprobar → visible', async () => {
  const p = await crear(promo({ precio_descuento: 100 }));
  await rechazar(p.id, 'Un 2x1 de Q120 debe costar Q60');

  const ed = await editar(p.id, { precio_descuento: 60 });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.estado_aprobacion, 'pendiente', 'la corrección vuelve a revisión');
  assert.equal(ed.body.motivo_rechazo, null, 'el motivo anterior se limpia');
  assert.equal(ed.body.precio_descuento, 60, 'los datos nuevos se guardan');
  assert.equal(ed.body.activo, true, 'el reenvío deshace la desactivación que impuso el rechazo');
  await assertOculta(p.id, 'corregida pero aún pendiente');

  // El motivo anterior no se pierde: queda en el evento de auditoría del reenvío.
  const reenvio = fake.tabla('eventos_dominio').find(e => e.event_type === 'publicacion.reenviada_revision');
  assert.ok(reenvio, 'el reenvío a revisión queda auditado');
  assert.equal(reenvio.payload.estado_anterior, 'rechazado');
  assert.equal(reenvio.payload.motivo_anterior, 'Un 2x1 de Q120 debe costar Q60');

  const ap = await aprobar(p.id);
  assert.equal(ap.body.visible_cliente, true, JSON.stringify(ap.body));
  await assertVisible(p.id, 'corregida y aprobada');
  assert.equal(fila(p.id).precio_descuento, 60);
});

test('corrección: segunda vuelta (rechazar → corregir → rechazar → corregir → aprobar) audita cada decisión', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'primera');
  await editar(p.id, { descripcion: 'v2' });
  await rechazar(p.id, 'segunda');
  assert.equal(fila(p.id).motivo_rechazo, 'segunda');
  await editar(p.id, { descripcion: 'v3' });
  await aprobar(p.id);
  await assertVisible(p.id, 'tras dos rechazos');

  const tipos = fake.tabla('eventos_dominio').filter(e => e.aggregate_id === p.id).map(e => e.event_type);
  assert.equal(tipos.filter(t => t === 'publicacion.rechazada').length, 2, 'cada rechazo es un evento propio');
  assert.equal(tipos.filter(t => t === 'publicacion.reenviada_revision').length, 2);
  assert.equal(tipos.filter(t => t === 'publicacion.aprobada').length, 1);
});

test('corrección: un restaurante que oculta a propósito su rechazada al corregirla la mantiene oculta', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'x');
  const ed = await editar(p.id, { descripcion: 'corregida', activo: false });
  assert.equal(ed.body.estado_aprobacion, 'pendiente');
  assert.equal(ed.body.activo, false);
  const ap = await aprobar(p.id);
  assert.equal(ap.body.visible_cliente, false);
  assert.ok(ap.body.motivos_no_visible.includes('inactiva'));
  await assertOculta(p.id, 'aprobada pero ocultada por el restaurante');
});

test('aprobar repetido es idempotente: no duplica auditoría ni cambia el estado', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  const r = await aprobar(p.id);
  assert.equal(r.status, 200);
  const aprobaciones = fake.tabla('eventos_dominio').filter(e => e.event_type === 'publicacion.aprobada');
  assert.equal(aprobaciones.length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// Caso Ola Azul exacto
// ════════════════════════════════════════════════════════════════════════════

test('Ola Azul: A mal creada → rechazada; B creada bien → aprobada ⇒ B visible, A no', async () => {
  const a = await crear(promo({ precio_descuento: 110, descripcion: '2x1 mal configurado' }));
  await rechazar(a.id, 'Un 2x1 no puede costar Q110');

  // Mismo nombre que la rechazada: no debe bloquear la creación de la nueva.
  const b = await crear(promo());
  assert.notEqual(b.id, a.id);
  assert.equal(b.estado_aprobacion, 'pendiente');
  await assertOculta(b.id, 'B pendiente');

  const ap = await aprobar(b.id);
  assert.equal(ap.status, 200);
  assert.equal(ap.body.visible_cliente, true, JSON.stringify(ap.body));

  await assertVisible(b.id, 'B aprobada');
  await assertOculta(a.id, 'A rechazada');
  const home = (await pedir('GET', '/api/negocios/feed')).body;
  assert.equal(home.find(n => n.id === IDS.olaAzul).cantidad_bolsas, 1, 'el Home cuenta solo B');

  // La pestaña Promociones devuelve exactamente B, con sus datos correctos.
  const promos = (await pedir('GET', '/api/bolsas?tipo=cupon')).body;
  assert.deepEqual(promos.map(x => x.id), [b.id]);
  const vista = promos[0];
  assert.equal(vista.negocios.nombre, 'Ola Azul');
  assert.equal(vista.negocio_id, IDS.olaAzul);
  assert.equal(vista.tipo, 'cupon');
  assert.equal(vista.precio_descuento, 60);
  assert.equal(vista.hora_recogida_inicio, '08:00');
  assert.equal(vista.hora_recogida_fin, '22:00');
  assert.equal(vista.fecha_caducidad, MANANA);
  assert.equal(vista.cantidad_disponible, 5);
  assert.equal(vista.cantidad_disponible_real, 5);
  assert.equal('motivo_rechazo' in vista, false, 'el feed público no expone motivo_rechazo');

  // Y el restaurante sigue viendo ambas versiones (historial intacto).
  const propias = (await pedir('GET', '/api/bolsas?mi_negocio=true', { como: IDS.restaurante })).body;
  assert.deepEqual(new Set(propias.map(x => x.id)), new Set([a.id, b.id]));
});

test('Ola Azul vía edición: A rechazada → corregida → aprobada ⇒ A visible', async () => {
  const a = await crear(promo({ precio_descuento: 110 }));
  await rechazar(a.id, 'precio');
  await editar(a.id, { precio_descuento: 60 });
  const ap = await aprobar(a.id);
  assert.equal(ap.body.visible_cliente, true, JSON.stringify(ap.body));
  await assertVisible(a.id, 'A corregida y aprobada');
});

test('dos versiones del mismo producto: solo la aprobada aparece, sin depender del orden de creación', async () => {
  // B (correcta) creada y aprobada ANTES de que se rechace A: el orden no importa.
  const a = await crear(promo({ nombre: '2x1 Tacos', precio_descuento: 90 }));
  const b = await crear(promo({ nombre: '2x1 Tacos (corregida)' }));
  await aprobar(b.id);
  await rechazar(a.id, 'duplicada');
  await assertVisible(b.id, 'B');
  await assertOculta(a.id, 'A');
});

// ════════════════════════════════════════════════════════════════════════════
// Modificación de una aprobada
// ════════════════════════════════════════════════════════════════════════════

test('aprobada → modificar dato relevante → pendiente y deja de verse hasta re-aprobar', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  await assertVisible(p.id, 'aprobada');

  const ed = await editar(p.id, { precio_descuento: 50 });
  assert.equal(ed.body.estado_aprobacion, 'pendiente');
  await assertOculta(p.id, 'cambio no revisado');

  await aprobar(p.id);
  await assertVisible(p.id, 're-aprobada');
  assert.equal(fila(p.id).precio_descuento, 50);
});

for (const [campo, valor] of [
  ['nombre', '2x1 Ceviche mixto'], ['descripcion', 'otra'], ['contenido', 'NUEVOCOD'],
  ['precio_original', 130], ['tipo', 'bolsa'], ['categoria', 'Porcentaje'],
  ['hora_recogida_fin', '21:00'], ['fecha_caducidad', fechaGuatemala(2)], ['imagen_url', 'https://x/y.jpg'],
]) {
  test(`aprobada: cambiar "${campo}" vuelve a revisión`, async () => {
    const p = await crear(promo());
    await aprobar(p.id);
    const ed = await editar(p.id, { [campo]: valor });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal(ed.body.estado_aprobacion, 'pendiente');
  });
}

test('aprobada: reponer unidades (cantidad_disponible) no la saca del catálogo', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  const ed = await editar(p.id, { cantidad_disponible: 9 });
  assert.equal(ed.body.estado_aprobacion, 'aprobado');
  assert.equal(ed.body.cantidad_disponible, 9);
  await assertVisible(p.id, 'tras reponer stock');
});

test('aprobada: guardar el formulario sin cambios reales no la manda a revisión', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  // La app reenvía el formulario completo; números como texto y horas con segundos
  // (como las devuelve una columna `time`) no son cambios.
  const ed = await editar(p.id, { ...promo(), precio_original: '120', hora_recogida_inicio: '08:00:00' });
  assert.equal(ed.body.estado_aprobacion, 'aprobado', JSON.stringify(ed.body));
  await assertVisible(p.id, 'sin cambios');
});

test('aprobada: ocultar y volver a mostrar (switch) no pasa por revisión', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  await editar(p.id, { activo: false });
  await assertOculta(p.id, 'ocultada');
  const ed = await editar(p.id, { activo: true });
  assert.equal(ed.body.estado_aprobacion, 'aprobado');
  await assertVisible(p.id, 'reactivada');
});

test('pendiente de revisión inicial sigue bloqueada para edición del restaurante', async () => {
  const p = await crear(promo());
  const ed = await editar(p.id, { descripcion: 'cambio' });
  assert.equal(ed.status, 409);
});

test('un restaurante no puede aprobarse a sí mismo vía PUT', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'x');
  const ed = await editar(p.id, { descripcion: 'y', estado_aprobacion: 'aprobado' });
  assert.equal(ed.body.estado_aprobacion, 'pendiente');
});

test('un restaurante no puede editar publicaciones de otro negocio', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  const ed = await editar(p.id, { precio_descuento: 1 }, IDS.otroRestaurante);
  assert.equal(ed.status, 403);
});

// ════════════════════════════════════════════════════════════════════════════
// Matriz de estados: solo lo aprobado, activo, vigente y con unidades entra
// ════════════════════════════════════════════════════════════════════════════

function sembrar(extra) {
  const b = {
    id: `seed-${Math.random().toString(16).slice(2)}`, negocio_id: IDS.olaAzul, nombre: 'Semilla',
    tipo: 'cupon', precio_original: 100, precio_descuento: 50, cantidad_disponible: 4,
    activo: true, estado_aprobacion: 'aprobado', motivo_rechazo: null,
    created_at: new Date().toISOString(), ...HORARIO_VIGENTE, ...extra,
  };
  fake._db.tablas.bolsas.push(b);
  return b.id;
}

for (const [caso, extra, esperado, opciones] of [
  ['pendiente', { estado_aprobacion: 'pendiente' }, false],
  ['pendiente con "pedir cambios"', { estado_aprobacion: 'pendiente', motivo_rechazo: 'corrige' }, false],
  ['rechazado', { estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'no' }, false],
  ['rechazado pero activo=true (dato heredado)', { estado_aprobacion: 'rechazado', activo: true }, false],
  ['aprobado', {}, true],
  ['legado sin estado_aprobacion (null)', { estado_aprobacion: null }, true],
  ['vencido por fecha_caducidad', { fecha_caducidad: AYER }, false],
  ['inactivo', { activo: false }, false],
  ['sin unidades', { cantidad_disponible: 0 }, false, { detalleAccesible: true }],
  ['estado desconocido', { estado_aprobacion: 'borrador' }, false],
]) {
  test(`estados: ${caso} → ${esperado ? 'SÍ' : 'NO'} entra al catálogo`, async () => {
    const id = sembrar(extra);
    if (esperado) await assertVisible(id, caso);
    else await assertOculta(id, caso, opciones);
  });
}

test('estados: un negocio suspendido oculta incluso sus publicaciones aprobadas', async () => {
  const id = sembrar({});
  fake._db.tablas.negocios.find(n => n.id === IDS.olaAzul).activo = false;
  const feed = (await pedir('GET', '/api/bolsas')).body;
  assert.equal(feed.some(b => b.id === id), false);
  assert.equal((await pedir('GET', `/api/bolsas/${id}`)).status, 404);
});

test('aprobar algo ya vencido responde éxito pero avisa que NO quedará visible', async () => {
  const id = sembrar({ estado_aprobacion: 'pendiente', fecha_caducidad: AYER });
  const r = await aprobar(id);
  assert.equal(r.status, 200);
  assert.equal(r.body.visible_cliente, false);
  assert.ok(r.body.motivos_no_visible.includes('vencida'), JSON.stringify(r.body));
});

// ════════════════════════════════════════════════════════════════════════════
// Tipos: cupon (Promoción) y bolsa (Tiempo limitado) no se mezclan
// ════════════════════════════════════════════════════════════════════════════

test('tipos: promoción y tiempo limitado se listan cada uno en su sección', async () => {
  const c = await crear(promo());
  const b = await crear(bolsaTiempoLimitado());
  await aprobar(c.id);
  await aprobar(b.id);

  const cupones = (await pedir('GET', '/api/bolsas?tipo=cupon')).body.map(x => x.id);
  const bolsas = (await pedir('GET', '/api/bolsas?tipo=bolsa')).body.map(x => x.id);
  assert.deepEqual(cupones, [c.id]);
  assert.deepEqual(bolsas, [b.id]);

  const ficha = (await pedir('GET', `/api/negocios/${IDS.olaAzul}/detalle`)).body.bolsas;
  assert.deepEqual(ficha.promocion.map(x => x.id), [c.id]);
  assert.deepEqual(ficha.tiempo_limitado.map(x => x.id), [b.id]);

  const porNegocio = (await pedir('GET', `/api/negocios/${IDS.olaAzul}/bolsas`)).body;
  assert.deepEqual(porNegocio.promociones.map(x => x.id), [c.id]);
  assert.deepEqual(porNegocio.tiempo_limitado.map(x => x.id), [b.id]);
});

test('tipos: sin tipo se crea como bolsa (tiempo limitado), igual que antes', async () => {
  const { tipo, ...sinTipo } = bolsaTiempoLimitado();
  const b = await crear(sinTipo);
  assert.equal(b.tipo, 'bolsa');
});

test('tipos: un tipo no canónico se rechaza al crear y al editar', async () => {
  const r = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ tipo: 'promocion' }) });
  assert.equal(r.status, 400);
  const p = await crear(promo());
  await rechazar(p.id, 'x');
  const ed = await editar(p.id, { tipo: 'tiempo_limitado' });
  assert.equal(ed.status, 400);
});

test('tipos: las banderas de menú no cambian el tipo canónico', async () => {
  const b = await crear(bolsaTiempoLimitado({ es_promocion: true, es_tiempo_limitado: false }));
  await aprobar(b.id);
  const cupones = (await pedir('GET', '/api/bolsas?tipo=cupon')).body;
  assert.equal(cupones.some(x => x.id === b.id), false);
});

// ════════════════════════════════════════════════════════════════════════════
// Robustez: el fallback de las consultas públicas falla CERRADO
// ════════════════════════════════════════════════════════════════════════════

test('fallback de GET /bolsas: si la consulta principal falla, no se filtran pendientes ni rechazadas ni se mezclan tipos', async () => {
  const visible = sembrar({});
  const pendiente = sembrar({ estado_aprobacion: 'pendiente' });
  const rechazada = sembrar({ estado_aprobacion: 'rechazado', activo: true });
  const vencida = sembrar({ fecha_caducidad: AYER });
  const deOtroTipo = sembrar({ tipo: 'bolsa' });

  fake.inyectarError({ code: '42703', message: 'fallo simulado' });
  const r = await pedir('GET', '/api/bolsas?tipo=cupon');
  assert.equal(r.status, 200);
  const ids = r.body.map(b => b.id);
  assert.deepEqual(ids, [visible]);
  for (const oculto of [pendiente, rechazada, vencida, deOtroTipo]) assert.equal(ids.includes(oculto), false);
});

for (const ruta of ['/feed', `/${IDS.olaAzul}/detalle`, `/${IDS.olaAzul}/bolsas`, `/${IDS.olaAzul}`]) {
  test(`fallback de GET /negocios${ruta.replace(IDS.olaAzul, ':id')}: falla cerrado`, async () => {
    sembrar({ estado_aprobacion: 'pendiente' });
    sembrar({ estado_aprobacion: 'rechazado', activo: true });
    // Las rutas /:id leen primero el negocio: esa lectura pasa (null) y falla la de bolsas.
    if (ruta !== '/feed') fake.inyectarError(null);
    fake.inyectarError({ code: '42703', message: 'fallo simulado' });
    const r = await pedir('GET', `/api/negocios${ruta}`);
    const texto = JSON.stringify(r.body);
    assert.equal(/Semilla/.test(texto), false, `no debe filtrar pendientes/rechazadas: ${texto}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Regresión: el ciclo no rompe stock, horario, unidades, negocio ni filtros
// ════════════════════════════════════════════════════════════════════════════

test('regresión: aprobar conserva tipo, fechas, horario, negocio, unidades y CO₂', async () => {
  const b = await crear(bolsaTiempoLimitado());
  const antes = { ...fila(b.id) };
  await aprobar(b.id);
  const despues = fila(b.id);
  for (const campo of ['tipo', 'negocio_id', 'hora_recogida_inicio', 'hora_recogida_fin', 'fecha_caducidad',
    'cantidad_disponible', 'precio_original', 'precio_descuento', 'peso_estimado_kg', 'co2_salvado_kg', 'activo']) {
    assert.deepEqual(despues[campo], antes[campo], campo);
  }
});

test('regresión: el reenvío conserva negocio_id aunque el body intente cambiarlo', async () => {
  const p = await crear(promo());
  await rechazar(p.id, 'x');
  await editar(p.id, { descripcion: 'y', negocio_id: IDS.otroNegocio });
  assert.equal(fila(p.id).negocio_id, IDS.olaAzul);
});

test('regresión: la disponibilidad real descuenta reservas vigentes y oculta lo agotado por reservas', async () => {
  const p = await crear(promo({ cantidad_disponible: 2 }));
  await aprobar(p.id);
  fake._db.tablas.pedidos.push({
    id: 'ped-1', bolsa_id: p.id, cantidad: 1, estado: 'pendiente', estado_pago: 'pendiente',
    created_at: new Date().toISOString(), reservado_at: new Date().toISOString(),
  });
  let feed = (await pedir('GET', '/api/bolsas')).body;
  assert.equal(feed.find(b => b.id === p.id).cantidad_disponible_real, 1);

  fake._db.tablas.pedidos.push({
    id: 'ped-2', bolsa_id: p.id, cantidad: 1, estado: 'pendiente', estado_pago: 'pendiente',
    created_at: new Date().toISOString(), reservado_at: new Date().toISOString(),
  });
  feed = (await pedir('GET', '/api/bolsas')).body;
  assert.equal(feed.some(b => b.id === p.id), false, 'agotada por reservas vigentes');
});

test('regresión: filtros de zona y categoría del feed siguen funcionando', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  assert.equal((await pedir('GET', '/api/bolsas?zona=10')).body.length, 1);
  assert.equal((await pedir('GET', '/api/bolsas?zona=4')).body.length, 0);
  assert.equal((await pedir('GET', '/api/bolsas?categoria=Restaurante')).body.length, 1);
  assert.equal((await pedir('GET', '/api/bolsas?categoria=Cafetería')).body.length, 0);
});

test('regresión: no se puede crear con horario ya vencido ni con unidades inválidas', async () => {
  const vencida = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ fecha_caducidad: AYER }) });
  assert.equal(vencida.status, 400);
  const sinUnidades = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ cantidad_disponible: 0 }) });
  assert.equal(sinUnidades.status, 400);
});

test('regresión: no se duplica una publicación activa con el mismo nombre', async () => {
  await crear(promo());
  const r = await pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo() });
  assert.equal(r.status, 409);
});
