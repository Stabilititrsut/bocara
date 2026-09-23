import type { Bolsa } from '../types';

// cantidad_disponible_real (DB − reservas pendientes, inyectado por el backend en
// GET /bolsas y GET /bolsas/:id) es la fuente de verdad. cantidad_disponible es
// solo el valor histórico de DB y se usa nada más si el backend todavía no manda
// el campo real (respuesta vieja cacheada, endpoint que no lo agrega, etc).
export function disponibilidadReal(bolsa: Pick<Bolsa, 'cantidad_disponible' | 'cantidad_disponible_real'> | null | undefined): number {
  if (!bolsa) return 0;
  const real = bolsa.cantidad_disponible_real;
  if (typeof real === 'number' && Number.isFinite(real)) return Math.max(0, real);
  const historico = bolsa.cantidad_disponible;
  return typeof historico === 'number' && Number.isFinite(historico) ? Math.max(0, historico) : 0;
}

// Campo crudo (sin validar) que decide la disponibilidad de una bolsa: el real
// del backend si vino en la respuesta, o el histórico de DB como fallback. Deja
// pasar valores inválidos (NaN, negativos, strings) a propósito — quien llama
// valida el resultado (ver stockLocal en cartStore.ts) para poder distinguir
// "agotado" de "el backend mandó un dato corrupto".
export function campoDisponibilidad(bolsa: Pick<Bolsa, 'cantidad_disponible' | 'cantidad_disponible_real'> | null | undefined): unknown {
  if (!bolsa) return undefined;
  return bolsa.cantidad_disponible_real !== undefined ? bolsa.cantidad_disponible_real : bolsa.cantidad_disponible;
}

// Mensaje único de disponibilidad, reutilizado en detalle, tienda, carrito y pago.
export function textoDisponibilidad(real: number): string {
  if (real <= 0) return 'Agotado';
  if (real === 1) return 'Solo queda 1 unidad disponible';
  return `Quedan ${real} unidades disponibles`;
}
