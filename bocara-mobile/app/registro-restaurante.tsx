import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useAuth } from '@/src/context/AuthContext';
import { negociosAPI, uploadsAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { Image } from 'expo-image';

let ImagePicker: any = null;
try { ImagePicker = require('expo-image-picker'); } catch { }

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];

const CAMPO_LABELS_ES: Record<string, string> = {
  nombre_negocio: 'Nombre del negocio',
  direccion: 'Dirección',
  telefono: 'Teléfono',
  nit: 'NIT',
  dpi_foto_url: 'Foto del DPI',
  datos_bancarios: 'Datos bancarios',
  imagen_url: 'Foto del negocio',
};
const BANCOS_GT  = ['Banrural', 'Banco Industrial', 'BAC Credomatic', 'Agromercantil', 'G&T Continental', 'Bantrab', 'Banpaís', 'Otro'];
const TIPOS_CUENTA = ['Monetaria', 'Ahorro', 'Empresarial'];
const ZONAS_GT = [
  'Zona 1','Zona 2','Zona 3','Zona 4','Zona 5','Zona 6','Zona 7','Zona 8',
  'Zona 9','Zona 10','Zona 11','Zona 12','Zona 13','Zona 14','Zona 15','Mixco','Villa Nueva',
];

type Step = 1 | 2 | 3 | 4;

type FormState = {
  nombre: string; apellido: string; email: string; password: string; confirmPassword: string; telefono: string;
  nombre_negocio: string; descripcion: string; categoria: string; categoria_otro: string;
  direccion_negocio: string; zona: string; horario_atencion: string;
  nit: string; dpi: string;
  banco: string; banco_otro: string; numero_cuenta: string; tipo_cuenta: string; titular_cuenta: string;
  dpi_foto_uri: string; dpi_foto_base64: string;
  foto_negocio_uri: string; foto_negocio_base64: string;
  latitud: string; longitud: string;
};

export default function RegistroRestauranteScreen() {
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormState>({
    nombre: '', apellido: '', email: '', password: '', confirmPassword: '', telefono: '',
    nombre_negocio: '', descripcion: '', categoria: '', categoria_otro: '',
    direccion_negocio: '', zona: '', horario_atencion: '',
    nit: '', dpi: '',
    banco: '', banco_otro: '', numero_cuenta: '', tipo_cuenta: 'Monetaria', titular_cuenta: '',
    dpi_foto_uri: '', dpi_foto_base64: '',
    foto_negocio_uri: '', foto_negocio_base64: '',
    latitud: '', longitud: '',
  });
  const [locCapturando, setLocCapturando] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [rechazoInfo, setRechazoInfo] = useState<{ texto: string; campos: string[] } | null>(null);

  const { registroRestaurante } = useAuth();
  const router = useRouter();

  useEffect(() => {
    negociosAPI.miNegocio()
      .then(res => {
        const neg = res.data;
        if (neg?.estado_verificacion === 'rechazado' && neg.motivo_rechazo) {
          try {
            const parsed = JSON.parse(neg.motivo_rechazo);
            setRechazoInfo({ texto: parsed.texto || '', campos: Array.isArray(parsed.campos) ? parsed.campos : [] });
          } catch {
            setRechazoInfo({ texto: neg.motivo_rechazo, campos: [] });
          }
        }
      })
      .catch(() => {});
  }, []);

  const set = (k: keyof FormState) => (v: string) => {
    setForm(f => ({ ...f, [k]: v }));
    setErrors(e => ({ ...e, [k]: '' }));
  };

  // ── Geocodificar por dirección (funciona en web y nativo) ────────────────
  async function geocodificarDireccion() {
    if (!form.direccion_negocio.trim()) {
      Alert.alert('Dirección requerida', 'Ingresa primero la dirección del negocio.');
      return;
    }
    setLocCapturando(true);
    try {
      const q = [
        form.direccion_negocio,
        form.zona ? `Zona ${form.zona}` : '',
        'Guatemala',
      ].filter(Boolean).join(', ');
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=gt`
      );
      const data = await res.json();
      if (data.length > 0) {
        const lat = parseFloat(data[0].lat).toFixed(6);
        const lng = parseFloat(data[0].lon).toFixed(6);
        setForm(f => ({ ...f, latitud: lat, longitud: lng }));
        Alert.alert('✅ Coordenadas obtenidas', `Lat: ${lat}\nLng: ${lng}`);
      } else {
        Alert.alert('No encontrado', 'No se pudo geocodificar esa dirección. Intenta con más detalles o usa el GPS.');
      }
    } catch {
      Alert.alert('Error', 'No se pudo conectar al servicio de geocodificación. Verifica tu conexión.');
    } finally {
      setLocCapturando(false);
    }
  }

  // ── GPS ──────────────────────────────────────────────────────────────────
  async function capturarUbicacion() {
    setLocCapturando(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permiso de ubicación', 'Necesitamos acceso a tu ubicación para registrar las coordenadas del negocio.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      setForm(f => ({ ...f, latitud: String(latitude), longitud: String(longitude) }));
    } catch {
      Alert.alert('Error de GPS', 'No se pudo obtener la ubicación. Puedes agregarla manualmente después.');
    } finally {
      setLocCapturando(false);
    }
  }

  // ── Foto picker ───────────────────────────────────────────────────────────
  async function seleccionarFoto(tipo: 'dpi' | 'negocio') {
    if (Platform.OS === 'web') {
      const input = (document as any).createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = (e: any) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        const reader = new (window as any).FileReader();
        reader.onload = (ev: any) => {
          const dataUrl: string = ev.target.result;
          const base64 = dataUrl.split(',')[1] ?? '';
          if (tipo === 'dpi') setForm(f => ({ ...f, dpi_foto_uri: dataUrl, dpi_foto_base64: base64 }));
          else setForm(f => ({ ...f, foto_negocio_uri: dataUrl, foto_negocio_base64: base64 }));
        };
        reader.readAsDataURL(file);
      };
      input.click(); return;
    }
    if (!ImagePicker) return Alert.alert('No disponible', 'La subida de fotos no está disponible en este dispositivo.');
    try { await ImagePicker.requestMediaLibraryPermissionsAsync(); } catch {}
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: tipo === 'dpi' ? [16, 9] : [1, 1], quality: 0.7, base64: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    if (tipo === 'dpi') setForm(f => ({ ...f, dpi_foto_uri: asset.uri, dpi_foto_base64: asset.base64 || '' }));
    else setForm(f => ({ ...f, foto_negocio_uri: asset.uri, foto_negocio_base64: asset.base64 || '' }));
  }

  // ── Validación por paso ───────────────────────────────────────────────────
  function validarPaso(): boolean {
    const e: Record<string, string> = {};
    if (step === 1) {
      if (!form.nombre.trim())   e.nombre   = 'El nombre es obligatorio';
      if (!form.apellido.trim()) e.apellido  = 'El apellido es obligatorio';
      if (!form.email.trim())    e.email     = 'El correo electrónico es obligatorio';
      else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Ingresa un correo electrónico válido';
      if (!form.password)        e.password  = 'La contraseña es obligatoria';
      else if (form.password.length < 6) e.password = 'La contraseña debe tener al menos 6 caracteres';
      if (!form.confirmPassword) e.confirmPassword = 'Confirma tu contraseña';
      else if (form.password !== form.confirmPassword) e.confirmPassword = 'Las contraseñas no coinciden';
      if (!form.telefono.trim()) e.telefono  = 'El teléfono es obligatorio';
    }
    if (step === 2) {
      if (!form.nombre_negocio.trim())    e.nombre_negocio    = 'El nombre del negocio es obligatorio';
      if (!form.descripcion.trim())       e.descripcion       = 'La descripción es obligatoria';
      if (!form.nit.trim())               e.nit               = 'El NIT es obligatorio';
      else if (!/^\d{7,9}-?[\dKk]$/i.test(form.nit.trim()))
        e.nit = 'Formato inválido. Ej: 1234567-8  (7–9 dígitos + guión + 1 dígito)';
      if (!form.dpi.trim())               e.dpi               = 'El DPI es obligatorio';
      else if (form.dpi.replace(/\s/g, '').length !== 13)
        e.dpi = 'El DPI debe tener exactamente 13 dígitos';
      if (!form.direccion_negocio.trim()) e.direccion_negocio = 'La dirección es obligatoria';
      if (!form.horario_atencion.trim())  e.horario_atencion  = 'El horario de atención es obligatorio';
      if (!form.zona)                     e.zona              = 'Selecciona una zona o sector';
      if (!form.categoria)                e.categoria         = 'Selecciona la categoría del negocio';
      else if (form.categoria === 'Otro' && !form.categoria_otro.trim())
        e.categoria_otro = 'Escribe la categoría de tu negocio';
      if (!form.foto_negocio_uri)         e.foto_negocio      = 'La foto del negocio es obligatoria';
    }
    if (step === 3) {
      if (!form.banco)                    e.banco            = 'Selecciona un banco';
      else if (form.banco === 'Otro' && !form.banco_otro.trim())
        e.banco_otro = 'Escribe el nombre de tu banco';
      if (!form.numero_cuenta.trim())     e.numero_cuenta    = 'El número de cuenta es obligatorio';
      if (!form.titular_cuenta.trim())    e.titular_cuenta   = 'El titular de la cuenta es obligatorio';
    }
    if (step === 4) {
      if (!form.dpi_foto_uri && !form.dpi_foto_base64)
        e.dpi_foto = 'La foto del DPI es obligatoria para verificar tu identidad';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Navegación entre pasos — sin correo en el medio ──────────────────────
  function nextStep() {
    if (!validarPaso()) return;
    setStep(s => Math.min(s + 1, 4) as Step);
  }

  // ── Subir foto base64 ─────────────────────────────────────────────────────
  async function subirFotoBase64(base64: string, path: string): Promise<string | null> {
    if (!base64) return null;
    try {
      const { data } = await uploadsAPI.uploadBase64(base64, path);
      return data?.publicUrl || null;
    } catch (e: any) {
      console.warn('Error subiendo foto:', e.message);
      return null;
    }
  }

  // ── Envío final: crear cuenta + negocio ───────────────────────────────────
  async function handleRegistro() {
    if (!validarPaso()) return;
    setLoading(true);
    setSubmitError('');
    setUploadStatus('Creando cuenta...');
    try {
      const categoriaFinal = form.categoria === 'Otro' ? form.categoria_otro.trim() : form.categoria;
      const nombreBanco    = form.banco === 'Otro' ? form.banco_otro : form.banco;
      const datos_bancarios = {
        banco: nombreBanco, numero_cuenta: form.numero_cuenta,
        tipo_cuenta: form.tipo_cuenta, titular: form.titular_cuenta,
      };
      const lat = form.latitud ? parseFloat(form.latitud) : undefined;
      const lng = form.longitud ? parseFloat(form.longitud) : undefined;

      await registroRestaurante({
        nombre: form.nombre.trim(), apellido: form.apellido.trim(),
        email: form.email.trim().toLowerCase(), password: form.password,
        telefono: form.telefono.trim(), nombre_negocio: form.nombre_negocio.trim(),
        descripcion: form.descripcion.trim(), categoria: categoriaFinal,
        direccion_negocio: form.direccion_negocio.trim(), zona: form.zona,
        horario_atencion: form.horario_atencion.trim(),
        nit: form.nit.trim(), dpi: form.dpi.replace(/\s/g, ''),
        datos_bancarios, latitud: lat, longitud: lng,
      });

      setUploadStatus('Subiendo documentos...');
      let negocioId = '';
      try { negocioId = (await negociosAPI.miNegocio()).data?.id || ''; } catch {}

      if (negocioId) {
        let dpi_foto_url: string | null = null;
        let imagen_url:   string | null = null;
        if (form.dpi_foto_base64) {
          setUploadStatus('Subiendo foto del DPI...');
          dpi_foto_url = await subirFotoBase64(form.dpi_foto_base64, `dpi/${negocioId}_${Date.now()}.jpg`);
        }
        if (form.foto_negocio_base64) {
          setUploadStatus('Subiendo foto del negocio...');
          imagen_url = await subirFotoBase64(form.foto_negocio_base64, `negocios/${negocioId}_${Date.now()}.jpg`);
        }
        if (dpi_foto_url || imagen_url) {
          const updates: Record<string, string> = {};
          if (dpi_foto_url) updates.dpi_foto_url = dpi_foto_url;
          if (imagen_url)   updates.imagen_url   = imagen_url;
          try { await negociosAPI.actualizar(negocioId, updates); } catch {}
        }
      }
      setSubmitted(true);
    } catch (e: any) {
      setSubmitError(e.message || 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
      setUploadStatus('');
    }
  }

  const steps = ['Propietario', 'Negocio', 'Bancario', 'Documentos'];
  const nitLen = form.nit.length;
  const dpiLen = form.dpi.replace(/\s/g, '').length;

  // ── Pantalla de confirmación ──────────────────────────────────────────────
  if (submitted) {
    const categoriaFinal = form.categoria === 'Otro' ? form.categoria_otro : form.categoria;
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={sc.scroll}>
          <View style={sc.iconWrap}><Text style={sc.icon}>✅</Text></View>
          <Text style={sc.title}>¡Solicitud enviada!</Text>
          <Text style={sc.subtitle}>
            Revisaremos tu información en las próximas 24 a 48 horas. Recibirás un correo de confirmación.
          </Text>
          <View style={sc.timeCard}>
            <Text style={sc.timeIcon}>⏳</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={sc.timeTitle}>Tiempo de revisión: 24 – 48 horas</Text>
              <Text style={sc.timeSub}>Recibirás una notificación cuando tu negocio sea aprobado.</Text>
            </View>
          </View>
          <View style={sc.credCard}>
            <Text style={sc.credTitle}>🔑 Tus credenciales de acceso</Text>
            <View style={sc.credRow}>
              <Text style={sc.credLabel}>Usuario (correo)</Text>
              <Text style={sc.credEmail}>{form.email}</Text>
            </View>
            <View style={sc.credWarning}>
              <Text style={sc.credWarningText}>⚠️ Guarda tu contraseña en un lugar seguro.</Text>
            </View>
          </View>
          <View style={sc.summaryCard}>
            <Text style={sc.summaryTitle}>📋 Datos registrados</Text>
            {[
              { label: 'Propietario', val: `${form.nombre} ${form.apellido}`.trim() },
              { label: 'Email',       val: form.email },
              { label: 'Teléfono',    val: form.telefono },
              { label: 'Negocio',     val: form.nombre_negocio },
              { label: 'Categoría',   val: categoriaFinal },
              { label: 'Dirección',   val: `${form.direccion_negocio}, ${form.zona}` },
              { label: 'Horario',     val: form.horario_atencion },
            ].map(({ label, val }) => val ? (
              <View key={label} style={sc.row}>
                <Text style={sc.rowLabel}>{label}</Text>
                <Text style={sc.rowVal} numberOfLines={1}>{val}</Text>
              </View>
            ) : null)}
          </View>
          <TouchableOpacity style={sc.btn} onPress={() => router.replace('/restaurante')}>
            <Text style={sc.btnText}>Ir a mi panel →</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => step > 1 ? setStep(n => (n - 1) as Step) : router.back()} style={s.back}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Registra tu negocio</Text>
          <Text style={s.headerSub}>Paso {step} de 4</Text>
        </View>
      </View>

      {/* ── Step indicator ── */}
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

        {/* Banner rechazo */}
        {rechazoInfo && (
          <View style={s.rechazoCard}>
            <Text style={s.rechazoTitle}>⚠️ Tu solicitud fue rechazada</Text>
            {rechazoInfo.campos.filter(c => CAMPO_LABELS_ES[c]).length > 0 && (
              <>
                <Text style={s.rechazoSub}>Corrige los siguientes campos:</Text>
                {rechazoInfo.campos.filter(c => CAMPO_LABELS_ES[c]).map(c => (
                  <Text key={c} style={s.rechazoItem}>• {CAMPO_LABELS_ES[c]}</Text>
                ))}
              </>
            )}
            {rechazoInfo.texto ? <Text style={s.rechazoMotivo}>Motivo: {rechazoInfo.texto}</Text> : null}
          </View>
        )}

        {/* ─── PASO 1: Propietario ─── */}
        {step === 1 && (
          <>
            <Text style={s.section}>👤 Datos del propietario</Text>
            <View style={s.infoCard}>
              <Text style={s.infoText}>📧 Tu correo electrónico será tu usuario para iniciar sesión en Bocara.</Text>
            </View>
            <Field label="Nombre *"              value={form.nombre}          onChange={set('nombre')}          placeholder="María"              error={errors.nombre} />
            <Field label="Apellido *"            value={form.apellido}        onChange={set('apellido')}        placeholder="González"           error={errors.apellido} />
            <Field label="Correo electrónico *"  value={form.email}           onChange={set('email')}           placeholder="maria@negocio.com"  keyboard="email-address" lower error={errors.email} />
            <Field label="Contraseña *"          value={form.password}        onChange={set('password')}        placeholder="Mínimo 6 caracteres" secure error={errors.password} />
            <Field label="Confirmar contraseña *" value={form.confirmPassword} onChange={set('confirmPassword')} placeholder="Repite tu contraseña" secure error={errors.confirmPassword} />
            <Field label="Teléfono *"            value={form.telefono}        onChange={set('telefono')}        placeholder="5555-1234"          keyboard="phone-pad" error={errors.telefono} />
          </>
        )}

        {/* ─── PASO 2: Negocio ─── */}
        {step === 2 && (
          <>
            <Text style={s.section}>🍽️ Información del negocio</Text>
            <Field label="Nombre del negocio *" value={form.nombre_negocio} onChange={set('nombre_negocio')} placeholder="Panadería San Marcos" error={errors.nombre_negocio} />
            <Field label="Descripción *"        value={form.descripcion}    onChange={set('descripcion')}    placeholder="Somos una panadería artesanal..." multi error={errors.descripcion} />

            {/* NIT */}
            <View>
              <View style={s.labelRow}>
                <Text style={s.label}>NIT *</Text>
                <Text style={[s.counter, nitLen > 10 && s.counterError]}>{nitLen}/10</Text>
              </View>
              <TextInput style={[s.input, errors.nit && s.inputError]} placeholder="Ej: 1234567-8" placeholderTextColor={Colors.textLight} value={form.nit} onChangeText={v => set('nit')(v)} maxLength={11} />
              <Text style={s.fieldHint}>7–9 dígitos + guión + 1 dígito. Ej: 1234567-8</Text>
              {errors.nit ? <Text style={s.fieldError}>{errors.nit}</Text> : null}
            </View>

            {/* DPI */}
            <View>
              <View style={s.labelRow}>
                <Text style={s.label}>DPI del propietario *</Text>
                <Text style={[s.counter, dpiLen > 13 && s.counterError, dpiLen === 13 && s.counterOk]}>{dpiLen}/13</Text>
              </View>
              <TextInput style={[s.input, errors.dpi && s.inputError]} placeholder="1234 12345 1234  (13 dígitos)" placeholderTextColor={Colors.textLight} value={form.dpi} onChangeText={v => set('dpi')(v.replace(/[^\d\s]/g, ''))} keyboardType="numeric" maxLength={15} />
              <Text style={s.fieldHint}>Exactamente 13 dígitos numéricos</Text>
              {errors.dpi ? <Text style={s.fieldError}>{errors.dpi}</Text> : null}
            </View>

            <Field label="Dirección *" value={form.direccion_negocio} onChange={set('direccion_negocio')} placeholder="5a Avenida 10-35, Zona 1" error={errors.direccion_negocio} />

            {/* GPS */}
            <View style={s.gpsCard}>
              <View style={s.gpsHeader}>
                <Text style={s.gpsTitle}>📍 Ubicación en el mapa</Text>
                {form.latitud
                  ? <View style={s.gpsBadgeOk}><Text style={s.gpsBadgeText}>✓ GPS capturado</Text></View>
                  : <View style={s.gpsBadgeMissing}><Text style={s.gpsBadgeText}>Sin GPS</Text></View>
                }
              </View>
              {form.latitud ? (
                <Text style={s.gpsCoordsText}>Lat: {parseFloat(form.latitud).toFixed(6)}{'\n'}Lng: {parseFloat(form.longitud).toFixed(6)}</Text>
              ) : (
                <Text style={s.gpsWarn}>Para mostrar tu negocio a clientes cercanos, necesitamos una ubicación exacta.</Text>
              )}
              <TouchableOpacity style={[s.gpsBtn, { backgroundColor: '#2563EB', marginBottom: 8 }]} onPress={geocodificarDireccion} disabled={locCapturando}>
                {locCapturando
                  ? <ActivityIndicator color={Colors.white} size="small" />
                  : <Text style={s.gpsBtnText}>📍 Geocodificar dirección</Text>
                }
              </TouchableOpacity>
              <TouchableOpacity style={s.gpsBtn} onPress={capturarUbicacion} disabled={locCapturando}>
                {locCapturando
                  ? <ActivityIndicator color={Colors.white} size="small" />
                  : <Text style={s.gpsBtnText}>{form.latitud ? '📡 Actualizar ubicación GPS' : '📡 Usar GPS del dispositivo'}</Text>
                }
              </TouchableOpacity>
              {!form.latitud && <Text style={s.gpsSkipHint}>Puedes agregar la ubicación después desde tu panel.</Text>}
            </View>

            {/* Horario */}
            <View>
              <Text style={s.label}>Horario de atención *</Text>
              <TextInput style={[s.input, errors.horario_atencion && s.inputError]} placeholder="Ej: Lunes a Viernes 7:00am - 9:00pm" placeholderTextColor={Colors.textLight} value={form.horario_atencion} onChangeText={set('horario_atencion')} />
              {errors.horario_atencion ? <Text style={s.fieldError}>{errors.horario_atencion}</Text> : null}
            </View>

            {/* Zona */}
            <Text style={s.label}>Zona / Sector *</Text>
            <View style={s.chipsWrap}>
              {ZONAS_GT.map((z) => (
                <TouchableOpacity key={z} style={[s.chip, form.zona === z && s.chipActive]} onPress={() => { setForm(f => ({ ...f, zona: z })); setErrors(e => ({ ...e, zona: '' })); }}>
                  <Text style={[s.chipText, form.zona === z && s.chipTextActive]}>{z}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {errors.zona ? <Text style={s.fieldError}>{errors.zona}</Text> : null}
            <View style={{ height: 14 }} />

            {/* Categoría */}
            <Text style={s.label}>Categoría *</Text>
            <View style={s.chipsWrap}>
              {CATEGORIAS.map((cat) => (
                <TouchableOpacity key={cat} style={[s.chip, form.categoria === cat && s.chipActive]} onPress={() => { setForm(f => ({ ...f, categoria: cat, categoria_otro: cat !== 'Otro' ? '' : f.categoria_otro })); setErrors(e => ({ ...e, categoria: '', categoria_otro: '' })); }}>
                  <Text style={[s.chipText, form.categoria === cat && s.chipTextActive]}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {form.categoria === 'Otro' && (
              <TextInput style={[s.input, { marginTop: 8 }, errors.categoria_otro && s.inputError]} placeholder="Escribe tu categoría (ej: Heladería, Repostería...)" placeholderTextColor={Colors.textLight} value={form.categoria_otro} onChangeText={set('categoria_otro')} autoFocus />
            )}
            {errors.categoria      ? <Text style={s.fieldError}>{errors.categoria}</Text>       : null}
            {errors.categoria_otro ? <Text style={s.fieldError}>{errors.categoria_otro}</Text>  : null}
            <View style={{ height: 14 }} />

            {/* Foto negocio */}
            <Text style={s.section}>🏪 Foto del negocio *</Text>
            <TouchableOpacity style={[s.fotoBtn, errors.foto_negocio && s.fotoBtnError]} onPress={() => seleccionarFoto('negocio')} activeOpacity={0.85}>
              {form.foto_negocio_uri
                ? <Image source={{ uri: form.foto_negocio_uri }} style={s.fotoPreview} contentFit="cover" />
                : <View style={s.fotoPlaceholder}><Text style={{ fontSize: 48 }}>🏪</Text><Text style={s.fotoPlaceholderText}>Toca para seleccionar foto</Text></View>
              }
              <View style={s.fotoOverlay}><Text style={s.fotoOverlayText}>📷 {form.foto_negocio_uri ? 'Cambiar foto' : 'Seleccionar foto (obligatorio)'}</Text></View>
            </TouchableOpacity>
            {errors.foto_negocio ? <Text style={s.fieldError}>{errors.foto_negocio}</Text> : null}
          </>
        )}

        {/* ─── PASO 3: Bancario ─── */}
        {step === 3 && (
          <>
            <Text style={s.section}>🏦 Datos bancarios</Text>
            <View style={s.infoCard}>
              <Text style={s.infoText}>Estos datos se usan para transferirte el 75% de tus ventas. Son completamente seguros.</Text>
            </View>
            <Text style={s.label}>Banco *</Text>
            <View style={s.chipsWrap}>
              {BANCOS_GT.map((b) => (
                <TouchableOpacity key={b} style={[s.chip, form.banco === b && s.chipActive]} onPress={() => { setForm(f => ({ ...f, banco: b, banco_otro: b === 'Otro' ? f.banco_otro : '' })); setErrors(e => ({ ...e, banco: '', banco_otro: '' })); }}>
                  <Text style={[s.chipText, form.banco === b && s.chipTextActive]}>{b}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {errors.banco ? <Text style={s.fieldError}>{errors.banco}</Text> : null}
            <View style={{ height: 14 }} />
            {form.banco === 'Otro' && <Field label="Nombre del banco *" value={form.banco_otro} onChange={set('banco_otro')} placeholder="Escribe el nombre de tu banco" error={errors.banco_otro} />}
            <Text style={s.label}>Tipo de cuenta *</Text>
            <View style={[s.row, { marginBottom: 16 }]}>
              {TIPOS_CUENTA.map((t) => (
                <TouchableOpacity key={t} style={[s.chipSmall, form.tipo_cuenta === t && s.chipActive]} onPress={() => setForm(f => ({ ...f, tipo_cuenta: t }))}>
                  <Text style={[s.chipText, form.tipo_cuenta === t && s.chipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Field label="Número de cuenta *"     value={form.numero_cuenta}  onChange={set('numero_cuenta')}  placeholder="000-000000-00" keyboard="numeric" error={errors.numero_cuenta} />
            <Field label="Titular de la cuenta *"  value={form.titular_cuenta} onChange={set('titular_cuenta')} placeholder="María González"                   error={errors.titular_cuenta} />
          </>
        )}

        {/* ─── PASO 4: DPI + Resumen ─── */}
        {step === 4 && (
          <>
            <Text style={s.section}>🪪 DPI del representante legal *</Text>
            <View style={s.infoCard}>
              <Text style={s.infoText}>Necesitamos una foto clara del DPI del propietario para verificar tu identidad. Esta información es confidencial.</Text>
            </View>
            <TouchableOpacity style={[s.fotoBtn, { height: 160 }, errors.dpi_foto && s.fotoBtnError]} onPress={() => seleccionarFoto('dpi')} activeOpacity={0.85}>
              {form.dpi_foto_uri
                ? <Image source={{ uri: form.dpi_foto_uri }} style={s.fotoPreview} contentFit="cover" />
                : <View style={[s.fotoPlaceholder, { backgroundColor: '#FEF3C7' }]}><Text style={{ fontSize: 40 }}>🪪</Text><Text style={s.fotoPlaceholderText}>Toca para fotografiar el DPI</Text></View>
              }
              <View style={[s.fotoOverlay, !form.dpi_foto_uri && { backgroundColor: 'rgba(245,158,11,0.9)' }]}>
                <Text style={s.fotoOverlayText}>{form.dpi_foto_uri ? '✓ DPI seleccionado — toca para cambiar' : '📷 Seleccionar foto del DPI (obligatorio)'}</Text>
              </View>
            </TouchableOpacity>
            {errors.dpi_foto ? <Text style={s.fieldError}>{errors.dpi_foto}</Text> : null}

            {/* Resumen */}
            <View style={[s.resumenCard, { marginTop: 20 }]}>
              <Text style={s.resumenTitle}>📋 Resumen de tu solicitud</Text>
              {([
                { label: 'Propietario', val: `${form.nombre} ${form.apellido}`.trim() },
                { label: 'Email',       val: form.email },
                { label: 'Teléfono',    val: form.telefono },
                { label: 'Negocio',     val: form.nombre_negocio },
                { label: 'Categoría',   val: form.categoria === 'Otro' ? form.categoria_otro : form.categoria },
                { label: 'Dirección',   val: `${form.direccion_negocio}, ${form.zona}` },
                { label: 'Horario',     val: form.horario_atencion },
                { label: 'NIT',         val: form.nit },
                { label: 'Banco',       val: form.banco === 'Otro' ? form.banco_otro : form.banco },
                { label: 'Cuenta',      val: form.numero_cuenta },
                { label: 'Titular',     val: form.titular_cuenta },
              ] as { label: string; val: string }[]).map(({ label, val }) =>
                val ? (
                  <View key={label} style={s.resumenRow}>
                    <Text style={s.resumenLabel}>{label}</Text>
                    <Text style={s.resumenVal} numberOfLines={1}>{val}</Text>
                  </View>
                ) : null
              )}
            </View>

            <View style={s.pendienteInfo}>
              <Text style={{ fontSize: 24 }}>⏳</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.pendienteTitle}>Revisión en 24-48 horas</Text>
                <Text style={s.pendienteSub}>Recibirás un correo de confirmación y una notificación en la app.</Text>
              </View>
            </View>
          </>
        )}

        {/* Botones */}
        <View style={s.btnRow}>
          {step < 4 ? (
            <TouchableOpacity style={s.btnNext} onPress={nextStep}>
              <Text style={s.btnNextText}>Siguiente →</Text>
            </TouchableOpacity>
          ) : (
            <>
              {submitError ? (
                <View style={s.errorCard}>
                  <Text style={s.errorCardText}>⚠️ {submitError}</Text>
                </View>
              ) : null}
              <TouchableOpacity
                style={[s.btnSubmit, (!form.dpi_foto_uri || loading) && s.btnDisabled]}
                onPress={handleRegistro}
                disabled={loading || !form.dpi_foto_uri}
              >
                {loading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <ActivityIndicator color={Colors.white} />
                    <Text style={s.btnSubmitText}>{uploadStatus || 'Enviando...'}</Text>
                  </View>
                ) : (
                  <Text style={s.btnSubmitText}>🚀 Enviar solicitud</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Field helper ──────────────────────────────────────────────────────────────
function Field({ label, value, onChange, placeholder, multi, keyboard, secure, lower, error, highlighted }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder: string; multi?: boolean; keyboard?: any;
  secure?: boolean; lower?: boolean; error?: string; highlighted?: boolean;
}) {
  return (
    <View>
      <Text style={sf.label}>{label}</Text>
      <TextInput
        style={[sf.input, multi && { height: 80 }, error && sf.inputError, highlighted && !error && sf.inputHighlighted]}
        placeholder={placeholder} placeholderTextColor={Colors.textLight}
        keyboardType={keyboard || 'default'} autoCapitalize={lower ? 'none' : multi ? 'sentences' : 'words'}
        secureTextEntry={secure} value={value} onChangeText={onChange}
        multiline={multi} textAlignVertical={multi ? 'top' : 'center'}
      />
      {error ? <Text style={sf.error}>{error}</Text> : null}
    </View>
  );
}

const sf = StyleSheet.create({
  label:            { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input:            { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 4 },
  inputError:       { borderColor: Colors.error },
  inputHighlighted: { borderColor: '#F59E0B', borderWidth: 2 },
  error:            { fontSize: 12, color: Colors.error, marginBottom: 12, marginTop: 2 },
});

const s = StyleSheet.create({
  root:            { flex: 1, backgroundColor: Colors.surface },
  header:          { flexDirection: 'row', alignItems: 'center', padding: 16, paddingTop: 52, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  back:            { padding: 8, marginRight: 8 },
  backText:        { fontSize: 22, color: Colors.accent, fontWeight: '700' },
  headerTitle:     { fontSize: 20, fontWeight: '900', color: Colors.primary },
  headerSub:       { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  stepsRow:        { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.white, paddingHorizontal: 16, paddingBottom: 16 },
  stepItem:        { flexDirection: 'row', alignItems: 'center' },
  stepDot:         { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.border, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: Colors.border },
  stepDotActive:   { backgroundColor: Colors.accent, borderColor: Colors.accent },
  stepDotDone:     { backgroundColor: Colors.primary, borderColor: Colors.primary },
  stepDotText:     { fontSize: 12, fontWeight: '800', color: Colors.textLight },
  stepDotTextActive: { color: Colors.white },
  stepLabel:       { fontSize: 10, color: Colors.textLight, fontWeight: '600', marginHorizontal: 4 },
  stepLabelActive: { color: Colors.accent, fontWeight: '800' },
  stepLine:        { width: 20, height: 2, backgroundColor: Colors.border, marginHorizontal: 2 },
  stepLineDone:    { backgroundColor: Colors.primary },
  scroll:          { padding: 20 },
  section:         { fontSize: 16, fontWeight: '800', color: Colors.primary, marginBottom: 16, marginTop: 4 },
  label:           { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  labelRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  counter:         { fontSize: 11, color: Colors.textLight, fontWeight: '600' },
  counterError:    { color: Colors.error },
  counterOk:       { color: Colors.primary },
  fieldHint:       { fontSize: 11, color: Colors.textLight, marginBottom: 4, marginTop: 2 },
  fieldError:      { fontSize: 12, color: Colors.error, marginBottom: 12, marginTop: 2 },
  input:           { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 4 },
  inputError:      { borderColor: Colors.error },
  row:             { flexDirection: 'row', gap: 8 },
  chipsWrap:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip:            { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.white },
  chipSmall:       { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.white },
  chipActive:      { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText:        { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive:  { color: Colors.white },
  infoCard:        { backgroundColor: Colors.accentLight, borderRadius: 12, padding: 14, marginBottom: 20 },
  infoText:        { fontSize: 13, color: Colors.primary, lineHeight: 20 },
  gpsCard:         { backgroundColor: Colors.white, borderRadius: 14, padding: 16, marginBottom: 20, borderWidth: 1.5, borderColor: Colors.border },
  gpsHeader:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  gpsTitle:        { fontSize: 14, fontWeight: '800', color: Colors.primary },
  gpsBadgeOk:      { backgroundColor: '#D1FAE5', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  gpsBadgeMissing: { backgroundColor: '#FEF3C7', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  gpsBadgeText:    { fontSize: 11, fontWeight: '700', color: Colors.primary },
  gpsCoordsText:   { fontSize: 12, color: Colors.textSecondary, marginBottom: 12, lineHeight: 18 },
  gpsWarn:         { fontSize: 12, color: Colors.textSecondary, marginBottom: 12, lineHeight: 18 },
  gpsBtn:          { backgroundColor: Colors.primary, borderRadius: 12, padding: 12, alignItems: 'center', marginBottom: 8 },
  gpsBtnText:      { color: Colors.white, fontWeight: '700', fontSize: 14 },
  gpsSkipHint:     { fontSize: 11, color: Colors.textLight, textAlign: 'center' },
  fotoBtn:         { borderRadius: 16, overflow: 'hidden', height: 180, marginBottom: 4 },
  fotoBtnError:    { borderWidth: 2, borderColor: Colors.error, borderRadius: 16 },
  fotoPreview:     { width: '100%', height: '100%' },
  fotoPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center', gap: 8 },
  fotoPlaceholderText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  fotoOverlay:     { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)', paddingVertical: 10, alignItems: 'center' },
  fotoOverlayText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  resumenCard:     { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  resumenTitle:    { fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 12 },
  resumenRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  resumenLabel:    { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  resumenVal:      { fontSize: 12, color: Colors.textPrimary, fontWeight: '700', flex: 1, textAlign: 'right', marginLeft: 8 },
  pendienteInfo:   { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF3C7', borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: '#F59E0B40' },
  pendienteTitle:  { fontSize: 14, fontWeight: '800', color: '#92400E' },
  pendienteSub:    { fontSize: 12, color: '#B45309', marginTop: 2, lineHeight: 18 },
  btnRow:          { marginTop: 8 },
  btnNext:         { backgroundColor: Colors.primary, borderRadius: 14, padding: 16, alignItems: 'center' },
  btnNextText:     { color: Colors.white, fontWeight: '800', fontSize: 16 },
  btnSubmit:       { backgroundColor: Colors.accent, borderRadius: 14, padding: 16, alignItems: 'center' },
  btnSubmitText:   { color: Colors.white, fontWeight: '800', fontSize: 16 },
  btnDisabled:     { backgroundColor: Colors.textLight },
  errorCard:       { backgroundColor: '#FEE2E2', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#FCA5A5' },
  errorCardText:   { fontSize: 13, color: '#DC2626', fontWeight: '600', lineHeight: 20 },
  rechazoCard:     { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, marginBottom: 20, borderWidth: 1.5, borderColor: '#FCA5A5' },
  rechazoTitle:    { fontSize: 14, fontWeight: '800', color: '#DC2626', marginBottom: 6 },
  rechazoSub:      { fontSize: 13, color: '#7F1D1D', fontWeight: '600', marginBottom: 4 },
  rechazoItem:     { fontSize: 13, color: '#991B1B', paddingVertical: 2, lineHeight: 20 },
  rechazoMotivo:   { fontSize: 12, color: '#7F1D1D', marginTop: 8, fontStyle: 'italic' },
});

const sc = StyleSheet.create({
  scroll:       { padding: 24, alignItems: 'center' },
  iconWrap:     { width: 96, height: 96, borderRadius: 48, backgroundColor: '#D1FAE5', alignItems: 'center', justifyContent: 'center', marginBottom: 20, marginTop: 20 },
  icon:         { fontSize: 48 },
  title:        { fontSize: 26, fontWeight: '900', color: Colors.primary, textAlign: 'center', marginBottom: 12 },
  subtitle:     { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 24, paddingHorizontal: 8 },
  timeCard:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF3C7', borderRadius: 14, padding: 16, marginBottom: 24, width: '100%', borderWidth: 1, borderColor: '#F59E0B40' },
  timeIcon:     { fontSize: 28 },
  timeTitle:    { fontSize: 14, fontWeight: '800', color: '#92400E', marginBottom: 4 },
  timeSub:      { fontSize: 12, color: '#B45309', lineHeight: 18 },
  credCard:     { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 20, width: '100%', borderWidth: 2, borderColor: Colors.accent },
  credTitle:    { fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 12 },
  credRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  credLabel:    { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  credEmail:    { fontSize: 13, color: Colors.textPrimary, fontWeight: '700', flex: 1, textAlign: 'right', marginLeft: 8 },
  credWarning:  { backgroundColor: '#FEF3C7', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#F59E0B40' },
  credWarningText: { fontSize: 12, color: '#92400E', lineHeight: 18 },
  summaryCard:  { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 20, width: '100%', borderWidth: 1.5, borderColor: Colors.border },
  summaryTitle: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 12 },
  row:          { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: Colors.border },
  rowLabel:     { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  rowVal:       { fontSize: 12, color: Colors.textPrimary, fontWeight: '700', flex: 1, textAlign: 'right', marginLeft: 8 },
  btn:          { backgroundColor: Colors.primary, borderRadius: 14, padding: 16, alignItems: 'center', width: '100%', marginBottom: 20 },
  btnText:      { color: Colors.white, fontWeight: '900', fontSize: 16 },
});
