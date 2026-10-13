// Monitor operativo en vivo (Admin › Dashboard): pedidos pagados que siguen
// en curso, con cuánto llevan en su estado actual y un semáforo para decidir
// a qué restaurante llamar primero.
//
// "Tiempo en el estado" se mide desde la marca que selló ese estado
// (routes/pedidos.js#MARCA_POR_ESTADO y el trigger pedidos_sellar_marcas_estado):
//   confirmado / pagado → pagado_en (pago confirmado por Cubo), o created_at
//   en_preparacion      → aceptado_en
//   listo               → listo_en
// Si la marca falta (migración no aplicada, filas viejas) se cae a la anterior
// del ciclo, nunca a "ahora": el semáforo puede exagerar, pero no esconder.

const { esPromocion } = require('./finanzasSnapshot');

const ESTADOS_MONITOR = Object.freeze(['pagado', 'confirmado', 'en_preparacion', 'listo']);

// Verde < 10 min · Amarillo 10–25 min · Rojo > 25 min.
const UMBRALES_MONITOR = Object.freeze({ amarillo: 10, rojo: 25 });

const ETIQUETA_ESTADO_MONITOR = Object.freeze({
  pagado: 'Pago recibido',
  confirmado: 'Esperando confirmación',
  en_preparacion: 'En cocina',
  listo: 'Listo para recoger',
});

function marcaDelEstado(p = {}) {
  const base = p.pagado_en || p.created_at || null;
  if (p.estado === 'listo') return p.listo_en || p.aceptado_en || base;
  if (p.estado === 'en_preparacion') return p.aceptado_en || base;
  return base;
}

function minutosDesde(instante, ahora = new Date()) {
  if (!instante) return null;
  const t = new Date(instante).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - t) / 60000));
}

function nivelAlerta(minutos) {
  if (minutos == null) return 'sin_datos';
  if (minutos < UMBRALES_MONITOR.amarillo) return 'verde';
  if (minutos <= UMBRALES_MONITOR.rojo) return 'amarillo';
  return 'rojo';
}

// 'tiempo_limitado' | 'promocion' | 'mixto', desde el snapshot del pedido; los
// pedidos heredados sin líneas usan su bolsa (Tiempo Limitado si no aparece).
function tipoPedido(p = {}, bolsasPorId = new Map()) {
  const lineas = Array.isArray(p.snapshot_financiero?.lineas) ? p.snapshot_financiero.lineas : [];
  if (lineas.length > 0) {
    const tipos = new Set(lineas.map((l) => (l.tipo_financiero === 'promocion' ? 'promocion' : 'tiempo_limitado')));
    return tipos.size > 1 ? 'mixto' : [...tipos][0];
  }
  const bolsa = bolsasPorId.get(p.bolsa_id);
  return bolsa && esPromocion(bolsa) ? 'promocion' : 'tiempo_limitado';
}

// Filas del monitor, ordenadas de la más atrasada a la más reciente.
function construirMonitor(pedidos = [], { ahora = new Date(), bolsasPorId = new Map() } = {}) {
  const filas = pedidos
    .filter((p) => ESTADOS_MONITOR.includes(p.estado))
    .map((p) => {
      const desde = marcaDelEstado(p);
      const minutos = minutosDesde(desde, ahora);
      return {
        id: p.id,
        codigo: p.codigo_recogida || null,
        tipo: tipoPedido(p, bolsasPorId),
        estado: p.estado,
        estado_etiqueta: ETIQUETA_ESTADO_MONITOR[p.estado],
        estado_desde: desde,
        minutos_en_estado: minutos,
        nivel: nivelAlerta(minutos),
        total: p.total == null ? null : Number(p.total),
        creado_en: p.created_at || null,
        restaurante: {
          id: p.negocio_id,
          nombre: p.negocios?.nombre || 'Sin nombre',
          zona: p.negocios?.zona || null,
          telefono: p.negocios?.telefono || null,
        },
      };
    })
    .sort((a, b) => (b.minutos_en_estado ?? -1) - (a.minutos_en_estado ?? -1));

  const conteo = { verde: 0, amarillo: 0, rojo: 0, sin_datos: 0 };
  for (const f of filas) conteo[f.nivel] += 1;
  return { pedidos: filas, conteo, total: filas.length, generado_en: ahora.toISOString(), umbrales: UMBRALES_MONITOR };
}

module.exports = {
  ESTADOS_MONITOR, UMBRALES_MONITOR, ETIQUETA_ESTADO_MONITOR,
  marcaDelEstado, minutosDesde, nivelAlerta, tipoPedido, construirMonitor,
};
