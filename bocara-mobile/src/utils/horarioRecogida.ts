import { Colors } from '@/constants/Colors';

export interface HorarioPublicacion {
  hora_recogida_inicio?: string | null;
  hora_recogida_fin?: string | null;
  fecha_caducidad?: string | null;
}

// Guatemala no observa horario de verano (UTC-6 todo el año), pero igual se usa
// Intl con la zona IANA — en vez de restar 6 horas a mano o confiar en el reloj
// del dispositivo — para no depender de en qué zona horaria esté el navegador o
// el teléfono del usuario. Debe reflejar exactamente
// backend/services/horarioGuatemala.js (fuente autoritativa: el backend nunca
// deja de filtrar por su cuenta, esto es solo un filtro defensivo en el cliente).
const ZONA_GUATEMALA = 'America/Guatemala';

const FMT_FECHA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_GUATEMALA, year: 'numeric', month: '2-digit', day: '2-digit',
});
const FMT_HORA = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA_GUATEMALA, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

interface AhoraGuatemala { fecha: string; hora: string; }

// { fecha: 'YYYY-MM-DD', hora: 'HH:MM:SS' } en hora local de Guatemala. Ambos
// formatos son comparables lexicográficamente (padding fijo).
function ahoraGuatemala(referencia: Date): AhoraGuatemala {
  const partes = FMT_HORA.formatToParts(referencia);
  const get = (tipo: string) => partes.find(p => p.type === tipo)?.value || '00';
  return { fecha: FMT_FECHA.format(referencia), hora: `${get('hour')}:${get('minute')}:${get('second')}` };
}

// 'HH:MM' | 'HH:MM:SS' → 'HH:MM:SS'; cualquier otra cosa → null.
function normalizarHora(hora?: string | null): string | null {
  if (typeof hora !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(hora.trim());
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}

function normalizarFecha(fecha?: string | null): string | null {
  if (fecha == null) return null;
  const texto = String(fecha).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

function sumarDias(fechaISO: string, dias: number): string {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const base = new Date(Date.UTC(anio, mes - 1, dia));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

// Instante (fecha + hora de Guatemala) en que termina la ventana de recogida:
//   · fecha base = `fecha_caducidad`, o el día de hoy en Guatemala si no la tiene
//   · si `hora_recogida_fin` < `hora_recogida_inicio` la ventana cruza la
//     medianoche, así que termina al día SIGUIENTE de la fecha base
function finVentanaRecogida(publicacion: HorarioPublicacion, ahora: AhoraGuatemala) {
  const fin = normalizarHora(publicacion?.hora_recogida_fin);
  if (!fin) return null;
  const inicio = normalizarHora(publicacion?.hora_recogida_inicio);
  let fecha = normalizarFecha(publicacion?.fecha_caducidad) || ahora.fecha;
  if (inicio && fin < inicio) fecha = sumarDias(fecha, 1);
  return { fecha, hora: fin };
}

// true si la ventana de recogida ya terminó según la hora actual de Guatemala.
// Al llegar exactamente a `hora_recogida_fin` la publicación ya está vencida:
// nadie puede recoger en el instante del cierre.
function estaVencidaEn(publicacion: HorarioPublicacion, ahora: AhoraGuatemala): boolean {
  const fin = finVentanaRecogida(publicacion, ahora);
  if (!fin) {
    const fecha = normalizarFecha(publicacion?.fecha_caducidad);
    return fecha ? fecha < ahora.fecha : false;
  }
  if (fin.fecha !== ahora.fecha) return fin.fecha < ahora.fecha;
  return fin.hora <= ahora.hora;
}

export function publicacionVencida(publicacion: HorarioPublicacion, now = new Date()): boolean {
  if (typeof publicacion?.hora_recogida_inicio !== 'string' &&
      typeof publicacion?.hora_recogida_fin !== 'string' &&
      !publicacion?.fecha_caducidad) {
    return false;
  }
  return estaVencidaEn(publicacion, ahoraGuatemala(now));
}

export function publicacionesVigentes<T extends HorarioPublicacion>(items: T[], now = new Date()): T[] {
  const ahora = ahoraGuatemala(now); // una sola lectura para todo el lote
  return items.filter(item => !estaVencidaEn(item, ahora));
}

function minutosHasta(desde: string, hasta: string): number {
  const toMin = (h: string) => { const [hh, mm] = h.split(':').map(Number); return hh * 60 + mm; };
  let diff = toMin(hasta) - toMin(desde);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function formatMins(mins: number): string {
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins} min`;
}

// Regla del detalle: estado de la ventana de recogida de hoy, calculado en hora
// de Guatemala (no en la del dispositivo).
export function calcularEstadoHorario(inicio: string, fin: string, now = new Date()) {
  if (!inicio || !fin) return { estado: 'desconocido', mensaje: '', color: Colors.textLight };
  const ini = normalizarHora(inicio);
  const finN = normalizarHora(fin);
  if (!ini || !finN) return { estado: 'desconocido', mensaje: '', color: Colors.textLight };

  const ahora = ahoraGuatemala(now);
  if (estaVencidaEn({ hora_recogida_inicio: inicio, hora_recogida_fin: fin }, ahora)) {
    return { estado: 'vencido', mensaje: 'Horario de recogida vencido por hoy', color: Colors.error, bloqueado: true };
  }
  if (ahora.hora < ini) {
    const mins = minutosHasta(ahora.hora, ini);
    return { estado: 'pronto', mensaje: `Abre en ${formatMins(mins)} · ${inicio.slice(0, 5)} – ${fin.slice(0, 5)}`, color: '#F59E0B', bloqueado: false };
  }
  const mins = minutosHasta(ahora.hora, finN);
  return { estado: 'abierto', mensaje: `Cierra en ${formatMins(mins)}`, color: mins <= 30 ? Colors.error : '#22C55E', bloqueado: false };
}
