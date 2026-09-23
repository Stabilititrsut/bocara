// Ejecutar: node scripts/test-push-dedup-behavioral.cjs. Sin red, Expo ni dispositivo real.
//
// scripts/test-push.cjs y scripts/test-pago-estado.cjs (FASE 7) verifican por
// REGEX que el patrón de dedup/cold-start/cross-role está presente en
// app/_layout.tsx. Este script va un paso más allá: EXTRAE literalmente el
// cuerpo de los dos useEffect relevantes (listeners de notificación, y
// resolución de la notificación pendiente) directamente del archivo fuente
// -- no una reimplementación propia -- los compila con TypeScript y los
// EJECUTA con Notifications/router/usuarioRef mockeados, para confirmar
// comportamiento real (no solo presencia de texto) en:
//   #18 cold start con sesión aún no cargada (guarda pendiente, no navega a ciegas)
//   #19 dedup de taps repetidos (mismo id no navega dos veces)
//   #20 cross-role (el rol de la sesión manda, nunca `data.screen`)
//
// Si en el futuro alguien cambia el texto exacto de _layout.tsx, los
// `assert.equal(count, 1)` de abajo fallan de forma explícita en vez de
// silenciosamente dejar de probar nada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const layoutSrc = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
const resolverSrc = fs.readFileSync(path.join(root, 'src/utils/resolverRutaNotificacion.ts'), 'utf8');

function extract(src, startMarker, endMarker) {
  const startCount = src.split(startMarker).length - 1;
  assert.equal(startCount, 1, `marcador de inicio no es único en el archivo: ${JSON.stringify(startMarker)}`);
  const start = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, start);
  assert.notEqual(endIdx, -1, `marcador de fin no encontrado tras el de inicio: ${JSON.stringify(endMarker)}`);
  return src.slice(start, endIdx + endMarker.length);
}

function compileTs(tsSource, filename) {
  const code = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const exportsObj = {};
  vm.runInNewContext(code, { exports: exportsObj, console }, { filename });
  return exportsObj;
}

// Resolver REAL (mismo módulo que usa _layout.tsx) — ya cubierto por
// scripts/test-push.cjs y scripts/test-navigation-events.cjs; se reutiliza
// aquí tal cual, sin mocks, para que el cross-role se pruebe con la lógica
// real de punta a punta (listener -> resolver -> router.push).
const { resolverRutaNotificacion } = compileTs(resolverSrc, 'resolverRutaNotificacion.ts');

// ── Efecto 1: listeners de notificaciones (registro, dedup, cold start) ────
const efecto1Body = extract(
  layoutSrc,
  'if (!Notifications) return;',
  'subRespuesta.remove();\r\n    };'
);

function compileEfecto1() {
  const wrapped = `
    function efectoListeners(ctx) {
      const { Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion } = ctx;
      ${efecto1Body}
    }
    exports.efectoListeners = efectoListeners;
  `;
  return compileTs(wrapped, 'efectoListeners.ts').efectoListeners;
}

function mockNotifications(coldStartResponse) {
  let responseCb = null;
  const calls = { removedReceived: false, removedResponse: false };
  return {
    addNotificationReceivedListener: () => ({ remove: () => { calls.removedReceived = true; } }),
    addNotificationResponseReceivedListener: (cb) => {
      responseCb = cb;
      return { remove: () => { calls.removedResponse = true; } };
    },
    getLastNotificationResponseAsync: () => Promise.resolve(coldStartResponse),
    _calls: calls,
    _fireTap: (id, data) => responseCb({ notification: { request: { identifier: id, content: { data } } } }),
  };
}

function mockRouter() {
  return {
    pushCalls: [], replaceCalls: [],
    push(r) { this.pushCalls.push(r); },
    replace(r) { this.replaceCalls.push(r); },
  };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

test('#19 dedup: tap en vivo y cold start reportando el MISMO id navegan una sola vez', async () => {
  const efectoListeners = compileEfecto1();
  const router = mockRouter();
  const usuarioRef = { current: { rol: 'cliente' } };
  const pendingNotifRef = { current: null };
  const Notifications = mockNotifications({ notification: { request: { identifier: 'notif-1', content: { data: { pedidoId: 'p1' } } } } });

  const cleanup = efectoListeners({ Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  await flush(); // getLastNotificationResponseAsync().then(...) resuelve como microtask

  Notifications._fireTap('notif-1', { pedidoId: 'p1' }); // mismo id que el cold start

  assert.equal(router.pushCalls.length, 1, 'debe navegar una sola vez pese a dos reportes del mismo id');
  assert.equal(router.pushCalls[0], '/(tabs)/pedidos');

  cleanup();
  assert.equal(Notifications._calls.removedReceived, true, 'listener de foreground debe removerse al desmontar');
  assert.equal(Notifications._calls.removedResponse, true, 'listener de tap debe removerse al desmontar');
});

test('#19 dedup: ids distintos SÍ navegan cada uno (el dedup no bloquea notificaciones legítimas distintas)', async () => {
  const efectoListeners = compileEfecto1();
  const router = mockRouter();
  const usuarioRef = { current: { rol: 'restaurante' } };
  const pendingNotifRef = { current: null };
  const Notifications = mockNotifications(null);
  const cleanup = efectoListeners({ Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  await flush();

  Notifications._fireTap('notif-A', { pedidoId: 'pA' });
  Notifications._fireTap('notif-B', { pedidoId: 'pB' });

  assert.equal(router.pushCalls.length, 2, 'ids distintos no deben deduplicarse entre sí');
  cleanup();
});

test('HALLAZGO (no bloqueante): taps SIN identifier no pasan por el guard de dedup y navegan cada vez', async () => {
  const efectoListeners = compileEfecto1();
  const router = mockRouter();
  const usuarioRef = { current: { rol: 'cliente' } };
  const pendingNotifRef = { current: null };
  const Notifications = mockNotifications(null);
  const cleanup = efectoListeners({ Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  await flush();

  Notifications._fireTap(undefined, { pedidoId: 'p1' });
  Notifications._fireTap(undefined, { pedidoId: 'p1' });

  // Comportamiento actual, documentado a propósito: `if (id) { ... }` en
  // _layout.tsx omite el guard de dedup por completo cuando `id` es
  // undefined, así que dos reportes sin identifier SÍ navegan dos veces.
  // Expo entrega `request.identifier` en la práctica (push remoto y local),
  // pero esto depende de una garantía externa no verificada por código.
  assert.equal(router.pushCalls.length, 2, 'sin id, el guard de dedup no aplica (ver informe: hallazgo, no bug bloqueante)');
  cleanup();
});

test('#20 cross-role: el mismo payload de pedido resuelve a la sección propia de cada rol, nunca a la ajena, ni con data.screen falsificado', async () => {
  for (const [rol, esperado] of [['cliente', '/(tabs)/pedidos'], ['restaurante', '/restaurante/pedidos'], ['admin', '/admin']]) {
    const efectoListeners = compileEfecto1();
    const router = mockRouter();
    const usuarioRef = { current: { rol } };
    const pendingNotifRef = { current: null };
    const Notifications = mockNotifications(null);
    const cleanup = efectoListeners({ Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
    await flush();

    // El payload dice explícitamente "screen: restaurante" sin importar el rol real
    Notifications._fireTap(`notif-${rol}`, { pedidoId: 'p1', screen: 'restaurante' });

    assert.equal(router.pushCalls[0], esperado, `rol ${rol} debe caer siempre en su propia sección, ignorando data.screen`);
    cleanup();
  }
});

test('#18 cold start con sesión aún no cargada: no navega a ciegas, guarda la notificación como pendiente', async () => {
  const efectoListeners = compileEfecto1();
  const router = mockRouter();
  const usuarioRef = { current: undefined }; // sesión aún no cargada
  const pendingNotifRef = { current: null };
  const Notifications = mockNotifications({ notification: { request: { identifier: 'cold-1', content: { data: { pedidoId: 'p1' } } } } });
  const cleanup = efectoListeners({ Notifications, usuarioRef, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  await flush();

  assert.equal(router.pushCalls.length, 0, 'sin rol todavía no debe navegar');
  assert.deepEqual(pendingNotifRef.current, { pedidoId: 'p1' }, 'debe quedar guardada para reintentar cuando la sesión termine de cargar');
  cleanup();
});

// ── Efecto 2: resolución de la notificación pendiente cuando la sesión carga ──
const efecto2Body = extract(
  layoutSrc,
  'if (loading || !usuario || !pendingNotifRef.current) return;',
  'if (ruta) router.replace(ruta as any);'
);

function compileEfecto2() {
  const wrapped = `
    function efectoPendiente(ctx) {
      const { loading, usuario, pendingNotifRef, router, rutaParaNotificacion } = ctx;
      ${efecto2Body}
    }
    exports.efectoPendiente = efectoPendiente;
  `;
  return compileTs(wrapped, 'efectoPendiente.ts').efectoPendiente;
}

test('#18 cuando la sesión termina de cargar, la notificación pendiente se resuelve UNA vez con router.replace', () => {
  const efectoPendiente = compileEfecto2();
  const router = mockRouter();
  const pendingNotifRef = { current: { pedidoId: 'p1' } };
  const usuario = { rol: 'cliente' };

  efectoPendiente({ loading: false, usuario, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  assert.equal(router.replaceCalls.length, 1);
  assert.equal(router.replaceCalls[0], '/(tabs)/pedidos');
  assert.equal(pendingNotifRef.current, null, 'debe limpiarse tras resolver — un segundo render no debe repetir la navegación');

  // Segundo "render" con las mismas deps (pendingNotifRef ya limpio)
  efectoPendiente({ loading: false, usuario, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  assert.equal(router.replaceCalls.length, 1, 'no debe repetir la navegación en el siguiente render');
});

test('#18 mientras loading=true (sesión aún cargando) no resuelve la pendiente aunque exista', () => {
  const efectoPendiente = compileEfecto2();
  const router = mockRouter();
  const pendingNotifRef = { current: { pedidoId: 'p1' } };
  efectoPendiente({ loading: true, usuario: { rol: 'cliente' }, pendingNotifRef, router, rutaParaNotificacion: resolverRutaNotificacion });
  assert.equal(router.replaceCalls.length, 0);
  assert.deepEqual(pendingNotifRef.current, { pedidoId: 'p1' });
});
