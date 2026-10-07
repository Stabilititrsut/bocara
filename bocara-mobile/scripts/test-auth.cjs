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

// ── Pruebas locales/LAN (auditoría auth local, fix/publication-lifecycle) ──
// Objetivo: nada de esto puede terminar en bocarafood.com cuando se prueba
// desde localhost o desde la IP de otra máquina de la misma red.

test('api.ts deriva el backend local/LAN de window.location, con los fallbacks de siempre intactos', () => {
  const src = read('src/services/api.ts');
  assert.match(src, /window\.location/, 'debe leer el origen actual en tiempo de ejecución');
  assert.match(src, /process\.env\.EXPO_PUBLIC_API_URL/, 'el fallback explícito por variable de entorno debe seguir existiendo');
  assert.match(src, /bocara\.onrender\.com\/api/, 'el fallback final de producción debe seguir presente');
});

test('la función que deriva la URL local/LAN no devuelve ninguna IP ni dominio hardcodeado', () => {
  const src = read('src/services/api.ts');
  const m = src.match(/function resolverApiBaseUrlLocalWeb\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'no se encontró resolverApiBaseUrlLocalWeb() en api.ts');
  const cuerpo = m[1];
  // Debe distinguir localhost/IP de un nombre de dominio real (bocarafood.com,
  // *.vercel.app) por SER una IP, nunca por una lista de dominios a excluir
  // (una lista se desactualiza; "es una IP" no).
  assert.match(cuerpo, /hostname === 'localhost'/);
  assert.match(cuerpo, /IP_LITERAL_RE/);
  // Acotado a los `return` (el valor que de verdad se entrega) y no al cuerpo
  // completo: la comparación "hostname === '127.0.0.1'" es legítima y no debe
  // confundirse con una IP hardcodeada como valor de retorno.
  const returns = [...cuerpo.matchAll(/return\s+([^;]+);/g)].map(m => m[1]);
  assert.ok(returns.length >= 2, 'se esperaban al menos dos return en la función');
  for (const r of returns) {
    assert.doesNotMatch(r, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, `no debe devolver una IP escrita a mano: ${r}`);
  }
  assert.doesNotMatch(cuerpo, /bocarafood\.com/, 'no debe mencionar el dominio de producción');
});

test('AuthContext solo navega con rutas relativas (nunca puede saltar fuera del origen actual)', () => {
  const src = read('src/context/AuthContext.tsx');
  const replaces = [...src.matchAll(/window\.location\.replace\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(replaces.length >= 2, 'se esperaban los replace() de logout y de sesión inválida');
  for (const arg of replaces) {
    assert.match(arg, /^'\/[^']*'$/, `window.location.replace debe recibir una ruta relativa que empiece con "/", no: ${arg}`);
  }
  assert.doesNotMatch(src, /bocarafood\.com/);
});

test('el cálculo de redirectTo de OAuth en login.tsx no menciona el dominio de producción', () => {
  // login.tsx sí contiene "bocarafood.com" en otro lugar (placeholder del campo
  // de correo admin, "admin@bocarafood.com") — eso es copy de UI, no lógica de
  // redirect. Se acota la búsqueda al bloque que calcula redirectTo.
  const src = read('app/login.tsx');
  const m = src.match(/const redirectTo[\s\S]*?signInWithOAuth\([\s\S]*?\}\);/);
  assert.ok(m, 'no se encontró el bloque de cálculo de redirectTo + signInWithOAuth en login.tsx');
  assert.doesNotMatch(m[0], /bocarafood\.com/);
});

test('auth/callback.tsx no hardcodea el dominio de producción', () => {
  assert.doesNotMatch(read('app/auth/callback.tsx'), /bocarafood\.com/);
});
