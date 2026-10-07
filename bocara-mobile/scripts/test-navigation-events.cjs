// Ejecutar: node scripts/test-navigation-events.cjs. Sin red, Expo ni dispositivo real.
// Cubre el criterio del viernes frontend "handlers de navegación": un único
// resolver seguro reusado por push, realtime y deep link, y el manejo de
// notificaciones pendientes hasta que la sesión esté lista (cold start).
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

const resolver = () => load('src/utils/resolverRutaNotificacion.ts');

test('resolverRutaNotificacion es el mismo módulo que usan push (_layout.tsx) y queda disponible para realtime/deep link', () => {
  const layoutSrc = read('app/_layout.tsx');
  assert.match(layoutSrc, /import \{ resolverRutaNotificacion \} from '@\/src\/utils\/resolverRutaNotificacion';/);
  assert.match(layoutSrc, /export const rutaParaNotificacion = resolverRutaNotificacion;/, 'no debe existir una segunda implementación divergente dentro de _layout.tsx');
});

test('admin: siempre a /admin, con o sin datos adicionales en el payload', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({}, 'admin'), '/admin');
  assert.equal(resolverRutaNotificacion({ pedidoId: 'x', negocioId: 'y' }, 'admin'), '/admin');
});

test('deep link con la misma forma que un push (pedidoId/tipo) resuelve igual — un solo contrato de payload', () => {
  const { resolverRutaNotificacion } = resolver();
  const deepLinkPayload = { pedidoId: 'ped-123', tipo: 'pedido.listo' };
  assert.equal(resolverRutaNotificacion(deepLinkPayload, 'cliente'), '/(tabs)/pedidos');
  assert.equal(resolverRutaNotificacion(deepLinkPayload, 'restaurante'), '/restaurante/pedidos');
});

test('sin rol (sesión aún no cargada) nunca resuelve una ruta — el llamador debe esperar, no adivinar', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: 'x' }, undefined), null);
  assert.equal(resolverRutaNotificacion({ pedidoId: 'x' }, null), null);
});

test('negocioId del payload se valida con la misma regla que pedidoId (string no vacío, o se descarta)', () => {
  const { validarPayloadNotificacion } = resolver();
  assert.equal(validarPayloadNotificacion({ negocioId: 'n1' }).negocioId, 'n1');
  assert.equal(validarPayloadNotificacion({ negocioId: 123 }).negocioId, undefined);
  assert.equal(validarPayloadNotificacion({ negocioId: '' }).negocioId, undefined);
});

// ── pendingNotification hasta que authReady ──────────────────────────────

test('cold start / tap antes de que la sesión cargue: se guarda pendiente y se resuelve una sola vez cuando la sesión existe', () => {
  const src = read('app/_layout.tsx');
  assert.match(src, /const pendingNotifRef = useRef<any>\(null\);/);
  assert.match(src, /if \(!rolActual\) \{ pendingNotifRef\.current = data; return; \}/, 'sin rol todavía, se guarda el payload y no se navega a ciegas');
  assert.match(src, /if \(loading \|\| !usuario \|\| !pendingNotifRef\.current\) return;/, 'espera explícitamente a que la sesión termine de cargar (authReady)');
  assert.match(src, /const data = pendingNotifRef\.current;\s*pendingNotifRef\.current = null;/, 'se limpia el pendiente ANTES de navegar — un segundo render no debe repetir la navegación');
});

test('la navegación pendiente usa router.replace (no push): no se acumula en el stack como si el usuario la hubiera pedido', () => {
  const src = read('app/_layout.tsx');
  assert.match(src, /router\.replace\(ruta as any\);/);
});

// ── Diseño deliberado: realtime no navega por sí solo ────────────────────

test('RealtimeContext no importa el resolver de navegación — realtime actualiza datos en la pantalla actual, nunca navega solo', () => {
  const src = read('src/context/RealtimeContext.tsx');
  assert.doesNotMatch(src, /resolverRutaNotificacion/, 'una actualización de pedido en tiempo real no debe sacar al usuario de donde está; solo push/tap navegan');
  assert.doesNotMatch(src, /router\.(push|replace)/);
});
