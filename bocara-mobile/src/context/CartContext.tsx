import React, { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createCartPersistence, createCartStore } from './cartStore';

export type { ResultadoAgregar } from './cartStore';
export const CART_KEY_PREFIX = 'carrito_';
const persistence = createCartPersistence(AsyncStorage);

type CartContextType = Pick<ReturnType<typeof createCartStore>, 'agregar' | 'quitar' | 'limpiar'> &
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
    agregar: store.agregar,
    quitar: store.quitar,
    limpiar: store.limpiar,
  }), [snapshot, store]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
