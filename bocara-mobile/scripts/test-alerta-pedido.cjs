// Ejecutar: node scripts/test-alerta-pedido.cjs. Sin red, Expo, navegador ni dispositivo.
// Cubre el timbre de cocina del panel del restaurante:
//   · src/utils/alertaPedido.ts — debeSonarTimbre (por ESTADO, también en la
//     primera carga), iniciarTimbre/detenerTimbre (sin intervalos duplicados),
//     resiliencia ante un AudioContext suspendido, ruta nativa.
//   · hooks/use-timbre-cocina.ts — montado con un doble de React que SÍ corre
//     efectos: suena en la primera carga, se calla al aceptar, respeta la
//     preferencia "Silenciado", pide/suelta Wake Lock.
//   · Cableado: el layout monta el hook (vía TimbreCocinaProvider) sin barra
//     visible; pedidos.tsx pinta el control, publica su lista, dice
//     "Aceptar pedido" y confirma antes de cancelar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const leer = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}, globals = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(leer(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports: exportsObj, console, Promise, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const flush = () => new Promise((r) => setImmediate(r));

// ── Dobles ───────────────────────────────────────────────────────────────────

function relojFalso() {
  const intervalos = new Map();
  let siguiente = 1;
  return {
    intervalos,
    creados: 0,
    setInterval(fn, ms) { this.creados++; const id = siguiente++; intervalos.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervalos.delete(id); },
    // Un timeout inmediato: desbloquearAudio no espera 1.5 s reales.
    setTimeout(fn) { fn(); return 0; },
    clearTimeout() {},
    tic(ms) { for (const { fn, ms: cada } of [...intervalos.values()]) if (cada === ms) fn(); },
  };
}

// modoResume: 'ok' (pasa a running), 'rechaza', 'pendiente' (nunca resuelve), 'lanza' (sync)
function navegadorFalso({ modoResume = 'ok', wakeLock = true } = {}) {
  const nav = { resumes: 0, osciladores: 0, vibraciones: 0, locksPedidos: 0, locksLiberados: 0, listeners: {} };
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; nav.ctx = this; }
    resume() {
      nav.resumes++;
      if (modoResume === 'ok') { this.state = 'running'; return Promise.resolve(); }
      if (modoResume === 'rechaza') return Promise.reject(new Error('NotAllowedError'));
      if (modoResume === 'lanza') throw new Error('resume roto');
      return new Promise(() => {});
    }
    createOscillator() {
      nav.osciladores++;
      return { type: '', frequency: { value: 0 }, connect: (g) => g, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}) };
    }
  }
  nav.window = { AudioContext: FakeAudioContext };
  nav.navigator = {
    vibrate() { nav.vibraciones++; },
    wakeLock: wakeLock ? {
      request: async () => { nav.locksPedidos++; return { release: async () => { nav.locksLiberados++; } }; },
    } : undefined,
  };
  nav.document = {
    visibilityState: 'visible',
    addEventListener(t, fn) { (nav.listeners[t] ||= new Set()).add(fn); },
    removeEventListener(t, fn) { nav.listeners[t]?.delete(fn); },
    disparar(t) { [...(nav.listeners[t] || [])].forEach((fn) => fn()); },
  };
  return nav;
}

function cargarAlerta({ os = 'web', nav = navegadorFalso(), reloj = relojFalso(), notifs } = {}) {
  const vib = { vibradas: 0, canceladas: 0 };
  const mocks = {
    'react-native': {
      Platform: { OS: os },
      Vibration: { vibrate() { vib.vibradas++; }, cancel() { vib.canceladas++; } },
    },
  };
  if (notifs) mocks['expo-notifications'] = notifs;
  const globals = {
    setInterval: reloj.setInterval.bind(reloj), clearInterval: reloj.clearInterval.bind(reloj),
    setTimeout: reloj.setTimeout.bind(reloj), clearTimeout: reloj.clearTimeout.bind(reloj),
  };
  if (os === 'web') Object.assign(globals, { window: nav.window, navigator: nav.navigator, document: nav.document });
  const A = load('src/utils/alertaPedido.ts', mocks, globals);
  return { A, nav, reloj, vib, globals };
}

// Ninguna promesa rechazada debe quedar sin capturar en todo el script.
const rechazosSinCapturar = [];
process.on('unhandledRejection', (e) => rechazosSinCapturar.push(e));

// ── 1. debeSonarTimbre (pura) ─────────────────────────────────────────────────

test('debeSonarTimbre: true con al menos un pedido confirmado, también en la carga inicial', () => {
  const { A } = cargarAlerta();
  // Carga inicial = la primera lista que ve la pantalla: no hay "vistos" que
  // excluyan nada. Un pedido que entró con el panel cerrado suena igual.
  assert.equal(A.debeSonarTimbre([{ id: '1', estado: 'confirmado' }]), true);
  assert.equal(A.debeSonarTimbre([{ estado: 'listo' }, { estado: 'confirmado' }, { estado: 'en_preparacion' }]), true);
});

test('debeSonarTimbre: false si solo hay en_preparacion, listo, completado (o nada)', () => {
  const { A } = cargarAlerta();
  assert.equal(A.debeSonarTimbre([{ estado: 'en_preparacion' }, { estado: 'listo' }, { estado: 'completado' }]), false);
  for (const v of [[], null, undefined, [null], [{}]]) assert.equal(A.debeSonarTimbre(v), false, JSON.stringify(v));
});

test('detectarNuevosConfirmados (aviso visual) conserva su contrato: la primera carga no avisa', () => {
  const { A } = cargarAlerta();
  const r = A.detectarNuevosConfirmados(null, [{ id: '1', estado: 'confirmado' }]);
  assert.equal(r.nuevos.length, 0);
  const r2 = A.detectarNuevosConfirmados(r.vistos, [{ id: '1', estado: 'confirmado' }, { id: '2', estado: 'confirmado' }]);
  assert.deepEqual(r2.nuevos.map((p) => p.id), ['2']);
});

// ── 2. iniciarTimbre / detenerTimbre ──────────────────────────────────────────

test('iniciarTimbre: llamadas consecutivas no duplican el intervalo', async () => {
  const { A, reloj, nav } = cargarAlerta();
  assert.equal(await A.desbloquearAudio(), true);
  assert.equal(A.iniciarTimbre(), true);
  assert.equal(A.iniciarTimbre(), false);
  assert.equal(A.iniciarTimbre(), false);
  assert.equal(reloj.creados, 1, 'un solo setInterval');
  assert.equal(reloj.intervalos.size, 1);
  assert.equal(reloj.intervalos.values().next().value.ms, A.INTERVALO_TIMBRE_MS);
  assert.equal(A.INTERVALO_TIMBRE_MS, 3000);
  assert.equal(A.timbreSonando(), true);
  assert.ok(nav.osciladores > 0, 'toca de inmediato, sin esperar al primer intervalo');
  // Cada intervalo vuelve a tocar la campana.
  const antes = nav.osciladores;
  reloj.tic(A.INTERVALO_TIMBRE_MS);
  assert.ok(nav.osciladores > antes);
  A.detenerTimbre();
});

test('detenerTimbre: libera el intervalo; es idempotente y permite volver a iniciar', async () => {
  const { A, reloj } = cargarAlerta();
  await A.desbloquearAudio();
  A.iniciarTimbre();
  assert.equal(A.detenerTimbre(), true);
  assert.equal(reloj.intervalos.size, 0, 'no queda ningún intervalo vivo');
  assert.equal(A.timbreSonando(), false);
  assert.equal(A.detenerTimbre(), false, 'detener dos veces no falla');
  assert.equal(A.iniciarTimbre(), true, 'tras detener se puede volver a iniciar');
  assert.equal(reloj.intervalos.size, 1);
  A.detenerTimbre();
});

// ── 3. AudioContext suspendido (autoplay bloqueado) ───────────────────────────

for (const modo of ['rechaza', 'pendiente', 'lanza']) {
  test(`AudioContext suspendido (resume ${modo}): sin excepción, sin colgarse, sin sonar`, async () => {
    const nav = navegadorFalso({ modoResume: modo });
    const { A, reloj } = cargarAlerta({ nav });
    assert.equal(A.audioWebListo(), false, 'sin gesto, el audio no está listo');
    assert.equal(await A.desbloquearAudio(), false, 'no se cuelga aunque resume() nunca resuelva');
    assert.doesNotThrow(() => A.iniciarTimbre());
    assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) reloj.tic(A.INTERVALO_TIMBRE_MS); });
    assert.equal(nav.osciladores, 0, 'con el contexto suspendido no se programa ningún tono');
    assert.ok(nav.resumes >= 2, 'cada toque reintenta reanudar (sin esperar)');
    assert.doesNotThrow(() => A.detenerTimbre());
    await flush();
    assert.deepEqual(rechazosSinCapturar, [], 'ningún rechazo de resume() queda sin capturar');
  });
}

test('sin Web Audio en el navegador: desbloquear devuelve false y el timbre no lanza', async () => {
  const nav = navegadorFalso();
  nav.window = {};
  const { A, reloj } = cargarAlerta({ nav });
  assert.equal(await A.desbloquearAudio(), false);
  assert.doesNotThrow(() => { A.iniciarTimbre(); reloj.tic(A.INTERVALO_TIMBRE_MS); A.detenerTimbre(); });
});

test('prepararAudioWeb: el primer toque en la página desbloquea y avisa', async () => {
  const { A, nav } = cargarAlerta();
  let avisado = 0;
  A.prepararAudioWeb(() => { avisado++; });
  nav.document.disparar('pointerdown');
  await flush();
  assert.equal(avisado, 1);
  assert.equal(A.audioWebListo(), true);
  nav.document.disparar('pointerdown');
  await flush();
  assert.equal(avisado, 1, 'el listener se quita tras el primer gesto');
});

// ── 4. Nativo ─────────────────────────────────────────────────────────────────

test('nativo: vibra en cada toque, notifica ~cada 21 s (no cada 3 s) y limpia al detener', () => {
  const programadas = [];
  const descartadas = [];
  const notifs = {
    scheduleNotificationAsync: async (n) => { programadas.push(n); },
    dismissNotificationAsync: async (id) => { descartadas.push(id); },
  };
  const { A, reloj, vib } = cargarAlerta({ os: 'android', notifs });
  A.iniciarTimbre();
  for (let i = 0; i < 7; i++) reloj.tic(A.INTERVALO_TIMBRE_MS);
  assert.equal(vib.vibradas, 8, '1 inmediato + 7 intervalos');
  assert.equal(programadas.length, 2, 'toques 1 y 8');
  assert.equal(programadas[0].identifier, 'timbre-cocina', 'misma notificación: reemplaza, no se apilan');
  assert.deepEqual(JSON.parse(JSON.stringify(programadas[0].trigger)), { channelId: 'pedidos' });
  A.detenerTimbre();
  assert.equal(vib.canceladas, 1);
  assert.deepEqual(descartadas, ['timbre-cocina']);
});

test('nativo: una notificación que falla no rompe el timbre', async () => {
  const notifs = { scheduleNotificationAsync: async () => { throw new Error('sin permiso'); } };
  const { A } = cargarAlerta({ os: 'ios', notifs });
  assert.doesNotThrow(() => A.iniciarTimbre());
  await flush();
  assert.doesNotThrow(() => A.detenerTimbre());
  assert.deepEqual(rechazosSinCapturar, []);
});

// ── 5. Pedidos compartidos (pub/sub) ──────────────────────────────────────────

test('publicar/suscribir pedidos: llega a los suscriptores y se puede desuscribir', () => {
  const { A } = cargarAlerta();
  const recibidas = [];
  const quitar = A.suscribirPedidosRestaurante((l) => recibidas.push(l.length));
  A.suscribirPedidosRestaurante(() => { throw new Error('oyente roto'); });
  assert.doesNotThrow(() => A.publicarPedidosRestaurante([{ estado: 'confirmado' }]));
  quitar();
  A.publicarPedidosRestaurante([{}, {}]);
  assert.deepEqual(recibidas, [1], 'un oyente roto no impide al resto; tras desuscribir no recibe');
});

// ── 6. Hook useTimbreCocina (montado con un doble de React que corre efectos) ─

function reactFalso() {
  const st = { estados: [], refs: [], cbs: [], efectos: [], pendientes: [] };
  let iS, iR, iC, iE;
  const igual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(init) {
      const i = iS++;
      if (!(i in st.estados)) st.estados[i] = typeof init === 'function' ? init() : init;
      return [st.estados[i], (v) => { st.estados[i] = typeof v === 'function' ? v(st.estados[i]) : v; }];
    },
    useRef(init) { const i = iR++; if (!(i in st.refs)) st.refs[i] = { current: init }; return st.refs[i]; },
    useCallback(fn, deps) {
      const i = iC++;
      if (st.cbs[i] && igual(st.cbs[i].deps, deps)) return st.cbs[i].fn;
      st.cbs[i] = { fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const i = iE++;
      const prev = st.efectos[i];
      if (prev && deps && igual(prev.deps, deps)) return;
      st.pendientes.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        st.efectos[i] = { deps, cleanup: fn() };
      });
    },
  };
  return {
    React,
    render(hook) {
      iS = iR = iC = iE = 0;
      const r = hook();
      const p = st.pendientes.splice(0);
      p.forEach((f) => f());
      return r;
    },
    desmontar() { st.efectos.forEach((e) => { if (typeof e?.cleanup === 'function') e.cleanup(); }); },
  };
}

function montarHook({ pedidos = [], almacen = {}, nav = navegadorFalso() } = {}) {
  const base = cargarAlerta({ nav });
  const { A, reloj, globals } = base;
  const r = reactFalso();
  const estado = { pedidos, fallar: false, consultas: 0, realtime: null };
  const H = load('hooks/use-timbre-cocina.ts', {
    react: r.React,
    'react-native': { Platform: { OS: 'web' } },
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async (k) => (k in almacen ? almacen[k] : null),
        setItem: async (k, v) => { almacen[k] = v; },
      },
    },
    '@/src/services/api': {
      pedidosAPI: {
        restaurante: async () => {
          estado.consultas++;
          if (estado.fallar) throw new Error('sin red');
          return { data: estado.pedidos };
        },
      },
    },
    '@/src/context/RealtimeContext': { useRealtime: () => ({ onPedidoCambiado: (cb) => { estado.realtime = cb; return () => {}; } }) },
    '@/src/utils/alertaPedido': A,
  }, globals);
  let res;
  const pintar = async () => {
    // Varias pasadas: un efecto puede actualizar estado que habilita otro.
    for (let i = 0; i < 4; i++) { res = r.render(() => H.useTimbreCocina()); await flush(); }
    return res;
  };
  return { A, H, nav, reloj, estado, almacen, pintar, desmontar: () => r.desmontar(), get res() { return res; } };
}

test('hook: suena en la PRIMERA carga si ya hay un pedido confirmado (tras el gesto)', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }] });
  let r = await h.pintar();
  assert.equal(r.hayPendientes, true, 'el pedido previo a abrir el panel cuenta');
  assert.equal(r.pendientes, 1);
  // Sin gesto, el navegador no deja sonar: banner en vez de timbre.
  assert.equal(r.audioDesbloqueado, false);
  assert.equal(r.armado, false);
  assert.equal(h.A.timbreSonando(), false);
  // Toque en el banner → activa (gesto) → suena.
  await r.activarTimbre();
  r = await h.pintar();
  assert.equal(r.armado, true);
  assert.equal(r.sonando, true);
  assert.equal(h.A.timbreSonando(), true);
  h.desmontar();
  assert.equal(h.A.timbreSonando(), false, 'al salir del panel el timbre se detiene');
});

test('hook: cualquier primer toque en el panel desbloquea el audio y arranca el timbre', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }] });
  await h.pintar();
  h.nav.document.disparar('pointerdown');
  await flush();
  const r = await h.pintar();
  assert.equal(r.sonando, true);
  h.desmontar();
});

test('hook: se calla solo cuando ya no queda ningún confirmado (aceptar → en_preparacion)', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }, { id: 'p2', estado: 'confirmado' }] });
  let r = await h.pintar();
  await r.activarTimbre();
  r = await h.pintar();
  assert.equal(h.A.timbreSonando(), true);
  // Se acepta uno: sigue sonando por el otro.
  h.A.publicarPedidosRestaurante([{ id: 'p1', estado: 'en_preparacion' }, { id: 'p2', estado: 'confirmado' }]);
  r = await h.pintar();
  assert.equal(r.pendientes, 1);
  assert.equal(h.A.timbreSonando(), true, 'queda uno sin aceptar: sigue sonando');
  // Se acepta el otro (la lista que publica pedidos.tsx tras aceptar): se calla al instante.
  h.A.publicarPedidosRestaurante([{ id: 'p1', estado: 'en_preparacion' }, { id: 'p2', estado: 'en_preparacion' }]);
  r = await h.pintar();
  assert.equal(r.sonando, false);
  assert.equal(h.A.timbreSonando(), false);
  // Si entra otro pedido después, vuelve a sonar.
  h.estado.pedidos = [{ id: 'p3', estado: 'confirmado' }];
  h.estado.realtime();
  r = await h.pintar();
  assert.equal(h.A.timbreSonando(), true);
  h.desmontar();
});

test('hook: un pedido cancelado también calla el timbre', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }] });
  let r = await h.pintar();
  await r.activarTimbre();
  await h.pintar();
  h.A.publicarPedidosRestaurante([]); // pedidos.tsx filtra los cancelados
  r = await h.pintar();
  assert.equal(h.A.timbreSonando(), false);
  h.desmontar();
});

test('hook: un fallo de red no calla un timbre que debe sonar', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }] });
  let r = await h.pintar();
  await r.activarTimbre();
  await h.pintar();
  h.estado.fallar = true;
  h.estado.realtime();
  r = await h.pintar();
  assert.equal(r.hayPendientes, true);
  assert.equal(h.A.timbreSonando(), true);
  h.desmontar();
});

test('hook: polling propio cada 5 s, pero no repite la consulta si pedidos.tsx acaba de publicar', async () => {
  const h = montarHook({ pedidos: [] });
  await h.pintar();
  const tras_arranque = h.estado.consultas;
  assert.equal(tras_arranque, 1);
  h.A.publicarPedidosRestaurante([]);
  h.reloj.tic(5000);
  await flush();
  assert.equal(h.estado.consultas, tras_arranque, 'lista recién publicada: no se repite');
  h.desmontar();
});

test('hook: "Silenciado" se guarda, calla el timbre y se respeta al volver a abrir el panel', async () => {
  const almacen = {};
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }], almacen });
  let r = await h.pintar();
  await r.activarTimbre();
  r = await h.pintar();
  assert.equal(h.A.timbreSonando(), true);
  await r.alternarTimbre();
  r = await h.pintar();
  assert.equal(r.activado, false);
  assert.equal(r.armado, false);
  assert.equal(h.A.timbreSonando(), false);
  assert.equal(almacen.bocara_timbre_cocina, '0');
  h.desmontar();

  const h2 = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }], almacen });
  r = await h2.pintar();
  assert.equal(r.activado, false, 'la preferencia persiste');
  // Volver a activarlo desde el control.
  await r.alternarTimbre();
  r = await h2.pintar();
  assert.equal(r.activado, true);
  assert.equal(almacen.bocara_timbre_cocina, '1');
  assert.equal(h2.A.timbreSonando(), true);
  h2.desmontar();
});

test('hook: pide Wake Lock con el timbre armado y lo suelta al salir', async () => {
  const h = montarHook({ pedidos: [] });
  let r = await h.pintar();
  assert.equal(h.nav.locksPedidos, 0, 'sin armar, no se pide');
  await r.activarTimbre();
  r = await h.pintar();
  assert.equal(h.nav.locksPedidos, 1, 'armado (aunque no suene aún): la pantalla debe seguir encendida');
  h.desmontar();
  await flush();
  assert.equal(h.nav.locksLiberados, 1);
});

test('hook: sin Wake Lock en el navegador no falla', async () => {
  const h = montarHook({ pedidos: [{ id: 'p1', estado: 'confirmado' }], nav: navegadorFalso({ wakeLock: false }) });
  const r = await h.pintar();
  await r.activarTimbre();
  await h.pintar();
  assert.equal(h.A.timbreSonando(), true);
  h.desmontar();
});

// ── 7. Cableado en las pantallas ──────────────────────────────────────────────

test('restaurante/_layout monta el timbre global (suena en cualquier pestaña) SIN barra visible', () => {
  const src = leer('app/restaurante/_layout.tsx');
  assert.match(src, /<TimbreCocinaProvider>\s*<RestauranteTabs \/>\s*<\/TimbreCocinaProvider>/,
    'el proveedor envuelve TODAS las pestañas');
  assert.doesNotMatch(src, /BarraTimbreCocina/, 'Disponibles, Ganancias, Mi negocio… quedan limpias');
  assert.match(src, /tabBarBadge: pendientes > 0 \? pendientes : undefined/, 'pedidos por aceptar en la pestaña Pedidos');
  const ctx = leer('src/context/TimbreCocinaContext.tsx');
  assert.match(ctx, /const timbre = useTimbreCocina\(\);/, 'el proveedor es quien ejecuta el hook (una sola instancia)');
});

test('restaurante/pedidos: el control del timbre vive aquí y lee la instancia del layout', () => {
  const src = leer('app/restaurante/pedidos.tsx');
  assert.match(src, /const timbre = useTimbreCocinaPanel\(\);/);
  assert.match(src, /\{timbre && <BarraTimbreCocina timbre=\{timbre\} \/>\}/);
  assert.doesNotMatch(src, /useTimbreCocina\(\)/, 'no monta un segundo timbre (doble polling / doble sonido)');
});

test('barra: textos del control y del banner de activación', () => {
  const src = leer('components/BarraTimbreCocina.tsx');
  assert.match(src, /Timbre de cocina: \{armado \? 'Activado' : 'Silenciado'\}/);
  assert.match(src, /hayPendientes && !armado/, 'el banner sale cuando hay pendientes y el timbre no puede sonar');
  assert.match(src, /onPress=\{activarTimbre\}/, 'tocar el banner es el gesto que activa el audio');
  assert.match(src, /⚠️ Nuevo pedido pendiente\. Toca aquí para activar el timbre de cocina/);
});

test('restaurante/pedidos: publica su lista, "Aceptar pedido" → en_preparacion, ✕ pide confirmación', () => {
  const src = leer('app/restaurante/pedidos.tsx');
  assert.match(src, /publicarPedidosRestaurante\(reales\)/);
  assert.doesNotMatch(src, /reproducirAlertaNuevoPedido/, 'el sonido es del timbre global, no por evento');
  assert.match(src, /cambiarEstado\(p\.id, 'en_preparacion'\)\}>\s*<Text style=\{s\.btnListoText\}>✅ Aceptar pedido<\/Text>/);
  assert.doesNotMatch(src, /En preparación<\/Text>\s*<\/TouchableOpacity>/);
  assert.doesNotMatch(src, /cambiarEstado\(p\.id, 'cancelado'\)/, 'cancelar ya no es de un solo toque');
  assert.match(src, /onPress=\{\(\) => pedirCancelacion\(p\)\}/);
  assert.match(src, /<ConfirmarAccionModal[\s\S]*?onConfirmar=\{confirmarCancelacion\}/);
  assert.match(src, /actualizarEstado\(cancelarPedido\.id, 'cancelado'\)/);
});
