// Integración PR #24 → main: de punta a punta con las rutas REALES.
//
//   POST /api/bolsas · PUT /api/admin/bolsas/:id/aprobar · PUT /api/bolsas/:id
//     → eventos_dominio (publicacion.visible)
//     → despachadorEventos.procesarPendientes (CAS de reclamo)
//     → notificacionesCercania.manejarPublicacionVisible
//     → notificaciones (clave geo:<bolsa>:<ciclo>:<usuario>) + push
//
// La RPC usuarios_en_radio se emula con la misma regla que la función SQL
// (bounding box + Haversine, ≤ 10 km, solo clientes con token, activos, sin
// opt-out y con ubicación de ≤ 30 días). Lo que solo el SQL puede garantizar
// (tope de radio, SECURITY DEFINER, permisos) se verifica sobre el texto de la
// migración en MIG-*. Casos: GEO-1..6, PUB-1..8, DEDUP-1..4, PUSH-1..3.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');
const { haversine } = require('../utils/geo');
const { procesarPendientes } = require('../services/despachadorEventos');
const {
  EVENTO_PUBLICACION_VISIBLE, RADIO_KM, MAX_EDAD_UBICACION_DIAS,
  manejarPublicacionVisible, emitirPublicacionesQueInician,
} = require('../services/notificacionesCercania');
const { enviarPushEnLotes } = require('../services/notificaciones');

const HOY = fechaGuatemala(0);
const MANANA = fechaGuatemala(1);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';
const NEGOCIO = { lat: 14.6, lng: -90.5 }; // Ola Azul (helpers/appPublicaciones.js)
const KM_POR_GRADO = 6371 * Math.PI / 180;
const alNorte = (km) => ({ latitud: NEGOCIO.lat + km / KM_POR_GRADO, longitud: NEGOCIO.lng });

const C = {
  cerca5: '00000000-0000-4000-8000-0000000000e1',
  lejos: '00000000-0000-4000-8000-0000000000e2',
  sinUbicacion: '00000000-0000-4000-8000-0000000000e3',
  ubicacionVieja: '00000000-0000-4000-8000-0000000000e4',
  favCerca: '00000000-0000-4000-8000-0000000000e5',
  favLejos: '00000000-0000-4000-8000-0000000000e6',
  optOut: '00000000-0000-4000-8000-0000000000e7',
};
const tokenDe = (id) => `ExponentPushToken[${id.slice(-2)}]`;
const hace = (dias) => new Date(Date.now() - dias * 864e5).toISOString();

function clientes() {
  const base = (id, ubic, extra = {}) => ({
    id, rol: 'cliente', activo: true, notif_promociones: true, expo_push_token: tokenDe(id),
    ubicacion_actualizada_at: hace(1), ...ubic, ...extra,
  });
  return [
    base(C.cerca5, alNorte(5)),
    base(C.lejos, alNorte(10.1)),
    base(C.sinUbicacion, { latitud: null, longitud: null }),
    base(C.ubicacionVieja, alNorte(2), { ubicacion_actualizada_at: hace(MAX_EDAD_UBICACION_DIAS + 10) }),
    base(C.favCerca, alNorte(3)),
    base(C.favLejos, alNorte(40)),
    base(C.optOut, alNorte(1), { notif_promociones: false }),
  ];
}

// Emulación de usuarios_en_radio (ver migración 202610051400).
let llamadasRpc = 0;
let filasExtraRpc = [];
function rpcUsuariosEnRadio(params) {
  llamadasRpc += 1;
  const radio = Math.min(params.p_radio_km, 10);
  const limiteEdad = Date.now() - params.p_max_edad_dias * 864e5;
  return fake.tabla('usuarios')
    .filter(u => u.rol === 'cliente' && u.activo !== false && u.notif_promociones !== false
      && u.expo_push_token && u.latitud != null && u.longitud != null
      && new Date(u.ubicacion_actualizada_at).getTime() >= limiteEdad)
    .map(u => ({ usuario_id: u.id, expo_push_token: u.expo_push_token,
      distancia_km: haversine(params.p_lat, params.p_lng, u.latitud, u.longitud) }))
    .filter(f => f.distancia_km <= radio)
    .concat(filasExtraRpc);
}
const cliente = {
  from: (t) => fake.from(t),
  rpc: (nombre, params) => ({
    range: async (desde, hasta) => ({ data: rpcUsuariosEnRadio(params).slice(desde, hasta + 1), error: null }),
  }),
};

// Push: el envío real (lotes, tickets, limpieza de tokens) con `post` inyectado.
let mensajes = [];
let postFalso = null;
const postOk = async (_url, lote) => {
  mensajes.push(...lote);
  return { data: { data: lote.map(() => ({ status: 'ok' })) } };
};
const handlers = {
  [EVENTO_PUBLICACION_VISIBLE]: (ev, opts) => manejarPublicacionVisible(ev, {
    ...opts, enviarPush: (m, o) => enviarPushEnLotes(m, { ...o, post: postFalso || postOk }),
  }),
};
const silenciar = async (fn) => {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};
const tick = () => new Promise((r) => setTimeout(r, 15));
const despachar = () => silenciar(() => procesarPendientes({ cliente, handlers }));

test.before(iniciar);
test.after(detener);
test.beforeEach(() => {
  const datos = datosBase();
  datos.usuarios.push(...clientes());
  datos.favoritos = [
    { id: 'f1', usuario_id: C.favCerca, tipo: 'negocio', referencia_id: IDS.olaAzul },
    { id: 'f2', usuario_id: C.favLejos, tipo: 'negocio', referencia_id: IDS.olaAzul },
    // Favorito de OTRO negocio y favorito de tipo 'bolsa': no cuentan.
    { id: 'f3', usuario_id: C.lejos, tipo: 'negocio', referencia_id: IDS.otroNegocio },
    { id: 'f4', usuario_id: C.lejos, tipo: 'bolsa', referencia_id: IDS.olaAzul },
  ];
  fake.reiniciar(datos);
  mensajes = []; postFalso = null; llamadasRpc = 0; filasExtraRpc = [];
});

const horario = { hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY };
const promo = (extra = {}) => ({
  nombre: `2x1 Ceviche ${Math.random().toString(36).slice(2, 7)}`, contenido: 'OLA2X1', tipo: 'cupon', categoria: '2x1',
  descripcion: 'Dos por uno', precio_original: 120, precio_descuento: 60, cantidad_disponible: 5,
  imagen_url: FOTO, ...horario, ...extra,
});
const tiempoLimitado = (extra = {}) => ({
  nombre: `Pan del día ${Math.random().toString(36).slice(2, 7)}`, tipo: 'bolsa', descripcion: 'Sorpresa',
  precio_original: 80, precio_descuento: 30, cantidad_disponible: 3, imagen_url: FOTO,
  ...horario, fecha_caducidad: MANANA, ...extra,
});
async function crear(datos) {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: datos }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await tick();
  return r.body;
}
async function aprobar(id) {
  const r = await silenciar(() => pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin }));
  await tick();
  return r;
}
const eventos = (id) => fake.tabla('eventos_dominio').filter(e => e.event_type === EVENTO_PUBLICACION_VISIBLE && (!id || e.aggregate_id === id));
const avisos = () => fake.tabla('notificaciones').filter(n => String(n.clave_idempotencia || '').startsWith('geo:'));
const avisosDe = (u) => avisos().filter(n => n.usuario_id === u);
const destinatarios = () => avisos().map(n => n.usuario_id).sort();

// ── MIG: lo que solo la función SQL garantiza ───────────────────────────────

const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
  '202610051400_notificaciones_geofencing_y_preferencias.sql'), 'utf8');
const sinComentarios = SQL.replace(/--.*$/gm, '');

test('MIG-1: aditiva e idempotente — sin DROP/TRUNCATE/DELETE, todo IF NOT EXISTS / OR REPLACE', () => {
  assert.doesNotMatch(sinComentarios, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  const addColumn = sinComentarios.split('\n').filter(l => /ADD COLUMN/i.test(l));
  assert.ok(addColumn.length > 0);
  for (const linea of addColumn) assert.match(linea, /ADD COLUMN IF NOT EXISTS/i, linea);
  assert.match(sinComentarios, /CREATE OR REPLACE FUNCTION usuarios_en_radio/);
  assert.match(sinComentarios, /CREATE INDEX IF NOT EXISTS usuarios_geo_idx/);
});

test('MIG-2: usuarios_en_radio acota a 10 km, es SECURITY DEFINER con search_path fijo y solo service_role la ejecuta', () => {
  assert.match(sinComentarios, /LEAST\(p_radio_km, 10\) AS radio/);
  assert.match(sinComentarios, /WHERE c\.distancia_km <= c\.radio/, '10 km exactos entran (≤)');
  assert.match(sinComentarios, /SECURITY DEFINER/);
  assert.match(sinComentarios, /SET search_path = public, pg_temp/);
  for (const rol of ['PUBLIC', 'anon', 'authenticated']) {
    assert.match(sinComentarios, new RegExp(`REVOKE EXECUTE ON FUNCTION usuarios_en_radio\\([^)]*\\) FROM ${rol};`));
  }
  assert.match(sinComentarios, /GRANT\s+EXECUTE ON FUNCTION usuarios_en_radio\([^)]*\) TO service_role;/);
});

test('MIG-3: la RPC filtra sin ubicación, sin token, no-clientes, inactivos, opt-out y ubicación vieja', () => {
  for (const cond of [/u\.latitud IS NOT NULL/, /u\.longitud IS NOT NULL/, /u\.expo_push_token IS NOT NULL/,
    /u\.rol = 'cliente'/, /COALESCE\(u\.activo, true\)/, /COALESCE\(u\.notif_promociones, true\)/,
    /u\.ubicacion_actualizada_at >= now\(\) - make_interval\(days => p_max_edad_dias\)/,
    /p_lat BETWEEN -90 AND 90/, /p_lng BETWEEN -180 AND 180/]) {
    assert.match(sinComentarios, cond);
  }
});

test('MIG-4: índice único de clave_idempotencia solo si no existe otro UNIQUE (sin índices redundantes); no es PostGIS', () => {
  assert.match(sinComentarios, /IF NOT EXISTS \(\s*SELECT 1\s*FROM pg_index/);
  assert.match(sinComentarios, /CREATE UNIQUE INDEX notificaciones_clave_idempotencia_uq/);
  assert.doesNotMatch(sinComentarios, /postgis|\bgist\b|ST_DWithin|geography/i);
  assert.match(SQL, /NO es un índice espacial/);
});

// ── GEO ─────────────────────────────────────────────────────────────────────

async function publicarYDespachar(datos = promo()) {
  const p = await crear(datos);
  const r = await aprobar(p.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await despachar();
  return p;
}

test('GEO-1 / GEO-3 / PUB-2 / PUB-4: 5 km recibe; 10.1 km no; Promoción aprobada y visible avisa', async () => {
  const p = await publicarYDespachar();
  assert.equal(avisosDe(C.cerca5).length, 1);
  assert.equal(avisosDe(C.lejos).length, 0, '10.1 km queda fuera');
  const [a] = avisosDe(C.cerca5);
  assert.equal(a.titulo, '🏷️ Nueva promoción cerca de ti');
  assert.doesNotMatch(`${a.titulo} ${a.cuerpo}`, /bolsa/i, 'una Promoción nunca se llama "bolsa" ante el cliente');
  assert.deepEqual(a.data, { tipo: 'promocion', bolsaId: p.id, negocioId: IDS.olaAzul });
});

test('GEO-2: una fila a exactamente 10 km entra; una a 10.1 km que la RPC devolviera se descarta igual', async () => {
  filasExtraRpc = [
    { usuario_id: C.sinUbicacion, expo_push_token: tokenDe(C.sinUbicacion), distancia_km: RADIO_KM },
    { usuario_id: C.optOut, expo_push_token: tokenDe(C.optOut), distancia_km: 10.1 },
  ];
  await publicarYDespachar();
  assert.equal(avisosDe(C.sinUbicacion).length, 1, '10 km exactos (≤) reciben');
  assert.equal(avisosDe(C.optOut).length, 0, 'defensa en profundidad: > 10 km nunca recibe');
});

test('GEO-4: sin ubicación, con ubicación vieja (> 30 días) u opt-out → no hay aviso geográfico', async () => {
  await publicarYDespachar();
  assert.equal(avisosDe(C.cerca5).length, 1, 'control: la campaña sí corrió');
  for (const u of [C.sinUbicacion, C.ubicacionVieja, C.optOut]) assert.equal(avisosDe(u).length, 0, u);
});

test('GEO-5: negocio sin coordenadas → no se llama la RPC (sin campaña por radio); los favoritos sí reciben', async () => {
  const ola = fake._db.tablas.negocios.find(n => n.id === IDS.olaAzul);
  ola.latitud = null; ola.longitud = null;
  await publicarYDespachar();
  assert.equal(llamadasRpc, 0);
  assert.deepEqual(destinatarios(), [C.favCerca, C.favLejos].sort());
  assert.equal(avisosDe(C.favCerca)[0].titulo, '🏷️ Nueva promoción en Ola Azul', 'sin radio no se dice "cerca de ti"');
});

test('GEO-6: coordenadas inválidas del negocio → fail closed (sin RPC, sin radio)', async () => {
  fake._db.tablas.negocios.find(n => n.id === IDS.olaAzul).latitud = 200;
  await publicarYDespachar();
  assert.equal(llamadasRpc, 0);
  assert.equal(avisosDe(C.cerca5).length, 0);
  assert.deepEqual(destinatarios(), [C.favCerca, C.favLejos].sort(), 'control: corrió y solo avisó a favoritos');
});

// ── Publicaciones ───────────────────────────────────────────────────────────

test('PUB-1: Promoción pendiente → no se emite ni se avisa', async () => {
  const p = await crear(promo());
  assert.equal(p.estado_aprobacion, 'pendiente');
  await despachar();
  assert.equal(eventos().length, 0);
  assert.equal(avisos().length, 0);
});

test('PUB-3: Tiempo limitado aprobado y visible → avisa con su propio copy', async () => {
  const p = await publicarYDespachar(tiempoLimitado());
  const [a] = avisosDe(C.cerca5);
  assert.equal(a.titulo, '⏱️ Tiempo limitado cerca de ti');
  assert.equal(a.data.tipo, 'tiempo_limitado');
  assert.equal(a.data.bolsaId, p.id);
});

test('PUB-5: fecha futura → nada al aprobar; el barrido emite cuando llega su día, una sola vez', async () => {
  const p = await crear(promo({ fecha_disponible: MANANA }));
  const r = await aprobar(p.id);
  assert.equal(r.body.visible_cliente, false);
  assert.equal(eventos().length, 0, 'no se avisa antes de su vigencia');

  await silenciar(() => emitirPublicacionesQueInician());
  await tick();
  assert.equal(eventos().length, 0, 'hoy todavía no inicia');

  const manana = { fecha: MANANA, hora: '00:05:00' };
  await silenciar(() => emitirPublicacionesQueInician({ ahora: manana }));
  await silenciar(() => emitirPublicacionesQueInician({ ahora: manana }));
  await tick();
  assert.equal(eventos(p.id).length, 1, 'encolar dos veces colapsa en la clave del evento');
  assert.equal(eventos(p.id)[0].idempotency_key, `bolsa:${p.id}:publicacion.visible:${MANANA}`);
});

test('PUB-6: eliminada → el barrido no la emite y un evento previo se cierra sin avisar', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  const del = await silenciar(() => pedir('DELETE', `/api/bolsas/${p.id}`, { como: IDS.restaurante }));
  assert.equal(del.status, 200);
  assert.equal(eventos(p.id).length, 1, 'el evento se emitió al aprobar');
  await despachar();
  assert.equal(eventos(p.id)[0].status, 'procesado', 'control: el handler corrió');
  assert.equal(avisos().length, 0, 'el handler revalida: eliminada no se anuncia');
  const r = await silenciar(() => emitirPublicacionesQueInician());
  assert.equal(r.encoladas, 0);
});

test('PUB-7: agotada → no emite al aprobar; al reponer unidades (PUT) se emite y avisa', async () => {
  const p = await crear(promo());
  fake.tabla('bolsas').find(b => b.id === p.id).cantidad_disponible = 0;
  const r = await aprobar(p.id);
  assert.equal(r.body.visible_cliente, false);
  assert.equal(eventos().length, 0);

  const ed = await silenciar(() => pedir('PUT', `/api/bolsas/${p.id}`, { como: IDS.restaurante, body: { cantidad_disponible: 4 } }));
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  await tick();
  assert.equal(eventos(p.id).length, 1);
  await despachar();
  assert.equal(avisosDe(C.cerca5).length, 1);
});

test('PUB-8: negocio suspendido → no emite; si se suspende con el evento en cola, el handler no avisa', async () => {
  const p = await crear(promo());
  const ola = fake._db.tablas.negocios.find(n => n.id === IDS.olaAzul);
  ola.activo = false;
  const r = await aprobar(p.id);
  assert.equal(r.body.visible_cliente, false);
  assert.equal(eventos().length, 0);

  ola.activo = true;
  const p2 = await crear(promo());
  await aprobar(p2.id);
  assert.equal(eventos(p2.id).length, 1);
  ola.activo = false;
  await despachar();
  assert.equal(eventos(p2.id)[0].status, 'procesado', 'control: el handler corrió');
  assert.equal(avisos().length, 0);
});

test('PUB: sin foto (heredada) → el handler no la anuncia', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  fake.tabla('bolsas').find(b => b.id === p.id).imagen_url = '  ';
  await despachar();
  assert.equal(eventos(p.id)[0].status, 'procesado', 'control: el handler corrió');
  assert.equal(avisos().length, 0);
});

// ── Deduplicación ───────────────────────────────────────────────────────────

test('DEDUP-1: mismo evento dos veces (aprobar 2×, barrido, despachar 2×) → una fila por usuario', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  await aprobar(p.id);
  await silenciar(() => emitirPublicacionesQueInician());
  await tick();
  assert.equal(eventos(p.id).length, 1);
  await despachar();
  // Reprocesar a mano el mismo evento (p. ej. tras un reinicio).
  await silenciar(() => manejarPublicacionVisible(eventos(p.id)[0], { cliente, enviarPush: (m, o) => enviarPushEnLotes(m, { ...o, post: postOk }) }));
  assert.equal(avisosDe(C.cerca5).length, 1);
  assert.equal(mensajes.filter(m => m.to === tokenDe(C.cerca5)).length, 1);
});

test('DEDUP-2: favorito + ≤ 10 km → UNA notificación y UN push; favorito lejos recibe con copy correcto', async () => {
  await publicarYDespachar();
  assert.equal(avisosDe(C.favCerca).length, 1);
  assert.equal(avisosDe(C.favCerca)[0].titulo, '🏷️ Nueva promoción cerca de ti');
  assert.equal(mensajes.filter(m => m.to === tokenDe(C.favCerca)).length, 1);
  assert.equal(avisosDe(C.favLejos).length, 1);
  assert.equal(avisosDe(C.favLejos)[0].titulo, '🏷️ Nueva promoción en Ola Azul');
  assert.equal(avisosDe(C.lejos).length, 0, 'favorito de OTRO negocio o de tipo bolsa no cuenta');
});

test('DEDUP-3: retry (Expo caído y el evento se reprocesa) → sin filas nuevas y sin segundo push', async () => {
  postFalso = async () => { throw new Error('ECONNRESET'); };
  const p = await publicarYDespachar();
  const filas = avisos().length;
  assert.ok(filas > 0, 'la bandeja se guarda aunque Expo falle');
  postFalso = null;
  await silenciar(() => manejarPublicacionVisible(eventos(p.id)[0], { cliente, enviarPush: (m, o) => enviarPushEnLotes(m, { ...o, post: postOk }) }));
  assert.equal(avisos().length, filas);
  assert.equal(mensajes.length, 0, 'los que ya tenían fila no reciben un push tardío duplicado');
});

test('DEDUP-4: dos workers sobre el mismo evento → el handler corre una vez; una notificación por usuario', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  let ejecuciones = 0;
  const contando = {
    [EVENTO_PUBLICACION_VISIBLE]: (ev, opts) => { ejecuciones += 1; return handlers[EVENTO_PUBLICACION_VISIBLE](ev, opts); },
  };
  const [a, b] = await silenciar(() => Promise.all([
    procesarPendientes({ cliente, handlers: contando }),
    procesarPendientes({ cliente, handlers: contando }),
  ]));
  assert.equal(ejecuciones, 1);
  assert.equal(a.procesados + b.procesados, 1);
  assert.equal(a.ajenos + b.ajenos, 1);
  assert.equal(avisosDe(C.cerca5).length, 1);
  assert.equal(eventos(p.id)[0].status, 'procesado');
});

// ── Push ────────────────────────────────────────────────────────────────────

test('PUSH-1: payload correcto — destino, sonido, canal compatible y data mínima para el deep link', async () => {
  const p = await publicarYDespachar();
  const m = mensajes.find(x => x.to === tokenDe(C.cerca5));
  assert.ok(m);
  assert.equal(m.sound, 'default');
  assert.equal(m.channelId, 'default', 'apps sin canal "promociones" siguen mostrando el aviso');
  assert.deepEqual(m.data, { tipo: 'promocion', bolsaId: p.id, negocioId: IDS.olaAzul });
  assert.ok(!JSON.stringify(m).match(/latitud|longitud|distancia/), 'nunca viaja ubicación de nadie');
});

test('PUSH-2: DeviceNotRegistered → se limpia ese token y la operación no falla', async () => {
  postFalso = async (_u, lote) => {
    mensajes.push(...lote);
    return { data: { data: lote.map(m => (m.to === tokenDe(C.cerca5)
      ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })) } };
  };
  await publicarYDespachar();
  assert.equal(fake.tabla('usuarios').find(u => u.id === C.cerca5).expo_push_token, null);
  assert.equal(fake.tabla('usuarios').find(u => u.id === C.favCerca).expo_push_token, tokenDe(C.favCerca));
  assert.equal(avisosDe(C.cerca5).length, 1, 'el aviso queda en su bandeja');
});

test('PUSH-3: Expo caído → la aprobación responde 200 y el evento se cierra procesado (no se reintenta en bucle)', async () => {
  postFalso = async () => { throw new Error('503 Service Unavailable'); };
  const p = await crear(promo());
  const r = await aprobar(p.id);
  assert.equal(r.status, 200);
  const res = await despachar();
  assert.equal(res.procesados, 1);
  assert.equal(eventos(p.id)[0].status, 'procesado');
});
