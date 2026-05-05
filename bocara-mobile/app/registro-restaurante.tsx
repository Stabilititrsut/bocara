import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { uploadsAPI, negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { Image } from 'expo-image';

let ImagePicker: any = null;
try { ImagePicker = require('expo-image-picker'); } catch { }

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];
const BANCOS_GT = ['Banrural', 'Banco Industrial', 'BAC Credomatic', 'Agromercantil', 'G&T Continental', 'Bantrab', 'Banpaís', 'Otro'];
const TIPOS_CUENTA = ['Monetaria', 'Ahorro', 'Empresarial'];
const ZONAS_GT = ['Zona 1', 'Zona 2', 'Zona 3', 'Zona 4', 'Zona 5', 'Zona 6', 'Zona 7', 'Zona 8', 'Zona 9', 'Zona 10', 'Zona 11', 'Zona 12', 'Zona 13', 'Zona 14', 'Zona 15', 'Mixco', 'Villa Nueva'];

type Step = 1 | 2 | 3 | 4;

export default function RegistroRestauranteScreen() {
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState({
    // Paso 1: datos del propietario
    nombre: '', apellido: '', email: '', password: '', telefono: '',
    // Paso 2: datos del negocio
    nombre_negocio: '', descripcion: '', categoria: '',
    direccion_negocio: '', zona: '', horario_atencion: '',
    nit: '', dpi: '',
    // Paso 3: datos bancarios
    banco: '', numero_cuenta: '', tipo_cuenta: 'Monetaria', titular_cuenta: '',
    // Paso 4: fotos (uris locales)
    foto_perfil_uri: '',
  });
  const [loading, setLoading] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const { registroRestaurante } = useAuth();
  const router = useRouter();
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function seleccionarFoto() {
    if (!ImagePicker) return Alert.alert('No disponible', 'La subida de fotos no está disponible aquí.');
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permiso requerido', 'Necesitamos acceso a tu galería.');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [1, 1], quality: 0.8,
    });
    if (result.canceled || !result.assets?.length) return;
    setForm(f => ({ ...f, foto_perfil_uri: result.assets[0].uri }));
  }

  async function handleRegistro() {
    if (!form.nombre || !form.email || !form.password || !form.nombre_negocio)
      return Alert.alert('Campos requeridos', 'Nombre, email, contraseña y nombre del negocio son obligatorios.');
    if (form.password.length < 6)
      return Alert.alert('Contraseña muy corta', 'Mínimo 6 caracteres.');

    setLoading(true);
    try {
      const datos_bancarios = (form.banco || form.numero_cuenta) ? {
        banco: form.banco,
        numero_cuenta: form.numero_cuenta,
        tipo_cuenta: form.tipo_cuenta,
        titular: form.titular_cuenta || `${form.nombre} ${form.apellido}`.trim(),
      } : undefined;

      await registroRestaurante({
        nombre: form.nombre,
        apellido: form.apellido,
        email: form.email,
        password: form.password,
        telefono: form.telefono,
        nombre_negocio: form.nombre_negocio,
        descripcion: form.descripcion,
        categoria: form.categoria || 'Restaurante',
        direccion_negocio: form.direccion_negocio,
        zona: form.zona,
        horario_atencion: form.horario_atencion,
        nit: form.nit,
        dpi: form.dpi,
        datos_bancarios,
      });

      // Subir foto si hay una seleccionada
      if (form.foto_perfil_uri) {
        try {
          setUploadingImg(true);
          const ext = form.foto_perfil_uri.split('.').pop()?.split('?')[0] || 'jpg';
          const path = `negocios/registro_${Date.now()}.${ext}`;
          const { data } = await uploadsAPI.getSignedUrl(path);
          const blob = await fetch(form.foto_perfil_uri).then(r => r.blob());
          await fetch(data.signedUrl, { method: 'PUT', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
          const { data: negocio } = await negociosAPI.miNegocio();
          if (negocio?.id) await negociosAPI.actualizar(negocio.id, { imagen_url: data.publicUrl });
        } catch { }
        setUploadingImg(false);
      }

      Alert.alert(
        '¡Solicitud enviada! 🎉',
        'Tu negocio está en revisión. El equipo de Bocara revisará tu información y te notificaremos cuando esté aprobado (normalmente en 24-48h).',
        [{ text: 'Entendido', style: 'default' }]
      );
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
      setUploadingImg(false);
    }
  }

  function nextStep() {
    if (step === 1) {
      if (!form.nombre || !form.email || !form.password)
        return Alert.alert('Completa los datos', 'Nombre, email y contraseña son obligatorios.');
      if (form.password.length < 6) return Alert.alert('Contraseña', 'Mínimo 6 caracteres.');
    }
    if (step === 2 && !form.nombre_negocio)
      return Alert.alert('Completa los datos', 'El nombre del negocio es obligatorio.');
    setStep(s => Math.min(s + 1, 4) as Step);
  }

  const steps = ['Propietario', 'Negocio', 'Bancario', 'Foto'];

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => step > 1 ? setStep(s => (s - 1) as Step) : router.back()} style={s.back}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Registra tu negocio</Text>
          <Text style={s.headerSub}>Paso {step} de 4</Text>
        </View>
      </View>

      {/* Indicador de pasos */}
      <View style={s.stepsRow}>
        {steps.map((label, i) => (
          <View key={label} style={s.stepItem}>
            <View style={[s.stepDot, i + 1 <= step && s.stepDotActive, i + 1 < step && s.stepDotDone]}>
              <Text style={[s.stepDotText, i + 1 <= step && s.stepDotTextActive]}>
                {i + 1 < step ? '✓' : String(i + 1)}
              </Text>
            </View>
            <Text style={[s.stepLabel, i + 1 === step && s.stepLabelActive]}>{label}</Text>
            {i < steps.length - 1 && <View style={[s.stepLine, i + 1 < step && s.stepLineDone]} />}
          </View>
        ))}
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* ─── PASO 1: Datos del propietario ─── */}
        {step === 1 && (
          <>
            <Text style={s.section}>👤 Datos del propietario</Text>
            {[
              { key: 'nombre',   label: 'Nombre *',     placeholder: 'María' },
              { key: 'apellido', label: 'Apellido',      placeholder: 'González' },
              { key: 'email',    label: 'Correo *',      placeholder: 'maria@negocio.com', keyboard: 'email-address' as any, lower: true },
              { key: 'password', label: 'Contraseña *',  placeholder: 'Mínimo 6 caracteres', secure: true },
              { key: 'telefono', label: 'Teléfono',      placeholder: '5555-1234', keyboard: 'phone-pad' as any },
            ].map(({ key, label, placeholder, keyboard, secure, lower }) => (
              <View key={key}>
                <Text style={s.label}>{label}</Text>
                <TextInput
                  style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
                  keyboardType={keyboard || 'default'} autoCapitalize={lower ? 'none' : 'words'}
                  secureTextEntry={secure} value={(form as any)[key]} onChangeText={set(key)}
                />
              </View>
            ))}
          </>
        )}

        {/* ─── PASO 2: Datos del negocio ─── */}
        {step === 2 && (
          <>
            <Text style={s.section}>🍽️ Información del negocio</Text>
            {[
              { key: 'nombre_negocio', label: 'Nombre del negocio *', placeholder: 'Panadería San Marcos' },
              { key: 'descripcion',    label: 'Descripción',          placeholder: 'Somos una panadería artesanal...', multi: true },
              { key: 'nit',            label: 'NIT',                  placeholder: '1234567-8' },
              { key: 'dpi',            label: 'DPI del propietario',  placeholder: '1234 12345 1234' },
              { key: 'direccion_negocio', label: 'Dirección',         placeholder: '5a Avenida 10-35' },
              { key: 'horario_atencion',  label: 'Horario de atención', placeholder: 'Lunes a Viernes 7am - 9pm' },
            ].map(({ key, label, placeholder, multi }) => (
              <View key={key}>
                <Text style={s.label}>{label}</Text>
                <TextInput
                  style={[s.input, multi && { height: 80 }]}
                  placeholder={placeholder} placeholderTextColor={Colors.textLight}
                  value={(form as any)[key]} onChangeText={set(key)}
                  multiline={multi} textAlignVertical={multi ? 'top' : 'center'}
                />
              </View>
            ))}

            <Text style={s.label}>Zona / Sector</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }} contentContainerStyle={{ gap: 8 }}>
              {ZONAS_GT.map((z) => (
                <TouchableOpacity key={z} style={[s.chip, form.zona === z && s.chipActive]} onPress={() => setForm(f => ({ ...f, zona: z }))}>
                  <Text style={[s.chipText, form.zona === z && s.chipTextActive]}>{z}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={s.label}>Categoría</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }} contentContainerStyle={{ gap: 8 }}>
              {CATEGORIAS.map((cat) => (
                <TouchableOpacity key={cat} style={[s.chip, form.categoria === cat && s.chipActive]} onPress={() => setForm(f => ({ ...f, categoria: cat }))}>
                  <Text style={[s.chipText, form.categoria === cat && s.chipTextActive]}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        {/* ─── PASO 3: Datos bancarios ─── */}
        {step === 3 && (
          <>
            <Text style={s.section}>🏦 Datos bancarios</Text>
            <View style={s.infoCard}>
              <Text style={s.infoText}>Estos datos se usan para transferirte el 75% de tus ventas cada semana. Son completamente seguros y solo los ve el equipo de Bocara.</Text>
            </View>

            <Text style={s.label}>Banco</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }} contentContainerStyle={{ gap: 8 }}>
              {BANCOS_GT.map((b) => (
                <TouchableOpacity key={b} style={[s.chip, form.banco === b && s.chipActive]} onPress={() => setForm(f => ({ ...f, banco: b }))}>
                  <Text style={[s.chipText, form.banco === b && s.chipTextActive]}>{b}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={s.label}>Tipo de cuenta</Text>
            <View style={s.row}>
              {TIPOS_CUENTA.map((t) => (
                <TouchableOpacity key={t} style={[s.chipSmall, form.tipo_cuenta === t && s.chipActive]} onPress={() => setForm(f => ({ ...f, tipo_cuenta: t }))}>
                  <Text style={[s.chipText, form.tipo_cuenta === t && s.chipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {[
              { key: 'numero_cuenta',   label: 'Número de cuenta', placeholder: '000-000000-00', keyboard: 'numeric' as any },
              { key: 'titular_cuenta',  label: 'Titular de la cuenta', placeholder: 'María González' },
            ].map(({ key, label, placeholder, keyboard }) => (
              <View key={key}>
                <Text style={s.label}>{label}</Text>
                <TextInput
                  style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
                  keyboardType={keyboard || 'default'} value={(form as any)[key]} onChangeText={set(key)}
                />
              </View>
            ))}

            <Text style={s.optionalNote}>* Los datos bancarios son opcionales. Puedes agregarlos después desde tu panel.</Text>
          </>
        )}

        {/* ─── PASO 4: Foto y confirmación ─── */}
        {step === 4 && (
          <>
            <Text style={s.section}>📸 Foto del negocio</Text>
            <Text style={s.optionalNote}>Opcional. Puedes subir una foto ahora o después desde tu panel.</Text>

            <TouchableOpacity style={s.fotoBtn} onPress={seleccionarFoto}>
              {form.foto_perfil_uri ? (
                <Image source={{ uri: form.foto_perfil_uri }} style={s.fotoPreview} contentFit="cover" />
              ) : (
                <View style={s.fotoPlaceholder}>
                  <Text style={{ fontSize: 48 }}>🏪</Text>
                  <Text style={s.fotoPlaceholderText}>Toca para seleccionar foto</Text>
                </View>
              )}
              <View style={s.fotoOverlay}>
                <Text style={s.fotoOverlayText}>📷 {form.foto_perfil_uri ? 'Cambiar foto' : 'Agregar foto'}</Text>
              </View>
            </TouchableOpacity>

            <View style={s.resumenCard}>
              <Text style={s.resumenTitle}>Resumen de tu registro</Text>
              {[
                { label: 'Propietario', val: `${form.nombre} ${form.apellido}` },
                { label: 'Email', val: form.email },
                { label: 'Negocio', val: form.nombre_negocio },
                { label: 'Categoría', val: form.categoria || 'Restaurante' },
                { label: 'Dirección', val: `${form.direccion_negocio}${form.zona ? `, ${form.zona}` : ''}` },
                { label: 'Banco', val: form.banco || 'No especificado' },
              ].map(({ label, val }) => val ? (
                <View key={label} style={s.resumenRow}>
                  <Text style={s.resumenLabel}>{label}</Text>
                  <Text style={s.resumenVal}>{val}</Text>
                </View>
              ) : null)}
            </View>

            <View style={s.pendienteInfo}>
              <Text style={{ fontSize: 24 }}>⏳</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.pendienteTitle}>Estado: En revisión</Text>
                <Text style={s.pendienteSub}>Recibirás una notificación cuando tu negocio sea aprobado (24-48 horas).</Text>
              </View>
            </View>
          </>
        )}

        {/* Botones de navegación */}
        <View style={s.btnRow}>
          {step < 4 ? (
            <TouchableOpacity style={s.btnNext} onPress={nextStep}>
              <Text style={s.btnNextText}>Siguiente →</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.btnSubmit} onPress={handleRegistro} disabled={loading || uploadingImg}>
              {loading || uploadingImg ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Text style={s.btnSubmitText}>🚀 Enviar solicitud</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', padding: 16, paddingTop: 52, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  back: { padding: 8, marginRight: 8 },
  backText: { fontSize: 22, color: Colors.orange, fontWeight: '700' },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown },
  headerSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  stepsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.white, paddingHorizontal: 16, paddingBottom: 16, gap: 0 },
  stepItem: { flexDirection: 'row', alignItems: 'center' },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.border, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: Colors.border },
  stepDotActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  stepDotDone: { backgroundColor: Colors.green, borderColor: Colors.green },
  stepDotText: { fontSize: 12, fontWeight: '800', color: Colors.textLight },
  stepDotTextActive: { color: Colors.white },
  stepLabel: { fontSize: 10, color: Colors.textLight, fontWeight: '600', marginHorizontal: 4 },
  stepLabelActive: { color: Colors.orange, fontWeight: '800' },
  stepLine: { width: 20, height: 2, backgroundColor: Colors.border, marginHorizontal: 2 },
  stepLineDone: { backgroundColor: Colors.green },
  scroll: { padding: 20 },
  section: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 16, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 16,
  },
  row: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.white },
  chipSmall: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.white },
  chipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  infoCard: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 14, marginBottom: 20 },
  infoText: { fontSize: 13, color: Colors.brown, lineHeight: 20 },
  optionalNote: { fontSize: 12, color: Colors.textLight, marginBottom: 16, fontStyle: 'italic' },
  fotoBtn: { borderRadius: 16, overflow: 'hidden', height: 180, marginBottom: 20 },
  fotoPreview: { width: '100%', height: '100%' },
  fotoPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.brownLight, alignItems: 'center', justifyContent: 'center', gap: 8 },
  fotoPlaceholderText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  fotoOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)', paddingVertical: 10, alignItems: 'center' },
  fotoOverlayText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  resumenCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  resumenTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  resumenRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  resumenLabel: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  resumenVal: { fontSize: 13, color: Colors.textPrimary, fontWeight: '700', flex: 1, textAlign: 'right', marginLeft: 8 },
  pendienteInfo: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF3C7', borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: '#F59E0B40' },
  pendienteTitle: { fontSize: 14, fontWeight: '800', color: '#92400E' },
  pendienteSub: { fontSize: 12, color: '#B45309', marginTop: 2, lineHeight: 18 },
  btnRow: { marginTop: 8 },
  btnNext: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center' },
  btnNextText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  btnSubmit: { backgroundColor: Colors.green, borderRadius: 14, padding: 16, alignItems: 'center' },
  btnSubmitText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
