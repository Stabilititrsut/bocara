const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

// Antes de esto, un usuario suspendido seguía operando con normalidad mientras su
// token siguiera siendo válido — la suspensión solo bloqueaba obtener un token
// NUEVO (login/oauth). Con tokens de hasta 100 días eso volvía la suspensión casi
// inútil. Este chequeo corre en cada request autenticado.
//
// Cache en memoria con TTL corto para no pegarle a Supabase en cada request: la
// gran mayoría de requests de un mismo usuario aciertan el cache. Se invalida
// activamente desde routes/admin.js justo cuando se suspende/rehabilita a
// alguien, así que en la práctica el efecto es casi inmediato — el TTL es solo
// un techo de staleness para lo que esa invalidación activa no cubre (ediciones
// directas en la DB, más de una instancia del backend corriendo a la vez, etc.).
const SUSPENSION_CACHE_TTL_MS = 60 * 1000;
const suspensionCache = new Map(); // usuarioId -> { suspendido: boolean, expiresAt: number }

async function estaSuspendido(usuarioId) {
  const cached = suspensionCache.get(usuarioId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.suspendido;

  const { data, error } = await supabase
    .from('usuarios')
    .select('rol, activo')
    .eq('id', usuarioId)
    .maybeSingle();

  // Fail-open: si Supabase falla o tarda, no tumbamos TODOS los requests
  // autenticados por esta verificación adicional — la protección real (firma y
  // expiración del JWT) ya corrió antes y sigue vigente.
  const suspendido = !error && data ? (data.rol === 'suspendido' || data.activo === false) : false;
  suspensionCache.set(usuarioId, { suspendido, expiresAt: now + SUSPENSION_CACHE_TTL_MS });
  return suspendido;
}

function invalidateSuspensionCache(usuarioId) {
  suspensionCache.delete(usuarioId);
}

const MENSAJE_SUSPENDIDO = 'Tu cuenta fue suspendida. Contáctanos al +502 5107-7949';

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No autenticado' });
  let usuario;
  try { usuario = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  try {
    if (await estaSuspendido(usuario.id)) {
      return res.status(401).json({ error: MENSAJE_SUSPENDIDO });
    }
  } catch (err) {
    console.error('[authMiddleware] estaSuspendido falló, dejando pasar (fail-open):', err.message);
  }

  req.usuario = usuario;
  next();
}

module.exports = authMiddleware;
module.exports.estaSuspendido = estaSuspendido;
module.exports.invalidateSuspensionCache = invalidateSuspensionCache;
module.exports.MENSAJE_SUSPENDIDO = MENSAJE_SUSPENDIDO;
