// Control del timbre de cocina, pintado SOLO en app/restaurante/pedidos.tsx.
// El timbre en sí corre en el layout (src/context/TimbreCocinaContext.tsx) y
// suena en cualquier pestaña; aquí solo se controla:
//
//   · "🔔 Timbre de cocina: Activado / Silenciado" — alterna la preferencia.
//   · Con pedidos por aceptar y el timbre sin poder sonar (silenciado o el
//     navegador aún sin gesto), un banner rojo pulsable lo activa: el toque es
//     el gesto que el navegador exige para reproducir audio.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { EstadoTimbreCocina } from '@/hooks/use-timbre-cocina';

const GOLD = '#C8960C';

export function textoAvisoPendientes(pendientes: number): string {
  return pendientes > 1
    ? `⚠️ ${pendientes} pedidos pendientes. Toca aquí para activar el timbre de cocina`
    : '⚠️ Nuevo pedido pendiente. Toca aquí para activar el timbre de cocina';
}

export default function BarraTimbreCocina({ timbre }: { timbre: EstadoTimbreCocina }) {
  const { armado, hayPendientes, pendientes, sonando, activarTimbre, alternarTimbre } = timbre;

  return (
    <View style={s.root}>
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
          <Text style={s.sonando} accessibilityLiveRegion="polite">
            🛎️ Sonando · {pendientes} por aceptar
          </Text>
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
  root:           { paddingHorizontal: 14, paddingTop: 10, gap: 8 },
  fila:           { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  control:        { borderRadius: 50, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5 },
  controlOn:      { backgroundColor: '#FEF7E0', borderColor: GOLD },
  controlOff:     { backgroundColor: '#FFFFFF', borderColor: '#D1D5DB' },
  controlText:    { fontSize: 13, fontWeight: '800' },
  controlTextOn:  { color: '#8A6508' },
  controlTextOff: { color: '#4B5563' },
  sonando:        { fontSize: 12, fontWeight: '800', color: '#DC2626' },
  banner:         { backgroundColor: '#DC2626', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  bannerText:     { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
});
