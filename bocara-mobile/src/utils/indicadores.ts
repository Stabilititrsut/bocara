// Lógica pura de la pantalla Admin › Indicadores (módulo 03). Sin React ni red:
// la pantalla solo pinta lo que estas funciones deciden, y
// scripts/test-indicadores.cjs las prueba tal cual viven aquí.
//
// Regla de la guía: denominador cero → "No aplica"; medición ausente →
// "Sin datos". Nunca se muestra un 0 que el backend no calculó.

import type { EstadoKpi, FiltrosKpi, Kpi, PeriodoKpi, RespuestaEmbudo, TipoPeriodoKpi } from '../services/api';

// Guatemala no tiene horario de verano: UTC-6 todo el año.
const OFFSET_GUATEMALA_MS = 6 * 60 * 60 * 1000;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function hoyGuatemala(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - OFFSET_GUATEMALA_MS).toISOString().slice(0, 10);
}

export function mesActualGuatemala(ahora: Date = new Date()): string {
  return hoyGuatemala(ahora).slice(0, 7);
}

function fechaReal(s: string): boolean {
  if (!RE_FECHA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const OPCIONES_PERIODO: { valor: TipoPeriodoKpi; etiqueta: string }[] = [
  { valor: 'hoy', etiqueta: 'Hoy' },
  { valor: 'mes_actual', etiqueta: 'Mes actual' },
  { valor: 'mes', etiqueta: 'Mes' },
  { valor: 'rango', etiqueta: 'Rango' },
  { valor: 'historico', etiqueta: 'Histórico' },
];

export const OPCIONES_TIPO: { valor: '' | 'bolsa' | 'cupon'; etiqueta: string }[] = [
  { valor: '', etiqueta: 'Todos' },
  { valor: 'bolsa', etiqueta: 'Tiempo limitado' },
  { valor: 'cupon', etiqueta: 'Promoción' },
];

export interface EstadoFiltros {
  periodo: TipoPeriodoKpi;
  mes: string;
  desde: string;
  hasta: string;
  negocio_id: string;
  zona: string;
  tipo: '' | 'bolsa' | 'cupon';
}

export function filtrosIniciales(ahora: Date = new Date()): EstadoFiltros {
  const hoy = hoyGuatemala(ahora);
  return { periodo: 'mes_actual', mes: hoy.slice(0, 7), desde: `${hoy.slice(0, 7)}-01`, hasta: hoy, negocio_id: '', zona: '', tipo: '' };
}

// Traduce el estado de la UI a los parámetros del backend; valida lo mismo que
// el backend para no gastar una consulta en un 400.
export function construirFiltros(e: EstadoFiltros): { filtros?: FiltrosKpi; error?: string } {
  const filtros: FiltrosKpi = { periodo: e.periodo };
  if (e.periodo === 'mes') {
    if (!RE_MES.test(e.mes)) return { error: 'Elige un mes válido.' };
    filtros.mes = e.mes;
  }
  if (e.periodo === 'rango') {
    if (!fechaReal(e.desde) || !fechaReal(e.hasta)) return { error: 'Elige las dos fechas del rango.' };
    if (e.desde > e.hasta) return { error: 'La fecha inicial no puede ser posterior a la final.' };
    filtros.desde = e.desde;
    filtros.hasta = e.hasta;
  }
  if (e.negocio_id) {
    if (!RE_UUID.test(e.negocio_id)) return { error: 'Negocio inválido.' };
    filtros.negocio_id = e.negocio_id;
  }
  if (e.zona.trim()) filtros.zona = e.zona.trim();
  if (e.tipo) filtros.tipo = e.tipo;
  return { filtros };
}

// ── Lectura de un KPI ────────────────────────────────────────────────────────

export const ETIQUETA_ESTADO: Record<EstadoKpi, string> = {
  ok: 'Calculado',
  no_aplica: 'No aplica',
  sin_datos: 'Sin datos',
};

export const EXPLICACION_ESTADO: Record<Exclude<EstadoKpi, 'ok'>, string> = {
  no_aplica: 'El denominador es 0 en este periodo: no hay base sobre la cual calcular.',
  sin_datos: 'No hay medición observable para este periodo (sin registros o instrumentación aún no activa).',
};

export function formatearMoneda(n: number): string {
  const [entero, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}Q${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

function formatearCantidad(n: number): string {
  const redondeado = Math.round(n * 100) / 100;
  const [entero, dec] = String(redondeado).split('.');
  return `${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${dec ? `.${dec}` : ''}`;
}

// Valor principal de la tarjeta. null cuando el estado no es 'ok': la tarjeta
// muestra entonces la insignia "No aplica"/"Sin datos", nunca un número.
export function valorPrincipal(kpi: Pick<Kpi, 'estado' | 'valor' | 'unidad'>): string | null {
  if (kpi.estado !== 'ok' || kpi.valor == null) return null;
  if (kpi.unidad === '%') return `${formatearCantidad(kpi.valor)}%`;
  if (kpi.unidad === 'GTQ') return formatearMoneda(kpi.valor);
  if (kpi.unidad === 'minutos') return `${formatearCantidad(kpi.valor)} min`;
  return `${formatearCantidad(kpi.valor)} ${kpi.unidad}`;
}

// Numerador y denominador legibles. En KPIs monetarios el numerador es dinero
// (inversión, venta) y el denominador cuenta personas o pedidos.
export function partesCociente(kpi: Kpi): { numerador: string; denominador: string } | null {
  if (kpi.numerador == null || kpi.denominador == null) return null;
  const numerador = kpi.unidad === 'GTQ' ? formatearMoneda(kpi.numerador) : formatearCantidad(kpi.numerador);
  return { numerador, denominador: formatearCantidad(kpi.denominador) };
}

const ETIQUETAS_DESGLOSE: Record<string, string> = {
  completados: 'Completados', en_curso: 'En curso', cancelados: 'Cancelados', rechazados_restaurante: 'Rechazados por restaurante',
  ofertas_observadas: 'Ofertas con vigencia terminada', ofertas_en_vigencia: 'Ofertas aún vigentes', ofertas_sin_vigencia: 'Ofertas sin fecha de caducidad',
  compradores_nuevos: 'Compradores nuevos', compradores_nuevos_atribuibles: 'Atribuibles a Meta', registros_inversion: 'Registros de inversión',
  observados: 'Procesos observados', abandonados: 'Abandonados',
  aprobados: 'Aprobados', fallidos: 'Fallidos', expirados: 'Expirados', pendientes: 'Pendientes', pedidos_afectados: 'Pedidos afectados',
  con_oferta: 'Con oferta comprable', sin_oferta: 'Sin oferta comprable',
};

export function filasDesglose(kpi: Kpi): { etiqueta: string; valor: string }[] {
  if (!kpi.desglose || Array.isArray(kpi.desglose)) return [];
  return Object.entries(kpi.desglose).map(([clave, valor]) => ({
    etiqueta: ETIQUETAS_DESGLOSE[clave] || clave.replace(/_/g, ' '),
    valor: formatearCantidad(Number(valor)),
  }));
}

// Notas que acompañan la lectura (cobertura parcial, ventanas, cohortes...).
export function notasKpi(kpi: Kpi): string[] {
  const notas: string[] = [];
  if (kpi.nota) notas.push(kpi.nota);
  if (kpi.cohorte) notas.push(`Cohorte: ${kpi.cohorte}.`);
  if (kpi.ventana_minutos) notas.push(`Ventana de abandono: ${kpi.ventana_minutos} min.`);
  if (kpi.ventana_medicion) notas.push(`Ventana: ${kpi.ventana_medicion}.`);
  if (kpi.cobertura_parcial && kpi.cobertura_desde) {
    notas.push(`Medición parcial: la captura empezó el ${formatearInstante(kpi.cobertura_desde)}.`);
  }
  if (kpi.periodo?.tipo === 'lectura_actual') notas.push('Lectura actual: no depende del periodo elegido.');
  if (kpi.periodo_abierto) notas.push('Periodo abierto: el valor puede cambiar.');
  return notas;
}

// ── Periodo ──────────────────────────────────────────────────────────────────

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES_CORTOS[m - 1]} ${a}`;
}

export function formatearInstante(iso: string): string {
  const local = new Date(new Date(iso).getTime() - OFFSET_GUATEMALA_MS).toISOString();
  return `${fechaCorta(local.slice(0, 10))}, ${local.slice(11, 16)}`;
}

export function describirPeriodo(p: PeriodoKpi | undefined): string {
  if (!p) return '';
  if (p.tipo === 'lectura_actual') return 'Lectura actual';
  if (!p.desde_local || !p.hasta_local) return '';
  const rango = p.desde_local === p.hasta_local
    ? fechaCorta(p.desde_local)
    : `${fechaCorta(p.desde_local)} – ${fechaCorta(p.hasta_local)}`;
  return `${rango} · hora de Guatemala`;
}

// ── Tiempos operativos ───────────────────────────────────────────────────────

// Umbrales de alerta en minutos por tramo. Valores iniciales de operación; la
// guía pide que sean configurables, así que viven en un solo lugar.
export const UMBRALES_TIEMPOS: Record<string, { alerta: number; critico: number }> = {
  tiempo_recibido_aceptado: { alerta: 10, critico: 20 },
  tiempo_aceptado_listo: { alerta: 30, critico: 60 },
  tiempo_listo_completado: { alerta: 60, critico: 120 },
};

export type NivelTiempo = 'ok' | 'alerta' | 'critico' | 'sin_datos';

export function nivelTiempo(kpi: Pick<Kpi, 'clave' | 'estado' | 'valor'>): NivelTiempo {
  if (kpi.estado !== 'ok' || kpi.valor == null) return 'sin_datos';
  const u = UMBRALES_TIEMPOS[kpi.clave];
  if (!u) return 'ok';
  if (kpi.valor >= u.critico) return 'critico';
  if (kpi.valor >= u.alerta) return 'alerta';
  return 'ok';
}

export function tramosTiempos(kpis: Kpi[]): Kpi[] {
  const t = kpis.find((k) => k.clave === 'tiempos_operativos');
  return Array.isArray(t?.desglose) ? t.desglose : [];
}

// ── Embudo ───────────────────────────────────────────────────────────────────

export const NOMBRES_EMBUDO: Record<string, string> = {
  visita: 'Visita',
  vista_oferta: 'Ve oferta',
  carrito: 'Carrito',
  inicio_pago: 'Inicia pago',
  compra_pagada: 'Compra pagada',
};

// Ancho relativo de cada barra (0–100) respecto de las visitas. null si no hay
// medición; 0 solo si el backend contó 0 sesiones de verdad.
export function barrasEmbudo(resp: Pick<RespuestaEmbudo, 'estado' | 'pasos'> | null) {
  if (!resp) return [];
  const visitas = resp.pasos[0]?.sesiones ?? null;
  return resp.pasos.map((p) => ({
    clave: p.clave,
    nombre: NOMBRES_EMBUDO[p.clave] || p.nombre,
    sesiones: p.sesiones,
    ancho: p.sesiones == null || !visitas ? null : Math.max(2, Math.round((p.sesiones / visitas) * 100)),
    tasa: p.tasa_desde_anterior,
  }));
}

// ── Inversión Meta Ads ───────────────────────────────────────────────────────

export interface FormInversion {
  campana: string;
  fecha_inicio: string;
  fecha_fin: string;
  monto: string;
}

export function validarFormInversion(f: FormInversion): { datos?: { campana?: string; fecha_inicio: string; fecha_fin: string; monto: string }; error?: string } {
  if (!fechaReal(f.fecha_inicio) || !fechaReal(f.fecha_fin)) return { error: 'Elige fecha de inicio y de fin.' };
  if (f.fecha_fin < f.fecha_inicio) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' };
  const monto = f.monto.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(monto) || !(Number(monto) > 0)) return { error: 'El monto debe ser mayor que 0, con hasta 2 decimales.' };
  if (Number(monto) > 10000000) return { error: 'El monto excede el máximo permitido.' };
  if (f.campana.trim().length > 120) return { error: 'La campaña no puede superar 120 caracteres.' };
  return { datos: { ...(f.campana.trim() ? { campana: f.campana.trim() } : {}), fecha_inicio: f.fecha_inicio, fecha_fin: f.fecha_fin, monto } };
}
