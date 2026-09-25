import { Alert, Platform } from 'react-native';
import type { ResultadoAgregar } from '../context/CartContext';

const MENSAJES = {
  vencido: ['Publicación no disponible', 'El horario de recogida ya venció. Elige otra publicación.'],
  no_cargado: ['Carrito cargando', 'Espera a que termine de cargar tu carrito.'],
  otro_negocio: ['Un restaurante por pedido', 'Finaliza o vacía tu carrito actual antes de agregar productos de otro restaurante.'],
  agotado: ['Sin stock', 'Este producto está agotado.'],
  limite_stock: ['Límite de stock', 'Ya alcanzaste las unidades disponibles de este producto.'],
  stock_invalido: ['Disponibilidad no confirmada', 'No se pudo comprobar la cantidad disponible. Actualiza el producto e intenta de nuevo.'],
  producto_invalido: ['Producto no disponible', 'Actualiza el producto e intenta de nuevo.'],
} as const;

// Los mensajes pertenecen a la UI; el contexto solo devuelve un resultado tipado.
export function mostrarErrorCarrito(result: ResultadoAgregar): boolean {
  if (result.ok) return false;
  const [title, message] = result.motivo === 'limite_stock'
    ? ['Límite de stock', result.stockDisponible === 1
        ? 'Solo queda 1 unidad disponible.'
        : `Solo quedan ${result.stockDisponible} unidades disponibles.`]
    : MENSAJES[result.motivo];
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(`${title}\n\n${message}`);
    }
  } else {
    Alert.alert(title, message);
  }
  return true;
}
