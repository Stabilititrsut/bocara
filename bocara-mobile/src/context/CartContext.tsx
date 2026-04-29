import React, { createContext, useContext, useState } from 'react';
import { Bolsa, CartItem } from '../types';

interface CartContextType {
  items: CartItem[];
  total: number;
  cantidad: number;
  agregar: (bolsa: Bolsa) => void;
  quitar: (bolsaId: string) => void;
  limpiar: () => void;
}

const CartContext = createContext<CartContextType>({} as CartContextType);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  const total = items.reduce(
    (sum, i) => sum + i.bolsa.precio_descuento * i.cantidad,
    0
  );
  const cantidad = items.reduce((sum, i) => sum + i.cantidad, 0);

  function agregar(bolsa: Bolsa) {
    setItems((prev) => {
      const existe = prev.find((i) => i.bolsa.id === bolsa.id);
      if (existe) {
        return prev.map((i) =>
          i.bolsa.id === bolsa.id ? { ...i, cantidad: i.cantidad + 1 } : i
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
    <CartContext.Provider value={{ items, total, cantidad, agregar, quitar, limpiar }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
