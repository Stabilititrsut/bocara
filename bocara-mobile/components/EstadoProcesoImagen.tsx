import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { pasosProceso, resumenProceso, TEXTOS_IMAGEN, type TrabajoImagen } from '@/src/utils/procesoImagen';
import { Colors } from '@/constants/Colors';

// Estado de la foto en el formulario de Promoción / Tiempo limitado: los pasos
// del procesamiento con IA, el resultado y las acciones (Reintentar / Cambiar
// foto). Guardar queda bloqueado en bolsas.tsx hasta "Imagen lista".
export default function EstadoProcesoImagen({ trabajo, subiendo, error, errorRed, onReintentar, onCambiarFoto }: {
  trabajo: TrabajoImagen | null;
  subiendo?: boolean;
  error?: string | null;
  errorRed?: boolean;
  onReintentar: () => void;
  onCambiarFoto: () => void;
}) {
  if (subiendo) {
    return (
      <View style={[s.caja, s.cajaProgreso]} testID="estado-proceso-imagen">
        <View style={s.fila}><ActivityIndicator size="small" color={Colors.primary} /><Text style={s.titulo}>{TEXTOS_IMAGEN.subiendo}</Text></View>
      </View>
    );
  }
  // No se pudo crear el trabajo (p. ej. migración pendiente o límite de fotos).
  if (!trabajo && error) {
    return (
      <View style={[s.caja, s.cajaError]} testID="estado-proceso-imagen">
        <Text style={s.titulo}>{TEXTOS_IMAGEN.fallida}</Text>
        <Text style={s.mensaje}>{error}</Text>
        <View style={s.acciones}>
          <TouchableOpacity onPress={onCambiarFoto} style={s.boton} accessibilityRole="button"><Text style={s.botonTexto}>{TEXTOS_IMAGEN.cambiarFoto}</Text></TouchableOpacity>
        </View>
      </View>
    );
  }
  const resumen = resumenProceso(trabajo, { dev: __DEV__ });
  if (!trabajo || !resumen) return null;
  const pasos = pasosProceso(trabajo);
  const estiloCaja = { progreso: s.cajaProgreso, ok: s.cajaOk, error: s.cajaError, rechazo: s.cajaRechazo }[resumen.tono];

  return (
    <View style={[s.caja, estiloCaja]} testID="estado-proceso-imagen" accessibilityLiveRegion="polite">
      <View style={s.fila}>
        {resumen.tono === 'progreso' && !errorRed ? <ActivityIndicator size="small" color={Colors.primary} /> : null}
        <Text style={s.titulo}>{resumen.titulo}</Text>
      </View>
      {resumen.tono !== 'ok' ? (
        <View style={s.pasos}>
          {pasos.map((p) => (
            <View key={p.texto} style={s.fila}>
              <Text style={[s.icono, p.estado === 'error' && s.textoError]}>
                {p.estado === 'hecho' ? '✓' : p.estado === 'activo' ? '•' : p.estado === 'error' ? '✗' : '○'}
              </Text>
              <Text style={[s.paso, p.estado === 'activo' && s.pasoActivo, p.estado === 'pendiente' && s.pasoPendiente, p.estado === 'error' && s.textoError]}>
                {p.texto}{p.estado === 'activo' ? '…' : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {resumen.mensajes.map((m) => <Text key={m} style={s.mensaje}>{m}</Text>)}
      {errorRed ? <Text style={s.mensaje}>Perdimos la conexión al consultar la imagen.</Text> : null}
      {resumen.puedeReintentar || errorRed || resumen.tono !== 'progreso' ? (
        <View style={s.acciones}>
          {resumen.puedeReintentar || errorRed ? (
            <TouchableOpacity onPress={onReintentar} style={s.boton} accessibilityRole="button" testID="reintentar-imagen">
              <Text style={s.botonTexto}>{TEXTOS_IMAGEN.reintentar}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={onCambiarFoto} style={s.botonSec} accessibilityRole="button" testID="cambiar-foto">
            <Text style={s.botonSecTexto}>{TEXTOS_IMAGEN.cambiarFoto}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  caja: { borderRadius: 12, borderWidth: 1.5, padding: 12, gap: 6, marginTop: 8, marginBottom: 4 },
  cajaProgreso: { borderColor: Colors.primary, backgroundColor: '#F2FAF9' },
  cajaOk: { borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
  cajaError: { borderColor: '#D97706', backgroundColor: '#FFFBEB' },
  cajaRechazo: { borderColor: '#DC2626', backgroundColor: '#FEF2F2' },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary, flexShrink: 1 },
  pasos: { gap: 2, marginTop: 2 },
  icono: { width: 14, textAlign: 'center', fontSize: 13, fontWeight: '800', color: Colors.textSecondary },
  paso: { fontSize: 13, color: Colors.textSecondary },
  pasoActivo: { color: Colors.textPrimary, fontWeight: '700' },
  pasoPendiente: { color: Colors.textLight },
  textoError: { color: '#B91C1C' },
  mensaje: { fontSize: 12, color: Colors.textSecondary },
  acciones: { flexDirection: 'row', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  boton: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, backgroundColor: Colors.primary },
  botonTexto: { fontSize: 13, fontWeight: '700', color: Colors.white },
  botonSec: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1.5, borderColor: Colors.primary },
  botonSecTexto: { fontSize: 13, fontWeight: '700', color: Colors.primary },
});
