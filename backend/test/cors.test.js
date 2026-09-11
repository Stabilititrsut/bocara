const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { esOrigenPermitido, corsMiddleware, corsOptions, ALLOWED_ORIGINS } = require('../middleware/cors');

const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

test('los orígenes canónicos están permitidos en producción', () => {
  for (const origin of [
    'http://localhost:8081',
    'http://localhost:8082',
    'http://localhost:19006',
    'https://bocarafood.com',
    'https://www.bocarafood.com',
  ]) {
    assert.equal(ALLOWED_ORIGINS.includes(origin), true, origin);
    assert.equal(esOrigenPermitido(origin, PROD), true, origin);
  }
});

test('requests sin header Origin (apps nativas, curl) pasan', () => {
  assert.equal(esOrigenPermitido(undefined, PROD), true);
  assert.equal(esOrigenPermitido('', PROD), true);
});

test('en desarrollo se acepta cualquier puerto de localhost, en producción no', () => {
  assert.equal(esOrigenPermitido('http://localhost:4444', DEV), true);
  assert.equal(esOrigenPermitido('http://127.0.0.1:8082', DEV), true);
  assert.equal(esOrigenPermitido('http://localhost:4444', PROD), false);
  assert.equal(esOrigenPermitido('http://127.0.0.1:8082', PROD), false);
});

test('la regex de desarrollo no acepta subdominios ni https falsos', () => {
  assert.equal(esOrigenPermitido('http://localhost.evil.com', DEV), false);
  assert.equal(esOrigenPermitido('http://localhost:8082.evil.com', DEV), false);
  assert.equal(esOrigenPermitido('https://evil.com', DEV), false);
});

test('un origen no permitido responde callback(null, false), nunca un Error (evita el 500 en preflight)', () => {
  const { origin } = corsOptions(PROD);
  const warn = console.warn;
  console.warn = () => {};
  try {
    origin('https://evil.com', (err, ok) => { assert.equal(err, null); assert.equal(ok, false); });
    origin('http://localhost:8082', (err, ok) => { assert.equal(err, null); assert.equal(ok, true); });
    origin(undefined, (err, ok) => { assert.equal(err, null); assert.equal(ok, true); });
  } finally { console.warn = warn; }
});

test('métodos y headers estándar habilitados; preflight responde 204', () => {
  const opts = corsOptions(PROD);
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(opts.methods.includes(m), true, m);
  for (const h of ['Content-Type', 'Authorization']) assert.equal(opts.allowedHeaders.includes(h), true, h);
  assert.equal(opts.optionsSuccessStatus, 204);
  assert.equal(opts.credentials, true);
});

test('orígenes desconocidos se rechazan; CORS_EXTRA_ORIGINS los habilita sin redeploy', () => {
  assert.equal(esOrigenPermitido('https://evil.com', PROD), false);
  assert.equal(esOrigenPermitido('https://bocarafood.com.evil.com', PROD), false);
  const env = { NODE_ENV: 'production', CORS_EXTRA_ORIGINS: ' https://preview.bocarafood.com , https://otro.com' };
  assert.equal(esOrigenPermitido('https://preview.bocarafood.com', env), true);
  assert.equal(esOrigenPermitido('https://otro.com', env), true);
});

// ── Integración: preflight real contra Express ───────────────────────────────
// Los tests de este repo corren sin node_modules; si express/cors no están
// instalados (npm ci) esta sección se salta en lugar de fallar.
let express = null;
try { express = require('express'); require('cors'); } catch { /* sin dependencias */ }
const integracion = express ? test : (name) => test(name, { skip: 'requiere npm ci (express, cors)' });

function conServidor(env, fn) {
  const app = express();
  app.use(corsMiddleware(env));
  app.use(express.json());
  app.post('/api/auth/oauth-complete', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn(base)); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

function request(url, { method, headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const preflight = (base, origin) => request(`${base}/api/auth/oauth-complete`, {
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,authorization',
  },
});

integracion('preflight OPTIONS desde localhost:8082 responde 204 con los headers CORS', () =>
  conServidor(PROD, async base => {
    const res = await preflight(base, 'http://localhost:8082');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:8082');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.equal(res.headers.vary.includes('Origin'), true);
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal(res.headers['access-control-allow-methods'].includes(m), true, m);
    }
    for (const h of ['Content-Type', 'Authorization']) {
      assert.equal(res.headers['access-control-allow-headers'].includes(h), true, h);
    }
  }));

integracion('preflight desde un origen no permitido no cae en 500 ni expone Allow-Origin', () =>
  conServidor(PROD, async base => {
    const res = await preflight(base, 'https://evil.com');
    // sin CORS, el OPTIONS cae al handler por defecto de Express (200); nunca 500
    assert.equal([200, 204].includes(res.status), true, `status ${res.status}`);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }));

integracion('POST real desde un origen permitido lleva Access-Control-Allow-Origin', () =>
  conServidor(PROD, async base => {
    const res = await request(`${base}/api/auth/oauth-complete`, {
      method: 'POST',
      headers: { Origin: 'https://www.bocarafood.com', 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'https://www.bocarafood.com');
  }));
