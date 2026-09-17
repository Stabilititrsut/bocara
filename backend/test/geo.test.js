const test = require('node:test');
const assert = require('node:assert/strict');
const {
  haversine, coordenadasValidas, aNumeroCoordenada, validarCoordenadasEntrada, resolverCoordenadasCliente,
} = require('../utils/geo');

test('valida límites geográficos y rechaza NaN/null', () => {
  assert.equal(coordenadasValidas(90, 180), true);
  assert.equal(coordenadasValidas(-90, -180), true);
  assert.equal(coordenadasValidas(90.01, 0), false);
  assert.equal(coordenadasValidas(null, 0), false);
  assert.equal(coordenadasValidas(Number.NaN, 0), false);
});

test('fronteras de 10 km son deterministas', () => {
  const origen = [14.6349, -90.5069]; // Ciudad de Guatemala
  const lat99 = origen[0] + (9.99 / 111.195);
  const lat10 = origen[0] + (10 / 111.195);
  const lat1001 = origen[0] + (10.01 / 111.195);
  const d99  = haversine(...origen, lat99,  origen[1]);
  const d10  = haversine(...origen, lat10,  origen[1]);
  const d1001 = haversine(...origen, lat1001, origen[1]);
  assert.ok(d99 <= 10, `9.99 km debe incluirse (real: ${d99})`);
  assert.ok(d10 <= 10.001, `10.00 km debe incluirse (real: ${d10})`);
  assert.ok(d1001 > 10, `10.01 km debe excluirse (real: ${d1001})`);
});

// ── aNumeroCoordenada / validarCoordenadasEntrada ────────────────────────────
// Punto de validación compartido por PATCH /api/auth/ubicacion y GET /api/bolsas.

test('aNumeroCoordenada acepta number y string numérica, rechaza el resto', () => {
  assert.equal(aNumeroCoordenada(14.5), 14.5);
  assert.equal(aNumeroCoordenada('14.5'), 14.5);
  assert.equal(aNumeroCoordenada('-90'), -90);
  assert.ok(Number.isNaN(aNumeroCoordenada(null)));
  assert.ok(Number.isNaN(aNumeroCoordenada(undefined)));
  assert.ok(Number.isNaN(aNumeroCoordenada('')));
  assert.ok(Number.isNaN(aNumeroCoordenada('   ')));
  assert.ok(Number.isNaN(aNumeroCoordenada('abc')));
  assert.ok(Number.isNaN(aNumeroCoordenada(true)));
  assert.ok(Number.isNaN(aNumeroCoordenada([])));
  assert.ok(Number.isNaN(aNumeroCoordenada({})));
});

test('validarCoordenadasEntrada: coordenada válida', () => {
  const r = validarCoordenadasEntrada('14.6349', '-90.5069');
  assert.equal(r.ok, true);
  assert.equal(r.lat, 14.6349);
  assert.equal(r.lng, -90.5069);
});

test('validarCoordenadasEntrada: latitud inválida (fuera de rango)', () => {
  assert.equal(validarCoordenadasEntrada(91, 0).ok, false);
  assert.equal(validarCoordenadasEntrada(-91, 0).ok, false);
});

test('validarCoordenadasEntrada: longitud inválida (fuera de rango)', () => {
  assert.equal(validarCoordenadasEntrada(0, 181).ok, false);
  assert.equal(validarCoordenadasEntrada(0, -181).ok, false);
});

test('validarCoordenadasEntrada: rechaza null, undefined, NaN, Infinity y string no numérico', () => {
  assert.equal(validarCoordenadasEntrada(null, 0).ok, false);
  assert.equal(validarCoordenadasEntrada(0, null).ok, false);
  assert.equal(validarCoordenadasEntrada(undefined, 0).ok, false);
  assert.equal(validarCoordenadasEntrada(Number.NaN, 0).ok, false);
  assert.equal(validarCoordenadasEntrada(Infinity, 0).ok, false);
  assert.equal(validarCoordenadasEntrada(-Infinity, 0).ok, false);
  assert.equal(validarCoordenadasEntrada('quince', 0).ok, false);
});

// ── resolverCoordenadasCliente ───────────────────────────────────────────────

test('resolverCoordenadasCliente: coordenadas explícitas del request siempre ganan', () => {
  const r = resolverCoordenadasCliente({ queryLat: 14.6, queryLng: -90.5, usuarioLat: 15, usuarioLng: -91 });
  assert.equal(r.origen, 'request');
  assert.equal(r.lat, 14.6);
  assert.equal(r.lng, -90.5);
});

test('resolverCoordenadasCliente: sin coordenadas en el request, usa la ubicación persistida del usuario', () => {
  const r = resolverCoordenadasCliente({ queryLat: undefined, queryLng: undefined, usuarioLat: 14.6349, usuarioLng: -90.5069 });
  assert.equal(r.origen, 'perfil');
  assert.equal(r.lat, 14.6349);
  assert.equal(r.lng, -90.5069);
});

test('resolverCoordenadasCliente: usuario sin ubicación persistida — no inventa ninguna', () => {
  const r = resolverCoordenadasCliente({ queryLat: undefined, queryLng: undefined, usuarioLat: null, usuarioLng: null });
  assert.equal(r.origen, 'ninguna');
  assert.equal(r.lat, null);
  assert.equal(r.lng, null);
});

test('resolverCoordenadasCliente: ubicación persistida corrupta (fuera de rango) se descarta, no se usa como fallback', () => {
  const r = resolverCoordenadasCliente({ queryLat: undefined, queryLng: undefined, usuarioLat: 999, usuarioLng: -91 });
  assert.equal(r.origen, 'ninguna');
});

test('negocio sin coordenadas: la distancia no puede calcularse, así que no puede "estar" dentro de 10 km', () => {
  // Documenta el mismo comportamiento que routes/bolsas.js: sin lat/lng del
  // negocio no hay Haversine que calcular — coordenadasValidas es la guarda
  // antes de siquiera intentarlo.
  assert.equal(coordenadasValidas(null, null), false);
  assert.equal(coordenadasValidas(undefined, undefined), false);
});
