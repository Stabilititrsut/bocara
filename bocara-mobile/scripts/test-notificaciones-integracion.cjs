// Ejecutar: node scripts/test-notificaciones-integracion.cjs. Sin red ni dispositivo.
// Casos explícitos LINK-1..5 (resolver REAL, mismo módulo que usa _layout.tsx)
// y BRAND-* (configuración de Expo que decide cómo se ve un push de Bocara).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function load(file) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj }, { filename: file });
  return exportsObj;
}
const { resolverRutaNotificacion } = load('src/utils/resolverRutaNotificacion.ts');

const BOLSA = '3f2b8c1e-9a4d-4c7e-8b2a-1d5e6f7a8b9c';
const PEDIDO = '7a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

// ── Deep links ──────────────────────────────────────────────────────────────

test('LINK-1: Promoción → /producto/{id} correcto', () => {
  assert.equal(resolverRutaNotificacion({ tipo: 'promocion', bolsaId: BOLSA, negocioId: 'n1' }, 'cliente'), `/producto/${BOLSA}`);
});

test('LINK-2: Tiempo limitado → /producto/{id} correcto', () => {
  assert.equal(resolverRutaNotificacion({ tipo: 'tiempo_limitado', bolsaId: BOLSA }, 'cliente'), `/producto/${BOLSA}`);
});

test('LINK-3: Pedido → la lista de pedidos enfocada en ese pedido', () => {
  assert.equal(resolverRutaNotificacion({ pedidoId: PEDIDO }, 'cliente'), `/(tabs)/pedidos?pedidoId=${PEDIDO}`);
  assert.equal(resolverRutaNotificacion({ pedidoId: PEDIDO }, 'restaurante'), '/restaurante/pedidos');
});

test('LINK-4: payload inválido → fallback seguro de su rol, sin lanzar', () => {
  for (const data of [null, undefined, 'x', 42, [], { bolsaId: 123 }, { bolsaId: 'no-es-uuid' }, { pedidoId: '' }]) {
    assert.doesNotThrow(() => resolverRutaNotificacion(data, 'cliente'));
    assert.equal(resolverRutaNotificacion(data, 'cliente'), '/(tabs)/pedidos');
  }
  assert.equal(resolverRutaNotificacion({ bolsaId: BOLSA }, null), null, 'sin sesión no se navega (queda pendiente)');
});

test('LINK-5: route/screen maliciosos o ids con inyección se ignoran', () => {
  const maliciosos = [
    { route: '/admin', bolsaId: `${BOLSA}/../../admin` },
    { screen: 'https://evil.example.com', bolsaId: `${BOLSA}?x=1` },
    { bolsaId: '../admin' },
    { pedidoId: `${PEDIDO}&rol=admin` },
  ];
  for (const data of maliciosos) {
    const ruta = resolverRutaNotificacion(data, 'cliente');
    assert.ok(['/(tabs)/pedidos'].includes(ruta), `${JSON.stringify(data)} → ${ruta}`);
    assert.doesNotMatch(ruta, /admin|http|\.\.|\?x=|&/);
  }
  assert.equal(resolverRutaNotificacion({ bolsaId: BOLSA, screen: '/admin' }, 'restaurante'), '/restaurante');
});

// ── Branding del push ───────────────────────────────────────────────────────

const app = JSON.parse(read('app.json')).expo;
const pluginNotif = app.plugins.find(p => Array.isArray(p) && p[0] === 'expo-notifications')[1];

test('BRAND-1: el nombre visible de la app (el que muestra el SO en cada push) es "Bocara"', () => {
  assert.equal(app.name, 'Bocara');
  assert.equal(app.slug, 'bocara-mobile', 'el slug no cambia: está atado al proyecto de EAS');
});

test('BRAND-2: icono de notificación Android = silueta blanca sobre transparente, 96×96', () => {
  assert.equal(pluginNotif.icon, './assets/images/notification-icon.png');
  const png = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/images/notification-icon.png')));
  assert.equal(png.width, 96);
  assert.equal(png.height, 96);
  let opacos = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] === 0) continue;
    opacos += 1;
    assert.deepEqual([png.data[i], png.data[i + 1], png.data[i + 2]], [255, 255, 255], 'Android solo usa el canal alfa: todo pixel visible debe ser blanco');
  }
  assert.ok(opacos > 96 * 96 * 0.1, 'la silueta no puede estar vacía');
  assert.ok(opacos < 96 * 96 * 0.8, 'tampoco un cuadrado lleno (el bug del icono a color)');
});

test('BRAND-3: color de acento de marca y canal por defecto; los iconos de la app no se tocaron', () => {
  assert.equal(pluginNotif.color, '#2C4A2E');
  assert.equal(pluginNotif.defaultChannel, 'default');
  assert.equal(app.icon, './assets/images/icon.png');
  assert.equal(app.android.adaptiveIcon.foregroundImage, './assets/images/android-icon-foreground.png');
});
