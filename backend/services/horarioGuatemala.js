// Fuente única de la hora de Guatemala para publicaciones (bolsas).
//
// El servidor corre en UTC (Render), así que `new Date().toISOString()` adelanta
// el día a partir de las 18:00 hora de Guatemala — una publicación válida hasta
// hoy quedaba fuera del feed seis horas antes de tiempo. Todo el cálculo de
// fechas/horas de publicaciones pasa por aquí para que eso no vuelva a ocurrir.
//
// Guatemala no observa horario de verano (UTC-6 todo el año), pero el cálculo se
// hace con Intl y la zona IANA en vez de restar 6 horas a mano: así sigue siendo
// correcto si eso cambiara y no depende de la zona horaria del proceso.

const ZONA_GUATEMALA = 'America/Guatemala';

const MENSAJE_HORARIO_VENCIDO = 'El horario de recogida ya ha expirado';

const FMT_FECHA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_GUATEMALA, year: 'numeric', month: '2-digit', day: '2-digit',
});
const FMT_HORA = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA_GUATEMALA, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// { fecha: 'YYYY-MM-DD', hora: 'HH:MM:SS' } en hora local de Guatemala.
// Ambos formatos son comparables lexicográficamente (padding fijo).
function ahoraGuatemala(referencia = new Date()) {
  const partes = FMT_HORA.formatToParts(referencia);
  const get = (tipo) => partes.find((p) => p.type === tipo)?.value || '00';
  return {
    fecha: FMT_FECHA.format(referencia),
    hora: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

// Fecha de hoy (YYYY-MM-DD) en Guatemala — para comparar contra `fecha_caducidad`,
// que es una columna `date` sin hora.
function hoyGuatemala(referencia = new Date()) {
  return ahoraGuatemala(referencia).fecha;
}

// 'HH:MM' | 'HH:MM:SS' → 'HH:MM:SS'; cualquier otra cosa → null.
function normalizarHora(hora) {
  if (typeof hora !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(hora.trim());
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}

// 'YYYY-MM-DD' de una columna date (o de un timestamp) → 'YYYY-MM-DD'; si no, null.
function normalizarFecha(fecha) {
  if (fecha == null) return null;
  const texto = String(fecha).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

function sumarDias(fechaISO, dias) {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const base = new Date(Date.UTC(anio, mes - 1, dia));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

// Instante (fecha + hora de Guatemala) en que termina la ventana de recogida:
//   · fecha base = `fecha_caducidad`, o el día de hoy en Guatemala si no la tiene
//   · si `hora_recogida_fin` < `hora_recogida_inicio` la ventana cruza la
//     medianoche, así que termina al día SIGUIENTE de la fecha base
// Devuelve null si la publicación no tiene una hora de fin utilizable.
function finVentanaRecogida(bolsa, ahora = ahoraGuatemala()) {
  const fin = normalizarHora(bolsa?.hora_recogida_fin);
  if (!fin) return null;
  const inicio = normalizarHora(bolsa?.hora_recogida_inicio);
  let fecha = normalizarFecha(bolsa?.fecha_caducidad) || ahora.fecha;
  if (inicio && fin < inicio) fecha = sumarDias(fecha, 1);
  return { fecha, hora: fin };
}

// true si la ventana de recogida ya terminó según la hora actual de Guatemala.
// Al llegar exactamente a `hora_recogida_fin` la publicación ya está vencida:
// nadie puede recoger en el instante del cierre.
function estaVencida(bolsa, ahora = ahoraGuatemala()) {
  const fin = finVentanaRecogida(bolsa, ahora);
  if (!fin) {
    // Sin hora de fin solo puede juzgarse por la fecha de caducidad.
    const fecha = normalizarFecha(bolsa?.fecha_caducidad);
    return fecha ? fecha < ahora.fecha : false;
  }
  if (fin.fecha !== ahora.fecha) return fin.fecha < ahora.fecha;
  return fin.hora <= ahora.hora;
}

// Filtra una lista de publicaciones dejando solo las vigentes. Una sola lectura
// de la hora para todo el lote: evita que un elemento se evalúe contra un
// segundo distinto que el siguiente.
function filtrarVigentes(bolsas, ahora = ahoraGuatemala()) {
  return (bolsas || []).filter((b) => !estaVencida(b, ahora));
}

// Valida (para escrituras: crear / editar / reactivar) que el fin de la ventana
// de recogida sea estrictamente futuro en Guatemala.
// Devuelve el mensaje de error, o null si el horario es válido.
function validarHorarioFuturo(bolsa, ahora = ahoraGuatemala()) {
  const fechaCaducidad = normalizarFecha(bolsa?.fecha_caducidad);
  // En escritura, una fecha de caducidad ya pasada nunca se acepta, aunque la
  // ventana cruce la medianoche y técnicamente siguiera abierta.
  if (fechaCaducidad && fechaCaducidad < ahora.fecha) return MENSAJE_HORARIO_VENCIDO;
  return estaVencida(bolsa, ahora) ? MENSAJE_HORARIO_VENCIDO : null;
}

module.exports = {
  ZONA_GUATEMALA,
  MENSAJE_HORARIO_VENCIDO,
  ahoraGuatemala,
  hoyGuatemala,
  normalizarHora,
  normalizarFecha,
  finVentanaRecogida,
  estaVencida,
  filtrarVigentes,
  validarHorarioFuturo,
};
