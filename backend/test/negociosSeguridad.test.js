// Transiciones que solo controla el backend (pre-merge a main), por HTTP con
// los routers reales sobre Supabase en memoria:
//   SEC-1  el restaurante no puede activar/suspender su negocio (`activo`)
//          ni escribir su estado de verificación; el admin sí.
//   SEC-2  reenvío de un negocio rechazado: rechazado → pendiente por un
//          endpoint explícito (POST /api/negocios/mi-negocio/reenviar).
//   SEC-3  ninguna publicación se aprueba sin foto, tampoco una heredada; el
//          restaurante puede agregarla y entonces sí se aprueba.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');

const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';
const FOTO_NEGOCIO = 'https://cdn.bocara.test/negocios/foto.jpg';
const HORARIO = {
  hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00',
  fecha_disponible: fechaGuatemala(0), fecha_caducidad: fechaGuatemala(1),
};

const fila = (tabla, id) => fake.tabla(tabla).find(x => x.id === id);
const olaAzul = () => fila('negocios', IDS.olaAzul);
const reenviar = (como = IDS.restaurante) => pedir('POST', '/api/negocios/mi-negocio/reenviar', { como });
const putNegocio = (body, como = IDS.restaurante, id = IDS.olaAzul) => pedir('PUT', `/api/negocios/${id}`, { como, body });

// Ola Azul como negocio rechazado (con o sin foto).
function rechazarOlaAzul(extra = {}) {
  Object.assign(olaAzul(), {
    estado_verificacion: 'rechazado', activo: false, verificado: false, imagen_url: FOTO_NEGOCIO,
    motivo_rechazo: JSON.stringify({ texto: 'La dirección no coincide', campos: ['direccion'] }), ...extra,
  });
}

function sembrarPublicacion(extra = {}) {
  const b = {
    id: `pub-${Math.random().toString(16).slice(2)}`, negocio_id: IDS.olaAzul, nombre: 'Heredada', tipo: 'cupon',
    contenido: 'VIEJO', categoria: '2x1', precio_original: 100, precio_descuento: 50, cantidad_disponible: 4,
    activo: true, estado_aprobacion: 'pendiente', motivo_rechazo: null, imagen_url: null,
    created_at: new Date().toISOString(), ...HORARIO, ...extra,
  };
  fake.tabla('bolsas').push(b);
  return b.id;
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => {
  fake.reiniciar(datosBase());
  olaAzul().imagen_url = FOTO_NEGOCIO;
});

// ── SEC-1: `activo` es del admin ─────────────────────────────────────────────

test('SEC-1: el restaurante no puede activar su negocio (activo=true) → 403, sin cambios', async () => {
  Object.assign(olaAzul(), { activo: false });
  const r = await putNegocio({ activo: true });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Solo un administrador/);
  assert.equal(olaAzul().activo, false);
});

test('SEC-1: el restaurante no puede suspender su negocio (activo=false) → 403, sin cambios', async () => {
  const r = await putNegocio({ activo: false, descripcion: 'colado junto a otro campo' });
  assert.equal(r.status, 403);
  assert.equal(olaAzul().activo, true);
  assert.notEqual(olaAzul().descripcion, 'colado junto a otro campo', 'no se aplica nada del payload');
});

test('SEC-1: el restaurante no puede escribir su estado de verificación', async () => {
  rechazarOlaAzul();
  for (const body of [{ estado_verificacion: 'aprobado' }, { estado_verificacion: 'pendiente' }, { verificado: true }]) {
    const r = await putNegocio(body);
    assert.equal(r.status, 403, JSON.stringify(body));
  }
  assert.equal(olaAzul().estado_verificacion, 'rechazado');
  assert.equal(olaAzul().verificado, false);
});

test('SEC-1: el restaurante sigue pudiendo editar sus datos (sin activo)', async () => {
  const r = await putNegocio({ descripcion: 'Mariscos frescos' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(olaAzul().descripcion, 'Mariscos frescos');
});

test('SEC-1: el admin puede activar (con foto) y suspender', async () => {
  Object.assign(olaAzul(), { activo: false });
  const activar = await putNegocio({ activo: true }, IDS.admin);
  assert.equal(activar.status, 200, JSON.stringify(activar.body));
  assert.equal(olaAzul().activo, true);
  const suspender = await putNegocio({ activo: false }, IDS.admin);
  assert.equal(suspender.status, 200, JSON.stringify(suspender.body));
  assert.equal(olaAzul().activo, false);
});

test('SEC-1: el admin no activa un negocio sin foto (regla de foto intacta)', async () => {
  Object.assign(olaAzul(), { activo: false, imagen_url: null });
  const r = await putNegocio({ activo: true }, IDS.admin);
  assert.equal(r.status, 400);
  assert.equal(olaAzul().activo, false);
});

// ── SEC-2: reenvío rechazado → pendiente ─────────────────────────────────────

test('SEC-2: rechazado → corrige → reenviar → pendiente (mismo negocio, inactivo, motivo auditado) → admin aprueba', async () => {
  rechazarOlaAzul();
  const totalNegocios = fake.tabla('negocios').length;
  const motivo = olaAzul().motivo_rechazo;

  const corrige = await putNegocio({ direccion: '6a avenida 10-20' });
  assert.equal(corrige.status, 200, JSON.stringify(corrige.body));
  assert.equal(olaAzul().estado_verificacion, 'rechazado', 'corregir no cambia el estado por sí solo');

  const r = await reenviar();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, IDS.olaAzul, 'es el mismo negocio');
  assert.equal(fake.tabla('negocios').length, totalNegocios, 'no se crea otro negocio');
  const n = olaAzul();
  assert.equal(n.estado_verificacion, 'pendiente');
  assert.equal(n.activo, false, 'no queda activo automáticamente');
  assert.equal(n.verificado, false);
  assert.equal(n.motivo_rechazo, null, 'el motivo viejo no se muestra como pendiente');
  assert.equal(n.direccion, '6a avenida 10-20', 'la corrección se conserva');
  const evento = fake.tabla('eventos_dominio').find(e => e.event_type === 'negocio.reenviado_revision');
  assert.ok(evento, 'el reenvío queda auditado');
  assert.equal(evento.payload.motivo_anterior, motivo);

  const aprobar = await pedir('PUT', `/api/admin/negocios/${IDS.olaAzul}/aprobar`, { como: IDS.admin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
  assert.equal(olaAzul().estado_verificacion, 'aprobado');
  assert.equal(olaAzul().activo, true);
});

test('SEC-2: reenviar exige foto — sin ella sigue rechazado', async () => {
  rechazarOlaAzul({ imagen_url: '  ' });
  const r = await reenviar();
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Debes agregar una foto del negocio para continuar.');
  assert.equal(olaAzul().estado_verificacion, 'rechazado');
});

test('SEC-2: solo desde "rechazado" — pendiente o aprobado no se pueden "reenviar"', async () => {
  for (const estado of ['pendiente', 'aprobado']) {
    Object.assign(olaAzul(), { estado_verificacion: estado, activo: estado === 'aprobado' });
    const r = await reenviar();
    assert.equal(r.status, 409, estado);
    assert.equal(olaAzul().estado_verificacion, estado);
    assert.equal(olaAzul().activo, estado === 'aprobado', 'un aprobado no se desactiva por esta vía');
  }
});

test('SEC-2: el reenvío solo actúa sobre el negocio propio; un cliente no puede usarlo', async () => {
  rechazarOlaAzul();
  const otro = await reenviar(IDS.otroRestaurante); // su negocio (otroNegocio) no está rechazado
  assert.equal(otro.status, 409);
  assert.equal(olaAzul().estado_verificacion, 'rechazado', 'no toca el negocio de otro restaurante');
  const cliente = await reenviar(IDS.cliente);
  assert.equal(cliente.status, 403);
});

// ── SEC-3: aprobar publicación sin foto ──────────────────────────────────────

test('SEC-3: el admin no puede aprobar una publicación heredada sin foto (409, mensaje claro)', async () => {
  const id = sembrarPublicacion();
  const r = await pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'No se puede aprobar la publicación porque no tiene foto.');
  assert.equal(fila('bolsas', id).estado_aprobacion, 'pendiente');
  // Sigue legible para el restaurante.
  const panel = await pedir('GET', '/api/bolsas?mi_negocio=true', { como: IDS.restaurante });
  assert.ok(panel.body.some(b => b.id === id));
});

test('SEC-3: legacy pendiente sin foto → restaurante agrega foto → admin aprueba', async () => {
  const id = sembrarPublicacion();
  // Sin foto no se puede "editar por editar" (seguiría trabada) …
  const sinFoto = await pedir('PUT', `/api/bolsas/${id}`, { como: IDS.restaurante, body: { nombre: 'Otra' } });
  assert.equal(sinFoto.status, 400);
  // … con foto sí, y sigue pendiente para la revisión del admin.
  const conFoto = await pedir('PUT', `/api/bolsas/${id}`, { como: IDS.restaurante, body: { imagen_url: FOTO } });
  assert.equal(conFoto.status, 200, JSON.stringify(conFoto.body));
  assert.equal(fila('bolsas', id).estado_aprobacion, 'pendiente');
  const aprobar = await pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
  assert.equal(fila('bolsas', id).estado_aprobacion, 'aprobado');
});

test('SEC-3: una pendiente CON foto sigue bloqueada para editar en revisión inicial (409, sin cambios)', async () => {
  const id = sembrarPublicacion({ imagen_url: FOTO });
  const r = await pedir('PUT', `/api/bolsas/${id}`, { como: IDS.restaurante, body: { nombre: 'Otra', imagen_url: FOTO } });
  assert.equal(r.status, 409);
});

test('SEC-3: legacy rechazada sin foto → corrige con foto → pendiente → admin aprueba', async () => {
  const id = sembrarPublicacion({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'Falta foto' });
  const intento = await pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
  assert.equal(intento.status, 409);
  const corrige = await pedir('PUT', `/api/bolsas/${id}`, { como: IDS.restaurante, body: { imagen_url: FOTO } });
  assert.equal(corrige.status, 200, JSON.stringify(corrige.body));
  assert.equal(fila('bolsas', id).estado_aprobacion, 'pendiente');
  const aprobar = await pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
  assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
});
