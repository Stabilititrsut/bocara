// Resolver único de navegación segura, compartido por TODAS las fuentes que
// pueden querer llevar al usuario a una pantalla a partir de un pedido:
//   · push notification (tap, foreground, cold start) — app/_layout.tsx
//   · Supabase Realtime (cuando corresponda reaccionar navegando, no solo
//     refrescando datos en la pantalla actual) — src/context/RealtimeContext.tsx
//   · deep link — cualquier ruta que reciba un payload externo con la misma forma
//
// Principio único, no negociable: el payload (`data`) puede venir de un
// tercero (push) o de una fila de BD (realtime) — nunca es confiable como
// fuente de la RUTA en sí. `data.route`/`data.screen` NUNCA se usan para
// construir la navegación; solo se usan como pistas opcionales para decidir
// ENTRE rutas ya fijas del rol activo. La única fuente de verdad de "a qué
// sección puede ir este usuario" es `rol`, que sale de la sesión autenticada
// vigente — nunca del payload.
export interface PayloadNotificacion {
  pedidoId?: unknown;
  negocioId?: unknown;
  screen?: unknown;
  tipo?: unknown; // event_type del catálogo de eventos del backend, si viene
}

// Valida la forma mínima sin lanzar — un payload corrupto/ajeno no debe
// tumbar el listener de notificaciones ni el de realtime.
export function validarPayloadNotificacion(data: unknown): PayloadNotificacion {
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;
  return {
    pedidoId: typeof d.pedidoId === 'string' && d.pedidoId.length > 0 ? d.pedidoId : undefined,
    negocioId: typeof d.negocioId === 'string' && d.negocioId.length > 0 ? d.negocioId : undefined,
    screen: typeof d.screen === 'string' ? d.screen : undefined,
    tipo: typeof d.tipo === 'string' ? d.tipo : undefined,
  };
}

const ROLES_VALIDOS = new Set(['cliente', 'restaurante', 'admin']);

// Convierte el payload `data` de un evento de pedido (push o realtime) en una
// ruta segura para el rol activo. Nunca confía en `data.screen` a ciegas: si
// no corresponde al rol de la sesión activa (ej. el dispositivo cambió de
// cuenta entre el envío y el tap), cae al destino por defecto de ese rol en
// vez de intentar montar una pantalla ajena. Sin rol (sesión no cargada
// todavía) devuelve null — el llamador debe guardar el intento como pendiente
// y reintentar cuando la sesión exista (ver pendingNotifRef en _layout.tsx).
export function resolverRutaNotificacion(dataCruda: unknown, rol?: string | null): string | null {
  if (!rol || !ROLES_VALIDOS.has(rol)) return null;
  const { pedidoId } = validarPayloadNotificacion(dataCruda);

  if (rol === 'cliente') return '/(tabs)/pedidos';
  if (rol === 'restaurante') return pedidoId ? '/restaurante/pedidos' : '/restaurante';
  return '/admin'; // rol === 'admin' — único caso restante tras el guard de arriba
}
