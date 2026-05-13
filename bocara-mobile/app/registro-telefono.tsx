import { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const GT_PHONE_REGEX = /^[234567]\d{7}$/;

type Step = 'phone' | 'profile' | 'otp';

export default function RegistroTelefonoScreen() {
  const [step, setStep] = useState<Step>('phone');
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [codigo, setCodigo] = useState('');
  const [isNewUser, setIsNewUser] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reenvioSegundos, setReenvioSegundos] = useState(0);
  const { setSession } = useAuth();
  const router = useRouter();
  const codigoRef = useRef<TextInput>(null);

  const digitsOnly = telefono.replace(/\D/g, '');
  const phoneValido = GT_PHONE_REGEX.test(digitsOnly);

  async function handleEnviarOtp() {
    if (!phoneValido) {
      setErrors({ telefono: 'Ingresa un número guatemalteco válido (8 dígitos, inicia con 2, 3, 4, 5, 6 o 7)' });
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await authAPI.sendPhoneOtp(digitsOnly);
      setIsNewUser(res.data.isNewUser);
      if (res.data.isNewUser && !nombre) {
        setStep('profile');
      } else {
        setStep('otp');
        setReenvioSegundos(60);
        startCountdown();
        setTimeout(() => codigoRef.current?.focus(), 300);
      }
    } catch (e: any) {
      setErrors({ telefono: e.message || 'No se pudo enviar el código. Intenta de nuevo.' });
    } finally {
      setLoading(false);
    }
  }

  async function handleContinuarPerfil() {
    if (!nombre.trim()) {
      setErrors({ nombre: 'El nombre es requerido' });
      return;
    }
    setErrors({});
    setStep('otp');
    setReenvioSegundos(60);
    startCountdown();
    setTimeout(() => codigoRef.current?.focus(), 300);
  }

  function startCountdown() {
    const interval = setInterval(() => {
      setReenvioSegundos((s) => {
        if (s <= 1) { clearInterval(interval); return 0; }
        return s - 1;
      });
    }, 1000);
  }

  async function handleReenviar() {
    if (reenvioSegundos > 0) return;
    setLoading(true);
    try {
      await authAPI.sendPhoneOtp(digitsOnly);
      setReenvioSegundos(60);
      startCountdown();
    } catch (e: any) {
      setErrors({ otp: 'No se pudo reenviar el código.' });
    } finally {
      setLoading(false);
    }
  }

  async function handleVerificar() {
    if (codigo.length !== 6) {
      setErrors({ otp: 'Ingresa el código de 6 dígitos.' });
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const res = await authAPI.verifyPhoneOtp({
        telefono: digitsOnly,
        codigo,
        nombre: nombre.trim() || undefined,
        apellido: apellido.trim() || undefined,
      });
      await setSession(res.data.token, res.data.usuario);
    } catch (e: any) {
      setErrors({ otp: e.message || 'Código incorrecto o expirado.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => step === 'phone' ? router.back() : setStep(step === 'otp' && isNewUser ? 'profile' : 'phone')} style={s.back}>
          <Text style={s.backText}>← Volver</Text>
        </TouchableOpacity>

        {step === 'phone' && (
          <>
            <Text style={s.title}>Ingresa con teléfono</Text>
            <Text style={s.subtitle}>Te enviaremos un código SMS para verificar tu número.</Text>

            <Text style={s.label}>Número de teléfono (Guatemala)</Text>
            <View style={s.phoneRow}>
              <View style={s.prefix}>
                <Text style={s.prefixText}>🇬🇹 +502</Text>
              </View>
              <TextInput
                style={[s.phoneInput, errors.telefono ? s.inputError : null]}
                placeholder="55555555"
                placeholderTextColor={Colors.textLight}
                keyboardType="phone-pad"
                maxLength={8}
                value={telefono}
                onChangeText={(v) => { setTelefono(v.replace(/\D/g, '')); setErrors({}); }}
              />
            </View>
            {errors.telefono ? <Text style={s.errorText}>{errors.telefono}</Text> : null}

            <TouchableOpacity style={[s.btn, !phoneValido && s.btnDisabled]} onPress={handleEnviarOtp} disabled={loading || !phoneValido}>
              <Text style={s.btnText}>{loading ? 'Enviando...' : 'Enviar código SMS'}</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'profile' && (
          <>
            <Text style={s.title}>Completa tu perfil</Text>
            <Text style={s.subtitle}>Es tu primera vez en Bocara. Cuéntanos tu nombre.</Text>

            <Text style={s.label}>Nombre *</Text>
            <TextInput
              style={[s.input, errors.nombre ? s.inputError : null]}
              placeholder="Juan"
              placeholderTextColor={Colors.textLight}
              autoCapitalize="words"
              value={nombre}
              onChangeText={(v) => { setNombre(v); setErrors({}); }}
            />
            {errors.nombre ? <Text style={s.errorText}>{errors.nombre}</Text> : null}

            <Text style={s.label}>Apellido</Text>
            <TextInput
              style={s.input}
              placeholder="García"
              placeholderTextColor={Colors.textLight}
              autoCapitalize="words"
              value={apellido}
              onChangeText={setApellido}
            />

            <TouchableOpacity style={s.btn} onPress={handleContinuarPerfil} disabled={loading}>
              <Text style={s.btnText}>Continuar</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'otp' && (
          <>
            <Text style={s.title}>Verifica tu número</Text>
            <Text style={s.subtitle}>
              Enviamos un código SMS al número{'\n'}
              <Text style={s.phoneBold}>+502 {digitsOnly}</Text>
            </Text>

            <Text style={s.label}>Código de verificación</Text>
            <TextInput
              ref={codigoRef}
              style={[s.inputOtp, errors.otp ? s.inputError : null]}
              placeholder="123456"
              placeholderTextColor={Colors.textLight}
              keyboardType="number-pad"
              maxLength={6}
              value={codigo}
              onChangeText={(v) => { setCodigo(v.replace(/\D/g, '')); setErrors({}); }}
            />
            {errors.otp ? <Text style={s.errorText}>{errors.otp}</Text> : null}

            <TouchableOpacity style={s.btn} onPress={handleVerificar} disabled={loading || codigo.length < 6}>
              <Text style={s.btnText}>{loading ? 'Verificando...' : isNewUser ? 'Crear mi cuenta' : 'Ingresar'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.reenvioBtn, reenvioSegundos > 0 && s.reenvioDisabled]}
              onPress={handleReenviar}
              disabled={reenvioSegundos > 0 || loading}
            >
              <Text style={[s.reenvioText, reenvioSegundos > 0 && s.reenvioTextDisabled]}>
                {reenvioSegundos > 0 ? `Reenviar en ${reenvioSegundos}s` : 'Reenviar código'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingTop: 56 },
  back: { marginBottom: 24 },
  backText: { color: Colors.orange, fontWeight: '700', fontSize: 15 },
  title: { fontSize: 28, fontWeight: '900', color: Colors.brown, marginBottom: 8 },
  subtitle: { fontSize: 15, color: Colors.textSecondary, lineHeight: 22, marginBottom: 28 },
  phoneBold: { fontWeight: '700', color: Colors.textPrimary },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  phoneRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  prefix: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, justifyContent: 'center',
  },
  prefixText: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600' },
  phoneInput: {
    flex: 1, backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 18, letterSpacing: 2, color: Colors.textPrimary,
  },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 4,
  },
  inputOtp: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 28, letterSpacing: 8,
    color: Colors.textPrimary, marginBottom: 4, textAlign: 'center',
  },
  inputError: { borderColor: '#e53e3e' },
  errorText: { color: '#e53e3e', fontSize: 12, marginBottom: 16, marginTop: 2 },
  btn: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  reenvioBtn: { marginTop: 20, alignItems: 'center', padding: 12 },
  reenvioDisabled: {},
  reenvioText: { color: Colors.orange, fontWeight: '600', fontSize: 14 },
  reenvioTextDisabled: { color: Colors.textLight },
});
