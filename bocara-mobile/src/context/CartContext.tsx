import React, { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCartPersistence, createCartStore } from './cartStore';
import { registrarEvento } from '../utils/analitica';

export type { ResultadoAgregar } from './cartStore';
export const CART_KEY_PREFIX = 'carrito_';
const persistence = createCartPersistence(AsyncStorage);

type CartContextType = Pick<ReturnType<typeof createCartStore>, 'agregar' | 'quitar' | 'limpiar' | 'sincronizarDisponibilidad'> &
  ReturnType<ReturnType<typeof createCartStore>['getSnapshot']> & { total: number; cantidad: number };

const CartContext = createContext<CartContextType>({} as CartContextType);

export function CartProvider({ children, userId }: { children: React.ReactNode; userId?: string | null }) {
  const cartKey = userId ? `${CART_KEY_PREFIX}${userId}` : 'carrito_anonimo';
  // Snapshot nuevo en el mismo render que cambia la cuenta, sin remontar navegación.
  const store = useMemo(() => createCartStore(cartKey, persistence), [cartKey]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useLayoutEffect(() => store.activate(), [store]);
  const value = useMemo(() => ({
    ...snapshot,
    total: snapshot.items.reduce((sum, i) => sum + i.bolsa.precio_descuento * i.cantidad, 0),
    cantidad: snapshot.items.reduce((sum, i) => sum + i.cantidad, 0),
    // add_to_cart solo cuando el carrito aceptó el producto; el resultado
    // vuelve intacto al llamador (la lógica del carrito no cambia).
    agregar: (bolsa: Parameters<typeof store.agregar>[0]) => {
      const resultado = store.agregar(bolsa);
      if (resultado.ok) registrarEvento('add_to_cart', { bolsa_id: bolsa.id, negocio_id: bolsa.negocio_id });
      return resultado;
    },
    quitar: store.quitar,
    limpiar: store.limpiar,
    sincronizarDisponibilidad: store.sincronizarDisponibilidad,
  }), [snapshot, store]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
