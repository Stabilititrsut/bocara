// Barra superior del panel del restaurante (app/restaurante/_layout.tsx) con el
// control del timbre de cocina (hooks/use-timbre-cocina.ts):
//
//   · "🔔 Timbre de cocina: Activado / Silenciado" — alterna la preferencia.
//   · Con pedidos por aceptar y el timbre sin poder sonar (silenciado o el
//     navegador aún sin gesto), un banner rojo pulsable lo activa.
//   · Mientras suena, un acceso directo a Pedidos para aceptarlos.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EstadoTimbreCocina } from '@/hooks/use-timbre-cocina';

const PRIMARY = '#0A2A2A';
const GOLD    = '#C8960C';

export function textoAvisoPendientes(pendientes: number): string {
  return pendientes > 1
    ? `⚠️ ${pendientes} pedidos pendientes. Toca aquí para activar el timbre de cocina`
    : '⚠️ Nuevo pedido pendiente. Toca aquí para activar el timbre de cocina';
}

export default function BarraTimbreCocina({ timbre, onVerPedidos }: {
  timbre: EstadoTimbreCocina;
  onVerPedidos: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { armado, hayPendientes, pendientes, sonando, activarTimbre, alternarTimbre } = timbre;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.fila}>
        <TouchableOpacity
          style={[s.control, armado ? s.controlOn : s.controlOff]}
          onPress={alternarTimbre}
          accessibilityRole="switch"
          accessibilityState={{ checked: armado }}
          accessibilityLabel={`Timbre de cocina: ${armado ? 'Activado' : 'Silenciado'}`}
          testID="timbre-cocina-control"
        >
          <Text style={[s.controlText, armado ? s.controlTextOn : s.controlTextOff]}>
            {armado ? '🔔' : '🔕'} Timbre de cocina: {armado ? 'Activado' : 'Silenciado'}
          </Text>
        </TouchableOpacity>
        {sonando && (
          <TouchableOpacity style={s.verPedidos} onPress={onVerPedidos} accessibilityRole="button">
            <Text style={s.verPedidosText}>
              🛎️ {pendientes} por aceptar ›
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {hayPendientes && !armado && (
        <TouchableOpacity
          style={s.banner}
          onPress={activarTimbre}
          accessibilityRole="button"
          testID="timbre-cocina-banner"
        >
          <Text style={s.bannerText}>{textoAvisoPendientes(pendientes)}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root:           { backgroundColor: PRIMARY },
  fila:           { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  control:        { flexShrink: 1, borderRadius: 50, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  controlOn:      { backgroundColor: 'rgba(200,150,12,0.15)', borderColor: GOLD },
  controlOff:     { backgroundColor: 'transparent', borderColor: 'rgba(255,255,255,0.3)' },
  controlText:    { fontSize: 12, fontWeight: '800' },
  controlTextOn:  { color: GOLD },
  controlTextOff: { color: 'rgba(255,255,255,0.7)' },
  verPedidos:     { marginLeft: 'auto', backgroundColor: '#DC2626', borderRadius: 50, paddingHorizontal: 12, paddingVertical: 6 },
  verPedidosText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  banner:         { backgroundColor: '#DC2626', paddingHorizontal: 14, paddingVertical: 12 },
  bannerText:     { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
});
