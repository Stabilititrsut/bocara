import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { Image } from 'expo-image';
import { negociosAPI, uploadsAPI } from '@/src/services/api';
import { useTrabajoImagen } from '@/hooks/use-trabajo-imagen';
import { pickImage } from '@/src/utils/pickImage';
import { bloqueoImagenNegocio, enCurso, imagenAGuardar } from '@/src/utils/procesoImagen';
import EstadoProcesoImagen from '@/components/EstadoProcesoImagen';
import { Colors } from '@/constants/Colors';

// Foto de perfil o portada del restaurante con el MISMO pipeline de IA que las
// publicaciones (backend/services/imagenes/trabajos.js, uso perfil/portada):
//   1. elegir foto → 2. subirla (negocios/<id>/<tipo>_<ts>) → 3-5. la IA la
//   analiza, mejora y valida → 6. Guardar (bloqueado hasta "lista").
// Si falla: Reintentar, Cambiar foto o Usar original (solo si el backend dice
// que la original cumple la calidad mínima). El backend vuelve a validar al
// guardar (PUT /api/negocios/:id/imagen) y nunca pisa la original.
const TEXTOS = {
  perfil: { titulo: 'Foto de perfil', ayuda: 'Tu logo o una imagen que identifique a tu negocio. Se muestra en un círculo.', guardar: 'Guardar foto de perfil', ok: '✅ Foto de perfil actualizada' },
  portada: { titulo: 'Portada (foto del negocio)', ayuda: 'Imagen horizontal de tu local, tu ambiente o tus platos. Es lo primero que ven tus clientes.', guardar: 'Guardar portada', ok: '✅ Portada actualizada' },
} as const;

export default function ImagenNegocioIA({ tipo, negocioId, actualUrl, obligatoria = false, pie, onGuardada, onAviso }: {
  tipo: 'perfil' | 'portada';
  negocioId: string;
  actualUrl?: string | null;
  obligatoria?: boolean;
  // Estado de la imagen ya guardada (p. ej. EstadoImagenIA); se oculta mientras se cambia.
  pie?: React.ReactNode;
  onGuardada: (negocio: any) => void;
  onAviso?: (mensaje: string, ok: boolean) => void;
}) {
  const proceso = useTrabajoImagen(tipo);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [usarOriginal, setUsarOriginal] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<any>(null);
  const t = TEXTOS[tipo];
  const trabajo = proceso.trabajo;
  const cambiando = subiendo || !!trabajo || !!proceso.error;

  async function subir(base64: string, mimeType: string) {
    setSubiendo(true);
    setError('');
    setUsarOriginal(false);
    try {
      const ext = mimeType.split('/')[1] || 'jpg';
      const { data } = await uploadsAPI.uploadBase64(base64, `negocios/${negocioId}/${tipo}_${Date.now()}.${ext}`, mimeType);
      if (data?.publicUrl) proceso.iniciar(data.publicUrl);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'No se pudo subir la imagen');
    } finally {
      setSubiendo(false);
    }
  }

  // Web: input oculto activado dentro del gesto del usuario (mismo patrón que bolsas.tsx).
  function alElegirArchivo(e: any) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => subir((reader.result as string).split(',')[1], file.type || 'image/jpeg');
    reader.onerror = () => setError('No se pudo leer la imagen');
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function elegir() {
    setError('');
    if (Platform.OS === 'web') { inputRef.current?.click(); return; }
    pickImage({ aspect: tipo === 'perfil' ? [1, 1] : [3, 2] }).then((p) => { if (p) subir(p.base64, p.mimeType); });
  }

  function cancelar() {
    proceso.reiniciar();
    setUsarOriginal(false);
    setError('');
  }

  const bloqueo = bloqueoImagenNegocio({ trabajo, subiendo, errorRed: proceso.errorRed, usarOriginal });

  async function guardar() {
    if (!trabajo || bloqueo || guardando) return;
    setGuardando(true);
    setError('');
    try {
      const { data } = await negociosAPI.guardarImagen(negocioId, { tipo, imagen_trabajo_id: trabajo.id, usar_original: usarOriginal });
      proceso.reiniciar();
      setUsarOriginal(false);
      onGuardada(data);
      onAviso?.(t.ok, true);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'No se pudo guardar la imagen');
    } finally {
      setGuardando(false);
    }
  }

  const vistaPrevia = imagenAGuardar(trabajo, { usarOriginal }) || trabajo?.original_url || actualUrl || null;
  const procesando = subiendo || enCurso(trabajo?.estado);

  return (
    <View style={s.caja} testID={`imagen-negocio-${tipo}`}>
      {Platform.OS === 'web' && React.createElement('input', {
        ref: inputRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: alElegirArchivo,
      })}
      <Text style={s.titulo}>{t.titulo}{obligatoria ? ' *' : ''}</Text>
      <Text style={s.ayuda}>{t.ayuda}</Text>

      <TouchableOpacity
        onPress={elegir}
        disabled={subiendo || guardando}
        accessibilityRole="button"
        accessibilityLabel={`Cambiar ${t.titulo.toLowerCase()}`}
        style={tipo === 'perfil' ? s.perfilMarco : [s.portadaMarco, obligatoria && !vistaPrevia && s.marcoError]}
      >
        {vistaPrevia ? (
          <Image source={{ uri: vistaPrevia }} style={s.img} contentFit="cover" transition={200} />
        ) : (
          <View style={s.vacio}>
            <Text style={{ fontSize: tipo === 'perfil' ? 30 : 36 }}>{tipo === 'perfil' ? '🏷️' : '🏪'}</Text>
            <Text style={s.vacioTexto}>Agregar imagen</Text>
          </View>
        )}
        {procesando ? <View style={s.velo}><ActivityIndicator color={Colors.white} /></View> : null}
      </TouchableOpacity>

      {!cambiando ? (
        <View style={s.acciones}>
          <TouchableOpacity onPress={elegir} style={s.botonSec} accessibilityRole="button">
            <Text style={s.botonSecTexto}>📷 {vistaPrevia ? 'Cambiar foto' : 'Subir foto'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {!cambiando ? pie : null}

      {cambiando ? (
        <EstadoProcesoImagen
          trabajo={trabajo}
          subiendo={subiendo}
          error={proceso.error}
          errorRed={proceso.errorRed}
          onReintentar={() => { setUsarOriginal(false); proceso.reintentar(); }}
          onCambiarFoto={elegir}
          onUsarOriginal={() => setUsarOriginal(true)}
        />
      ) : null}
      {usarOriginal && !bloqueo ? <Text style={s.nota}>Se guardará tu imagen original, tal como la subiste.</Text> : null}

      {cambiando ? (
        <View style={s.acciones}>
          <TouchableOpacity
            onPress={guardar}
            disabled={!!bloqueo || guardando}
            style={[s.boton, (bloqueo || guardando) && s.botonBloqueado]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!bloqueo || guardando }}
            testID={`guardar-${tipo}`}
          >
            {guardando ? <ActivityIndicator size="small" color={Colors.white} /> : <Text style={s.botonTexto}>{usarOriginal ? `${t.guardar} (original)` : t.guardar}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={cancelar} disabled={guardando} style={s.botonSec} accessibilityRole="button">
            <Text style={s.botonSecTexto}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {cambiando && bloqueo && trabajo ? <Text style={s.nota}>{bloqueo}</Text> : null}
      {error ? <Text style={s.error}>⚠️ {error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  caja: { marginBottom: 16 },
  titulo: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 2 },
  ayuda: { fontSize: 12, color: Colors.textLight, marginBottom: 8, lineHeight: 16 },
  perfilMarco: { width: 112, height: 112, borderRadius: 56, overflow: 'hidden', backgroundColor: Colors.brownLight, alignSelf: 'flex-start' },
  portadaMarco: { width: '100%', aspectRatio: 3 / 1.4, maxHeight: 220, borderRadius: 16, overflow: 'hidden', backgroundColor: Colors.brownLight },
  marcoError: { borderWidth: 2, borderColor: Colors.error },
  img: { width: '100%', height: '100%' },
  vacio: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6 },
  vacioTexto: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  velo: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center' },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  boton: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 18, backgroundColor: Colors.orange, minWidth: 140, alignItems: 'center' },
  botonBloqueado: { backgroundColor: Colors.border },
  botonTexto: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  botonSec: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1.5, borderColor: Colors.orange },
  botonSecTexto: { color: Colors.orange, fontWeight: '700', fontSize: 13 },
  nota: { fontSize: 12, color: Colors.textSecondary, marginTop: 6 },
  error: { fontSize: 12, color: '#B91C1C', fontWeight: '600', marginTop: 6 },
});
