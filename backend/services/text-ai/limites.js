// Control de costo y abuso de la IA de texto (en memoria, por instancia).
//   - por usuario y minuto   TEXT_AI_MAX_PER_MINUTE      (5 por defecto)
//   - por usuario y día      TEXT_AI_DAILY_LIMIT          (30 por defecto)
//   - global por día         TEXT_AI_GLOBAL_DAILY_LIMIT   (500 por defecto: muy
//     por debajo de la cuota gratuita de Gemini; tope de gasto si hay plan pago)
// El día es el calendario de Guatemala. Con varias instancias del backend cada
// una lleva su propia cuenta: el tope real es N × límite (hoy corre una sola en
// Render). Si se escala, mover estos contadores a la BD o a Redis.
const { hoyGuatemala } = require('../horarioGuatemala');

const MINUTO_MS = 60 * 1000;

function entero(nombre, porDefecto) {
  const n = Number.parseInt(process.env[nombre], 10);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

function crearLimites({
  porMinuto = entero('TEXT_AI_MAX_PER_MINUTE', 5),
  porDia = entero('TEXT_AI_DAILY_LIMIT', 30),
  globalPorDia = entero('TEXT_AI_GLOBAL_DAILY_LIMIT', 500),
  ahora = () => Date.now(),
  dia = () => hoyGuatemala(),
} = {}) {
  const recientes = new Map(); // usuarioId → [timestamps del último minuto]
  let diaActual = null;
  let usosDia = new Map();     // usuarioId → generaciones de hoy
  let usosGlobal = 0;

  function rotarDia() {
    const hoy = dia();
    if (hoy !== diaActual) { diaActual = hoy; usosDia = new Map(); usosGlobal = 0; }
  }

  // Por minuto: cuenta cada intento, incluso los inválidos (frena el spam).
  function permitirIntento(usuarioId) {
    const t = ahora();
    const lista = (recientes.get(usuarioId) || []).filter((x) => t - x < MINUTO_MS);
    if (lista.length >= porMinuto) {
      recientes.set(usuarioId, lista);
      return { ok: false, motivo: 'minuto', reintentarEnS: Math.max(1, Math.ceil((MINUTO_MS - (t - lista[0])) / 1000)) };
    }
    lista.push(t);
    recientes.set(usuarioId, lista);
    if (recientes.size > 5000) for (const [k, v] of recientes) if (!v.some((x) => t - x < MINUTO_MS)) recientes.delete(k);
    return { ok: true };
  }

  // Diario: se consume justo antes de llamar al proveedor (lo que cuesta).
  function consumirDiario(usuarioId) {
    rotarDia();
    if (usosGlobal >= globalPorDia) return { ok: false, motivo: 'global' };
    const usados = usosDia.get(usuarioId) || 0;
    if (usados >= porDia) return { ok: false, motivo: 'dia' };
    usosDia.set(usuarioId, usados + 1);
    usosGlobal += 1;
    return { ok: true, restantes: porDia - usados - 1 };
  }

  return { permitirIntento, consumirDiario, config: { porMinuto, porDia, globalPorDia } };
}

module.exports = { crearLimites };
