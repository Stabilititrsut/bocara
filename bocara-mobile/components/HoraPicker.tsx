// Selector visual de hora — reemplaza el input de texto libre en Crear/Editar
// Promoción y Tiempo limitado (restaurante/bolsas.tsx). El usuario nunca
// escribe la hora a mano: toca el campo, elige hora, minuto y AM/PM en tres
// columnas tipo rueda, y confirma. La UI (botón cerrado y rueda) siempre
// muestra formato de 12 horas ("11:00 pm"); internamente, `value`/`onChange`
// siguen siendo el formato canónico 'HH:MM' de 24 horas que ya usa el
// backend — el contrato del componente no cambió, solo la presentación.
// Sin intervalos de 15/30 min: los 60 minutos están disponibles. Solo
// primitivos de react-native (Modal, View, Text, TouchableOpacity,
// ScrollView) — sin dependencias nuevas, funciona igual en web y nativo.
import { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Colors } from '@/constants/Colors';

type Props = {
  label: string;
  // Formato canónico 'HH:MM' (24h). '' si todavía no hay selección.
  value: string;
  onChange: (hhmm: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

type AmPm = 'am' | 'pm';

const HORAS_12 = Array.from({ length: 12 }, (_, i) => String(i + 1)); // '1'..'12'
const MINUTOS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const AMPM: AmPm[] = ['am', 'pm'];

// 24h → {hora12 1-12, ampm}. Mediodía = 12pm, medianoche = 12am.
function a12Horas(h24: number): { hora12: number; ampm: AmPm } {
  const ampm: AmPm = h24 >= 12 ? 'pm' : 'am';
  const hora12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { hora12, ampm };
}

// {hora12 1-12, ampm} → 24h.
function a24Horas(hora12: number, ampm: AmPm): number {
  if (ampm === 'am') return hora12 === 12 ? 0 : hora12;
  return hora12 === 12 ? 12 : hora12 + 12;
}

// 'HH:MM' (o con segundos) canónico → índices de las 3 columnas.
function aIndices(value: string): { horaIdx: number; minuto: number; ampmIdx: number } {
  const m = /^(\d{1,2}):(\d{1,2})/.exec(value || '');
  const h24 = m ? Math.min(23, Math.max(0, parseInt(m[1], 10) || 0)) : 18; // default 18:00 si no hay valor
  const minuto = m ? Math.min(59, Math.max(0, parseInt(m[2], 10) || 0)) : 0;
  const { hora12, ampm } = a12Horas(h24);
  return { horaIdx: hora12 - 1, minuto, ampmIdx: ampm === 'am' ? 0 : 1 };
}

// 'HH:MM' canónico → texto de 12 horas para mostrar ("11:00 pm"). '' si vacío/inválido.
function aTexto12h(value: string): string {
  const m = /^(\d{1,2}):(\d{1,2})/.exec(value || '');
  if (!m) return '';
  const h24 = Math.min(23, Math.max(0, parseInt(m[1], 10) || 0));
  const minuto = Math.min(59, Math.max(0, parseInt(m[2], 10) || 0));
  const { hora12, ampm } = a12Horas(h24);
  return `${hora12}:${String(minuto).padStart(2, '0')} ${ampm}`;
}

export default function HoraPicker({ label, value, onChange, placeholder = 'Seleccionar hora', disabled }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [horaIdx, setHoraIdx] = useState(0); // índice en HORAS_12 (hora12 = horaIdx + 1)
  const [minuto, setMinuto] = useState(0);
  const [ampmIdx, setAmpmIdx] = useState(1); // 0=am, 1=pm

  function abrir() {
    if (disabled) return;
    const idx = aIndices(value);
    setHoraIdx(idx.horaIdx);
    setMinuto(idx.minuto);
    setAmpmIdx(idx.ampmIdx);
    setAbierto(true);
  }

  function confirmar() {
    const h24 = a24Horas(horaIdx + 1, AMPM[ampmIdx]);
    onChange(`${String(h24).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`);
    setAbierto(false);
  }

  const textoMostrado = aTexto12h(value);

  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={st.label}>{label}</Text>
      <TouchableOpacity
        style={[st.boton, disabled && st.botonDeshabilitado]}
        onPress={abrir}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${textoMostrado || placeholder}`}
      >
        <Text style={[st.botonTexto, !textoMostrado && st.botonPlaceholder]}>{textoMostrado || placeholder}</Text>
        <Text style={st.botonIcono}>🕐</Text>
      </TouchableOpacity>

      <Modal visible={abierto} transparent animationType="slide" onRequestClose={() => setAbierto(false)}>
        <View style={st.overlay}>
          <View style={st.card}>
            <Text style={st.titulo}>{label}</Text>
            <View style={st.columnas}>
              <Columna valores={HORAS_12} seleccionado={horaIdx} onSeleccionar={setHoraIdx} ancho={56} />
              <Text style={st.separador}>:</Text>
              <Columna valores={MINUTOS} seleccionado={minuto} onSeleccionar={setMinuto} ancho={64} />
              <Columna valores={AMPM} seleccionado={ampmIdx} onSeleccionar={setAmpmIdx} ancho={64} />
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

function Columna({ valores, seleccionado, onSeleccionar, ancho }: {
  valores: string[]; seleccionado: number; onSeleccionar: (n: number) => void; ancho: number;
}) {
  return (
    <ScrollView style={[st.columna, { width: ancho }]} showsVerticalScrollIndicator={false}>
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
  columna: { height: 220 },
  separador: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginHorizontal: 4 },
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
