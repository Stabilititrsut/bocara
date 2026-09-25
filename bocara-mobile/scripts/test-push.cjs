// Ejecutar: node scripts/test-push.cjs. Sin red, Expo ni dispositivo real.
// Cubre el criterio del domingo frontend: registro de push, foreground, tap,
// cold start, dedup, cleanup de listeners, logout limpia pendiente, y que web
// nunca ejecuta nada nativo de expo-notifications. La mayor parte de esta
// lógica vive en app/_layout.tsx — se audita por lectura de fuente (mismo
// patrón que scripts/test-pago-estado.cjs FASE 7) más los casos nuevos que esa
// suite no cubre todavía (payload inválido, ruta arbitraria, canal Android,
// registro condicionado a dispositivo real).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}) {
  const exportsObj = {};
  const source = read(file);
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const layoutSrc = read('app/_layout.tsx');

// ── 1) foreground ────────────────────────────────────────────────────────

test('1) foreground: el listener de "recibida" existe y no navega solo (no saca al usuario de lo que hace)', () => {
  assert.match(layoutSrc, /addNotificationReceivedListener\(\(\) => \{\}\)/, 'foreground no debe navegar automáticamente');
});

// ── 2) tap ───────────────────────────────────────────────────────────────

test('2) tap: el listener de respuesta resuelve la ruta con el resolver único y navega', () => {
  assert.match(layoutSrc, /addNotificationResponseReceivedListener\(\(response: any\) => \{/);
  assert.match(layoutSrc, /procesarTap\(response\?\.notification\?\.request\?\.identifier, response\?\.notification\?\.request\?\.content\?\.data\)/);
  assert.match(layoutSrc, /if \(ruta\) router\.push\(ruta as any\);/);
});

// ── 3) cold start ────────────────────────────────────────────────────────

test('3) cold start: getLastNotificationResponseAsync se consulta y también pasa por procesarTap/dedup', () => {
  assert.match(layoutSrc, /Notifications\.getLastNotificationResponseAsync\?\.\(\)/);
  assert.match(layoutSrc, /procesarTap\(response\.notification\.request\.identifier, response\.notification\.request\.content\.data\)/);
});

// ── 4) dedup ─────────────────────────────────────────────────────────────

test('4) dedup: la misma notificación (foreground/tap/cold start reportando el mismo id) no navega dos veces', () => {
  assert.match(layoutSrc, /const procesadas = new Set<string>\(\);/);
  assert.match(layoutSrc, /if \(id\) \{ if \(procesadas\.has\(id\)\) return; procesadas\.add\(id\); \}/);
});

// ── 5-6) rol cliente / rol restaurante (resolver compartido) ───────────────

const resolver = () => load('src/utils/resolverRutaNotificacion.ts');

test('5) rol cliente: pedido confirmado/listo/cancelado siempre resuelve a la lista de pedidos del cliente', () => {
  const { resolverRutaNotificacion } = resolver();
  for (const tipo of ['pedido.pago_confirmado', 'pedido.listo', 'pedido.cancelado', undefined]) {
    assert.equal(resolverRutaNotificacion({ pedidoId: 'p1', tipo }, 'cliente'), '/(tabs)/pedidos');
  }
});

test('6) rol restaurante: con pedidoId va al panel de pedidos; sin pedidoId (aviso genérico) va al home del restaurante', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, 'restaurante'), '/restaurante/pedidos');
  assert.equal(resolverRutaNotificacion({}, 'restaurante'), '/restaurante');
});

// ── 7) payload inválido ──────────────────────────────────────────────────

test('7) payload inválido (null, string, número, pedidoId no-string) no lanza y no produce una ruta rota', () => {
  const { resolverRutaNotificacion, validarPayloadNotificacion } = resolver();
  for (const payload of [null, undefined, 'texto', 42, [], { pedidoId: 123 }, { pedidoId: '' }]) {
    assert.doesNotThrow(() => resolverRutaNotificacion(payload, 'cliente'));
  }
  // deepEqual con un objeto creado dentro del VM sandbox falla por identidad
  // de prototipo entre realms, no por contenido — se compara por claves.
  assert.equal(Object.keys(validarPayloadNotificacion(null)).length, 0);
  assert.equal(Object.keys(validarPayloadNotificacion('texto')).length, 0);
  assert.equal(validarPayloadNotificacion({ pedidoId: 123 }).pedidoId, undefined, 'pedidoId debe ser string — un número no es válido');
});

// ── 8) ruta arbitraria rechazada ─────────────────────────────────────────

test('8) data.route/data.screen arbitrarios nunca se usan como ruta — solo deciden entre rutas ya fijas por rol', () => {
  const { resolverRutaNotificacion } = resolver();
  const maliciosos = [
    { screen: '/admin/usuarios/eliminar-todo' },
    { route: '../../etc/passwd' },
    { screen: 'http://evil.example.com' },
  ];
  for (const data of maliciosos) {
    const ruta = resolverRutaNotificacion(data, 'cliente');
    assert.equal(ruta, '/(tabs)/pedidos', 'un cliente siempre cae en su propia sección, sin importar qué diga el payload');
  }
  const src = read('src/utils/resolverRutaNotificacion.ts');
  assert.doesNotMatch(src, /return data\.route/);
  assert.doesNotMatch(src, /return data\.screen/);
  assert.doesNotMatch(src, /router\.push\(data\.route/);
});

test('rol inválido/ajeno (ni cliente, ni restaurante, ni admin) nunca resuelve — mejor no navegar que navegar mal', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, 'hacker'), null);
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, ''), null);
});

// ── 9) logout limpia pendiente ──────────────────────────────────────────

test('9) logout/cambio de cuenta descarta cualquier notificación pendiente del usuario anterior', () => {
  assert.match(layoutSrc, /if \(!usuario\) \{ pushRegistered\.current = false; pendingNotifRef\.current = null; \}/);
});

// ── 10) web no ejecuta nativo ────────────────────────────────────────────

test('10) web: expo-notifications/expo-device solo se cargan fuera de web, y el registro de token exige un dispositivo real', () => {
  assert.match(layoutSrc, /if \(Platform\.OS !== 'web'\) \{/);
  assert.match(layoutSrc, /if \(!Notifications \|\| !Device\) return;/);
  assert.match(layoutSrc, /if \(!Device\.isDevice\) return;/, 'no debe intentar obtener push token en un simulador/emulador sin push real');
});

test('canal de Android configurado con sonido por defecto — nunca un asset inventado', () => {
  assert.match(layoutSrc, /Notifications\.setNotificationChannelAsync\('default', \{/);
  assert.match(layoutSrc, /sound: 'default'/, 'debe usar el sonido default del sistema, no un archivo que podría no existir');
  assert.doesNotMatch(layoutSrc, /sound:\s*['"](?!default)[^'"]+\.(mp3|wav|caf)['"]/i, 'no debe referenciar un archivo de sonido que no viene con el proyecto');
});

// ── 11) cleanup de listeners ─────────────────────────────────────────────

test('11) cleanup: ambos listeners se remueven al desmontar, y se registran una sola vez por vida de la app', () => {
  assert.match(layoutSrc, /subRecibida\.remove\(\);\s*subRespuesta\.remove\(\);/);
  assert.match(layoutSrc, /\}, \[\]\);/, 'deps vacías: no se vuelven a registrar en cada render/relogin');
});
