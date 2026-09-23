import type { TipoPublicacion } from '../types';

// bolsa.tipo es el único campo contractual de backend para el tipo de
// publicación (ver TipoPublicacion en src/types/index.ts). Cualquier valor
// que no sea exactamente 'cupon' se trata como 'bolsa', igual que hace el
// propio backend (`tipo: tipo || 'bolsa'` en backend/routes/bolsas.js).
function normalizar(tipo: string | null | undefined): TipoPublicacion {
  return tipo === 'cupon' ? 'cupon' : 'bolsa';
}

const ETIQUETA: Record<TipoPublicacion, string> = {
  bolsa: 'Tiempo limitado',
  cupon: 'Promoción',
};

const ETIQUETA_CORTA: Record<TipoPublicacion, string> = {
  bolsa: 'T. LIMITADO',
  cupon: 'PROMO',
};

const EMOJI: Record<TipoPublicacion, string> = {
  bolsa: '⏱️',
  cupon: '🏷️',
};

// Etiqueta larga que ve el cliente (detalle de producto, secciones, etc.).
export function etiquetaTipoProducto(tipo: string | null | undefined): string {
  return ETIQUETA[normalizar(tipo)];
}

// Variante corta para badges pequeños sobre tarjetas de producto.
export function etiquetaTipoProductoCorta(tipo: string | null | undefined): string {
  return ETIQUETA_CORTA[normalizar(tipo)];
}

export function emojiTipoProducto(tipo: string | null | undefined): string {
  return EMOJI[normalizar(tipo)];
}

// Clasificación canónica para filtros (tabs de tienda, etc.) — misma fuente
// que las etiquetas de arriba. No usar banderas de menú independientes
// (es_tiempo_limitado/es_promocion) para esto: pueden divergir del `tipo`
// real que el badge muestra (QA #23). Legacy sin `tipo` cae a 'bolsa', igual
// que el backend, así que la clasificación es determinista.
export function esTiempoLimitado(tipo: string | null | undefined): boolean {
  return normalizar(tipo) === 'bolsa';
}

export function esPromocion(tipo: string | null | undefined): boolean {
  return normalizar(tipo) === 'cupon';
}
