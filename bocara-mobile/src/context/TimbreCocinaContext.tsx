// Una sola instancia del timbre de cocina para todo el panel del restaurante.
//
// El proveedor vive en app/restaurante/_layout.tsx y ejecuta useTimbreCocina
// ahí, así que el timbre suena en cualquier pestaña (Dashboard, Disponibles,
// Ganancias…). El CONTROL visible (Activado/Silenciado y el aviso para
// desbloquear el audio) solo se pinta en app/restaurante/pedidos.tsx, que lee
// este mismo estado — sin montar el hook dos veces (dos pollings, dos timbres).
import { createContext, useContext, type ReactNode } from 'react';
import { useTimbreCocina, type EstadoTimbreCocina } from '@/hooks/use-timbre-cocina';

const TimbreCocinaContext = createContext<EstadoTimbreCocina | null>(null);

export function TimbreCocinaProvider({ children }: { children: ReactNode }) {
  const timbre = useTimbreCocina();
  return <TimbreCocinaContext.Provider value={timbre}>{children}</TimbreCocinaContext.Provider>;
}

// null fuera del panel del restaurante (sin proveedor): quien lo use no pinta nada.
export function useTimbreCocinaPanel(): EstadoTimbreCocina | null {
  return useContext(TimbreCocinaContext);
}
