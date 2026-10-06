const test = require('node:test');
const assert = require('node:assert/strict');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const { haversine } = require('../utils/geo');
const { hoyGuatemala, sumarDias } = require('../services/horarioGuatemala');
const {
  manejarPublicacionVisible, claveNotificacion, cicloPublicacion, RADIO_KM, PAGINA_RPC,
} = require('../services/notificacionesCercania');
const { enviarPushEnLotes, EXPO_LOTE_MAX } = require('../services/notificaciones');

// ════════════════════════════════════════════════════════════════════════════
// Doble de Supabase para el handler de cercanía.
//
// bolsas/negocios/favoritos/usuarios viven en el fakeSupabase compartido
// (embebidos incluidos). Encima se modelan las dos piezas que importan aquí:
//   · notificaciones.clave_idempotencia es UNIQUE → 23505 al repetir
//     (índice de la migración 202610051400);
//   · la RPC usuarios_en_radio, con la misma regla que la función SQL
//     (Haversine ≤ p_radio_km, solo clientes notificables) y paginada con
//     .range() como la llama el handler.
// ════════════════════════════════════════════════════════════════════════════
const LAT = 14.6349, LNG = -90.5069;   // Ciudad de Guatemala
const KM_LAT = 1 / 111.195;            // 1 km hacia el norte con R = 6371

const IDS = {
  negocio: 'n0000000-0000-4000-8000-000000000001',
  bolsa: 'b0000000-0000-4000-8000-000000000001',
};

function usuario(id, km, extra = {}) {
  return {
    id, rol: 'cliente', activo: true, notif_promociones: true,
    expo_push_token: `ExponentPushToken[${id}]`,
    latitud: km == null ? null : LAT + km * KM_LAT, longitud: km == null ? null : LNG,
    ...extra,
  };
}

function bolsaVisible(extra = {}) {
  const hoy = hoyGuatemala();
  return {
    id: IDS.bolsa, negocio_id: IDS.negocio, nombre: 'Combo almuerzo', tipo: 'cupon',
    activo: true, estado_aprobacion: 'aprobado', eliminado_en: null, cantidad_disponible: 5,
    fecha_disponible: hoy, fecha_caducidad: sumarDias(hoy, 3),
    hora_recogida_inicio: '08:00', hora_recogida_fin: '20:00',
    ...extra,
  };
}

function crearCliente({ usuarios = [], favoritos = [], negocio = {}, bolsa = bolsaVisible(), rpcExtra = [], rpcError = null } = {}) {
  const fake = crearFakeSupabase({
    usuarios,
    negocios: [{ id: IDS.negocio, nombre: 'Ola Azul', latitud: LAT, longitud: LNG, activo: true, estado_verificacion: 'aprobado', ...negocio }],
    bolsas: bolsa ? [bolsa] : [],
    favoritos,
  });
  const notificaciones = [];
  const llamadasRpc = [];
  const fallosInsert = new Set();

  const cliente = {
    from(tabla) {
      if (tabla !== 'notificaciones') return fake.from(tabla);
      return {
        insert: async (fila) => {
          if (fallosInsert.has(fila.usuario_id)) return { error: { code: '08006', message: 'conexión perdida' } };
          if (notificaciones.some(n => n.clave_idempotencia === fila.clave_idempotencia)) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          notificaciones.push(fila);
          return { error: null };
        },
      };
    },
    rpc(nombre, params) {
      return {
        range: async (desde, hasta) => {
          llamadasRpc.push({ nombre, params, desde, hasta });
          if (rpcError) return { data: null, error: rpcError };
          const filas = fake.tabla('usuarios')
            .filter(u => u.rol === 'cliente' && u.activo !== false && u.notif_promociones !== false
              && u.expo_push_token && u.latitud != null)
            .map(u => ({ usuario_id: u.id, expo_push_token: u.expo_push_token,
              distancia_km: haversine(params.p_lat, params.p_lng, u.latitud, u.longitud) }))
            .filter(f => f.distancia_km <= Math.min(params.p_radio_km, 10))
            .sort((a, b) => a.distancia_km - b.distancia_km)
            .concat(rpcExtra);
          return { data: filas.slice(desde, hasta + 1), error: null };
        },
      };
    },
  };
  return { cliente, fake, notificaciones, llamadasRpc, fallosInsert };
}

function espiaPush() {
  const lotes = [];
  const enviarPush = async (mensajes) => { lotes.push(mensajes); return { enviados: mensajes.length, errores: 0, tokensInvalidos: [] }; };
  return { lotes, enviarPush, tokens: () => lotes.flat().map(m => m.to) };
}

const evento = (ciclo) => ({ id: 'evt-1', aggregate_id: IDS.bolsa, payload: ciclo ? { ciclo } : {} });

// ── Frontera de 10 km ───────────────────────────────────────────────────────

test('frontera 10 km: entra quien está a 9.99 km, queda fuera quien está a 10.01 km', async () => {
  const { cliente, notificaciones, llamadasRpc } = crearCliente({
    usuarios: [usuario('dentro', 9.99), usuario('fuera', 10.01), usuario('cerca', 1)],
  });
  const push = espiaPush();
  const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });

  assert.deepEqual(notificaciones.map(n => n.usuario_id).sort(), ['cerca', 'dentro']);
  assert.deepEqual(push.tokens().sort(), ['ExponentPushToken[cerca]', 'ExponentPushToken[dentro]']);
  assert.equal(r.cercanos, 2);
  // La RPC se llama con el radio y la antigüedad contractuales.
  assert.equal(llamadasRpc[0].nombre, 'usuarios_en_radio');
  assert.deepEqual(llamadasRpc[0].params, { p_lat: LAT, p_lng: LNG, p_radio_km: 10, p_max_edad_dias: 30 });
});

test('defensa en profundidad: una fila de la RPC a más de 10 km se descarta', async () => {
  const { cliente, notificaciones } = crearCliente({
    usuarios: [usuario('ok', 3)],
    rpcExtra: [{ usuario_id: 'colado', expo_push_token: 'ExponentPushToken[colado]', distancia_km: RADIO_KM + 0.001 }],
  });
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush });
  assert.deepEqual(notificaciones.map(n => n.usuario_id), ['ok']);
});

test('la RPC se pagina: con más de 1000 cercanos no se pierde a nadie', async () => {
  const usuarios = Array.from({ length: PAGINA_RPC + 5 }, (_, i) => usuario(`u${i}`, (i % 900) / 100));
  const { cliente, notificaciones, llamadasRpc } = crearCliente({ usuarios });
  const push = espiaPush();
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
  assert.equal(llamadasRpc.length, 2);
  assert.deepEqual([llamadasRpc[1].desde, llamadasRpc[1].hasta], [PAGINA_RPC, 2 * PAGINA_RPC - 1]);
  assert.equal(notificaciones.length, PAGINA_RPC + 5);
  assert.equal(push.tokens().length, PAGINA_RPC + 5);
});

// ── Negocio sin coordenadas ─────────────────────────────────────────────────

for (const [nombre, coords] of [
  ['sin latitud/longitud', { latitud: null, longitud: null }],
  ['coordenadas fuera de rango', { latitud: 123, longitud: LNG }],
  ['coordenadas no numéricas', { latitud: 'abc', longitud: LNG }],
]) {
  test(`negocio ${nombre}: no consulta el radio, avisa solo a favoritos y no falla`, async () => {
    const { cliente, notificaciones, llamadasRpc } = crearCliente({
      negocio: coords,
      usuarios: [usuario('vecino', 1), usuario('fan', 50)],
      favoritos: [{ id: 'f1', usuario_id: 'fan', negocio_id: IDS.negocio }],
    });
    const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush });
    assert.equal(llamadasRpc.length, 0);
    assert.deepEqual(notificaciones.map(n => n.usuario_id), ['fan']);
    assert.equal(r.cercanos, 0);
  });
}

test('negocio sin coordenadas y sin favoritos: evento completo sin envíos', async () => {
  const { cliente, notificaciones } = crearCliente({ negocio: { latitud: null, longitud: null } });
  const push = espiaPush();
  const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
  assert.equal(notificaciones.length, 0);
  assert.equal(push.lotes.length, 0);
  assert.equal(r.destinatarios, 0);
});

// ── Deduplicación ───────────────────────────────────────────────────────────

test('un cliente cercano que también es favorito recibe una sola notificación', async () => {
  const { cliente, notificaciones } = crearCliente({
    usuarios: [usuario('ambos', 2), usuario('solo_fav', 40)],
    favoritos: [
      { id: 'f1', usuario_id: 'ambos', negocio_id: IDS.negocio },
      { id: 'f2', usuario_id: 'solo_fav', negocio_id: IDS.negocio },
    ],
  });
  const push = espiaPush();
  const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
  assert.deepEqual(notificaciones.map(n => n.usuario_id).sort(), ['ambos', 'solo_fav']);
  assert.equal(push.tokens().length, 2);
  assert.equal(r.destinatarios, 2);
});

test('favoritos respetan opt-out, rol, cuenta inactiva y token ausente', async () => {
  const { cliente, notificaciones } = crearCliente({
    usuarios: [
      usuario('optout', null, { notif_promociones: false }),
      usuario('restaurante', null, { rol: 'restaurante' }),
      usuario('inactivo', null, { activo: false }),
      usuario('sin_token', null, { expo_push_token: null }),
      usuario('valido', null, { notif_promociones: null }), // NULL = no hizo opt-out
    ],
    favoritos: ['optout', 'restaurante', 'inactivo', 'sin_token', 'valido']
      .map((u, i) => ({ id: `f${i}`, usuario_id: u, negocio_id: IDS.negocio })),
  });
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush });
  assert.deepEqual(notificaciones.map(n => n.usuario_id), ['valido']);
});

// ── Idempotencia ────────────────────────────────────────────────────────────

test('reprocesar el mismo evento no reenvía push ni duplica la bandeja', async () => {
  const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1), usuario('b', 5)] });
  const push = espiaPush();
  const r1 = await manejarPublicacionVisible(evento('2026-10-05'), { cliente, enviarPush: push.enviarPush });
  const r2 = await manejarPublicacionVisible(evento('2026-10-05'), { cliente, enviarPush: push.enviarPush });

  assert.equal(r1.insertadas, 2);
  assert.equal(r2.insertadas, 0);
  assert.equal(r2.duplicadas, 2);
  assert.equal(notificaciones.length, 2);
  assert.equal(push.lotes.length, 1, 'el segundo proceso no llama a Expo');
});

test('la clave de idempotencia es geo:<bolsa>:<ciclo>:<usuario> y el ciclo sale de fecha_disponible', async () => {
  const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1)] });
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush });
  const ciclo = cicloPublicacion(bolsaVisible());
  assert.equal(ciclo, hoyGuatemala());
  assert.equal(notificaciones[0].clave_idempotencia, `geo:${IDS.bolsa}:${ciclo}:a`);
  assert.equal(claveNotificacion('x', 'c', 'u'), 'geo:x:c:u');
});

test('un ciclo nuevo (republicada con otra fecha) sí vuelve a notificar', async () => {
  const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1)] });
  const push = espiaPush();
  await manejarPublicacionVisible(evento('2026-10-05'), { cliente, enviarPush: push.enviarPush });
  await manejarPublicacionVisible(evento('2026-10-12'), { cliente, enviarPush: push.enviarPush });
  assert.equal(notificaciones.length, 2);
  assert.equal(push.lotes.length, 2);
});

test('fallo transitorio al guardar: el evento lanza para reintentarse y el reintento solo avisa al pendiente', async () => {
  const { cliente, notificaciones, fallosInsert } = crearCliente({ usuarios: [usuario('a', 1), usuario('b', 2)] });
  const push = espiaPush();
  fallosInsert.add('b');
  await assert.rejects(
    manejarPublicacionVisible(evento('c1'), { cliente, enviarPush: push.enviarPush }),
    /no se pudieron guardar/,
  );
  assert.deepEqual(push.tokens(), ['ExponentPushToken[a]'], 'quien sí se guardó recibe su push');

  fallosInsert.clear();
  await manejarPublicacionVisible(evento('c1'), { cliente, enviarPush: push.enviarPush });
  assert.deepEqual(push.tokens(), ['ExponentPushToken[a]', 'ExponentPushToken[b]'], 'a no recibe un segundo push');
  assert.equal(notificaciones.length, 2);
});

// ── Contenido y visibilidad ─────────────────────────────────────────────────

test('payload { tipo, bolsaId, negocioId } por el canal default (compatible con apps sin canal promociones)', async () => {
  const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1)] });
  const push = espiaPush();
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
  const [msg] = push.lotes[0];
  assert.equal(msg.channelId, 'default');
  assert.deepEqual(msg.data, { tipo: 'promocion', bolsaId: IDS.bolsa, negocioId: IDS.negocio });
  assert.deepEqual(notificaciones[0].data, msg.data);
  assert.equal(notificaciones[0].tipo, 'nueva_bolsa');
  assert.ok(notificaciones[0].cuerpo.includes('Ola Azul'));
});

test('PUSH_CANAL_CERCANIA=promociones cambia el canal; cualquier otro valor mantiene default', () => {
  const ruta = require.resolve('../services/notificacionesCercania');
  const original = process.env.PUSH_CANAL_CERCANIA;
  const canalCon = (valor) => {
    if (valor === undefined) delete process.env.PUSH_CANAL_CERCANIA;
    else process.env.PUSH_CANAL_CERCANIA = valor;
    delete require.cache[ruta];
    return require(ruta).CANAL_CERCANIA;
  };
  try {
    assert.equal(canalCon('promociones'), 'promociones');
    assert.equal(canalCon('inventado'), 'default');
    assert.equal(canalCon(undefined), 'default');
  } finally {
    if (original === undefined) delete process.env.PUSH_CANAL_CERCANIA;
    else process.env.PUSH_CANAL_CERCANIA = original;
    delete require.cache[ruta];
  }
});

test('Tiempo limitado (tipo bolsa) usa su propio tipo y título', async () => {
  const { cliente } = crearCliente({ usuarios: [usuario('a', 1)], bolsa: bolsaVisible({ tipo: 'bolsa' }) });
  const push = espiaPush();
  await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
  assert.equal(push.lotes[0][0].data.tipo, 'tiempo_limitado');
  assert.match(push.lotes[0][0].title, /Tiempo limitado/);
});

for (const [nombre, cambios] of [
  ['oculta por el restaurante', { activo: false }],
  ['agotada', { cantidad_disponible: 0 }],
  ['eliminada', { eliminado_en: '2026-10-01T00:00:00Z' }],
  ['que todavía no inicia', { fecha_disponible: sumarDias(hoyGuatemala(), 2) }],
]) {
  test(`publicación ${nombre} al procesar el evento: cierra sin avisar`, async () => {
    const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1)], bolsa: bolsaVisible(cambios) });
    const push = espiaPush();
    const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: push.enviarPush });
    assert.equal(r.omitido, 'no_visible');
    assert.equal(notificaciones.length, 0);
    assert.equal(push.lotes.length, 0);
  });
}

test('publicación inexistente: cierra sin avisar ni lanzar', async () => {
  const { cliente } = crearCliente({ bolsa: null });
  const r = await manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush });
  assert.equal(r.omitido, 'no_existe');
});

test('error de la RPC: lanza para que el despachador reintente', async () => {
  const { cliente, notificaciones } = crearCliente({ usuarios: [usuario('a', 1)], rpcError: { message: 'timeout' } });
  await assert.rejects(manejarPublicacionVisible(evento(), { cliente, enviarPush: espiaPush().enviarPush }), /usuarios_en_radio/);
  assert.equal(notificaciones.length, 0);
});

// ── Servicio push (lotes, canales, tickets) ─────────────────────────────────

function mensajes(n) {
  return Array.from({ length: n }, (_, i) => ({ to: `ExponentPushToken[t${i}]`, title: 't', body: 'b', channelId: 'promociones' }));
}

test(`push: 250 mensajes viajan en lotes de ${EXPO_LOTE_MAX}`, async () => {
  const tamanos = [];
  const post = async (_url, lote) => { tamanos.push(lote.length); return { data: { data: lote.map(() => ({ status: 'ok' })) } }; };
  const r = await enviarPushEnLotes(mensajes(250), { post, cliente: crearFakeSupabase() });
  assert.deepEqual(tamanos, [100, 100, 50]);
  assert.equal(r.enviados, 250);
});

test('push: DeviceNotRegistered pone a NULL el token de ese usuario y no toca los demás', async () => {
  const fake = crearFakeSupabase({
    usuarios: [
      { id: 'u0', expo_push_token: 'ExponentPushToken[t0]' },
      { id: 'u1', expo_push_token: 'ExponentPushToken[t1]' },
      { id: 'u2', expo_push_token: 'ExponentPushToken[t2]' },
    ],
  });
  const post = async (_url, lote) => ({
    data: { data: lote.map((m, i) => (i === 1
      ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: m.to } }
      : i === 2 ? { status: 'error', details: { error: 'MessageRateExceeded' } } : { status: 'ok' })) },
  });
  const r = await enviarPushEnLotes(mensajes(3), { post, cliente: fake });
  assert.deepEqual(r.tokensInvalidos, ['ExponentPushToken[t1]']);
  assert.equal(r.enviados, 1);
  assert.equal(r.errores, 2);
  const tokens = Object.fromEntries(fake.tabla('usuarios').map(u => [u.id, u.expo_push_token]));
  assert.deepEqual(tokens, { u0: 'ExponentPushToken[t0]', u1: null, u2: 'ExponentPushToken[t2]' });
});

test('push: un lote caído no impide enviar los siguientes ni lanza', async () => {
  let n = 0;
  const post = async (_url, lote) => {
    n += 1;
    if (n === 1) throw new Error('ECONNRESET');
    return { data: { data: lote.map(() => ({ status: 'ok' })) } };
  };
  const r = await enviarPushEnLotes(mensajes(150), { post, cliente: crearFakeSupabase() });
  assert.equal(r.errores, 100);
  assert.equal(r.enviados, 50);
});

test('push: un channelId desconocido cae a default (Android no muestra canales inexistentes)', async () => {
  const { construirMensaje } = require('../services/notificaciones');
  assert.equal(construirMensaje('t', 'a', 'b', {}, 'promociones').channelId, 'promociones');
  assert.equal(construirMensaje('t', 'a', 'b', {}, 'pedidos').channelId, 'pedidos');
  assert.equal(construirMensaje('t', 'a', 'b', {}, 'inventado').channelId, 'default');
  assert.equal(construirMensaje('t', 'a', 'b', {}).channelId, 'default');
});
