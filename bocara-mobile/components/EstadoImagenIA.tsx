import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { Image } from 'expo-image';
import { imagenesAPI } from '@/src/services/api';
import { estadoImagenIA, type FilaImagen } from '@/src/utils/estadoImagen';
import { Colors } from '@/constants/Colors';

// Línea compacta bajo la foto (panel del restaurante): qué pasa con la mejora
// automática y, si aplica, una sola acción (reintentar / usar original /
// usar mejorada). Sin estado de pipeline (fotos viejas) no muestra nada.
// "Comparar" abre original y mejorada lado a lado (la mejora es generada por
// IA: el restaurante debe poder comprobar que su producto sigue igual).
export default function EstadoImagenIA({ tipo, id, fila, onCambio }: {
  tipo: 'publicacion' | 'negocio';
  id: string;
  fila: FilaImagen;
  onCambio?: () => void;
}) {
  const estado = estadoImagenIA(fila);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const [comparando, setComparando] = useState(false);
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
      {estado.puedeComparar ? (
        <TouchableOpacity onPress={() => setComparando(true)} accessibilityRole="button" style={s.botonSec}>
          <Text style={s.botonSecTexto}>Comparar</Text>
        </TouchableOpacity>
      ) : null}
      {error ? <Text style={s.textoError}>{error}</Text> : null}
      <Modal visible={comparando} transparent animationType="fade" onRequestClose={() => setComparando(false)}>
        <View style={s.fondo}>
          <View style={s.panel}>
            <Text style={s.titulo}>Tu foto original y la mejorada</Text>
            <View style={s.par}>
              <View style={s.col}>
                <Image source={{ uri: fila.imagen_original_url || undefined }} style={s.img} contentFit="cover" />
                <Text style={s.pie}>Original</Text>
              </View>
              <View style={s.col}>
                <Image source={{ uri: fila.imagen_mejorada_url || undefined }} style={s.img} contentFit="cover" />
                <Text style={s.pie}>Mejorada</Text>
              </View>
            </View>
            <Text style={s.nota}>Si la mejorada no representa fielmente tu producto, usa tu original.</Text>
            <TouchableOpacity onPress={() => setComparando(false)} style={s.cerrar} accessibilityRole="button">
              <Text style={s.botonTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  botonSec: { paddingVertical: 2, paddingHorizontal: 8 },
  botonSecTexto: { fontSize: 11, fontWeight: '700', color: Colors.textSecondary, textDecorationLine: 'underline' },
  fondo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 16 },
  panel: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, gap: 12 },
  titulo: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  par: { flexDirection: 'row', gap: 8 },
  col: { flex: 1, alignItems: 'center', gap: 4 },
  img: { width: '100%', aspectRatio: 1, borderRadius: 10, backgroundColor: Colors.border },
  pie: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  nota: { fontSize: 12, color: Colors.textSecondary },
  cerrar: { alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: Colors.primary },
});
