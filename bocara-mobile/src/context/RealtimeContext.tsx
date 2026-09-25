import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { negociosAPI } from '../services/api';
import { suscribirPedidosPorFiltro, PedidoRealtimeEvento } from '../services/realtime';

// Único punto de la app que abre un canal de Supabase Realtime — las pantallas
// nunca crean su propio `supabase.channel(...)`. Se suscriben aquí vía
// `onPedidoCambiado`, que es un pub/sub en memoria: un solo canal real por
// sesión, N consumidores locales.
//
// Ver src/services/realtime.ts para el aviso sobre RLS: hoy este canal no
// recibirá eventos reales en producción (deny_all_client_access bloquea la
// réplica), pero la arquitectura queda lista para cuando el backend lo permita.
// El polling que ya existe en cada pantalla sigue siendo la vía funcional.
interface RealtimeContextType {
  conectado: boolean;
  onPedidoCambiado: (cb: (evento: PedidoRealtimeEvento) => void) => () => void;
}

const RealtimeContext = createContext<RealtimeContextType>({
  conectado: false,
  onPedidoCambiado: () => () => {},
});

// Pura y exportada para test-realtime.cjs: qué canal (si alguno) le
// corresponde a esta sesión. `negocioId` ya resuelto porque viene de una
// llamada de red aparte (negociosAPI.miNegocio) que no tiene sentido simular
// aquí — esta función solo decide la forma del filtro/nombre de canal.
export function configCanalPedidos(
  usuario: { id: string; rol: string } | null | undefined,
  negocioId?: string | null
): { filtro: string; nombreCanal: string } | null {
  if (!usuario) return null;
  if (usuario.rol === 'cliente') {
    return { filtro: `usuario_id=eq.${usuario.id}`, nombreCanal: `pedidos-cliente-${usuario.id}` };
  }
  if (usuario.rol === 'restaurante') {
    if (!negocioId) return null;
    return { filtro: `negocio_id=eq.${negocioId}`, nombreCanal: `pedidos-restaurante-${negocioId}` };
  }
  return null; // admin u otros roles: sin canal de pedidos por ahora
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { usuario } = useAuth();
  const [conectado, setConectado] = useState(false);
  const listenersRef = useRef<Set<(evento: PedidoRealtimeEvento) => void>>(new Set());

  const emitir = useCallback((evento: PedidoRealtimeEvento) => {
    // Copia defensiva: un listener que se desregistra durante la iteración
    // (p. ej. una pantalla que navega fuera al procesar el evento) no debe
    // mutar el Set mientras se recorre.
    for (const cb of Array.from(listenersRef.current)) {
      try { cb(evento); } catch { /* un listener roto no debe tumbar a los demás */ }
    }
  }, []);

  // Cambio de usuario.id o de rol (login, logout, cambio de cuenta) limpia la
  // suscripción anterior y arma una nueva — nunca hay dos canales de pedidos
  // vivos a la vez, y un logout deja el efecto sin canal (usuario null).
  useEffect(() => {
    setConectado(false);
    if (!usuario) return undefined;

    let cancelado = false;
    let limpiarCanal: (() => void) | null = null;

    (async () => {
      let negocioId: string | null = null;
      if (usuario.rol === 'restaurante') {
        try {
          const res = await negociosAPI.miNegocio();
          negocioId = res.data?.id ?? null;
        } catch {
          return; // sin negocio resuelto todavía — sin canal, el polling sigue cubriendo
        }
      }
      if (cancelado) return;

      const config = configCanalPedidos(usuario, negocioId);
      if (!config) return;

      limpiarCanal = suscribirPedidosPorFiltro({
        filtro: config.filtro,
        nombreCanal: config.nombreCanal,
        onEvento: emitir,
        onEstadoConexion: setConectado,
      });
    })();

    return () => {
      cancelado = true;
      limpiarCanal?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuario?.id, usuario?.rol, emitir]);

  const onPedidoCambiado = useCallback((cb: (evento: PedidoRealtimeEvento) => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  return (
    <RealtimeContext.Provider value={{ conectado, onPedidoCambiado }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export const useRealtime = () => useContext(RealtimeContext);
