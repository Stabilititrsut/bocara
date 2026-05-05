import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Bolsa, CartItem } from '../types';

const CART_KEY = 'bocara_cart_v2';

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

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Cargar carrito guardado al iniciar
  useEffect(() => {
    AsyncStorage.getItem(CART_KEY).then((stored) => {
      if (stored) {
        try { setItems(JSON.parse(stored)); } catch { }
      }
      setLoaded(true);
    });
  }, []);

  // Persistir carrito cuando cambia
  useEffect(() => {
    if (loaded) {
      AsyncStorage.setItem(CART_KEY, JSON.stringify(items));
    }
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
