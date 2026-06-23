#!/usr/bin/env node
/**
 * Pruebas de la lógica de validación del webhook de Cubo Pago.
 * Cobertura: validarWebhookCubo() — función pura exportada desde routes/webhooks.js
 *
 * No realiza pagos reales ni llamadas de red ni escrituras en BD.
 * Ejecutar: node scripts/test-webhook-cubo.js
 *
 * Tests 1-9: unitarios (función pura, sin mocks de red ni BD)
 * Tests 10-12: arquitecturales (comportamiento garantizado por diseño del sistema)
 */
'use strict';

require('dotenv').config();

// ── Suprimir requires de módulos externos para cargar webhooks.js en aislamiento ─
const Module = require('module');
const _origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  const r = request.replace(/\\/g, '/');
  if (r.includes('config/supabase'))     return {};
  if (r.includes('notificaciones'))      return { enviarNotificacionPush: async () => {}, guardarNotificacion: async () => {} };
  if (r.includes('visaLink'))            return { consultarTransaccionCubo: async () => { throw new Error('NO_LLAMAR_EN_UNIT_TEST'); } };
  return _origLoad(request, parent, isMain);
};

const { validarWebhookCubo } = require('../routes/webhooks');
const assert = require('assert');

// ── Utilidades de test ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(nombre, fn) {
  try {
    fn();
    console.log(`  ✅  ${nombre}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${nombre}`);
    console.error(`       → ${err.message}`);
    failed++;
  }
}

// ── Datos de referencia ───────────────────────────────────────────────────────
const TOKEN = 'TOKEN_CUBO_ABC123';
const UUID  = '11111111-1111-1111-1111-111111111111';

const PEDIDO_BASE = {
  id:                        UUID,
  estado_pago:               'pendiente',
  cubo_payment_intent_token: TOKEN,
  monto_esperado_centavos:   1000,   // Q10.00 → 1000 centavos
  _cuboColumnsMissing:       false,
};

const CONSULTA_OK = {
  paymentIntentToken: TOKEN,
  status:             'SUCCEEDED',
  amount:             '10.00',        // string decimal — Cubo GET /transactions
  currency:           'USD',
};

const BODY_OK = {
  identifier:        TOKEN,
  status:            'SUCCEEDED',
  referenceId:       'REF-007194',
  authorizationCode: '007194',
  processedAt:       '2025-03-10T09:56:47.228Z',
  amount:            1000,            // centavos — payload del webhook
  metadata:          { orderId: UUID },
};

// ── Test 1: Columnas ausentes en BD → no procesa (fail-closed) ───────────────
console.log('\n── Test 1: columnas ausentes en BD ───────────────────────────────');

test('_cuboColumnsMissing=true → 503, no procesa pago', () => {
  const pedido = { ...PEDIDO_BASE, _cuboColumnsMissing: true };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false, 'ok debe ser false');
  assert.strictEqual(r.statusCode, 503, `statusCode debe ser 503, got ${r.statusCode}`);
  assert.match(r.error, /migración|columna/i, 'mensaje debe mencionar migración o columna');
});

// ── Test 2: Token almacenado ausente → no procesa ────────────────────────────
console.log('\n── Test 2: token almacenado ausente ──────────────────────────────');

test('cubo_payment_intent_token=null → 422, no procesa pago', () => {
  const pedido = { ...PEDIDO_BASE, cubo_payment_intent_token: null };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 422, `statusCode debe ser 422, got ${r.statusCode}`);
  assert.match(r.error, /token|payment_intent/i);
});

test('cubo_payment_intent_token="" (vacío) → 422, no procesa pago', () => {
  const pedido = { ...PEDIDO_BASE, cubo_payment_intent_token: '' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 422);
});

// ── Test 3: Monto esperado ausente → no procesa ──────────────────────────────
console.log('\n── Test 3: monto esperado ausente ────────────────────────────────');

test('monto_esperado_centavos=null → 422, no procesa pago', () => {
  const pedido = { ...PEDIDO_BASE, monto_esperado_centavos: null };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 422, `statusCode debe ser 422, got ${r.statusCode}`);
  assert.match(r.error, /monto/i);
});

test('monto_esperado_centavos=0 → 422 (valor inválido)', () => {
  const pedido = { ...PEDIDO_BASE, monto_esperado_centavos: 0 };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 422);
});

test('monto_esperado_centavos="1000" (string, no entero) → 422', () => {
  const pedido = { ...PEDIDO_BASE, monto_esperado_centavos: '1000' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 422);
});

// ── Test 4: Token diferente → no procesa ─────────────────────────────────────
console.log('\n── Test 4: token diferente ───────────────────────────────────────');

test('pedido.cubo_payment_intent_token ≠ body.identifier → 409', () => {
  const pedido = { ...PEDIDO_BASE, cubo_payment_intent_token: 'OTRO_TOKEN' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /token/i);
});

test('consulta.paymentIntentToken ≠ body.identifier → 409', () => {
  const consultaMal = { ...CONSULTA_OK, paymentIntentToken: 'OTRO_TOKEN' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaMal, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /token/i);
});

// ── Test 5: Monto diferente → no procesa ─────────────────────────────────────
console.log('\n── Test 5: monto diferente ───────────────────────────────────────');

test('consulta.amount "20.00" (2000¢) ≠ monto_esperado 1000¢ → 409', () => {
  const consultaMal = { ...CONSULTA_OK, amount: '20.00' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaMal, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /monto|Monto/i);
});

test('consulta.amount "10.00" (1000¢) == monto_esperado 1000¢ → aprobado', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tipo, 'aprobado');
});

test('monto negativo en consulta → 409', () => {
  const consultaMal = { ...CONSULTA_OK, amount: '-10.00' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaMal, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
});

// ── Test 6: Moneda diferente → no procesa ────────────────────────────────────
console.log('\n── Test 6: moneda diferente ──────────────────────────────────────');

test('consulta.currency="GTQ" con monedaEsperada="USD" → 409', () => {
  const consultaGTQ = { ...CONSULTA_OK, currency: 'GTQ' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaGTQ, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /moneda|Moneda/i);
});

test('consulta sin currency (campo ausente) → no bloquea (moneda no verificable)', () => {
  const consultaSinMoneda = { ...CONSULTA_OK };
  delete consultaSinMoneda.currency;
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaSinMoneda, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true, 'sin currency en consulta → no bloquea');
  assert.strictEqual(r.tipo, 'aprobado');
});

// ── Test 7: Cubo no responde → no procesa ────────────────────────────────────
// En procesarWebhookCubo, si consultarTransaccionCubo lanza, se retorna 502.
// En validarWebhookCubo, esto se representa como consulta=null → 503.
console.log('\n── Test 7: Cubo no responde ──────────────────────────────────────');

test('consulta=null (Cubo no responde) → 503, no procesa pago', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.ok([502, 503].includes(r.statusCode), `statusCode debe ser 502 o 503, got ${r.statusCode}`);
});

test('consulta=null con body vacío → 400 (payload inválido tiene precedencia)', () => {
  const r = validarWebhookCubo({ body: {}, pedido: null, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 400);
});

// ── Test 8: REJECTED → no confirma pago, no descuenta inventario ─────────────
console.log('\n── Test 8: REJECTED ──────────────────────────────────────────────');

test('status REJECTED → tipo=fallido, ok=true, no confirma pago', () => {
  const body = { ...BODY_OK, status: 'REJECTED' };
  const r = validarWebhookCubo({ body, pedido: PEDIDO_BASE, consulta: null, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true, 'ok=true para REJECTED (es un resultado esperado)');
  assert.strictEqual(r.tipo, 'fallido');
  assert.notStrictEqual(r.tipo, 'aprobado', 'nunca debe ser aprobado');
});

test('REJECTED con consulta OK igualmente no confirma (consulta no aplica a REJECTED)', () => {
  const body = { ...BODY_OK, status: 'REJECTED' };
  const r = validarWebhookCubo({ body, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.tipo, 'fallido');
});

test('estado desconocido (PENDING) → 200 con warning, sin confirmar', () => {
  const body = { ...BODY_OK, status: 'PENDING' };
  const r = validarWebhookCubo({ body, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false, 'no procesar estados no documentados');
  assert.strictEqual(r.statusCode, 200, '200 para no interrumpir Cubo en estados desconocidos');
  assert.ok(r.warning, 'debe incluir mensaje de warning');
});

// ── Test 9: SUCCEEDED válido → una única confirmación ────────────────────────
console.log('\n── Test 9: SUCCEEDED válido ──────────────────────────────────────');

test('todos los campos correctos → tipo=aprobado, ok=true, statusCode=200', () => {
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true, 'ok debe ser true');
  assert.strictEqual(r.tipo, 'aprobado', 'tipo debe ser aprobado');
  assert.strictEqual(r.statusCode, 200);
});

test('consulta Cubo dice FAILED aunque webhook dice SUCCEEDED → 409', () => {
  const consultaFailed = { ...CONSULTA_OK, status: 'FAILED' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: PEDIDO_BASE, consulta: consultaFailed, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.statusCode, 409);
  assert.match(r.error, /FAILED/);
});

// ── Test 10: Webhooks concurrentes → un solo descuento de inventario ──────────
// Garantía arquitectural: la RPC usa SELECT FOR UPDATE, que impone serialización.
// La segunda llamada concurrente espera el COMMIT de la primera. Si el primero
// confirma, el segundo obtiene estado_pago='pagado' y retorna 'duplicado'.
console.log('\n── Test 10: webhooks concurrentes ────────────────────────────────');

test('[concurrencia] primer webhook → aprobado', () => {
  const pedidoPendiente = { ...PEDIDO_BASE, estado_pago: 'pendiente' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPendiente, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.tipo, 'aprobado');
});

test('[concurrencia] segundo webhook (pedido ya pagado) → duplicado, sin efectos', () => {
  const pedidoPagado = { ...PEDIDO_BASE, estado_pago: 'pagado' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPagado, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.tipo, 'duplicado', 'segundo webhook debe ser duplicado');
  assert.notStrictEqual(r.tipo, 'aprobado', 'no debe re-confirmar pago');
});

// Test 10 nota: el FOR UPDATE en la RPC garantiza que entre los dos webhooks
// solo uno ejecuta el UPDATE. El segundo ve el estado actualizado y retorna 'duplicado'.
// Esta garantía no puede verificarse sin una BD real de PostgreSQL.

// ── Test 11: Falla de notificación → no duplica el pago ──────────────────────
// Garantía arquitectural: las notificaciones se ejecutan DESPUÉS de que la RPC
// confirma el pago. Si fallan, el pago ya está en estado 'pagado' en la BD.
// Un webhook repetido que llega después verá estado_pago='pagado' y retorna 'duplicado'.
console.log('\n── Test 11: falla de notificación ────────────────────────────────');

test('[notificación] webhook repetido tras falla de notificación → duplicado', () => {
  // Simular: RPC ya confirmó el pago (estado_pago='pagado'),
  // notificación falló (no importa — no revierte el pago),
  // el mismo webhook llega de nuevo.
  const pedidoPostRPC = { ...PEDIDO_BASE, estado_pago: 'pagado' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPostRPC, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.tipo, 'duplicado', 'webhook repetido tras falla de notificación → duplicado');
  assert.notStrictEqual(r.tipo, 'aprobado', 'no debe re-procesar stock ni puntos');
});

// Test 11 nota: enviarNotificacionPush y guardarNotificacion están dentro de .catch()
// en procesarWebhookCubo. Si lanzan, el error se registra pero no propaga.
// El estado_pago permanece 'pagado' (escrito por la RPC antes de las notificaciones).

// ── Test 12: Webhook repetido → duplicado sin efectos nuevos ─────────────────
console.log('\n── Test 12: webhook repetido ─────────────────────────────────────');

test('pedido ya en estado_pago=pagado → tipo=duplicado, statusCode=200', () => {
  const pedidoPagado = { ...PEDIDO_BASE, estado_pago: 'pagado' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPagado, consulta: CONSULTA_OK, monedaEsperada: 'USD' });
  assert.strictEqual(r.ok, true, 'ok=true para duplicado (respuesta controlada)');
  assert.strictEqual(r.tipo, 'duplicado');
  assert.strictEqual(r.statusCode, 200, 'HTTP 200 para no generar reintentos de Cubo');
});

test('webhook repetido con monto diferente (intento de fraude) → detectado antes de duplicado', () => {
  // Si el pedido ya está pagado, la validación de monto no aplica (la idempotencia
  // se verifica después del monto). En este caso, el monto difiere PERO el pedido
  // ya está pagado → duplicado gana (no hay riesgo ya que no se modifica nada).
  // Esta prueba documenta el comportamiento: duplicado tiene precedencia.
  //
  // En la RPC: SELECT FOR UPDATE → estado='pagado' → retorna 'duplicado' sin llegar al check de monto.
  const pedidoPagado = { ...PEDIDO_BASE, estado_pago: 'pagado' };
  const consultaMontoMal = { ...CONSULTA_OK, amount: '999.00' };
  const r = validarWebhookCubo({ body: BODY_OK, pedido: pedidoPagado, consulta: consultaMontoMal, monedaEsperada: 'USD' });
  // La validación de monto ocurre ANTES de la verificación de idempotencia en validarWebhookCubo
  // → el monto difiere → 409 (correcto: se detecta la manipulación aunque el pedido esté pagado)
  assert.strictEqual(r.ok, false, 'monto manipulado detectado incluso en duplicado');
  assert.strictEqual(r.statusCode, 409);
});

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(64)}`);
console.log(`  Tests unitarios:     ${passed} pasados, ${failed} fallidos`);
if (failed > 0) {
  console.error(`  ⚠️  Fallos encontrados — corregir antes de continuar`);
  process.exit(1);
} else {
  console.log(`  ✅  Todos los tests pasados`);
  console.log(`
  Garantías arquitecturales adicionales (no testeables sin BD real):
  • Test 10 (concurrencia): SELECT FOR UPDATE en confirmar_pago_cubo serializa
    dos webhooks concurrentes — PostgreSQL garantiza un único descuento de stock.
  • Test 11 (notificaciones): notificaciones están en .catch() fuera de la RPC.
    Si fallan, el pago permanece confirmado y el webhook repetido retorna 'duplicado'.

  PENDIENTE antes de activar CUBO_PAYMENTS_ENABLED=true:
  1. Ejecutar sql/cubo-pago-schema.sql en Supabase (BLOQUE 1 y BLOQUE 2)
  2. Confirmar con integracion@cubopago.com la moneda real (USD o GTQ)
  3. Configurar CUBO_CURRENCY en Render Dashboard
  `);
}
