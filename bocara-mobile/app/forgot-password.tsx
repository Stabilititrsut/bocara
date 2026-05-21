import { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

type Stage = 'email' | 'verify';

export default function ForgotPasswordScreen() {
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [success, setSuccess] = useState(false);
  const [reenvioSeg, setReenvioSeg] = useState(0);
  const countdownRef = useRef<any>(null);
  const router = useRouter();

  function startCountdown(seconds = 60) {
    setReenvioSeg(seconds);
    clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setReenvioSeg((s) => {
        if (s <= 1) { clearInterval(countdownRef.current); return 0; }
        return s - 1;
      });
    }, 1000);
  }

  async function handleEnviar() {
    const trimEmail = email.trim().toLowerCase();
    if (!trimEmail || !/\S+@\S+\.\S+/.test(trimEmail)) {
      setErrorMsg('Ingresa un correo electrónico válido');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimEmail,
        options: { shouldCreateUser: true },
      });
      if (error) {
        setErrorMsg('No se pudo enviar el código. Verifica el correo e intenta de nuevo.');
        return;
      }
      setStage('verify');
      startCountdown();
    } catch (e: any) {
      setErrorMsg(e.message || 'Error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReenviar() {
    if (reenvioSeg > 0) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { shouldCreateUser: true },
      });
      if (error) { setErrorMsg('No se pudo reenviar el código. Intenta más tarde.'); return; }
      startCountdown();
    } catch (e: any) {
      setErrorMsg(e.message || 'Error al reenviar');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerificar() {
    if (codigo.length !== 6) { setErrorMsg('Ingresa el código de 6 dígitos'); return; }
    if (newPassword.length < 6) { setErrorMsg('La contraseña debe tener al menos 6 caracteres'); return; }
    setLoading(true);
    setErrorMsg('');
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: codigo.trim(),
        type: 'email',
      });
      if (error) {
        setErrorMsg('Código incorrecto o expirado. Verifica el código en tu correo.');
        return;
      }
      const access_token = data.session?.access_token;
      if (!access_token) {
        setErrorMsg('No se pudo verificar la sesión. Intenta de nuevo.');
        return;
      }
      await authAPI.resetPassword({
        email: email.trim().toLowerCase(),
        new_password: newPassword,
        supabase_access_token: access_token,
      });
      clearInterval(countdownRef.current);
      setSuccess(true);
    } catch (e: any) {
      setErrorMsg(e.message || 'Error al restablecer la contraseña');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={s.successIcon}><Text style={{ fontSize: 56 }}>✅</Text></View>
          <Text style={s.title}>¡Contraseña actualizada!</Text>
          <Text style={s.subtitle}>Ya puedes iniciar sesión con tu nueva contraseña.</Text>
          <TouchableOpacity style={s.btn} onPress={() => router.replace('/login')}>
            <Text style={s.btnText}>Ir al inicio de sesión</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.back()} style={s.back}>
          <Text style={s.backText}>← Volver</Text>
        </TouchableOpacity>

        {stage === 'email' ? (
          <>
            <Text style={s.title}>¿Olvidaste tu contraseña?</Text>
            <Text style={s.subtitle}>
              Ingresa tu correo y te enviaremos un código para restablecer tu contraseña.
            </Text>

            <Text style={s.label}>Correo electrónico</Text>
            <TextInput
              style={[s.input, errorMsg ? s.inputError : null]}
              placeholder="tu@correo.com"
              placeholderTextColor={Colors.textLight}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={(v) => { setEmail(v); setErrorMsg(''); }}
              autoFocus
            />
            {errorMsg ? <Text style={s.errorText}>{errorMsg}</Text> : null}

            <TouchableOpacity
              style={[s.btn, loading && s.btnLoading]}
              onPress={handleEnviar}
              disabled={loading}
            >
              <Text style={s.btnText}>{loading ? 'Enviando código...' : 'Enviar código'}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={s.title}>Ingresa el código</Text>
            <Text style={s.subtitle}>
              Enviamos un código de 6 dígitos a{'\n'}
              <Text style={{ fontWeight: '700', color: Colors.textPrimary }}>{email}</Text>
            </Text>
            <Text style={s.hint}>Revisa también tu carpeta de spam.</Text>

            <Text style={s.label}>Código de verificación</Text>
            <TextInput
              style={[s.input, s.inputCode, errorMsg ? s.inputError : null]}
              placeholder="123456"
              placeholderTextColor={Colors.textLight}
              keyboardType="number-pad"
              maxLength={6}
              value={codigo}
              onChangeText={(v) => { setCodigo(v.replace(/\D/g, '')); setErrorMsg(''); }}
              autoFocus
            />

            <Text style={s.label}>Nueva contraseña</Text>
            <View style={s.passWrap}>
              <TextInput
                style={[s.inputPass, errorMsg ? s.inputError : null]}
                placeholder="Mínimo 6 caracteres"
                placeholderTextColor={Colors.textLight}
                secureTextEntry={!showPass}
                value={newPassword}
                onChangeText={(v) => { setNewPassword(v); setErrorMsg(''); }}
              />
              <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPass(!showPass)}>
                <Text style={{ fontSize: 18 }}>{showPass ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>

            {errorMsg ? <Text style={s.errorText}>{errorMsg}</Text> : null}

            <TouchableOpacity
              style={[s.btn, (loading || codigo.length < 6 || newPassword.length < 6) && s.btnLoading]}
              onPress={handleVerificar}
              disabled={loading || codigo.length < 6 || newPassword.length < 6}
            >
              <Text style={s.btnText}>{loading ? 'Verificando...' : 'Restablecer contraseña'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.reenvioBtn, reenvioSeg > 0 && s.reenvioDisabled]}
              onPress={handleReenviar}
              disabled={reenvioSeg > 0 || loading}
            >
              <Text style={[s.reenvioText, reenvioSeg > 0 && s.reenvioTextDisabled]}>
                {reenvioSeg > 0 ? `Reenviar código en ${reenvioSeg}s` : 'Reenviar código'}
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
  hint: { fontSize: 12, color: Colors.textLight, marginBottom: 20, marginTop: -16 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 16,
  },
  inputCode: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
  inputError: { borderColor: '#e53e3e' },
  passWrap: {
    flexDirection: 'row', backgroundColor: Colors.white, borderWidth: 1.5,
    borderColor: Colors.border, borderRadius: 12, marginBottom: 16, alignItems: 'center',
  },
  inputPass: { flex: 1, padding: 14, fontSize: 15, color: Colors.textPrimary },
  eyeBtn: { paddingHorizontal: 14 },
  errorText: { color: '#e53e3e', fontSize: 12, marginBottom: 16, marginTop: -8 },
  btn: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 4 },
  btnLoading: { opacity: 0.6 },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  successIcon: { alignItems: 'center', marginBottom: 24, marginTop: 60 },
  reenvioBtn: { marginTop: 20, alignItems: 'center', padding: 12 },
  reenvioDisabled: {},
  reenvioText: { color: Colors.orange, fontWeight: '600', fontSize: 14 },
  reenvioTextDisabled: { color: Colors.textLight },
});
