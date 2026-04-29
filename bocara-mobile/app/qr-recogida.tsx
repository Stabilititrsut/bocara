import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Colors } from '@/constants/Colors';

export default function QrRecogidaScreen() {
  const { codigo, tipo } = useLocalSearchParams<{ codigo: string; tipo: string; pedidoId: string }>();
  const router = useRouter();
  const esEnvio = tipo === 'envio';

  return (
    <SafeAreaView style={s.root}>
      <View style={s.container}>
        {/* Icono de éxito */}
        <View style={s.successIcon}>
          <Text style={{ fontSize: 48 }}>✅</Text>
        </View>
        <Text style={s.title}>¡Pago confirmado!</Text>
        <Text style={s.subtitle}>
          {esEnvio
            ? 'Tu pedido está en camino. Te notificaremos cuando salga.'
            : 'Muestra este código al recoger tu bolsa'}
        </Text>

        {!esEnvio && (
          <>
            {/* Código QR simulado */}
            <View style={s.qrBox}>
              <View style={s.qrFrame}>
                {/* Patrón visual tipo QR */}
                {Array.from({ length: 7 }).map((_, row) => (
                  <View key={row} style={s.qrRow}>
                    {Array.from({ length: 7 }).map((_, col) => (
                      <View
                        key={col}
                        style={[
                          s.qrCell,
                          ((row < 3 && col < 3) || (row < 3 && col > 3) || (row > 3 && col < 3) ||
                            (Math.random() > 0.4)) && s.qrCellDark,
                        ]}
                      />
                    ))}
                  </View>
                ))}
              </View>
              <Text style={s.codigo}>{codigo}</Text>
            </View>

            <View style={s.instrucciones}>
              <Text style={s.instruccionTitle}>¿Cómo recoger?</Text>
              <Text style={s.instruccionItem}>1. Ve al restaurante en el horario indicado</Text>
              <Text style={s.instruccionItem}>2. Muestra este código o el número al personal</Text>
              <Text style={s.instruccionItem}>3. ¡Disfruta tu bolsa rescatada! 🌱</Text>
            </View>
          </>
        )}

        {esEnvio && (
          <View style={s.envioCard}>
            <Text style={{ fontSize: 40 }}>🏍️</Text>
            <Text style={s.envioTitle}>Tu pedido está siendo preparado</Text>
            <Text style={s.envioText}>Recibirás notificaciones sobre el estado de tu entrega. Tiempo estimado: 30-60 minutos.</Text>
          </View>
        )}

        {/* Impacto */}
        <View style={s.impact}>
          <Text style={s.impactTitle}>🌿 ¡Gracias por rescatar comida!</Text>
          <Text style={s.impactText}>Contribuiste a reducir el desperdicio de alimentos en Guatemala</Text>
        </View>

        <TouchableOpacity style={s.btnPedidos} onPress={() => router.replace('/(tabs)/pedidos')}>
          <Text style={s.btnPedidosText}>Ver mis pedidos</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btnHome} onPress={() => router.replace('/(tabs)/')}>
          <Text style={s.btnHomeText}>Seguir explorando</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  container: { flex: 1, padding: 24, alignItems: 'center' },
  successIcon: { backgroundColor: Colors.greenLight, borderRadius: 50, width: 96, height: 96, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  title: { fontSize: 26, fontWeight: '900', color: Colors.brown, marginTop: 16, textAlign: 'center' },
  subtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
  qrBox: { alignItems: 'center', marginTop: 24 },
  qrFrame: { backgroundColor: Colors.white, padding: 16, borderRadius: 16, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12, marginBottom: 12 },
  qrRow: { flexDirection: 'row' },
  qrCell: { width: 12, height: 12, margin: 1, backgroundColor: Colors.white, borderRadius: 1 },
  qrCellDark: { backgroundColor: Colors.brown },
  codigo: { fontSize: 28, fontWeight: '900', color: Colors.brown, letterSpacing: 4, marginTop: 8 },
  instrucciones: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, width: '100%', marginTop: 16 },
  instruccionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 10 },
  instruccionItem: { fontSize: 13, color: Colors.textSecondary, marginBottom: 6, lineHeight: 20 },
  envioCard: { backgroundColor: Colors.white, borderRadius: 20, padding: 24, alignItems: 'center', marginTop: 20, width: '100%', gap: 8 },
  envioTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown, textAlign: 'center' },
  envioText: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  impact: { backgroundColor: Colors.greenLight, borderRadius: 16, padding: 16, width: '100%', marginTop: 16, alignItems: 'center' },
  impactTitle: { fontSize: 14, fontWeight: '800', color: Colors.green, marginBottom: 4 },
  impactText: { fontSize: 13, color: Colors.brown, textAlign: 'center' },
  btnPedidos: { backgroundColor: Colors.orange, borderRadius: 14, padding: 14, width: '100%', alignItems: 'center', marginTop: 20 },
  btnPedidosText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnHome: { borderWidth: 2, borderColor: Colors.brown, borderRadius: 14, padding: 14, width: '100%', alignItems: 'center', marginTop: 10 },
  btnHomeText: { color: Colors.brown, fontWeight: '700', fontSize: 15 },
});
