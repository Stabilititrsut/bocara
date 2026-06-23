#!/usr/bin/env node
/**
 * Pruebas unitarias del webhook de Cubo Pago — sin pagos reales ni llamadas de red.
 *
 * Cobertura: validarWebhookCubo() (lógica pura exportada desde routes/webhooks.js)
 * Ejecutar: node scripts/test-webhook-cubo.js
 *
 * Tests que requieren BD real están marcados como [INTEGRACIÓN] y deben correrse
 * manualmente en sandbox con CUBO_PAYMENTS_ENABLED=false.
 */
'use strict';

require('dotenv').config();

// ── Suprimir require de módulos que conectan con servicios externos ────────────
// Permite cargar webhooks.js sin iniciar conexiones reales.
const Module = require('module');
const _origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  if (request === '../config/supabase' || request.includes('config/supabase')) {
    return {}; // stub vacío — pruebas unitarias no usan BD
  }
  if (request === '../services/notificaciones' || request.includes('notificaciones')) {
    return { enviarNotificacionPush: async () => {}, guardarNotificacion: async () => {} };
  }
  if (request === '../services/visaLink' || request.includes('visaLink')) {
    return { consultarTransaccionCubo: async () => { throw new Error('NO LLAMAR EN UNIT TEST'); } };
  }
  return _origLoad(request, parent, isMain);
};

const { validarWebhookCubo } = require('../routes/webhooks');
const assert = require('assert');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(nombre, fn) {
  try {
    fn();
    console.log(`  ✅  ${nombre}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${nombre}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

// Pedido de referencia para reutilizar en los tests
const PEDIDO_BASE = {
  id: '11111111-1111-1111-1111-111111111111',
  estado_pago: 'pendiente',
  cubo_payment_intent_token: 'TOKEN123',
  monto_esperado_centavos: 1000, // Q10.00
};

const CONSULTA_OK = {
  paymentIntentToken: 'TOKEN123',
  status: 'SUCCEEDED',
  amount: '10.00',
  currency: 'USD',
};

const BODY_OK = {
  identifier: 'TOKEN123',
  status: 'SUCCEEDED',
  referenceId: 'REF-001',
  authorizationCode: '007194',
  processedAt: '2025-03-10T09:56:47.228Z',
  amount: 1000,
  metadata: { orderId: '11111111-1111-1111-1111-111111111111' },
};

// ── Test 1: webhook vacío → 400, no modifica BD ───────────────────────────────
console.log('\n── Test 1: webhook vacío ──────────────────────────────────────────');
test('body vacío → statusCode 400, falta identifier', () => {
  const r = validarWebhookCubo({ body: {}, pedido: null, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false, 'ok debe ser false');
  assert.strictEqual(r.statusCode, 400, 'statusCode debe ser 400');
  assert.match(r.error, /identifier/i, 'mensaje debe mencionar identifier');
});

test('body sin metadata.orderId → statusCode 400', () => {
  const body = { identifier: 'TOKEN123', status: 'SUCCEEDED' };
  const r = validarWebhookCubo({ body, pedido: null, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.error, /orderId/i);
});

// ── Test 2: token inexistente (Cubo 404) → 409, no confirma ──────────────────
// La consulta a Cubo lanza error con code=NOT_FOUND; validarWebhookCubo recibe consulta=null
// y devuelve 503. El handler de procesarWebhookCubo convierte NOT_FOUND en 409.
// Aquí testeamos que sin consulta disponible no se aprueba.
console.log('\n── Test 2: token inexistente en Cubo ─────────────────────────────');
test('consulta=null (Cubo no disponible) → no confirma pago (503)', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 503);
});

// ── Test 3: Cubo devuelve REJECTED → no confirma pago ────────────────────────
console.log('\n── Test 3: Cubo devuelve REJECTED ────────────────────────────────');
test('status REJECTED → tipo=fallido, ok=true, no confirma pago', () => {
  const body = { ...BODY_OK, status: 'REJECTED' };
  const r = validarWebhookCubo({ body, pedido: PEDIDO_BASE, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'fallido', 'tipo debe ser fallido');
  assert.notStrictEqual(r.tipo, 'aprobado', 'no debe confirmar pago');
});

test('consulta Cubo dice PENDING aunque webhook dice SUCCEEDED → 409', () => {
  const consultaPending = { ...CONSULTA_OK, status: 'PENDING' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaPending, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /PENDING/);
});

// ── Test 4: monto diferente → no confirma ────────────────────────────────────
console.log('\n── Test 4: monto diferente ───────────────────────────────────────');
test('consulta.amount "20.00" ≠ monto_esperado_centavos 1000 → 409', () => {
  const consultaMontoMal = { ...CONSULTA_OK, amount: '20.00' }; // 2000¢ ≠ 1000¢
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaMontoMal, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /monto|Monto/i);
});

test('consulta.amount "10.00" == monto_esperado_centavos 1000 → aprobado', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'aprobado');
});

test('monto_esperado_centavos ausente (migración pendiente) → no bloquea aprobación', () => {
  const pedidoSinMonto = { ...PEDIDO_BASE, monto_esperado_centavos: null };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoSinMonto, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'aprobado');
});

// ── Test 5: token diferente → no confirma ────────────────────────────────────
console.log('\n── Test 5: token diferente en el pedido ──────────────────────────');
test('pedido.cubo_payment_intent_token ≠ webhook identifier → 409', () => {
  const pedidoOtroToken = { ...PEDIDO_BASE, cubo_payment_intent_token: 'OTRO_TOKEN' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoOtroToken, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /token|Token/i);
});

test('consulta.paymentIntentToken ≠ body.identifier → 409', () => {
  const consultaTokenMal = { ...CONSULTA_OK, paymentIntentToken: 'OTRO_TOKEN' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaTokenMal, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /token|Token/i);
});

test('cubo_payment_intent_token ausente en pedido → no bloquea (migración pendiente)', () => {
  const pedidoSinToken = { ...PEDIDO_BASE, cubo_payment_intent_token: null };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoSinToken, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'aprobado');
});

// ── Test 6: webhook duplicado → no duplica efectos ───────────────────────────
console.log('\n── Test 6: webhook duplicado ─────────────────────────────────────');
test('pedido ya en estado_pago=pagado → tipo=duplicado, ok=true', () => {
  const pedidoPagado = { ...PEDIDO_BASE, estado_pago: 'pagado' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPagado, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'duplicado');
  assert.notStrictEqual(r.tipo, 'aprobado', 'no debe reintentar descuento de stock ni QR');
});

// ── Test 7: SUCCEEDED verificado → aprobado (flujo correcto) ─────────────────
console.log('\n── Test 7: SUCCEEDED verificado correctamente ────────────────────');
test('payload correcto + consulta OK + pedido pendiente → aprobado', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true, 'ok debe ser true');
  assert.strictEqual(r.tipo, 'aprobado', 'tipo debe ser aprobado');
  assert.strictEqual(r.statusCode, 200);
});

test('moneda incorrecta (GTQ recibido, USD esperado) → 409', () => {
  const consultaGTQ = { ...CONSULTA_OK, currency: 'GTQ' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaGTQ, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /moneda|Moneda/i);
});

test('estado desconocido (ej. PENDING) → 200 con warning, sin confirmar', () => {
  const body = { ...BODY_OK, status: 'PENDING' };
  const r = validarWebhookCubo({ body, pedido: null, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false, 'ok false para estado desconocido');
  assert.strictEqual(r.statusCode, 200, 'statusCode 200 para no interrumpir Cubo');
  assert.ok(r.warning, 'debe incluir warning');
});

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`  Resultado: ${passed} pasados, ${failed} fallidos`);
if (failed > 0) {
  console.error(`  ⚠️  Fallos encontrados — revisar antes de habilitar CUBO_PAYMENTS_ENABLED=true`);
  process.exit(1);
} else {
  console.log(`  ✅  Todos los tests pasaron`);
  console.log(`\n  NOTA: Los tests de integración (BD real + Cubo sandbox) deben correrse`);
  console.log(`  manualmente con CUBO_PAYMENTS_ENABLED=false y una API key de sandbox.`);
}
