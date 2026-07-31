// Fuente única de los parámetros configurables de negocio (tabla `configuracion`
// existente, clave/valor). Antes cada endpoint tenía su propio 25%/0.75 escrito
// a mano — ahora todos leen de aquí para no volver a desincronizarse.
const supabase = require('../config/supabase');

const DEFAULTS = {
  comision_porcentaje: 25,
  puntos_por_pedido: 10,
  min_puntos_canje: 100,
  puntos_a_quetzales: 0.10,
  costo_envio_fijo: 25,
  max_bolsas_por_restaurante: 10,
};

// Cargo de plataforma Cubo Pago (3.5%) — fee de procesamiento fijo por contrato,
// no una palanca de negocio como `comision_porcentaje`, así que vive como
// constante de código en vez de la tabla `configuracion`. Se centraliza aquí
// (una sola fuente) para que routes/pagos.js y la RPC aplicar_cupon_borrador
// nunca puedan desincronizarse con literales 0.035 repetidos en cada archivo.
const COMISION_PLATAFORMA_FRACCION = 0.035;

const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

async function obtenerConfig() {
  if (cache && (Date.now() - cacheAt) < CACHE_TTL_MS) return cache;
  const config = { ...DEFAULTS };
  try {
    const { data, error } = await supabase.from('configuracion').select('clave,valor');
    if (!error && data) {
      for (const row of data) {
        const num = parseFloat(row.valor);
        config[row.clave] = isNaN(num) ? row.valor : num;
      }
    }
  } catch { /* usar defaults si la tabla no existe aún */ }
  cache = config;
  cacheAt = Date.now();
  return config;
}

async function obtenerConfigNumerica(clave) {
  const config = await obtenerConfig();
  const val = parseFloat(config[clave]);
  return isNaN(val) ? DEFAULTS[clave] : val;
}

async function obtenerComisionFraccion() {
  const pct = await obtenerConfigNumerica('comision_porcentaje');
  return pct / 100;
}

module.exports = { obtenerConfig, obtenerConfigNumerica, obtenerComisionFraccion, DEFAULTS, COMISION_PLATAFORMA_FRACCION };
