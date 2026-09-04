import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { notificacionesAPI } from '../services/api';

// Tipos que el panel de restaurante sabe mostrar. Debe reflejar la misma
// lista que el backend usa para filtrar (backend/routes/notificaciones.js
// TIPOS_RESTAURANTE) — se repite aquí solo como defensa extra, no como
// única fuente de verdad.
const TIPOS_RESTAURANTE = new Set([
  'negocio_aprobado', 'negocio_rechazado', 'negocio_suspendido',
  'bolsa_aprobada', 'bolsa_rechazada', 'bolsa_cambios_solicitados',
  'nuevo_pedido', 'pedido_en_preparacion', 'pedido_listo',
  'liquidacion', 'liquidacion_pagada', 'perfil_aprobado', 'perfil_rechazado',
]);

interface NotificacionesRestauranteContextType {
  notifs: any[];
  sinLeer: number;
  loading: boolean;
  refrescar: () => Promise<void>;
  marcarLeida: (id: string) => Promise<void>;
}

const NotificacionesRestauranteContext = createContext<NotificacionesRestauranteContextType>({
  notifs: [], sinLeer: 0, loading: true, refrescar: async () => {}, marcarLeida: async () => {},
});

// Única fuente de verdad para los avisos del panel de restaurante: tanto el
// badge de la pestaña (RestauranteLayout) como la pantalla de Notificaciones
// leen del mismo estado. Antes cada uno hacía su propio polling independiente,
// así que marcar un aviso como leído en la pantalla no se reflejaba en el
// badge de la pestaña hasta su siguiente poll (hasta 30s de número desfasado).
export function NotificacionesRestauranteProvider({ children }: { children: React.ReactNode }) {
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef<any>(null);

  const refrescar = useCallback(async () => {
    try {
      const res = await notificacionesAPI.listar();
      const todas: any[] = res.data || [];
      setNotifs(todas.filter(n => !n.tipo || TIPOS_RESTAURANTE.has(n.tipo)));
    } catch { } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refrescar();
    pollingRef.current = setInterval(refrescar, 30000);
    return () => clearInterval(pollingRef.current);
  }, [refrescar]);

  const marcarLeida = useCallback(async (id: string) => {
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, leida: true } : n));
    try { await notificacionesAPI.marcarLeida(id); } catch { }
  }, []);

  const sinLeer = notifs.filter(n => !n.leida).length;

  return (
    <NotificacionesRestauranteContext.Provider value={{ notifs, sinLeer, loading, refrescar, marcarLeida }}>
      {children}
    </NotificacionesRestauranteContext.Provider>
  );
}

export function useNotificacionesRestaurante() {
  return useContext(NotificacionesRestauranteContext);
}
