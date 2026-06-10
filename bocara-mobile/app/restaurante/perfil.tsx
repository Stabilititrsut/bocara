import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, SafeAreaView, ActivityIndicator, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { negociosAPI, uploadsAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';
import { pickImage } from '@/src/utils/pickImage';

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];

export default function PerfilRestauranteScreen() {
  const [negocio, setNegocio] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [originalForm, setOriginalForm] = useState<any>({});
  const [camposPendientes, setCamposPendientes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [imgError, setImgError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const { logout } = useAuth();
  const fileInputRef = useRef<any>(null);
  const dpiInputRef = useRef<any>(null);
  const [dpiUrl, setDpiUrl] = useState('');
  const [uploadingDpi, setUploadingDpi] = useState(false);
  const [dpiError, setDpiError] = useState('');
  const [geoLoading, setGeoLoading] = useState(false);
  const [rechazoInfo, setRechazoInfo] = useState<{ texto: string; campos: string[] } | null>(null);
  const set = (k: string) => (v: string) => {
    setForm((f: any) => ({ ...f, [k]: v }));
    setCamposPendientes(prev => {
      const next = new Set(prev);
      next.add(k);
      return next;
    });
  };

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    negociosAPI.miNegocio().then((res) => {
      setNegocio(res.data);
      const loaded = {
        nombre: res.data.nombre || '',
        descripcion: res.data.descripcion || '',
        direccion: res.data.direccion || '',
        zona: res.data.zona || '',
        ciudad: res.data.ciudad || 'Guatemala',
        telefono: res.data.telefono || '',
        categoria: res.data.categoria || '',
        latitud: res.data.latitud != null ? String(res.data.latitud) : '',
        longitud: res.data.longitud != null ? String(res.data.longitud) : '',
        punto_referencia: res.data.punto_referencia || '',
        google_maps_url: res.data.google_maps_url || '',
        waze_url: res.data.waze_url || '',
      };
      setForm(loaded);
      setOriginalForm(loaded);
      setCamposPendientes(new Set());
      setDpiUrl(res.data.dpi_foto_url || res.data.datos_bancarios?.dpi_foto_url || '');
      if (res.data.estado_verificacion === 'rechazado' && res.data.motivo_rechazo) {
        try {
          const parsed = JSON.parse(res.data.motivo_rechazo);
          setRechazoInfo({ texto: parsed.texto || '', campos: Array.isArray(parsed.campos) ? parsed.campos : [] });
        } catch {
          setRechazoInfo({ texto: res.data.motivo_rechazo, campos: [] });
        }
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Web: leer el archivo seleccionado y subirlo
  function handleWebFileChange(e: any) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      subirImagen(base64, file.type || 'image/jpeg');
    };
    reader.onerror = () => setImgError('No se pudo leer la imagen');
    reader.readAsDataURL(file);
    e.target.value = ''; // permite volver a seleccionar el mismo archivo
  }

  function seleccionarImagen() {
    setImgError('');
    if (Platform.OS === 'web') {
      // Activar el input oculto directamente — sincrónico dentro del gesto del usuario
      fileInputRef.current?.click();
      return;
    }
    // Nativo: usar pickImage (expo-image-picker)
    pickImage().then((picked) => {
      if (!picked) return;
      subirImagen(picked.base64, picked.mimeType);
    });
  }

  const isRejected = (campo: string) => !!(rechazoInfo?.campos?.includes(campo));

  function handleWebDpiChange(e: any) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      subirDpi(base64, file.type || 'image/jpeg');
    };
    reader.onerror = () => setDpiError('No se pudo leer el archivo');
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function seleccionarDpi() {
    setDpiError('');
    if (Platform.OS === 'web') { dpiInputRef.current?.click(); return; }
    pickImage().then((picked) => {
      if (!picked) return;
      subirDpi(picked.base64, picked.mimeType);
    });
  }

  async function subirDpi(base64: string, mimeType: string) {
    if (!negocio?.id) return;
    setUploadingDpi(true);
    try {
      const ext = mimeType.split('/')[1] || 'jpg';
      const path = `dpi/${negocio.id}_${Date.now()}.${ext}`;
      const { data } = await uploadsAPI.uploadBase64(base64, path, mimeType);
      if (data?.publicUrl) {
        await negociosAPI.actualizar(negocio.id, { dpi_foto_url: data.publicUrl });
        setDpiUrl(data.publicUrl);
        showToast('✅ Foto del DPI actualizada');
      }
    } catch (e: any) {
      setDpiError(e.message || 'No se pudo subir la foto del DPI');
    } finally {
      setUploadingDpi(false);
    }
  }

  async function subirImagen(base64: string, mimeType: string) {
    if (!negocio?.id) return;
    setUploadingImg(true);
    try {
      const ext = mimeType.split('/')[1] || 'jpg';
      const path = `negocios/${negocio.id}/imagen_${Date.now()}.${ext}`;
      const { data } = await uploadsAPI.uploadBase64(base64, path, mimeType);
      if (data?.publicUrl) {
        await negociosAPI.actualizar(negocio.id, { imagen_url: data.publicUrl });
        setNegocio((n: any) => ({ ...n, imagen_url: data.publicUrl }));
      }
    } catch (e: any) {
      setImgError(e.message || 'No se pudo subir la imagen');
    } finally {
      setUploadingImg(false);
    }
  }

  async function guardar() {
    if (camposPendientes.size === 0) { showToast('No hay cambios para guardar', false); return; }
    setSaving(true);
    setToast(null);
    try {
      const payload: any = { ...form };
      const lat = parseFloat(form.latitud);
      const lng = parseFloat(form.longitud);
      payload.latitud  = isNaN(lat) ? null : lat;
      payload.longitud = isNaN(lng) ? null : lng;
      if (negocio?.estado_verificacion === 'rechazado') payload.estado_verificacion = 'pendiente';
      await negociosAPI.actualizar(negocio.id, payload);
      setCamposPendientes(new Set());
      setOriginalForm({ ...form });
      if (negocio?.estado_verificacion === 'rechazado') {
        setNegocio((n: any) => ({ ...n, estado_verificacion: 'pendiente' }));
        setRechazoInfo(null);
        showToast('✅ Solicitud re-enviada. El equipo de Bocara la revisará en 24-48h.');
      } else {
        showToast('✅ Cambios enviados para revisión del equipo Bocara');
      }
    } catch (e: any) { showToast(e.message || 'Error al guardar', false); }
    finally { setSaving(false); }
  }

  async function geocodificarAhora() {
    if (!form.direccion) { showToast('Ingresa una dirección primero', false); return; }
    setGeoLoading(true);
    try {
      const q = [
        form.direccion,
        form.zona ? `Zona ${form.zona}` : '',
        form.ciudad || 'Guatemala',
        'Guatemala',
      ].filter(Boolean).join(', ');
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=gt`
      );
      const data = await res.json();
      if (data.length > 0) {
        const lat = parseFloat(data[0].lat).toFixed(6);
        const lng = parseFloat(data[0].lon).toFixed(6);
        setForm((f: any) => ({ ...f, latitud: lat, longitud: lng }));
        setCamposPendientes(prev => { const n = new Set(prev); n.add('latitud'); n.add('longitud'); return n; });
        showToast(`✅ ${lat}, ${lng}`);
      } else {
        showToast('Dirección no encontrada. Intenta con más detalles.', false);
      }
    } catch { showToast('Error de conexión al geocodificar', false); }
    finally { setGeoLoading(false); }
  }

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} /></View>;

  const tieneCoordenadas = negocio?.latitud != null && negocio?.longitud != null;

  return (
    <SafeAreaView style={s.root}>
      {/* Input de archivo oculto — solo web, activado via ref desde seleccionarImagen() */}
      {Platform.OS === 'web' && React.createElement('input', {
        ref: fileInputRef,
        type: 'file',
        accept: 'image/*',
        style: { display: 'none' },
        onChange: handleWebFileChange,
      })}
      {Platform.OS === 'web' && React.createElement('input', {
        ref: dpiInputRef,
        type: 'file',
        accept: 'image/*',
        style: { display: 'none' },
        onChange: handleWebDpiChange,
      })}

      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Mi negocio</Text>
          {camposPendientes.size > 0 && (
            <Text style={s.pendienteHint}>⏳ Tienes cambios sin enviar</Text>
          )}
        </View>
        <TouchableOpacity style={[s.saveBtn, camposPendientes.size === 0 && s.saveBtnDisabled]} onPress={guardar} disabled={saving}>
          <Text style={s.saveBtnText}>{saving ? '...' : 'Enviar cambios'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        {toast && (
          <View style={[s.toast, toast.ok ? s.toastOk : s.toastErr]}>
            <Text style={s.toastText}>{toast.msg}</Text>
          </View>
        )}
        {rechazoInfo && (
          <View style={s.rechazoCard}>
            <Text style={s.rechazoTitle}>⚠️ Tu solicitud fue rechazada</Text>
            {rechazoInfo.campos.filter((c: string) => !['otro'].includes(c) && ['nombre_negocio','direccion','telefono','nit','dpi_foto_url','datos_bancarios','imagen_url'].includes(c)).length > 0 && (
              <>
                <Text style={s.rechazoSub}>Corrige los siguientes campos:</Text>
                {rechazoInfo.campos.filter((c: string) => c !== 'otro').map((c: string) => {
                  const labels: Record<string,string> = { nombre_negocio:'Nombre del negocio', direccion:'Dirección', telefono:'Teléfono', nit:'NIT', dpi_foto_url:'Foto del DPI', datos_bancarios:'Datos bancarios', imagen_url:'Foto del negocio' };
                  return labels[c] ? <Text key={c} style={s.rechazoItem}>• {labels[c]}</Text> : null;
                })}
              </>
            )}
            {rechazoInfo.texto ? <Text style={s.rechazoMotivo}>Motivo: {rechazoInfo.texto}</Text> : null}
          </View>
        )}

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
        {imgError ? (
          <View style={s.errorInline}>
            <Text style={s.errorInlineText}>⚠️ {imgError}</Text>
          </View>
        ) : null}

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
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>Información del negocio</Text>
          {(['nombre','descripcion','telefono','categoria'] as const).some(k => camposPendientes.has(k)) && (
            <View style={s.pendienteBadge}><Text style={s.pendienteBadgeText}>⏳ Pendiente</Text></View>
          )}
        </View>
        {[
          { key: 'nombre',      label: 'Nombre del negocio', campo: 'nombre_negocio' },
          { key: 'descripcion', label: 'Descripción', multi: true },
          { key: 'telefono',    label: 'Teléfono', keyboard: 'phone-pad' as any, campo: 'telefono' },
        ].map(({ key, label, multi, keyboard, campo }: any) => (
          <View key={key}>
            <Text style={[s.label, campo && isRejected(campo) && s.labelRejected]}>{label}{campo && isRejected(campo) ? ' ⚠️' : ''}</Text>
            <TextInput
              style={[s.input, multi && { height: 80 }, campo && isRejected(campo) && s.inputRejected]}
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
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>Dirección</Text>
          {(['direccion','zona','ciudad'] as const).some(k => camposPendientes.has(k)) && (
            <View style={s.pendienteBadge}><Text style={s.pendienteBadgeText}>⏳ Pendiente</Text></View>
          )}
        </View>
        {[
          { key: 'direccion', label: 'Dirección', placeholder: '5a Calle 10-35', campo: 'direccion' },
          { key: 'zona',      label: 'Zona / Colonia', placeholder: 'Zona 10' },
          { key: 'ciudad',    label: 'Ciudad', placeholder: 'Guatemala' },
        ].map(({ key, label, placeholder, campo }: any) => (
          <View key={key}>
            <Text style={[s.label, campo && isRejected(campo) && s.labelRejected]}>{label}{campo && isRejected(campo) ? ' ⚠️' : ''}</Text>
            <TextInput style={[s.input, campo && isRejected(campo) && s.inputRejected]} placeholder={placeholder} placeholderTextColor={Colors.textLight} value={form[key]} onChangeText={set(key)} />
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
          <TouchableOpacity style={s.geocodeBtn} onPress={geocodificarAhora} disabled={geoLoading}>
            {geoLoading
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.geocodeBtnText}>🔍 Detectar desde dirección</Text>}
          </TouchableOpacity>
          <Text style={s.coordsHint}>O busca en maps.google.com, haz clic derecho y copia las coordenadas.</Text>
        </View>

        {/* Links de navegación */}
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>Links de navegación 🗺️</Text>
          {(['punto_referencia','google_maps_url','waze_url'] as const).some(k => camposPendientes.has(k)) && (
            <View style={s.pendienteBadge}><Text style={s.pendienteBadgeText}>⏳ Pendiente</Text></View>
          )}
        </View>

        <View style={{ backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#FDE68A' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#92400E', marginBottom: 6 }}>📌 ¿Cómo obtener el link?</Text>
          <Text style={{ fontSize: 12, color: '#B45309', lineHeight: 18 }}>
            {'Google Maps: Abre maps.google.com → busca tu negocio → toca "Compartir" → copia el link.\n\nWaze: Abre waze.com → busca tu dirección → toca los 3 puntos → "Compartir lugar".'}
          </Text>
        </View>

        <Text style={s.label}>Punto de referencia</Text>
        <TextInput
          style={s.input}
          placeholder="Ej. Frente al parque central, local 5"
          placeholderTextColor={Colors.textLight}
          value={form.punto_referencia}
          onChangeText={set('punto_referencia')}
        />

        <Text style={s.label}>Link de Google Maps</Text>
        <TextInput
          style={s.input}
          placeholder="https://maps.app.goo.gl/..."
          placeholderTextColor={Colors.textLight}
          value={form.google_maps_url}
          onChangeText={set('google_maps_url')}
          autoCapitalize="none"
          keyboardType="url"
        />

        <Text style={s.label}>Link de Waze</Text>
        <TextInput
          style={s.input}
          placeholder="https://waze.com/ul?ll=..."
          placeholderTextColor={Colors.textLight}
          value={form.waze_url}
          onChangeText={set('waze_url')}
          autoCapitalize="none"
          keyboardType="url"
        />

        {/* Foto del DPI */}
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>Foto del DPI 🪪</Text>
          {isRejected('dpi_foto_url') && <View style={s.pendienteBadge}><Text style={[s.pendienteBadgeText, { color: '#DC2626' }]}>⚠️ Requiere corrección</Text></View>}
        </View>
        <TouchableOpacity
          style={[s.dpiContainer, isRejected('dpi_foto_url') && { borderColor: '#DC2626' }]}
          onPress={seleccionarDpi}
          disabled={uploadingDpi}
        >
          {dpiUrl ? (
            <Image source={{ uri: dpiUrl }} style={s.dpiImg} contentFit="contain" />
          ) : (
            <View style={s.dpiPlaceholder}>
              <Text style={{ fontSize: 32 }}>🪪</Text>
              <Text style={s.dpiPlaceholderText}>Toca para subir foto del DPI</Text>
              <Text style={{ fontSize: 11, color: Colors.textLight }}>Frente del documento, bien iluminado</Text>
            </View>
          )}
          <View style={[s.imgEditBtn, !dpiUrl && { backgroundColor: 'rgba(245,158,11,0.9)' }]}>
            {uploadingDpi
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.imgEditText}>{dpiUrl ? '📷 Cambiar foto DPI' : '📷 Subir foto DPI'}</Text>
            }
          </View>
        </TouchableOpacity>
        {dpiError ? <View style={s.errorInline}><Text style={s.errorInlineText}>⚠️ {dpiError}</Text></View> : null}

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
  saveBtnDisabled: { backgroundColor: Colors.border },
  saveBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  pendienteHint: { fontSize: 11, color: Colors.orange, fontWeight: '600', marginTop: 2 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, marginTop: 4 },
  pendienteBadge: { backgroundColor: '#FEF3C7', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#FDE68A' },
  pendienteBadgeText: { fontSize: 11, color: '#92400E', fontWeight: '700' },
  scroll: { padding: 16 },
  toast: { borderRadius: 12, padding: 12, marginBottom: 14 },
  toastOk: { backgroundColor: '#DCFCE7' },
  toastErr: { backgroundColor: '#FEE2E2' },
  toastText: { fontSize: 13, fontWeight: '600', color: Colors.brown },
  imgContainer: { borderRadius: 16, overflow: 'hidden', marginBottom: 8, height: 160 },
  imgNegocio: { width: '100%', height: '100%' },
  imgPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.brownLight, justifyContent: 'center', alignItems: 'center', gap: 8 },
  imgPlaceholderText: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
  imgEditBtn: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingVertical: 10, alignItems: 'center' },
  imgEditText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  errorInline: { backgroundColor: '#FEE2E2', borderRadius: 10, padding: 10, marginBottom: 12 },
  errorInlineText: { color: '#B91C1C', fontSize: 13, fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stat: { flex: 1, backgroundColor: Colors.white, borderRadius: 14, padding: 12, alignItems: 'center', elevation: 1 },
  statVal: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2, textAlign: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown },
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
  inputRejected: { borderColor: '#DC2626', borderWidth: 2 },
  labelRejected: { color: '#DC2626' },
  rechazoCard: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1.5, borderColor: '#FCA5A5' },
  rechazoTitle: { fontSize: 14, fontWeight: '800', color: '#DC2626', marginBottom: 6 },
  rechazoSub: { fontSize: 13, color: '#7F1D1D', fontWeight: '600', marginBottom: 4 },
  rechazoItem: { fontSize: 13, color: '#991B1B', paddingVertical: 2, lineHeight: 20 },
  rechazoMotivo: { fontSize: 12, color: '#7F1D1D', marginTop: 8, fontStyle: 'italic' },
  dpiContainer: { borderRadius: 16, overflow: 'hidden', marginBottom: 8, height: 140, borderWidth: 1.5, borderColor: Colors.border },
  dpiImg: { width: '100%', height: '100%' },
  dpiPlaceholder: { width: '100%', height: '100%', backgroundColor: '#FEF3C7', justifyContent: 'center', alignItems: 'center', gap: 6 },
  dpiPlaceholderText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
});
