import { useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

export default function PagoRetorno() {
  const { pedidoId } = useLocalSearchParams<{ pedidoId?: string }>();
  const { limpiar } = useCart();
  const intentosRef = useRef(0);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    console.log('[PAGO RETORNO] pedidoId:', pedidoId);
    if (!pedidoId) {
      router.replace('/(tabs)/pedidos' as any);
      return;
    }
    verificar(pedidoId);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [pedidoId]);

  async function verificar(id: string) {
    intentosRef.current++;
    if (intentosRef.current > 10) {
      console.log('[PAGO RETORNO] timeout tras 10 intentos → pedidos');
      router.replace('/(tabs)/pedidos' as any);
      return;
    }

    try {
      const res = await pagosAPI.estado(id);
      const { estado_pago, estado, codigo_recogida, tipo_entrega } = res.data;
      console.log('[PAGO RETORNO] intento', intentosRef.current, '| estado_pago:', estado_pago, '| estado:', estado);

      if (estado_pago === 'pagado' && estado === 'confirmado') {
        limpiar();
        router.replace({
          pathname: '/pago-exitoso',
          params: { pedidoId: id, status: 'SUCCEEDED', codigo_recogida, tipo_entrega },
        } as any);
      } else if (estado_pago === 'fallido' || estado === 'cancelado') {
        router.replace({
          pathname: '/pago-exitoso',
          params: { pedidoId: id, status: 'FAILED' },
        } as any);
      } else {
        timerRef.current = setTimeout(() => verificar(id), 3000);
      }
    } catch {
      timerRef.current = setTimeout(() => verificar(id), 3000);
    }
  }

  return (
    <View style={s.root}>
      <ActivityIndicator size="large" color={Colors.primary} />
      <Text style={s.text}>Confirmando tu pago...</Text>
      <Text style={s.sub}>Esto toma unos segundos</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface, gap: 12 },
  text: { fontSize: 18, fontWeight: '800', color: Colors.primary },
  sub:  { fontSize: 13, color: Colors.textSecondary },
});
