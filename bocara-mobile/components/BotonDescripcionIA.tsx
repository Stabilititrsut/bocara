import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { iaAPI } from '@/src/services/api';
import {
  crearMejorador, motivoNoMejorable, TEXTO_BOTON, TEXTO_GENERANDO, TEXTO_LISTO, TEXTO_LISTO_AYUDA,
  TEXTO_DESHACER, TEXTO_EDITAR, type DatosDescripcionIA,
} from '@/src/utils/descripcionIA';
import { Colors } from '@/constants/Colors';

// "Mejorar descripción con IA", bajo el campo Descripción del formulario de
// Promoción y Tiempo limitado (mismo componente para ambos). Nunca se dispara
// solo: el restaurante lo toca, la propuesta reemplaza el texto del campo y
// queda editable ("Editar sugerencia" lleva el cursor al campo). "Deshacer"
// devuelve la descripción que había. Si falla, el campo no se toca. Mientras
// genera, el botón se deshabilita y el padre bloquea el campo (onProcesando)
// para que la propuesta no pise lo que se esté escribiendo.
// `aviso`: el servidor reporta la IA de texto sin configurar (GET /api/ia/estado).
export default function BotonDescripcionIA({ datos, onPropuesta, onProcesando, onEditar, aviso }: {
  datos: DatosDescripcionIA;
  onPropuesta: (texto: string) => void;
  onProcesando?: (procesando: boolean) => void;
  onEditar?: () => void;
  aviso?: string | null;
}) {
  const mejorador = useRef(crearMejorador(iaAPI.mejorarDescripcion, { dev: __DEV__ })).current;
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState('');
  const [sugerida, setSugerida] = useState(false);
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
        setSugerida(true);
        // Solo se ofrece deshacer si había una descripción que recuperar.
        setAnterior(r.anterior.trim() ? r.anterior : null);
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
    setSugerida(false);
  }

  return (
    <View style={s.wrap}>
      <TouchableOpacity
        onPress={mejorar}
        disabled={procesando}
        accessibilityRole="button"
        accessibilityState={{ disabled: procesando, busy: procesando }}
        accessibilityHint="Propone una descripción a partir de los datos del formulario. Podrás editarla antes de guardar."
        style={[s.boton, (procesando || sinNombre || !!aviso) && s.botonApagado]}
        testID="mejorar-descripcion-ia"
      >
        {procesando ? <ActivityIndicator size="small" color={Colors.primary} style={s.spinner} /> : null}
        <Text style={s.botonTexto}>{procesando ? TEXTO_GENERANDO : TEXTO_BOTON}</Text>
      </TouchableOpacity>
      {aviso && !error ? <Text style={s.error}>⚠️ {aviso}</Text> : null}
      {error ? <Text style={s.error} accessibilityLiveRegion="polite">⚠️ {error}</Text> : null}
      {!error && sugerida && !procesando ? (
        <View style={s.caja} testID="descripcion-sugerida">
          <Text style={s.listo}>{TEXTO_LISTO}</Text>
          <Text style={s.ayuda}>{TEXTO_LISTO_AYUDA}</Text>
          <View style={s.filaListo}>
            {onEditar ? (
              <TouchableOpacity onPress={onEditar} accessibilityRole="button" testID="editar-sugerencia">
                <Text style={s.accion}>{TEXTO_EDITAR}</Text>
              </TouchableOpacity>
            ) : null}
            {anterior !== null ? (
              <TouchableOpacity onPress={deshacer} accessibilityRole="button" testID="deshacer-descripcion">
                <Text style={s.accion}>{TEXTO_DESHACER}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
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
  caja: { borderRadius: 10, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#86EFAC', padding: 10, gap: 4 },
  listo: { fontSize: 13, fontWeight: '800', color: '#166534' },
  ayuda: { fontSize: 12, color: Colors.textSecondary },
  filaListo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginTop: 2 },
  accion: { fontSize: 13, fontWeight: '700', color: Colors.primary, textDecorationLine: 'underline' },
});
