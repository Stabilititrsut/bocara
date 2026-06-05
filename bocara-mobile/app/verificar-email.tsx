import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

export default function VerificarEmailScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [codigo, setCodigo] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [reenvioSegundos, setReenvioSegundos] = useState(60);
  const { setSession } = useAuth();
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const interval = setInterval(() => {
      setReenvioSegundos((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleVerificar() {
    if (codigo.length !== 6) {
      setErrorMsg('Ingresa el código de 6 dígitos.');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    try {
      // 1. Verificar OTP con Supabase
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: codigo.trim(),
        type: 'email',
      });
      if (error) {
        setErrorMsg('Código incorrecto o expirado. Verifica el código en tu correo.');
        return;
      }

      const access_token = data.session?.access_token;
      if (!access_token) {
        setErrorMsg('No se pudo obtener la sesión. Intenta de nuevo.');
        return;
      }

      // 2. Recuperar datos del formulario guardados antes de navegar
      const raw = await AsyncStorage.getItem('bocara_pending_registro');
      if (!raw) {
        setErrorMsg('Datos de registro perdidos. Vuelve atrás e intenta de nuevo.');
        return;
      }
      const form = JSON.parse(raw);

      // 3. Crear cuenta en nuestro backend
      const res = await authAPI.registroCompleto({
        email,
        password: form.password,
        nombre: form.nombre,
        apellido: form.apellido,
        telefono: form.telefono,
        supabase_access_token: access_token,
      });

      await AsyncStorage.removeItem('bocara_pending_registro');
      await setSession(res.data.token, res.data.usuario);
    } catch (e: any) {
      setErrorMsg(e.message || 'Error al verificar. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReenviar() {
    if (reenvioSegundos > 0) return;
    setErrorMsg('');
    setReenvioSegundos(60);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: 'https://bocara.vercel.app/auth/callback',
        },
      });
      if (error) setErrorMsg('No se pudo reenviar el código. Intenta más tarde.');
    } catch {
      setErrorMsg('No se pudo enviar el código. Intenta nuevamente.');
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.back()} style={s.back}>
          <Text style={s.backText}>← Volver</Text>
        </TouchableOpacity>

        <Text style={s.title}>Verifica tu correo</Text>
        <Text style={s.subtitle}>
          Enviamos un código de 6 dígitos a{'\n'}
          <Text style={s.emailBold}>{email}</Text>
        </Text>
        <Text style={s.hint}>Revisa también tu carpeta de spam.</Text>

        <Text style={s.label}>Código de verificación</Text>
        <TextInput
          ref={inputRef}
          style={[s.input, errorMsg ? s.inputError : null]}
          placeholder="123456"
          placeholderTextColor={Colors.textLight}
          keyboardType="number-pad"
          maxLength={6}
          value={codigo}
          onChangeText={(v) => { setCodigo(v.replace(/\D/g, '')); setErrorMsg(''); }}
        />
        {errorMsg ? <Text style={s.errorText}>{errorMsg}</Text> : null}

        <TouchableOpacity style={s.btn} onPress={handleVerificar} disabled={loading || codigo.length < 6}>
          <Text style={s.btnText}>{loading ? 'Verificando...' : 'Confirmar y crear cuenta'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.reenvioBtn, reenvioSegundos > 0 && s.reenvioDisabled]}
          onPress={handleReenviar}
          disabled={reenvioSegundos > 0}
        >
          <Text style={[s.reenvioText, reenvioSegundos > 0 && s.reenvioTextDisabled]}>
            {reenvioSegundos > 0
              ? `Reenviar código en ${reenvioSegundos}s`
              : 'Reenviar código'}
          </Text>
        </TouchableOpacity>
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
  subtitle: { fontSize: 15, color: Colors.textSecondary, lineHeight: 22, marginBottom: 4 },
  emailBold: { fontWeight: '700', color: Colors.textPrimary },
  hint: { fontSize: 12, color: Colors.textLight, marginBottom: 32 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 24, letterSpacing: 8,
    color: Colors.textPrimary, marginBottom: 4, textAlign: 'center',
  },
  inputError: { borderColor: '#e53e3e' },
  errorText: { color: '#e53e3e', fontSize: 12, marginBottom: 16, marginTop: 2 },
  btn: {
    backgroundColor: Colors.orange, borderRadius: 14, padding: 16,
    alignItems: 'center', marginTop: 8, opacity: 1,
  },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  reenvioBtn: { marginTop: 20, alignItems: 'center', padding: 12 },
  reenvioDisabled: {},
  reenvioText: { color: Colors.orange, fontWeight: '600', fontSize: 14 },
  reenvioTextDisabled: { color: Colors.textLight },
});
