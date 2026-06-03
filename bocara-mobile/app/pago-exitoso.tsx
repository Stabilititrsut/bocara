import { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/Colors';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';

export default function PagoExitosoScreen() {
  const router = useRouter();
  const { pedidoId, codigo, tipo } = useLocalSearchParams<{ pedidoId?: string; codigo?: string; tipo?: string }>();
  const { limpiar } = useCart();
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limpiadoRef = useRef(false);

  useEffect(() => {
    if (!pedidoId) return;

    let intentos = 0;
    pollingRef.current = setInterval(async () => {
      intentos++;
      try {
        const res = await pagosAPI.estado(pedidoId);
        const { estado_pago, estado, codigo_recogida } = res.data;

        if (estado_pago === 'pagado' && estado === 'confirmado') {
          clearInterval(pollingRef.current!);
          if (!limpiadoRef.current) { limpiadoRef.current = true; limpiar(); }
          router.replace({
            pathname: '/qr-recogida',
            params: { codigo: codigo_recogida || codigo, pedidoId, tipo: tipo || 'recogida' },
          } as any);
        }
      } catch { /* webhook puede confirmar más tarde */ }

      if (intentos >= 15) clearInterval(pollingRef.current!);
    }, 3000);

    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [pedidoId]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.iconBox}>
        <Ionicons name="checkmark-circle" size={80} color={Colors.green} />
      </View>

      <Text style={s.title}>¡Pago recibido!</Text>
      <Text style={s.sub}>Estamos verificando tu pedido con Cubo Pago.</Text>
      <Text style={s.hint}>Esto puede tomar unos segundos.</Text>

      <ActivityIndicator color={Colors.orange} size="small" style={{ marginTop: 24 }} />

      <TouchableOpacity style={s.btn} onPress={() => {
        if (pollingRef.current) clearInterval(pollingRef.current);
        router.replace('/(tabs)/pedidos' as any);
      }}>
        <Ionicons name="receipt-outline" size={18} color={Colors.white} />
        <Text style={s.btnText}>Ver mis pedidos</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.link} onPress={() => {
        if (pollingRef.current) clearInterval(pollingRef.current);
        router.replace('/(tabs)/index' as any);
      }}>
        <Text style={s.linkText}>Volver al inicio</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center', padding: 32 },
  iconBox: { marginBottom: 24 },
  title:   { fontSize: 28, fontWeight: '900', color: Colors.brown, marginBottom: 10, textAlign: 'center' },
  sub:     { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', lineHeight: 24 },
  hint:    { fontSize: 13, color: Colors.textLight, textAlign: 'center', marginTop: 6 },
  btn:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.orange, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 28, marginTop: 32 },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  link:    { marginTop: 16 },
  linkText:{ color: Colors.textLight, fontSize: 14 },
});
