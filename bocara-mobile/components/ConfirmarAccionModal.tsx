import type { ReactNode } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator,
} from 'react-native';

// Confirmación de acciones del panel Admin. Sustituye a Alert.alert con
// botones, que en web no muestra nada (react-native-web lo implementa vacío).
// El error real del backend se pinta dentro del modal, que queda abierto.

type Tono = 'peligro' | 'exito' | 'neutro';
type Tema = 'oscuro' | 'claro';

type Props = {
  visible: boolean;
  titulo: string;
  mensaje: string;
  detalle?: string;
  textoConfirmar: string;
  tono?: Tono;
  tema?: Tema;
  procesando?: boolean;
  error?: string;
  onConfirmar: () => void;
  onCancelar: () => void;
  children?: ReactNode;
};

const TONOS: Record<Tono, { bg: string; text: string }> = {
  peligro: { bg: '#991B1B', text: '#FFFFFF' },
  exito:   { bg: '#065F46', text: '#FFFFFF' },
  neutro:  { bg: '#1A3C3C', text: '#FFFFFF' },
};

const TEMAS: Record<Tema, { card: string; borde: string; titulo: string; texto: string; suave: string; error: string }> = {
  oscuro: { card: '#1E293B', borde: '#334155', titulo: '#FFFFFF', texto: '#94A3B8', suave: '#64748B', error: '#FCA5A5' },
  claro:  { card: '#FFFFFF', borde: '#E5E7EB', titulo: '#111827', texto: '#374151', suave: '#6B7280', error: '#DC2626' },
};

export default function ConfirmarAccionModal({
  visible, titulo, mensaje, detalle, textoConfirmar, tono = 'peligro', tema = 'oscuro',
  procesando = false, error, onConfirmar, onCancelar, children,
}: Props) {
  const t = TEMAS[tema];
  const c = TONOS[tono];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!procesando) onCancelar(); }}>
      <View style={s.overlay}>
        <View style={[s.card, { backgroundColor: t.card, borderColor: t.borde }]}>
          <Text style={[s.titulo, { color: t.titulo }]}>{titulo}</Text>
          <Text style={[s.mensaje, { color: t.texto }]}>{mensaje}</Text>
          {detalle ? <Text style={[s.detalle, { color: t.suave }]}>{detalle}</Text> : null}
          {children}
          {error ? <Text style={[s.error, { color: t.error }]} accessibilityRole="alert">⚠️ {error}</Text> : null}
          <View style={s.acciones}>
            <TouchableOpacity
              style={[s.cancelar, { borderColor: t.borde }]}
              onPress={onCancelar}
              disabled={procesando}
              accessibilityRole="button"
            >
              <Text style={[s.cancelarText, { color: t.suave }]}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.confirmar, { backgroundColor: c.bg }, procesando && s.off]}
              onPress={onConfirmar}
              disabled={procesando}
              accessibilityRole="button"
            >
              {procesando
                ? <ActivityIndicator color={c.text} size="small" />
                : <Text style={[s.confirmarText, { color: c.text }]}>{textoConfirmar}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Aviso de éxito/error de la última acción, para pintar en la pantalla.
export function AvisoAccion({
  aviso, onCerrar, tema = 'oscuro',
}: { aviso: { tipo: 'exito' | 'error'; texto: string } | null; onCerrar: () => void; tema?: Tema }) {
  if (!aviso) return null;
  const exito = aviso.tipo === 'exito';
  const colores = tema === 'oscuro'
    ? (exito ? { bg: '#022C22', borde: '#065F46', text: '#6EE7B7' } : { bg: '#450A0A', borde: '#991B1B', text: '#FCA5A5' })
    : (exito ? { bg: '#F0FDF4', borde: '#BBF7D0', text: '#15803D' } : { bg: '#FEF2F2', borde: '#FECACA', text: '#DC2626' });
  return (
    <TouchableOpacity
      style={[s.aviso, { backgroundColor: colores.bg, borderColor: colores.borde }]}
      onPress={onCerrar}
      accessibilityRole="alert"
    >
      <Text style={[s.avisoText, { color: colores.text }]}>{exito ? '✓ ' : '⚠️ '}{aviso.texto}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card:     { borderRadius: 20, padding: 24, borderWidth: 1 },
  titulo:   { fontSize: 18, fontWeight: '900', marginBottom: 6 },
  mensaje:  { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  detalle:  { fontSize: 12, lineHeight: 18, marginBottom: 16 },
  error:    { fontSize: 13, fontWeight: '600', marginBottom: 12 },
  acciones: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelar: { flex: 1, borderWidth: 1.5, borderRadius: 12, padding: 12, alignItems: 'center' },
  cancelarText: { fontWeight: '600', fontSize: 14 },
  confirmar: { flex: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  confirmarText: { fontWeight: '800', fontSize: 14 },
  off:      { opacity: 0.6 },
  aviso:    { marginHorizontal: 16, marginTop: 12, borderRadius: 12, padding: 12, borderWidth: 1 },
  avisoText: { fontWeight: '700', fontSize: 13 },
});
