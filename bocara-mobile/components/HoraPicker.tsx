// Selector visual de hora (HH:MM, 24 horas) — reemplaza el input de texto
// libre en Crear/Editar Promoción y Tiempo limitado (restaurante/bolsas.tsx).
// El usuario nunca escribe la hora a mano: toca el campo, elige hora y
// minuto exactos (sin intervalos de 15/30 min — los 60 minutos están
// disponibles) y confirma. Solo usa primitivos de react-native (Modal, View,
// Text, TouchableOpacity, ScrollView) para funcionar igual en web y nativo
// sin depender de ninguna librería nueva.
import { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Colors } from '@/constants/Colors';

type Props = {
  label: string;
  // Formato canónico 'HH:MM'. '' si todavía no hay selección.
  value: string;
  onChange: (hhmm: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

const HORAS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTOS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

function aNumeros(value: string): [number, number] {
  const m = /^(\d{1,2}):(\d{1,2})/.exec(value || '');
  if (!m) return [18, 0];
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10) || 0));
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10) || 0));
  return [h, mi];
}

export default function HoraPicker({ label, value, onChange, placeholder = 'Seleccionar hora', disabled }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [hora, setHora] = useState(0);
  const [minuto, setMinuto] = useState(0);

  function abrir() {
    if (disabled) return;
    const [h, m] = aNumeros(value);
    setHora(h);
    setMinuto(m);
    setAbierto(true);
  }

  function confirmar() {
    onChange(`${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`);
    setAbierto(false);
  }

  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={st.label}>{label}</Text>
      <TouchableOpacity
        style={[st.boton, disabled && st.botonDeshabilitado]}
        onPress={abrir}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value || placeholder}`}
      >
        <Text style={[st.botonTexto, !value && st.botonPlaceholder]}>{value || placeholder}</Text>
        <Text style={st.botonIcono}>🕐</Text>
      </TouchableOpacity>

      <Modal visible={abierto} transparent animationType="slide" onRequestClose={() => setAbierto(false)}>
        <View style={st.overlay}>
          <View style={st.card}>
            <Text style={st.titulo}>{label}</Text>
            <View style={st.columnas}>
              <Columna valores={HORAS} seleccionado={hora} onSeleccionar={setHora} />
              <Text style={st.separador}>:</Text>
              <Columna valores={MINUTOS} seleccionado={minuto} onSeleccionar={setMinuto} />
            </View>
            <View style={st.acciones}>
              <TouchableOpacity style={st.btnCancelar} onPress={() => setAbierto(false)}>
                <Text style={st.btnCancelarTexto}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={st.btnConfirmar} onPress={confirmar}>
                <Text style={st.btnConfirmarTexto}>Listo</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Columna({ valores, seleccionado, onSeleccionar }: {
  valores: string[]; seleccionado: number; onSeleccionar: (n: number) => void;
}) {
  return (
    <ScrollView style={st.columna} showsVerticalScrollIndicator={false}>
      {valores.map((texto, i) => (
        <TouchableOpacity
          key={texto}
          style={[st.celda, i === seleccionado && st.celdaActiva]}
          onPress={() => onSeleccionar(i)}
        >
          <Text style={[st.celdaTexto, i === seleccionado && st.celdaTextoActivo]}>{texto}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6, marginTop: 4 },
  boton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 12, marginBottom: 4,
  },
  botonDeshabilitado: { opacity: 0.5 },
  botonTexto: { fontSize: 14, color: Colors.textPrimary, fontWeight: '700' },
  botonPlaceholder: { color: Colors.textLight, fontWeight: '400' },
  botonIcono: { fontSize: 16 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: {
    backgroundColor: Colors.white, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 20, paddingBottom: 28,
  },
  titulo: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 14, textAlign: 'center' },
  columnas: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', height: 220 },
  columna: { height: 220, width: 72 },
  separador: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginHorizontal: 6 },
  celda: { paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  celdaActiva: { backgroundColor: Colors.aqua },
  celdaTexto: { fontSize: 18, color: Colors.textSecondary, fontWeight: '600' },
  celdaTextoActivo: { color: Colors.white, fontWeight: '900' },
  acciones: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btnCancelar: { flex: 1, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnCancelarTexto: { color: Colors.textSecondary, fontWeight: '700', fontSize: 14 },
  btnConfirmar: { flex: 1, backgroundColor: Colors.aqua, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnConfirmarTexto: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
