import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

const MAX_INTENTOS = 10;
const POLL_MS = 3000;
type Vista = 'verificando' | 'timeout' | 'error';
export const mensajeHttp = (status?: number) => ({ 400: 'La respuesta de pago no es válida. Regresa al carrito.', 401: 'Tu sesión expiró. Inicia sesión de nuevo para ver el estado de tu pago.', 403: 'Este pedido no pertenece a tu cuenta.', 404: 'No encontramos este pedido.', 409: 'El estado del pedido cambió. Actualiza tus pedidos.', 500: 'El servidor no pudo confirmar el pago.', 502: 'El servidor no está disponible en este momento.', 503: 'El servicio no está disponible todavía.', 504: 'El servidor tardó demasiado en responder.' }[status || 0] || 'No pudimos verificar el pago.');

export default function PagoRetorno() {
  const { pedidoId } = useLocalSearchParams<{ pedidoId?: string }>();
  const { limpiar } = useCart();
  const intentos = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null), navegando = useRef(false);
  const [vista, setVista] = useState<Vista>('verificando');
  const [mensaje, setMensaje] = useState('Confirmando tu pago con Bocara...');
  const detener = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const verificar = useCallback(async (id: string) => {
    if (navegando.current || timer.current) return;
    if (++intentos.current > MAX_INTENTOS) { setVista('timeout'); setMensaje('La confirmación está tardando. El backend sigue siendo la fuente de verdad.'); return; }
    try {
      const { data } = await pagosAPI.estado(id);
      if (data.estado_pago === 'pagado' && data.estado === 'confirmado') { navegando.current = true; detener(); limpiar(); router.replace({ pathname: '/pago-exitoso', params: { pedidoId: id, status: 'SUCCEEDED', codigo_recogida: data.codigo_recogida, tipo_entrega: data.tipo_entrega } } as any); return; }
      if (data.estado_pago === 'fallido' || data.estado === 'cancelado') { navegando.current = true; detener(); router.replace({ pathname: '/pago-exitoso', params: { pedidoId: id, status: 'FAILED' } } as any); return; }
      timer.current = setTimeout(() => { timer.current = null; void verificar(id); }, POLL_MS);
    } catch (error: any) { detener(); setVista('error'); setMensaje(mensajeHttp(error?.status)); }
  }, [detener, limpiar]);
  useEffect(() => { if (!pedidoId) { setVista('error'); setMensaje('Falta el identificador del pedido.'); return; } void verificar(pedidoId); return detener; }, [pedidoId, verificar, detener]);
  const reintentar = () => { if (!pedidoId) return; detener(); intentos.current = 0; setVista('verificando'); setMensaje('Confirmando tu pago con Bocara...'); void verificar(pedidoId); };
  if (vista !== 'verificando') return <View style={s.root}><Text style={s.title}>{vista === 'timeout' ? 'Confirmación pendiente' : 'No pudimos verificar el pago'}</Text><Text style={s.sub}>{mensaje}</Text><TouchableOpacity style={s.btn} onPress={reintentar}><Text style={s.btnText}>Reintentar</Text></TouchableOpacity><TouchableOpacity onPress={() => router.replace('/(tabs)/pedidos' as any)}><Text style={s.link}>Ver mis pedidos</Text></TouchableOpacity></View>;
  return <View style={s.root}><ActivityIndicator size="large" color={Colors.primary} /><Text style={s.title}>Confirmando tu pago...</Text><Text style={s.sub}>{mensaje}</Text></View>;
}
const s = StyleSheet.create({ root: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, backgroundColor: Colors.surface, gap: 14 }, title: { fontSize: 18, fontWeight: '800', color: Colors.primary, textAlign: 'center' }, sub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' }, btn: { backgroundColor: Colors.primary, padding: 13, borderRadius: 10 }, btnText: { color: '#fff', fontWeight: '800' }, link: { color: Colors.primary, fontWeight: '700' } });
