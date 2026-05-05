import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, SafeAreaView, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { negociosAPI, uploadsAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

// expo-image-picker cargado dinámicamente — no disponible en web sin config adicional
let ImagePicker: any = null;
try { ImagePicker = require('expo-image-picker'); } catch { }

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];

export default function PerfilRestauranteScreen() {
  const [negocio, setNegocio] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const { logout } = useAuth();
  const set = (k: string) => (v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  useEffect(() => {
    negociosAPI.miNegocio().then((res) => {
      setNegocio(res.data);
      setForm({
        nombre: res.data.nombre || '',
        descripcion: res.data.descripcion || '',
        direccion: res.data.direccion || '',
        zona: res.data.zona || '',
        ciudad: res.data.ciudad || 'Guatemala',
        telefono: res.data.telefono || '',
        categoria: res.data.categoria || '',
        latitud: res.data.latitud != null ? String(res.data.latitud) : '',
        longitud: res.data.longitud != null ? String(res.data.longitud) : '',
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function seleccionarImagen() {
    if (!ImagePicker) {
      Alert.alert('No disponible', 'La subida de imágenes no está disponible en esta plataforma.');
      return;
    }
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permiso requerido', 'Necesitamos acceso a tu galería para cambiar la foto.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    await subirImagen(asset.uri);
  }

  async function subirImagen(uri: string) {
    if (!negocio?.id) return;
    setUploadingImg(true);
    try {
      const ext = uri.split('.').pop()?.split('?')[0] || 'jpg';
      const path = `negocios/${negocio.id}/imagen_${Date.now()}.${ext}`;

      // 1. Obtener URL firmada del backend
      const { data } = await uploadsAPI.getSignedUrl(path);

      // 2. Subir directo a Supabase Storage
      const blob = await fetch(uri).then((r) => r.blob());
      const uploadRes = await fetch(data.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'image/jpeg' },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error('Error al subir la imagen');

      // 3. Guardar URL pública en el negocio
      await negociosAPI.actualizar(negocio.id, { imagen_url: data.publicUrl });
      setNegocio((n: any) => ({ ...n, imagen_url: data.publicUrl }));
      Alert.alert('¡Foto actualizada!', 'La imagen del negocio fue guardada.');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'No se pudo subir la imagen');
    } finally {
      setUploadingImg(false);
    }
  }

  async function guardar() {
    setSaving(true);
    try {
      const payload: any = { ...form };
      const lat = parseFloat(form.latitud);
      const lng = parseFloat(form.longitud);
      payload.latitud  = isNaN(lat) ? null : lat;
      payload.longitud = isNaN(lng) ? null : lng;
      await negociosAPI.actualizar(negocio.id, payload);
      Alert.alert('¡Guardado!', 'Datos del negocio actualizados.');
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  }

  async function geocodificarAhora() {
    if (!form.direccion) return Alert.alert('Sin dirección', 'Ingresa una dirección primero');
    setSaving(true);
    try {
      await negociosAPI.actualizar(negocio.id, {
        direccion: form.direccion, zona: form.zona, ciudad: form.ciudad,
        latitud: null, longitud: null,
      });
      const res = await negociosAPI.miNegocio();
      setNegocio(res.data);
      setForm((f: any) => ({
        ...f,
        latitud: res.data.latitud != null ? String(res.data.latitud) : '',
        longitud: res.data.longitud != null ? String(res.data.longitud) : '',
      }));
      if (res.data.latitud) {
        Alert.alert('✅ Ubicación obtenida', `Lat: ${res.data.latitud.toFixed(6)}\nLng: ${res.data.longitud?.toFixed(6)}`);
      } else {
        Alert.alert('Sin resultado', 'No se encontró la dirección. Ingresa coordenadas manualmente.');
      }
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  }

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} /></View>;

  const tieneCoordenadas = negocio?.latitud != null && negocio?.longitud != null;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mi negocio</Text>
        <TouchableOpacity style={s.saveBtn} onPress={guardar} disabled={saving}>
          <Text style={s.saveBtnText}>{saving ? '...' : 'Guardar'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        {/* Foto del negocio */}
        <TouchableOpacity style={s.imgContainer} onPress={seleccionarImagen} disabled={uploadingImg}>
          {negocio?.imagen_url ? (
            <Image source={{ uri: negocio.imagen_url }} style={s.imgNegocio} contentFit="cover" transition={200} />
          ) : (
            <View style={s.imgPlaceholder}>
              <Text style={{ fontSize: 40 }}>🏪</Text>
              <Text style={s.imgPlaceholderText}>Agregar foto</Text>
            </View>
          )}
          <View style={s.imgEditBtn}>
            {uploadingImg
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.imgEditText}>📷 Cambiar foto</Text>
            }
          </View>
        </TouchableOpacity>

        {/* Stats rápidos */}
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{negocio?.total_bolsas_vendidas || 0}</Text>
            <Text style={s.statLabel}>Bolsas vendidas</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{negocio?.calificacion_promedio?.toFixed(1) || '–'}</Text>
            <Text style={s.statLabel}>Calificación</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statVal}>{negocio?.total_resenas || 0}</Text>
            <Text style={s.statLabel}>Reseñas</Text>
          </View>
        </View>

        {/* Datos básicos */}
        <Text style={s.sectionTitle}>Información del negocio</Text>
        {[
          { key: 'nombre',      label: 'Nombre del negocio' },
          { key: 'descripcion', label: 'Descripción', multi: true },
          { key: 'telefono',    label: 'Teléfono', keyboard: 'phone-pad' as any },
        ].map(({ key, label, multi, keyboard }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              style={[s.input, multi && { height: 80 }]}
              placeholder={label} placeholderTextColor={Colors.textLight}
              keyboardType={keyboard} value={form[key]} onChangeText={set(key)}
              multiline={multi} textAlignVertical={multi ? 'top' : 'center'}
            />
          </View>
        ))}

        <Text style={s.label}>Categoría</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }} contentContainerStyle={{ gap: 8 }}>
          {CATEGORIAS.map((cat) => (
            <TouchableOpacity key={cat} style={[s.chip, form.categoria === cat && s.chipActive]} onPress={() => setForm((f: any) => ({ ...f, categoria: cat }))}>
              <Text style={[s.chipText, form.categoria === cat && s.chipTextActive]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Dirección */}
        <Text style={s.sectionTitle}>Dirección</Text>
        {[
          { key: 'direccion', label: 'Dirección', placeholder: '5a Calle 10-35' },
          { key: 'zona',      label: 'Zona / Colonia', placeholder: 'Zona 10' },
          { key: 'ciudad',    label: 'Ciudad', placeholder: 'Guatemala' },
        ].map(({ key, label, placeholder }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight} value={form[key]} onChangeText={set(key)} />
          </View>
        ))}

        {/* Coordenadas */}
        <Text style={s.sectionTitle}>Ubicación en el mapa 📍</Text>
        <View style={[s.coordsCard, tieneCoordenadas && s.coordsCardOk]}>
          <View style={s.coordsStatus}>
            <Text style={{ fontSize: 24 }}>{tieneCoordenadas ? '✅' : '❌'}</Text>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={s.coordsStatusTitle}>{tieneCoordenadas ? 'Ubicación registrada' : 'Sin ubicación'}</Text>
              <Text style={s.coordsStatusSub}>
                {tieneCoordenadas
                  ? 'Tu negocio aparece en las búsquedas por distancia'
                  : 'Sin coordenadas los clientes no verán la distancia'}
              </Text>
            </View>
          </View>
          <View style={s.coordsInputRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Latitud</Text>
              <TextInput style={s.input} value={form.latitud} onChangeText={set('latitud')} placeholder="14.6349" placeholderTextColor={Colors.textLight} keyboardType="decimal-pad" />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.label}>Longitud</Text>
              <TextInput style={s.input} value={form.longitud} onChangeText={set('longitud')} placeholder="-90.5069" placeholderTextColor={Colors.textLight} keyboardType="decimal-pad" />
            </View>
          </View>
          <TouchableOpacity style={s.geocodeBtn} onPress={geocodificarAhora} disabled={saving}>
            <Text style={s.geocodeBtnText}>{saving ? 'Buscando...' : '🔍 Detectar desde dirección'}</Text>
          </TouchableOpacity>
          <Text style={s.coordsHint}>O busca en maps.google.com, haz clic derecho y copia las coordenadas.</Text>
        </View>

        <TouchableOpacity style={s.logoutBtn} onPress={logout}>
          <Text style={s.logoutText}>Cerrar sesión</Text>
        </TouchableOpacity>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  saveBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  saveBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  scroll: { padding: 16 },
  imgContainer: { borderRadius: 16, overflow: 'hidden', marginBottom: 20, height: 160 },
  imgNegocio: { width: '100%', height: '100%' },
  imgPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.brownLight, justifyContent: 'center', alignItems: 'center', gap: 8 },
  imgPlaceholderText: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
  imgEditBtn: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingVertical: 10, alignItems: 'center' },
  imgEditText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stat: { flex: 1, backgroundColor: Colors.white, borderRadius: 14, padding: 12, alignItems: 'center', elevation: 1 },
  statVal: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2, textAlign: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 14 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.white },
  chipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  coordsCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 2, borderColor: Colors.error + '40' },
  coordsCardOk: { borderColor: Colors.green + '60' },
  coordsStatus: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  coordsStatusTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown },
  coordsStatusSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },
  coordsInputRow: { flexDirection: 'row' },
  geocodeBtn: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 12, alignItems: 'center', marginBottom: 10 },
  geocodeBtnText: { color: Colors.brown, fontWeight: '700', fontSize: 14 },
  coordsHint: { fontSize: 11, color: Colors.textLight, lineHeight: 16 },
  logoutBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 14, padding: 14, alignItems: 'center', marginTop: 8 },
  logoutText: { color: Colors.error, fontWeight: '700', fontSize: 15 },
});
