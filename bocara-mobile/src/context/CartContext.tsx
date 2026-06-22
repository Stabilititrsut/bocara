import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Bolsa, CartItem } from '../types';

const CART_KEY_PREFIX = 'carrito_';

interface CartContextType {
  items: CartItem[];
  total: number;
  cantidad: number;
  loaded: boolean;
  agregar: (bolsa: Bolsa) => void;
  quitar: (bolsaId: string) => void;
  limpiar: () => void;
}

const CartContext = createContext<CartContextType>({} as CartContextType);

interface CartProviderProps {
  children: React.ReactNode;
  userId?: string | null;
}

export function CartProvider({ children, userId }: CartProviderProps) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const cartKey = userId ? `${CART_KEY_PREFIX}${userId}` : 'carrito_anonimo';

  // Recargar carrito cuando cambia el userId (cambio de cuenta)
  useEffect(() => {
    setLoaded(false);
    setItems([]);
    AsyncStorage.getItem(cartKey).then((stored) => {
      if (stored) {
        try { setItems(JSON.parse(stored)); } catch { }
      }
      setLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Persistir carrito cuando cambia (solo después de cargar)
  useEffect(() => {
    if (loaded) {
      AsyncStorage.setItem(cartKey, JSON.stringify(items));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loaded]);

  const total = items.reduce((sum, i) => sum + i.bolsa.precio_descuento * i.cantidad, 0);
  const cantidad = items.reduce((sum, i) => sum + i.cantidad, 0);

  function agregar(bolsa: Bolsa) {
    setItems((prev) => {
      const existe = prev.find((i) => i.bolsa.id === bolsa.id);
      if (existe) {
        const max = bolsa.cantidad_disponible || 99;
        return prev.map((i) =>
          i.bolsa.id === bolsa.id
            ? { ...i, cantidad: Math.min(i.cantidad + 1, max) }
            : i
        );
      }
      return [...prev, { bolsa, cantidad: 1 }];
    });
  }

  function quitar(bolsaId: string) {
    setItems((prev) => {
      const item = prev.find((i) => i.bolsa.id === bolsaId);
      if (!item) return prev;
      if (item.cantidad === 1) return prev.filter((i) => i.bolsa.id !== bolsaId);
      return prev.map((i) =>
        i.bolsa.id === bolsaId ? { ...i, cantidad: i.cantidad - 1 } : i
      );
    });
  }

  function limpiar() {
    setItems([]);
  }

  return (
    <CartContext.Provider value={{ items, total, cantidad, loaded, agregar, quitar, limpiar }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
