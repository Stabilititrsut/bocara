// Selector de periodo financiero del admin (Dashboard y Módulo financiero):
// Hoy · 7 días · 30 días · Mes (con selector de meses históricos) · Todo.
// Mismo contrato que GET /admin/stats y GET /admin/financiero
// (?periodo=hoy|7d|30d|mes|todo[&mes=AAAA-MM]), cortes en hora de Guatemala.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import CalendarioPicker from '@/components/CalendarioPicker';
import { hoyGuatemala } from '@/src/utils/indicadores';

export type PeriodoFinanciero = 'hoy' | '7d' | '30d' | 'mes' | 'todo';
export type SeleccionPeriodo = { periodo: PeriodoFinanciero; mes: string };

const OPCIONES: { key: PeriodoFinanciero; label: string }[] = [
  { key: 'hoy',  label: 'Hoy' },
  { key: '7d',   label: '7 días' },
  { key: '30d',  label: '30 días' },
  { key: 'mes',  label: 'Mes' },
  { key: 'todo', label: 'Todo' },
];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const GOLD   = '#E8820C';
const BORDER = '#E5E7EB';
const TEXT2  = '#6B7280';

export function mesEnCurso(): string {
  return hoyGuatemala().slice(0, 7);
}

export function nombreMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return MESES[m - 1] ? `${MESES[m - 1]} ${a}` : mes;
}

// Texto corto del periodo para títulos ("últimos 7 días", "septiembre 2026"…).
export function tituloPeriodo({ periodo, mes }: SeleccionPeriodo): string {
  switch (periodo) {
    case 'hoy':  return 'hoy';
    case '7d':   return 'últimos 7 días';
    case '30d':  return 'últimos 30 días';
    case 'mes':  return mes === mesEnCurso() ? `mes en curso (${nombreMes(mes)})` : nombreMes(mes);
    default:     return 'histórico total';
  }
}

// Parámetro `mes` para la API: solo cuando el periodo es 'mes'.
export function mesParam({ periodo, mes }: SeleccionPeriodo): string | undefined {
  return periodo === 'mes' ? mes : undefined;
}

// Clave estable para caches y efectos.
export function clavePeriodo(sel: SeleccionPeriodo): string {
  return sel.periodo === 'mes' ? `mes_${sel.mes}` : sel.periodo;
}

export default function SelectorPeriodo({ valor, onChange }: {
  valor: SeleccionPeriodo;
  onChange: (sel: SeleccionPeriodo) => void;
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={s.chips}>
        {OPCIONES.map(({ key, label }) => {
          const activo = valor.periodo === key;
          return (
            <TouchableOpacity
              key={key}
              style={[s.chip, activo && s.chipActivo]}
              onPress={() => onChange({ periodo: key, mes: valor.mes || mesEnCurso() })}
              accessibilityRole="button"
              accessibilityState={{ selected: activo }}
            >
              <Text style={[s.chipTexto, activo && s.chipTextoActivo]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {valor.periodo === 'mes' && (
        <View style={{ maxWidth: 260, marginTop: 6 }}>
          <CalendarioPicker
            label="Mes"
            modo="mes"
            value={valor.mes}
            maxDate={mesEnCurso()}
            onChange={(mes) => onChange({ periodo: 'mes', mes })}
          />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  chips:           { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:            { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: BORDER, backgroundColor: '#FFFFFF' },
  chipActivo:      { backgroundColor: GOLD, borderColor: GOLD },
  chipTexto:       { fontSize: 12, fontWeight: '600', color: TEXT2 },
  chipTextoActivo: { color: '#fff', fontWeight: '800' },
});
