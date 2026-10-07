// Lógica de presentación de liquidaciones mensuales y reseñas verificadas
// (Fase C). Sin React ni red: la usan ganancias, reseñas del restaurante,
// pedidos del cliente, la ficha pública del negocio y el panel admin, y se
// prueba en scripts/test-liquidaciones-resenas.cjs.

// Hora de Guatemala: UTC-6 todo el año (sin horario de verano). Se aplica el
// desfase a mano en vez de Intl con timeZone, que no todas las builds de
// Hermes soportan; así la fecha mostrada coincide con la del PDF del backend.
const OFFSET_GUATEMALA_MS = 6 * 60 * 60 * 1000;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const MAX_TEXTO_RESENA = 500;

// 'YYYY-MM' → 'Septiembre 2026'. Liquidaciones previas al corte mensual no
// tienen mes.
export function etiquetaMes(mes?: string | null): string {
  if (!mes || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return 'Liquidación anterior';
  const nombre = MESES[Number(mes.slice(5)) - 1];
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${mes.slice(0, 4)}`;
}

// Instante ISO → 'dd/mm/aaaa' en hora de Guatemala.
export function fechaGT(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const [a, m, d] = new Date(t - OFFSET_GUATEMALA_MS).toISOString().slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export const ESTADOS_LIQUIDACION: Record<string, { label: string; color: string; bg: string }> = {
  pendiente: { label: 'Pendiente de pago', color: '#92400E', bg: '#FEF3C7' },
  pagado:    { label: 'Pagado',            color: '#065F46', bg: '#D1FAE5' },
  liquidado: { label: 'Liquidado',         color: '#065F46', bg: '#D1FAE5' },
  anulado:   { label: 'Anulado',           color: '#6B7280', bg: '#F3F4F6' },
};

export function estadoLiquidacion(estado?: string | null) {
  return ESTADOS_LIQUIDACION[estado || ''] || ESTADOS_LIQUIDACION.pendiente;
}

// Pendiente y ya pasó la fecha límite (3er día hábil del mes siguiente).
export function pagoVencido(liq: { estado?: string; fecha_limite_pago?: string | null }, ahora: Date = new Date()): boolean {
  if (liq.estado !== 'pendiente' || !liq.fecha_limite_pago) return false;
  return new Date(liq.fecha_limite_pago).getTime() < ahora.getTime();
}

export function quetzales(valor: unknown): string {
  const n = Number(valor);
  return `Q${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

// ── Reseñas ──────────────────────────────────────────────────────────────────

const ESTADOS_ENTREGADOS = ['completado', 'recogido'];

// El backend decide si ya existe reseña (`resena_id` en GET /pedidos); la app
// ya no guarda nada localmente.
export function puedeResenar(pedido: { estado?: string; resena_id?: string | null }): boolean {
  return ESTADOS_ENTREGADOS.includes(pedido.estado || '') && !pedido.resena_id;
}

export function yaResenado(pedido: { estado?: string; resena_id?: string | null }): boolean {
  return ESTADOS_ENTREGADOS.includes(pedido.estado || '') && !!pedido.resena_id;
}

// 409 de POST /resenas: el pedido ya tenía reseña (otro dispositivo, doble
// toque). Devuelve el id que mandó el backend, o un marcador si no vino.
export function resenaExistenteDeError(error: any): string | null {
  if (error?.status !== 409) return null;
  return error?.responseData?.resena_id || 'existente';
}

// Largo como char_length() de Postgres (un emoji = 1), que es lo que valida el
// backend. Array.from itera por code points; `[...texto]` también, pero al
// transpilar a ES5 se convierte en un helper que no acepta strings.
export function largoTexto(texto: string): number {
  return Array.from(texto || '').length;
}

export function estrellas(calificacion: number): string {
  const n = Math.max(0, Math.min(5, Math.round(Number(calificacion) || 0)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// Mismas reglas que backend/services/resenas.js validarRespuesta.
export function validarRespuesta(texto: string): string | null {
  const limpio = (texto || '').trim();
  if (!limpio) return 'Escribe una respuesta';
  if (largoTexto(limpio) > MAX_TEXTO_RESENA) return `Máximo ${MAX_TEXTO_RESENA} caracteres`;
  return null;
}

// Ocultar exige motivo (backend/services/resenas.js validarModeracion).
export function validarMotivoOcultar(motivo: string): string | null {
  const limpio = (motivo || '').trim();
  if (!limpio) return 'Indica el motivo para ocultar la reseña';
  if (largoTexto(limpio) > 300) return 'Máximo 300 caracteres';
  return null;
}

// Nombre público abreviado: 'María José López' → 'María L.'
export function nombreCorto(nombre?: string | null): string {
  const partes = (nombre || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'Cliente';
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1].charAt(0).toUpperCase()}.`;
}
