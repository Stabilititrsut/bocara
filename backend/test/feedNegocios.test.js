// Feed de restaurantes del cliente: activos y verificados con al menos una
// publicación disponible; la ubicación solo ordena (cercanos primero), nunca recorta.

const test = require('node:test');
const assert = require('node:assert/strict');
const { armarFeedNegocios } = require('../services/feedNegocios');
const { fake, IDS, datosBase, iniciar, detener, pedir } = require('./helpers/appPublicaciones');

const CAYALA = { lat: 14.6097, lng: -90.4842 };

// ── Unidad ────────────────────────────────────────────────────────────────────

test('armarFeedNegocios: incluye negocios sin publicaciones y lejanos (nunca recorta)', () => {
  const feed = armarFeedNegocios(
    [
      { id: 'cerca', nombre: 'Cerca', latitud: 14.61, longitud: -90.485 },
      { id: 'lejos', nombre: 'Lejos', latitud: 15.47, longitud: -90.37 }, // Cobán, >90 km
      { id: 'sin-coords', nombre: 'Sin coords' },
    ],
    [],
    CAYALA,
  );
  assert.deepEqual(feed.map((n) => n.id), ['cerca', 'lejos', 'sin-coords']);
  assert.ok(feed.every((n) => n.cantidad_bolsas === 0 && n.max_descuento === 0));
  assert.ok(feed[1].distancia_km > 90, 'el lejano aparece con su distancia');
  assert.equal(feed[2].distancia_km, null);
});

test('armarFeedNegocios: con disponibilidad primero, luego por cercanía', () => {
  const feed = armarFeedNegocios(
    [
      { id: 'cerca-sin', latitud: 14.61, longitud: -90.485 },
      { id: 'lejos-con', latitud: 14.64, longitud: -90.51 },
      { id: 'medio-con', latitud: 14.62, longitud: -90.49 },
    ],
    [
      { negocio_id: 'lejos-con', precio_original: 100, precio_descuento: 50 },
      { negocio_id: 'medio-con', precio_original: 100, precio_descuento: 70 },
      { negocio_id: 'medio-con', precio_original: 100, precio_descuento: 80 },
      { negocio_id: 'suspendido', precio_original: 100, precio_descuento: 10 },
    ],
    CAYALA,
  );
  assert.deepEqual(feed.map((n) => n.id), ['medio-con', 'lejos-con', 'cerca-sin']);
  assert.equal(feed[0].cantidad_bolsas, 2);
  assert.equal(feed[0].max_descuento, 30);
  assert.equal(feed[1].max_descuento, 50);
  assert.ok(!feed.some((n) => n.id === 'suspendido'), 'solo negocios del listado recibido');
});

test('armarFeedNegocios: sin ubicación ordena por disponibilidad y calificación', () => {
  const feed = armarFeedNegocios(
    [
      { id: 'a', nombre: 'A', calificacion_promedio: 3 },
      { id: 'b', nombre: 'B', calificacion_promedio: 5 },
      { id: 'c', nombre: 'C', calificacion_promedio: 1 },
    ],
    [{ negocio_id: 'c', precio_original: 10, precio_descuento: 5 }],
    null,
  );
  assert.deepEqual(feed.map((n) => n.id), ['c', 'b', 'a']);
  assert.ok(feed.every((n) => n.distancia_km === null));
});

// ── Ruta ──────────────────────────────────────────────────────────────────────

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

// Publicación aprobada y con unidades. Por defecto es diaria (sin fecha de
// caducidad) con una ventana de un minuto: casi siempre está fuera de horario,
// y aun así debe contar como disponible en el feed.
function publicacion(negocioId, extra = {}) {
  return {
    id: `b-${negocioId}-${fake.tabla('bolsas').length}`, negocio_id: negocioId, tipo: 'cupon',
    precio_original: 100, precio_descuento: 60, activo: true, estado_aprobacion: 'aprobado',
    cantidad_disponible: 5, hora_recogida_inicio: '00:00', hora_recogida_fin: '00:01',
    fecha_caducidad: null, fecha_disponible: null, eliminado_en: null, ...extra,
  };
}

test('GET /negocios/feed: solo activos y verificados que tienen publicaciones disponibles', async () => {
  fake.tabla('negocios').push(
    { id: 'pendiente', nombre: 'Pendiente', activo: true, estado_verificacion: 'pendiente' },
    { id: 'suspendido', nombre: 'Suspendido', activo: false, estado_verificacion: 'aprobado' },
    { id: 'legacy', nombre: 'Legacy sin estado', activo: true },
    { id: 'sin-bolsas', nombre: 'Sin publicaciones', activo: true, estado_verificacion: 'aprobado' },
  );
  fake.tabla('bolsas').push(
    publicacion(IDS.olaAzul),
    publicacion(IDS.otroNegocio, { tipo: 'bolsa' }),
    publicacion('legacy'),
    publicacion('pendiente'),
    publicacion('suspendido'),
  );
  const r = await pedir('GET', '/api/negocios/feed');
  assert.equal(r.status, 200);
  const ids = r.body.map((n) => n.id).sort();
  assert.deepEqual(ids, [IDS.olaAzul, IDS.otroNegocio, 'legacy'].sort());
  assert.ok(r.body.every((n) => n.cantidad_bolsas > 0));
  assert.ok(r.body.every((n) => !('activo' in n) && !('estado_verificacion' in n)), 'no expone campos internos');
});

test('GET /negocios/feed: caducada, eliminada o aún no iniciada no mantiene al negocio en el feed', async () => {
  fake.tabla('bolsas').push(
    publicacion(IDS.olaAzul, { fecha_caducidad: '2026-01-01' }),
    publicacion(IDS.olaAzul, { eliminado_en: '2026-10-01T00:00:00Z' }),
    publicacion(IDS.otroNegocio, { fecha_disponible: '2999-01-01' }),
  );
  const r = await pedir('GET', '/api/negocios/feed');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('GET /negocios/feed?lat&lng: ordena por cercanía; coords inválidas no rompen', async () => {
  fake.tabla('bolsas').push(publicacion(IDS.olaAzul), publicacion(IDS.otroNegocio));
  // Otro queda en Cayalá; Ola Azul (14.6, -90.5) a ~2 km.
  fake.tabla('negocios').find((n) => n.id === IDS.otroNegocio).latitud = CAYALA.lat;
  fake.tabla('negocios').find((n) => n.id === IDS.otroNegocio).longitud = CAYALA.lng;
  const r = await pedir('GET', `/api/negocios/feed?lat=${CAYALA.lat}&lng=${CAYALA.lng}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((n) => n.id), [IDS.otroNegocio, IDS.olaAzul]);
  assert.equal(r.body[0].distancia_km, 0);

  const mal = await pedir('GET', '/api/negocios/feed?lat=abc&lng=999');
  assert.equal(mal.status, 200);
  assert.equal(mal.body.length, 2);
});
