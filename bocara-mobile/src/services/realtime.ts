import { supabase } from './supabase';

// ════════════════════════════════════════════════════════════════════════════
// Capa única de Supabase Realtime para pedidos.
//
// ── Aviso arquitectónico (léase antes de asumir que esto ya funciona) ────────
//
// El backend bloquea `pedidos` con una política RLS `deny_all_client_access`
// (backend/supabase/migrations/202607301400_rls_lockdown_tablas_sensibles.sql),
// y esta app NO mantiene una sesión de Supabase Auth para el login normal
// (email/password, OTP) — solo un JWT propio del backend, sin relación con el
// secreto de Supabase. Sin sesión de Supabase Auth y con RLS en `deny_all`,
// Realtime jamás entrega cambios de `pedidos` a este cliente (ni error visible:
// el canal queda "SUBSCRIBED" pero no llegan payloads — RLS también gobierna la
// réplica lógica que alimenta Realtime, no solo REST).
//
// Esta capa es correcta y queda lista para el día en que el backend exponga una
// política RLS estrecha de solo lectura (scoped al dueño de la fila) y la app
// tenga una identidad que Supabase Auth reconozca. Mientras tanto, el polling
// que ya existe en cada pantalla sigue siendo la vía funcional — por diseño
// esta capa nunca reemplaza esa red de seguridad, solo la complementa cuando
// puede.
// ════════════════════════════════════════════════════════════════════════════

export type PedidoEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface PedidoRealtimeEvento {
  tipo: PedidoEventType;
  pedidoId: string;
  estado?: string;
  estado_pago?: string;
  raw: any;
}

// Cliente Supabase inyectable (mismo patrón que el backend usa para sus
// servicios) — permite probar la orquestación con un doble sin abrir sockets.
export type ClienteRealtime = Pick<typeof supabase, 'channel' | 'removeChannel'>;

// Clave de deduplicación: un mismo cambio de fila puede redistribuirse si el
// canal se reconecta con un buffer pendiente. commit_timestamp + id + tipo de
// evento identifica el cambio real, no el envío.
export function construirClaveDedup(payload: any): string {
  const fila = payload?.new ?? payload?.old;
  const id = fila?.id ?? 'sin-id';
  return `${payload?.eventType ?? '?'}:${id}:${payload?.commit_timestamp ?? ''}`;
}

// Deduplicador acotado en memoria — nunca crece sin límite en una sesión larga.
export function crearDeduplicador(maxEntradas = 200) {
  const orden: string[] = [];
  const vistos = new Set<string>();
  return {
    yaVisto(clave: string): boolean {
      if (vistos.has(clave)) return true;
      orden.push(clave);
      vistos.add(clave);
      if (orden.length > maxEntradas) {
        const masViejo = orden.shift();
        if (masViejo !== undefined) vistos.delete(masViejo);
      }
      return false;
    },
    size(): number { return vistos.size; },
  };
}

// Payload crudo de postgres_changes → forma mínima que consume la UI. Devuelve
// null si la fila no trae id (payload corrupto/inesperado) — nunca se emite un
// evento sin un pedidoId utilizable.
export function mapearEventoPedido(payload: any): PedidoRealtimeEvento | null {
  const fila = payload?.new ?? payload?.old;
  if (!fila?.id) return null;
  return {
    tipo: payload.eventType,
    pedidoId: String(fila.id),
    estado: fila.estado,
    estado_pago: fila.estado_pago,
    raw: payload,
  };
}

// Backoff exponencial acotado para reconexión: 2s, 4s, 8s, 16s, tope 30s.
// No es indefinido — un dispositivo con la red muerta reintenta cada 30s en
// vez de en bucle rápido agotando batería.
export function calcularBackoffMs(intento: number): number {
  return Math.min(30000, 2000 * 2 ** Math.max(0, intento - 1));
}

interface SuscribirPedidosOpciones {
  // Filtro de Postgres (server-side, no post-filtrado en el cliente) — ej.
  // "usuario_id=eq.<uuid>" o "negocio_id=eq.<uuid>". Nunca se suscribe sin
  // filtro: eso traería cambios de pedidos de otros usuarios/negocios.
  filtro: string;
  nombreCanal: string;
  onEvento: (evento: PedidoRealtimeEvento) => void;
  onEstadoConexion?: (conectado: boolean) => void;
  cliente?: ClienteRealtime;
}

// Suscribe un único canal a los cambios de `pedidos` que cumplen `filtro`.
// Devuelve una función de limpieza — llamarla siempre en el cleanup del efecto
// que la invoque (logout, cambio de usuario, o desmontaje del provider).
export function suscribirPedidosPorFiltro(opciones: SuscribirPedidosOpciones): () => void {
  const { filtro, nombreCanal, onEvento, onEstadoConexion, cliente = supabase } = opciones;
  const dedup = crearDeduplicador();
  let montado = true;
  let intento = 0;
  let reintentoTimer: ReturnType<typeof setTimeout> | null = null;
  let canalActual: ReturnType<ClienteRealtime['channel']> | null = null;

  function limpiarCanalActual() {
    if (canalActual) {
      cliente.removeChannel(canalActual);
      canalActual = null;
    }
  }

  function conectar() {
    if (!montado) return;
    const canal = cliente
      .channel(nombreCanal)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos', filter: filtro },
        (payload: any) => {
          // Nunca actualizar estado de React después de que el consumidor se
          // desmontó/cambió de sesión — el flag `montado` lo garantiza.
          if (!montado) return;
          const clave = construirClaveDedup(payload);
          if (dedup.yaVisto(clave)) return;
          const evento = mapearEventoPedido(payload);
          if (evento) onEvento(evento);
        }
      )
      .subscribe((status: string) => {
        if (!montado) return;
        if (status === 'SUBSCRIBED') {
          intento = 0;
          onEstadoConexion?.(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          onEstadoConexion?.(false);
          intento += 1;
          if (reintentoTimer) clearTimeout(reintentoTimer);
          reintentoTimer = setTimeout(() => {
            if (!montado) return;
            limpiarCanalActual();
            conectar();
          }, calcularBackoffMs(intento));
        }
      });
    canalActual = canal;
  }

  conectar();

  return () => {
    montado = false;
    if (reintentoTimer) clearTimeout(reintentoTimer);
    limpiarCanalActual();
  };
}
