import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { imagenesAPI } from '@/src/services/api';
import { estadoImagenIA, type FilaImagen } from '@/src/utils/estadoImagen';
import { Colors } from '@/constants/Colors';

// Línea compacta bajo la foto (panel del restaurante): qué pasa con la mejora
// automática y, si aplica, una sola acción (reintentar / usar original /
// usar mejorada). Sin estado de pipeline (fotos viejas) no muestra nada.
export default function EstadoImagenIA({ tipo, id, fila, onCambio }: {
  tipo: 'publicacion' | 'negocio';
  id: string;
  fila: FilaImagen;
  onCambio?: () => void;
}) {
  const estado = estadoImagenIA(fila);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  if (estado.clave === 'sin_procesar') return null;

  async function ejecutar() {
    if (!estado.accion) return;
    setEnviando(true); setError('');
    try {
      await imagenesAPI.accion(tipo, id, estado.accion);
      onCambio?.();
    } catch (e: any) {
      setError(e?.message || 'No se pudo completar. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <View style={s.fila} accessibilityLabel={`Estado de la foto: ${estado.etiqueta}`}>
      {estado.enCurso ? <ActivityIndicator size="small" color={Colors.textSecondary} style={s.spinner} /> : null}
      <Text style={[s.texto, estado.clave === 'fallida' && s.textoError]} numberOfLines={2}>{estado.etiqueta}</Text>
      {estado.accion ? (
        <TouchableOpacity onPress={ejecutar} disabled={enviando} accessibilityRole="button" style={s.boton}>
          {enviando ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text style={s.botonTexto}>{estado.textoAccion}</Text>}
        </TouchableOpacity>
      ) : null}
      {error ? <Text style={s.textoError}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  spinner: { transform: [{ scale: 0.7 }] },
  texto: { fontSize: 11, color: Colors.textSecondary, flexShrink: 1 },
  textoError: { fontSize: 11, color: '#B45309' },
  boton: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: Colors.primary },
  botonTexto: { fontSize: 11, fontWeight: '700', color: Colors.primary },
});
