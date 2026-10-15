import { View, Text, StyleSheet } from 'react-native';

// Reseña tal como la leen admin (/admin/resenas/resumen → comentarios) y
// restaurante (/resenas/restaurante). `cliente` o `usuarios.nombre` según el
// endpoint.
export type ResenaLectura = {
  id: string;
  calificacion: number;
  comentario?: string | null;
  respuesta_restaurante?: string | null;
  cliente?: string | null;
  usuarios?: { nombre?: string | null } | null;
  created_at: string;
};

function estrellas(n: number) {
  const c = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(c) + '☆'.repeat(5 - c);
}

function fecha(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guatemala' });
}

export default function ListaResenas({ resenas, vacio = 'Sin reseñas en este periodo.' }: {
  resenas: ResenaLectura[];
  vacio?: string;
}) {
  if (!resenas.length) return <Text style={s.vacio}>{vacio}</Text>;
  return (
    <View style={s.lista}>
      {resenas.map((r) => {
        const cliente = r.cliente ?? r.usuarios?.nombre ?? 'Cliente';
        return (
          <View key={r.id} style={s.item}>
            <View style={s.cabecera}>
              <Text style={s.estrellas}>{estrellas(r.calificacion)}</Text>
              <Text style={s.fecha}>{fecha(r.created_at)}</Text>
            </View>
            <Text style={s.cliente}>{cliente}</Text>
            {r.comentario
              ? <Text style={s.comentario} selectable>“{r.comentario}”</Text>
              : <Text style={s.sinComentario}>Sin comentario escrito</Text>}
            {!!r.respuesta_restaurante && (
              <Text style={s.respuesta}>Respuesta del comercio: {r.respuesta_restaurante}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  lista:         { gap: 8 },
  item:          { backgroundColor: '#FFFBF5', borderRadius: 10, borderWidth: 1, borderColor: '#FED7AA', padding: 10 },
  cabecera:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  estrellas:     { fontSize: 14, color: '#E8820C', letterSpacing: 1 },
  fecha:         { fontSize: 11, color: '#6B7280' },
  cliente:       { fontSize: 12, fontWeight: '700', color: '#111827', marginTop: 4 },
  comentario:    { fontSize: 13, color: '#1F2937', marginTop: 4, lineHeight: 19 },
  sinComentario: { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic', marginTop: 4 },
  respuesta:     { fontSize: 12, color: '#065F46', marginTop: 6 },
  vacio:         { fontSize: 12, color: '#6B7280', fontStyle: 'italic' },
});
