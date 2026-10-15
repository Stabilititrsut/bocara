// Avisos en pantalla + sonido para el CLIENTE:
//   · cada cambio de fase de su pedido (confirmado, en preparación, listo,
//     entregado, cancelado) — el backend deja una fila en `notificaciones`;
//   · Tiempo limitado recién publicado (fila `nueva_bolsa` en la bandeja);
//   · ofertas activas (Promoción / Tiempo limitado) cerca de su ubicación.
//
// Realtime está bloqueado por RLS en producción, así que la vía funcional es
// el polling de la bandeja (ver components/AvisosCliente.tsx).
//
// Sonido:
//   · Web: beeps con Web Audio (sonarAvisoWeb) + notificación del navegador
//     (window.Notification) si el usuario dio permiso.
//   · Nativo: el push remoto ya suena (setNotificationHandler con
//     shouldPlaySound: true en app/_layout.tsx). Si este dispositivo no tiene
//     token de push, o el aviso nace en el cliente (ofertas cercanas), se
//     programa una notificación local inmediata con sonido.
import { Platform, Vibration } from 'react-native';
import { sonarAvisoWeb, PATRON_VIBRACION } from './alertaPedido';
import { pushTokenActual } from '../services/pushToken';

let Notifications: any = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Notifications = require('expo-notifications');
  } catch { }
}

// Tipos de la bandeja que merecen aviso sonoro en el cliente.
export const TIPOS_AVISO_CLIENTE = new Set([
  'pago_confirmado', 'pedido_en_preparacion', 'pedido_listo', 'bolsa_recogida', 'pedido_cancelado',
  'nueva_bolsa',
]);

// Solo suenan avisos recientes: una fila vieja sin leer (p. ej. de ayer) que
// aparece al reabrir la app no debe sonar como si fuera nueva.
export const VENTANA_AVISO_MS = 30 * 60 * 1000;

export type AvisoBandeja = {
  id: string; tipo?: string; titulo?: string; cuerpo?: string; leida?: boolean;
  data?: any; created_at?: string; creado_en?: string;
};

// `vistos` = ids ya conocidos; null en la primera carga (nunca suena: lo que
// ya estaba al abrir la app no es "nuevo"). Devuelve los nuevos, más recientes
// primero, y el conjunto actualizado.
export function detectarAvisosNuevos(
  vistos: Set<string> | null,
  notifs: AvisoBandeja[],
  ahora = Date.now(),
): { nuevos: AvisoBandeja[]; vistos: Set<string> } {
  const actualizados = new Set(vistos ?? []);
  for (const n of notifs) if (n?.id) actualizados.add(String(n.id));
  if (vistos === null) return { nuevos: [], vistos: actualizados };
  const nuevos = notifs
    .filter((n) => n?.id && !vistos.has(String(n.id)) && !n.leida && TIPOS_AVISO_CLIENTE.has(n.tipo || ''))
    .filter((n) => {
      const t = new Date(n.created_at || n.creado_en || '').getTime();
      return Number.isNaN(t) || ahora - t <= VENTANA_AVISO_MS;
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { nuevos, vistos: actualizados };
}

// ── Ofertas cercanas ──────────────────────────────────────────────────────────

export const RADIO_OFERTA_CERCANA_KM = 2;
// Un mismo restaurante no vuelve a avisar en este lapso.
export const ENFRIAMIENTO_OFERTA_MS = 12 * 60 * 60 * 1000;

export type OfertaCercana = { negocioId: string; nombre: string; bolsaId: string; tipo: 'promocion' | 'tiempo_limitado'; distanciaKm: number };

// `bolsas` = respuesta de GET /bolsas?lat&lng (con distancia_km y negocios).
// `avisados` = { negocioId: epoch ms del último aviso }. Una oferta por
// restaurante, el más cercano primero; Tiempo limitado gana sobre Promoción.
export function detectarOfertasCercanas(
  bolsas: any[],
  avisados: Record<string, number>,
  ahora = Date.now(),
  radioKm = RADIO_OFERTA_CERCANA_KM,
): OfertaCercana[] {
  const porNegocio = new Map<string, OfertaCercana>();
  for (const b of bolsas || []) {
    const negocioId = b?.negocio_id ?? b?.negocios?.id;
    const d = Number(b?.distancia_km);
    if (!negocioId || !b?.id || b.distancia_km == null || !Number.isFinite(d) || d > radioKm) continue;
    if (Number(b.cantidad_disponible ?? 1) <= 0) continue;
    const ultimo = avisados[negocioId];
    if (ultimo && ahora - ultimo < ENFRIAMIENTO_OFERTA_MS) continue;
    const tipo: OfertaCercana['tipo'] = b.tipo === 'cupon' ? 'promocion' : 'tiempo_limitado';
    const previa = porNegocio.get(negocioId);
    if (previa && !(previa.tipo === 'promocion' && tipo === 'tiempo_limitado')) continue;
    porNegocio.set(negocioId, { negocioId, nombre: b.negocios?.nombre || 'Un restaurante', bolsaId: b.id, tipo, distanciaKm: d });
  }
  return [...porNegocio.values()].sort((a, b) => a.distanciaKm - b.distanciaKm);
}

export function textoOfertaCercana(o: OfertaCercana): { titulo: string; cuerpo: string } {
  return {
    titulo: o.tipo === 'tiempo_limitado' ? '⏱️ Tiempo limitado cerca de ti' : '🏷️ Promoción cerca de ti',
    cuerpo: `${o.nombre} tiene ofertas activas a ${o.distanciaKm < 1 ? `${Math.round(o.distanciaKm * 1000)} m` : `${o.distanciaKm.toFixed(1)} km`}.`,
  };
}

// ── Sonido / notificación del sistema ────────────────────────────────────────

// Web: pide permiso de notificaciones del navegador con el primer gesto del
// usuario (los navegadores ignoran el pedido sin gesto). Devuelve la limpieza.
export function pedirPermisoNotificacionWeb(): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const N = (window as any).Notification;
  if (!N || N.permission !== 'default') return () => {};
  const pedir = () => {
    quitar();
    try { N.requestPermission?.(); } catch { }
  };
  const quitar = () => {
    document.removeEventListener('pointerdown', pedir);
    document.removeEventListener('keydown', pedir);
  };
  document.addEventListener('pointerdown', pedir);
  document.addEventListener('keydown', pedir);
  return quitar;
}

// `local`: el aviso nació en el cliente (no hay push remoto que suene por él).
export async function emitirAvisoCliente(
  { titulo, cuerpo, data, etiqueta }: { titulo: string; cuerpo: string; data?: any; etiqueta?: string },
  { local = false }: { local?: boolean } = {},
) {
  if (Platform.OS === 'web') {
    await sonarAvisoWeb();
    try {
      const N = (window as any).Notification;
      if (N && N.permission === 'granted') {
        new N(titulo, { body: cuerpo, icon: '/favicon-192.png', tag: etiqueta, renotify: true });
      }
    } catch { }
    return;
  }
  try { Vibration.vibrate(PATRON_VIBRACION); } catch { }
  if (!local && pushTokenActual()) return; // el push remoto ya suena
  try {
    await Notifications?.scheduleNotificationAsync({
      content: { title: titulo, body: cuerpo, sound: 'default', data: data || {} },
      trigger: Platform.OS === 'android' ? { channelId: 'pedidos' } : null,
    });
  } catch { }
}
