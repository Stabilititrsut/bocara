// Orígenes canónicos permitidos en cualquier entorno.
const ALLOWED_ORIGINS = Object.freeze([
  // producción
  'https://bocarafood.com',
  'https://www.bocarafood.com',
  'https://app.bocarafood.com',
  'https://bocara.vercel.app',
  // desarrollo local (Expo web / Metro / dev servers habituales)
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:8082',
  'http://localhost:19000',
  'http://localhost:19006',
]);

// En desarrollo, Expo/Metro cambian de puerto con frecuencia (8081 → 8082 → ...),
// así que se acepta cualquier puerto de localhost / 127.0.0.1. Nunca en producción.
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

// Orígenes extra sin redeploy (ej. preview de Vercel): CORS_EXTRA_ORIGINS="https://a.com,https://b.com"
function origenesExtra(env = process.env) {
  return String(env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

function esOrigenPermitido(origin, env = process.env) {
  // sin header Origin: apps móviles nativas, Postman, curl, health checks
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origenesExtra(env).includes(origin)) return true;
  if (env.NODE_ENV !== 'production' && LOCAL_ORIGIN_RE.test(origin)) return true;
  return false;
}

// Un origen no permitido NO lanza error: el paquete `cors` simplemente omite los
// headers Access-Control-* y el navegador bloquea la respuesta. Lanzar aquí
// convertía cada preflight OPTIONS desde un origen desconocido en un 500.
function corsOptions(env = process.env) {
  return {
    origin: (origin, callback) => {
      const permitido = esOrigenPermitido(origin, env);
      if (!permitido) console.warn(`⚠ CORS: origen no permitido → ${origin}`);
      callback(null, permitido);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

// `cors` se carga aquí y no al importar el módulo para que esOrigenPermitido /
// corsOptions se puedan probar sin node_modules (convención de test/ del repo).
function corsMiddleware(env = process.env) {
  return require('cors')(corsOptions(env));
}

module.exports = { corsMiddleware, corsOptions, esOrigenPermitido, ALLOWED_ORIGINS, LOCAL_ORIGIN_RE };
