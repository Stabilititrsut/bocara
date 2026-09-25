// Ejecutar: node scripts/test-auth.cjs. Sin red, Expo ni dependencias nuevas.
// Guardas estáticas contra la regresión de OAuth web (ver docs del Día 1):
// evita volver a mezclar el flow implícito (hash fragment) con PKCE, y evita
// volver a hardcodear localhost en el redirect.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('supabase client usa PKCE explícito y detectSessionInUrl activo', () => {
  const src = read('src/services/supabase.ts');
  assert.match(src, /flowType:\s*'pkce'/, 'flowType debe ser pkce explícito (no queda ambiguo/implícito)');
  assert.match(src, /detectSessionInUrl:\s*true/);
});

test('auth/callback no vuelve a parsear tokens del hash fragment (flow implícito)', () => {
  const src = read('app/auth/callback.tsx');
  assert.doesNotMatch(src, /window\.location\.hash/, 'no debe leer window.location.hash: PKCE entrega el code por querystring');
  assert.doesNotMatch(src, /access_token\s*=\s*params\.get/, 'no debe extraer access_token manualmente del hash');
  assert.match(src, /supabase\.auth\.getSession\(\)/, 'debe seguir apoyándose en getSession() para obtener la sesión ya intercambiada');
});

test('login web calcula el redirect de OAuth dinámicamente, nunca hardcodeado', () => {
  const src = read('app/login.tsx');
  assert.match(src, /window\.location\.origin.*auth\/callback/, 'web: debe derivar el origin en tiempo de ejecución (funciona en localhost y en producción)');
  assert.doesNotMatch(src, /localhost:\d+\/auth\/callback/, 'no debe hardcodear localhost en el redirectTo');
  assert.match(src, /bocara:\/\/auth\/callback/, 'nativo: debe preservar el esquema bocara://');
});

test('auth/callback sigue manejando errores de OAuth (?error=) y confirmación por token_hash', () => {
  const src = read('app/auth/callback.tsx');
  assert.match(src, /searchParams\.get\('error'\)/);
  assert.match(src, /searchParams\.get\('token_hash'\)/);
});
