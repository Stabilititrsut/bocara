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
//
// 2026-08-09: el mismo cache ahora también respalda esAdminReal() (usado por
// adminOnly en routes/admin.js). Antes, adminOnly confiaba en el campo `rol`
// del JWT sin volver a consultarlo — y como POST /auth/registro aceptaba
// cualquier valor de `rol` sin validar (ya corregido), cualquiera podía
// autoemitirse un JWT con rol:"admin" en una sola petición pública sin
// autenticar. Ahora el rol de admin se verifica contra la base de datos en
// cada request, igual que la suspensión, reusando el mismo cache para no
// duplicar el costo en Supabase.
const USUARIO_CACHE_TTL_MS = 60 * 1000;
const usuarioCache = new Map(); // usuarioId -> { datos: {rol, activo} | null, expiresAt }

// Único punto que golpea Supabase para rol/activo. `datos` es `undefined`
// cuando la consulta falló (transitorio, no se cachea — cada caller decide si
// eso es fail-open o fail-closed) y `null` cuando la fila ya no existe.
async function obtenerUsuarioCacheado(usuarioId) {
  const cached = usuarioCache.get(usuarioId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.datos;

  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('rol, activo')
      .eq('id', usuarioId)
      .maybeSingle();
    if (error) return undefined;
    const datos = data || null;
    usuarioCache.set(usuarioId, { datos, expiresAt: now + USUARIO_CACHE_TTL_MS });
    return datos;
  } catch {
    return undefined;
  }
}

async function estaSuspendido(usuarioId) {
  const datos = await obtenerUsuarioCacheado(usuarioId);
  // Fail-open: si Supabase falla o tarda, no tumbamos TODOS los requests
  // autenticados por esta verificación adicional — la protección real (firma y
  // expiración del JWT) ya corrió antes y sigue vigente.
  if (!datos) return false;
  return datos.rol === 'suspendido' || datos.activo === false;
}

// A diferencia de estaSuspendido, esto falla CERRADO: si Supabase no responde
// negamos acceso de admin en vez de asumir que sí lo es. Negarle admin a un
// admin real por un hipo transitorio de Supabase es mucho más barato que
// dejar pasar a alguien que no lo es.
async function esAdminReal(usuarioId) {
  const datos = await obtenerUsuarioCacheado(usuarioId);
  if (!datos) return false;
  return datos.rol === 'admin';
}

function invalidateUsuarioCache(usuarioId) {
  usuarioCache.delete(usuarioId);
}

const MENSAJE_SUSPENDIDO = 'Tu cuenta fue suspendida. Contáctanos al +502 5107-7949';

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No autenticado' });
  let usuario;
  try { usuario = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  try {
    const datosActuales = await obtenerUsuarioCacheado(usuario.id);
    if (datosActuales === null) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    if (datosActuales && (datosActuales.rol === 'suspendido' || datosActuales.activo === false)) {
      return res.status(401).json({ error: MENSAJE_SUSPENDIDO });
    }
    // El rol del JWT puede quedar obsoleto después de una degradación o
    // rehabilitación. Usar el rol vigente de la base de datos cuando está disponible.
    if (datosActuales?.rol) usuario.rol = datosActuales.rol;
  } catch (err) {
    console.error('[authMiddleware] validación de usuario falló, dejando pasar (fail-open):', err.message);
  }

  req.usuario = usuario;
  next();
}

module.exports = authMiddleware;
module.exports.estaSuspendido = estaSuspendido;
module.exports.esAdminReal = esAdminReal;
module.exports.invalidateUsuarioCache = invalidateUsuarioCache;
module.exports.MENSAJE_SUSPENDIDO = MENSAJE_SUSPENDIDO;
