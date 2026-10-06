// POST/DELETE /api/notificaciones/token con el router REAL sobre el doble de
// Supabase. Debe cargar el doble ANTES que cualquier módulo que requiera
// config/supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-token';
const fake = crearFakeSupabase();
const rutaSupabase = require.resolve(path.join(__dirname, '..', 'config', 'supabase'));
require.cache[rutaSupabase] = { id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: fake };

const TOK_A = 'ExponentPushToken[aaaaaaaaaaaa]';
const TOK_B = 'ExponentPushToken[bbbbbbbbbbbb]';
const IDS = { ana: '00000000-0000-4000-8000-0000000000c1', beto: '00000000-0000-4000-8000-0000000000c2' };

let base, servidor;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/notificaciones', require('../routes/notificaciones'));
  await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => new Promise((r) => servidor.close(r)));

test.beforeEach(() => fake.reiniciar({
  usuarios: [
    { id: IDS.ana, rol: 'cliente', activo: true, expo_push_token: TOK_A },
    { id: IDS.beto, rol: 'cliente', activo: true, expo_push_token: null },
  ],
}));

async function pedir(metodo, como, body) {
  const r = await fetch(`${base}/api/notificaciones/token`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: como, rol: 'cliente' }, process.env.JWT_SECRET)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const tokenDe = (id) => fake.tabla('usuarios').find(u => u.id === id).expo_push_token;

test('POST /token: el mismo dispositivo en otra cuenta se le quita a la anterior', async () => {
  const r = await pedir('POST', IDS.beto, { expo_push_token: TOK_A });
  assert.equal(r.status, 200);
  assert.equal(tokenDe(IDS.beto), TOK_A);
  assert.equal(tokenDe(IDS.ana), null, 'Ana ya no recibe push en el teléfono de Beto');
});

test('POST /token: re-registrar el propio token no lo borra', async () => {
  const r = await pedir('POST', IDS.ana, { expo_push_token: TOK_A });
  assert.equal(r.status, 200);
  assert.equal(tokenDe(IDS.ana), TOK_A);
});

test('POST /token: un token de otro dispositivo no afecta a las demás cuentas', async () => {
  await pedir('POST', IDS.beto, { expo_push_token: TOK_B });
  assert.equal(tokenDe(IDS.beto), TOK_B);
  assert.equal(tokenDe(IDS.ana), TOK_A);
});

for (const [nombre, body] of [
  ['vacío', {}], ['no string', { expo_push_token: 123 }], ['formato ajeno', { expo_push_token: 'hola' }],
  ['con espacios', { expo_push_token: 'ExponentPushToken[a b]' }],
]) {
  test(`POST /token: token ${nombre} → 400 sin escribir`, async () => {
    const r = await pedir('POST', IDS.beto, body);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'TOKEN_INVALIDO');
    assert.equal(tokenDe(IDS.beto), null);
    assert.equal(tokenDe(IDS.ana), TOK_A);
  });
}

test('POST /token: acepta el formato ExpoPushToken[…]', async () => {
  const r = await pedir('POST', IDS.beto, { expo_push_token: 'ExpoPushToken[xyz]' });
  assert.equal(r.status, 200);
});

test('POST /token: error de BD → 503, no un ok falso', async () => {
  // Primera petición: deja a Beto en la caché de authMiddleware, para que el
  // error inyectado caiga en el UPDATE de la ruta y no en la verificación.
  await pedir('POST', IDS.beto, { expo_push_token: TOK_B });
  fake.reiniciar({ usuarios: [{ id: IDS.beto, rol: 'cliente', activo: true, expo_push_token: null }] });
  fake.inyectarError({ message: 'timeout' });
  const r = await pedir('POST', IDS.beto, { expo_push_token: TOK_B });
  assert.equal(r.status, 503);
  assert.equal(tokenDe(IDS.beto), null);
});

test('DELETE /token: sin body borra el token de la cuenta (logout)', async () => {
  const r = await pedir('DELETE', IDS.ana);
  assert.equal(r.status, 200);
  assert.equal(tokenDe(IDS.ana), null);
});

test('DELETE /token: con un token que ya no es el vigente no borra el del otro dispositivo', async () => {
  const r = await pedir('DELETE', IDS.ana, { expo_push_token: TOK_B });
  assert.equal(r.status, 200);
  assert.equal(tokenDe(IDS.ana), TOK_A);
});

test('DELETE /token: con el token vigente lo borra y repetir es idempotente', async () => {
  assert.equal((await pedir('DELETE', IDS.ana, { expo_push_token: TOK_A })).status, 200);
  assert.equal((await pedir('DELETE', IDS.ana, { expo_push_token: TOK_A })).status, 200);
  assert.equal(tokenDe(IDS.ana), null);
});

test('DELETE /token: solo toca la cuenta autenticada', async () => {
  await pedir('POST', IDS.beto, { expo_push_token: TOK_B });
  await pedir('DELETE', IDS.ana);
  assert.equal(tokenDe(IDS.beto), TOK_B);
});
