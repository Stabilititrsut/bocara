// Requisitos de Fase 1 para publicar (POST/PUT /api/bolsas), con los routers
// reales sobre Supabase en memoria:
//   MAPS-1..4   sin enlaces de Google Maps y Waze no se crea (services/enlacesMapa.js)
//   FECHA-1..5  fecha_disponible nunca en el pasado (validarFechaDisponibleNoPasada)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');
const { tieneEnlacesMapa, MENSAJE_ENLACES_MAPA } = require('../services/enlacesMapa');
const {
  validarFechaDisponibleNoPasada, MENSAJE_FECHA_DISPONIBLE_PASADA,
} = require('../services/horarioGuatemala');

const AYER = fechaGuatemala(-1);
const HOY = fechaGuatemala(0);
const MANANA = fechaGuatemala(1);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';

const HORARIO = {
  hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, fecha_caducidad: MANANA,
};
const tiempoLimitado = (extra = {}) => ({
  nombre: 'Bolsa sorpresa', tipo: 'bolsa', descripcion: 'Pan del día', precio_original: 80, precio_descuento: 35,
  cantidad_disponible: 3, peso_estimado_kg: 1.2, categoria_alimento: 'cereales', imagen_url: FOTO, ...HORARIO, ...extra,
});
const promo = (extra = {}) => ({
  nombre: '2x1 Ceviche', contenido: 'OLA2X1', tipo: 'cupon', categoria: '2x1', descripcion: 'Dos por uno',
  precio_original: 120, precio_descuento: 60, cantidad_disponible: 5, imagen_url: FOTO, ...HORARIO, ...extra,
});

const crear = (body, como = IDS.restaurante) => pedir('POST', '/api/bolsas', { como, body });
const editar = (id, body, como = IDS.restaurante) => pedir('PUT', `/api/bolsas/${id}`, { como, body });
const negocio = (id) => fake.tabla('negocios').find(n => n.id === id);

// Publicación aprobada y vigente que empezó en `fecha_disponible`.
function sembrarAprobada(extra = {}) {
  const b = {
    id: `pub-${Math.random().toString(16).slice(2)}`, negocio_id: IDS.olaAzul, ...tiempoLimitado(),
    activo: true, estado_aprobacion: 'aprobado', motivo_rechazo: null,
    // Publicada con foto validada por IA (services/imagenes/trabajos.js).
    estado_procesamiento_imagen: 'completada',
    created_at: new Date().toISOString(), ...extra,
  };
  fake.tabla('bolsas').push(b);
  return b.id;
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

// ── Unitarias ────────────────────────────────────────────────────────────────

test('tieneEnlacesMapa: exige ambos enlaces con texto real', () => {
  assert.equal(tieneEnlacesMapa({ google_maps_url: 'https://g', waze_url: 'https://w' }), true);
  for (const [g, w] of [[null, 'https://w'], ['https://g', ''], ['   ', 'https://w'], [undefined, undefined]]) {
    assert.equal(tieneEnlacesMapa({ google_maps_url: g, waze_url: w }), false, `${g} / ${w}`);
  }
  assert.equal(tieneEnlacesMapa(null), false);
});

test('validarFechaDisponibleNoPasada: pasado rechazado, hoy/futuro válidos, sin cambio no se valida', () => {
  const ahora = { fecha: '2026-10-11', hora: '12:00:00' };
  assert.equal(validarFechaDisponibleNoPasada('2026-10-10', {}, ahora), MENSAJE_FECHA_DISPONIBLE_PASADA);
  assert.equal(validarFechaDisponibleNoPasada('2026-10-11', {}, ahora), null);
  assert.equal(validarFechaDisponibleNoPasada('2026-10-12', {}, ahora), null);
  assert.equal(validarFechaDisponibleNoPasada(null, {}, ahora), null);
  assert.equal(validarFechaDisponibleNoPasada('2026-10-01', { fechaAnterior: '2026-10-01' }, ahora), null);
  assert.equal(validarFechaDisponibleNoPasada('2026-10-01', { fechaAnterior: '2026-10-01T00:00:00Z' }, ahora), null);
  assert.equal(validarFechaDisponibleNoPasada('2026-10-02', { fechaAnterior: '2026-10-01' }, ahora), MENSAJE_FECHA_DISPONIBLE_PASADA);
});

// ── Enlaces de mapa ──────────────────────────────────────────────────────────

test('MAPS-1: negocio sin Google Maps → 400 con mensaje claro y no se crea nada', async () => {
  negocio(IDS.olaAzul).google_maps_url = null;
  const antes = fake.tabla('bolsas').length;
  const r = await crear(tiempoLimitado());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, MENSAJE_ENLACES_MAPA);
  assert.equal(fake.tabla('bolsas').length, antes);
});

test('MAPS-2: negocio con Waze vacío o solo espacios → 400 (ambos tipos)', async () => {
  for (const valor of ['', '   ']) {
    fake.reiniciar(datosBase());
    negocio(IDS.olaAzul).waze_url = valor;
    for (const body of [tiempoLimitado(), promo()]) {
      const r = await crear(body);
      assert.equal(r.status, 400, JSON.stringify(valor));
      assert.equal(r.body.error, MENSAJE_ENLACES_MAPA);
    }
  }
});

test('MAPS-3: con ambos enlaces se crea normalmente', async () => {
  const r = await crear(tiempoLimitado());
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('MAPS-4: sin enlaces, editar una publicación existente sigue permitido', async () => {
  const id = sembrarAprobada();
  negocio(IDS.olaAzul).google_maps_url = null;
  negocio(IDS.olaAzul).waze_url = null;
  const r = await editar(id, { cantidad_disponible: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

// ── Fecha mínima ─────────────────────────────────────────────────────────────

test('FECHA-1: POST con fecha_disponible de ayer → 400 (Tiempo limitado y Promoción)', async () => {
  for (const body of [tiempoLimitado({ fecha_disponible: AYER }), promo({ fecha_disponible: AYER })]) {
    const r = await crear(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, MENSAJE_FECHA_DISPONIBLE_PASADA);
  }
});

test('FECHA-2: POST con fecha_disponible de hoy o mañana se crea', async () => {
  assert.equal((await crear(tiempoLimitado({ nombre: 'Hoy' }))).status, 201);
  assert.equal((await crear(tiempoLimitado({ nombre: 'Mañana', fecha_disponible: MANANA }))).status, 201);
});

test('FECHA-3: PUT que reenvía sin cambios una fecha_disponible ya pasada se acepta', async () => {
  const id = sembrarAprobada({ fecha_disponible: AYER });
  const r = await editar(id, { fecha_disponible: AYER, cantidad_disponible: 9 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('FECHA-4: PUT que mueve fecha_disponible al pasado → 400 y no se guarda', async () => {
  const id = sembrarAprobada({ fecha_disponible: HOY });
  const r = await editar(id, { fecha_disponible: AYER });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, MENSAJE_FECHA_DISPONIBLE_PASADA);
  assert.equal(fake.tabla('bolsas').find(b => b.id === id).fecha_disponible, HOY);
});

test('FECHA-5: PUT que mueve fecha_disponible a hoy o al futuro se acepta', async () => {
  const id = sembrarAprobada({ fecha_disponible: AYER });
  const r = await editar(id, { fecha_disponible: HOY });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
