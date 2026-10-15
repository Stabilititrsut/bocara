import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { resenasAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import CalendarioPicker from '@/components/CalendarioPicker';
import { mesEnCurso, nombreMes } from '@/components/SelectorPeriodo';
import ListaResenas, { type ResenaLectura } from '@/components/ListaResenas';

type Periodo = 'mes' | 'todo';

// Panel del restaurante: promedio de estrellas del mes (o histórico) y lo que
// escribieron sus clientes. Las ocultas por moderación no cuentan ni se listan.
export default function ResenasRestaurante() {
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [mes, setMes] = useState(() => mesEnCurso());
  const [resenas, setResenas] = useState<ResenaLectura[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    setError(false);
    resenasAPI.delRestaurante(periodo === 'mes' ? mes : undefined)
      .then((res) => {
        if (!vigente) return;
        setResenas((res.data || []).filter((r: any) => r.visible !== false));
      })
      .catch(() => { if (vigente) { setResenas([]); setError(true); } })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [periodo, mes]);

  const total = resenas.length;
  const promedio = total ? resenas.reduce((a, r) => a + Number(r.calificacion || 0), 0) / total : 0;
  const etiqueta = periodo === 'mes'
    ? (mes === mesEnCurso() ? `mes en curso (${nombreMes(mes)})` : nombreMes(mes))
    : 'histórico';

  return (
    <View style={s.card}>
      <Text style={s.titulo}>⭐ Reseñas de tus clientes</Text>
      <View style={s.chips}>
        {([['mes', 'Por mes'], ['todo', 'Histórico']] as [Periodo, string][]).map(([p, label]) => (
          <TouchableOpacity
            key={p}
            style={[s.chip, periodo === p && s.chipActivo]}
            onPress={() => setPeriodo(p)}
            accessibilityRole="button"
            accessibilityState={{ selected: periodo === p }}
          >
            <Text style={[s.chipText, periodo === p && s.chipTextActivo]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {periodo === 'mes' && (
        <CalendarioPicker
          label=""
          modo="mes"
          value={mes}
          maxDate={mesEnCurso()}
          onChange={(m) => { if (m) setMes(m); }}
        />
      )}

      {cargando ? (
        <ActivityIndicator color={Colors.orange} style={{ marginVertical: 12 }} />
      ) : (
        <>
          <Text style={s.resumen}>
            {total ? `★ ${promedio.toFixed(1)} · ${total} reseña${total !== 1 ? 's' : ''}` : '★ — · Sin reseñas'} · {etiqueta}
          </Text>
          {error
            ? <Text style={s.error}>No se pudieron cargar las reseñas. Intenta de nuevo en un momento.</Text>
            : <ListaResenas resenas={resenas} />}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:          { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: Colors.border },
  titulo:        { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginBottom: 10 },
  chips:         { flexDirection: 'row', gap: 8, marginBottom: 8 },
  chip:          { borderWidth: 1, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  chipActivo:    { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText:      { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActivo: { color: Colors.white, fontWeight: '800' },
  resumen:       { fontSize: 14, fontWeight: '800', color: '#9A3412', marginVertical: 10 },
  error:         { fontSize: 12, color: Colors.error },
});
