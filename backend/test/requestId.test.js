const test = require('node:test');
const assert = require('node:assert/strict');
const { esRequestIdValido, generarRequestId, resolverRequestId } = require('../utils/requestId');

test('acepta un request_id heredado con formato razonable (uuid, nanoid)', () => {
  assert.equal(esRequestIdValido('11111111-2222-4333-8444-555555555555'), true);
  assert.equal(esRequestIdValido('V1StGXR8_Z5jdHi6B-myT'), true);
  assert.equal(resolverRequestId('mi-request-id-123'), 'mi-request-id-123');
});

test('rechaza vacío, no-string, y genera uno propio', () => {
  for (const invalido of ['', null, undefined, 123, {}, [], true]) {
    assert.equal(esRequestIdValido(invalido), false);
    const r = resolverRequestId(invalido);
    assert.match(r, /^req_/);
  }
});

test('rechaza un header gigante (protección contra log-flooding)', () => {
  const gigante = 'a'.repeat(5000);
  assert.equal(esRequestIdValido(gigante), false);
  assert.match(resolverRequestId(gigante), /^req_/);
});

test('rechaza caracteres de inyección de log (saltos de línea, espacios, comillas)', () => {
  for (const malicioso of ['abc\ninyectado', 'abc\r\nFAKE-LOG: admin=true', 'abc def', 'abc"; DROP TABLE', 'abc<script>']) {
    assert.equal(esRequestIdValido(malicioso), false);
    assert.match(resolverRequestId(malicioso), /^req_/);
  }
});

test('rechaza un valor exactamente de 101 caracteres, acepta 100', () => {
  assert.equal(esRequestIdValido('a'.repeat(100)), true);
  assert.equal(esRequestIdValido('a'.repeat(101)), false);
});

test('generarRequestId produce valores distintos y con formato válido', () => {
  const a = generarRequestId();
  const b = generarRequestId();
  assert.notEqual(a, b);
  assert.equal(esRequestIdValido(a), true);
  assert.equal(esRequestIdValido(b), true);
});
