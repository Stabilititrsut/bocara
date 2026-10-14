import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { iaAPI } from '@/src/services/api';
import {
  crearMejorador, motivoNoMejorable, TEXTO_GENERANDO, TEXTO_LISTO, type DatosDescripcionIA,
} from '@/src/utils/descripcionIA';
import { Colors } from '@/constants/Colors';

// "Mejorar descripción con IA", bajo el campo Descripción del formulario de
// Promoción y Tiempo limitado (mismo componente para ambos). Nunca se dispara
// solo: el restaurante lo toca, la propuesta reemplaza el texto del campo y
// queda editable. "Deshacer" devuelve el texto anterior. Si falla, el campo no
// se toca. Mientras genera, el botón se deshabilita y el padre bloquea el campo
// (onProcesando) para que la propuesta no pise lo que se esté escribiendo.
export default function BotonDescripcionIA({ datos, onPropuesta, onProcesando }: {
  datos: DatosDescripcionIA;
  onPropuesta: (texto: string) => void;
  onProcesando?: (procesando: boolean) => void;
}) {
  const mejorador = useRef(crearMejorador(iaAPI.mejorarDescripcion)).current;
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState('');
  const [anterior, setAnterior] = useState<string | null>(null);
  // Si el formulario se cierra mientras genera, la respuesta tardía se descarta
  // (no debe caer en otra publicación).
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true; // StrictMode monta, desmonta y vuelve a montar
    return () => { montado.current = false; };
  }, []);
  const sinNombre = !!motivoNoMejorable({ nombre: datos.nombre, descripcion: '', contenido: '' });

  async function mejorar() {
    if (mejorador.enCurso) return;
    setError('');
    setProcesando(true); onProcesando?.(true);
    try {
      const r = await mejorador.mejorar(datos);
      if (!montado.current) return;
      if (r.estado === 'ok') {
        onPropuesta(r.descripcion);
        setAnterior(r.anterior);
      } else if (r.estado === 'error') {
        setError(r.error);
      }
    } finally {
      onProcesando?.(false);
      if (montado.current) setProcesando(false);
    }
  }

  function deshacer() {
    if (anterior === null) return;
    onPropuesta(anterior);
    setAnterior(null);
  }

  return (
    <View style={s.wrap}>
      <TouchableOpacity
        onPress={mejorar}
        disabled={procesando}
        accessibilityRole="button"
        accessibilityState={{ disabled: procesando, busy: procesando }}
        accessibilityHint="Propone una descripción a partir de los datos del formulario. Podrás editarla antes de guardar."
        style={[s.boton, (procesando || sinNombre) && s.botonApagado]}
        testID="mejorar-descripcion-ia"
      >
        {procesando ? <ActivityIndicator size="small" color={Colors.primary} style={s.spinner} /> : null}
        <Text style={s.botonTexto}>{procesando ? TEXTO_GENERANDO : '✨ Mejorar descripción con IA'}</Text>
      </TouchableOpacity>
      {error ? <Text style={s.error} accessibilityLiveRegion="polite">⚠️ {error}</Text> : null}
      {!error && anterior !== null && !procesando ? (
        <View style={s.filaListo}>
          <Text style={s.listo}>{TEXTO_LISTO}</Text>
          <TouchableOpacity onPress={deshacer} accessibilityRole="button">
            <Text style={s.deshacer}>Deshacer</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: 2, marginBottom: 10, gap: 6 },
  boton: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5, borderColor: Colors.primary,
  },
  botonApagado: { opacity: 0.55 },
  spinner: { transform: [{ scale: 0.8 }] },
  botonTexto: { fontSize: 13, fontWeight: '700', color: Colors.primary },
  error: { fontSize: 12, color: '#B45309' },
  filaListo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  listo: { fontSize: 12, color: Colors.textSecondary, flexShrink: 1 },
  deshacer: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, textDecorationLine: 'underline' },
});
