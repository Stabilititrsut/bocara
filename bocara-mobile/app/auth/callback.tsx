import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

export default function AuthCallbackScreen() {
  const [errorMsg, setErrorMsg] = useState('');
  const { setSession } = useAuth();
  const router = useRouter();

  useEffect(() => {
    processCallback();
  }, []);

  async function processCallback() {
    try {
      if (Platform.OS === 'web') {
        console.log('[OAuth Callback] URL:', window.location.href);
      }

      // 1. Intentar obtener sesión que Supabase ya pudo haber procesado del hash
      let { data: { session } } = await supabase.auth.getSession();
      console.log('[OAuth Callback] session (inmediata):', session?.user?.email ?? null);

      // 2. Si no hay sesión, parsear el hash manualmente y llamar setSession
      if (!session && Platform.OS === 'web') {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);

        // Detectar si Supabase/Google envió un error en la URL
        const hashError = params.get('error');
        const hashErrorDesc = params.get('error_description');
        if (hashError) {
          throw new Error(`OAuth error en URL hash: ${hashError} — ${hashErrorDesc}`);
        }

        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        console.log('[OAuth Callback] tokens en hash:', { access_token: !!access_token, refresh_token: !!refresh_token });
        console.log('[OAuth Callback] hash completo (sin tokens):', hash.replace(/access_token=[^&]+/, 'access_token=REDACTED').replace(/refresh_token=[^&]+/, 'refresh_token=REDACTED'));

        if (access_token) {
          const { data, error: setErr } = await supabase.auth.setSession({
            access_token,
            refresh_token: refresh_token || '',
          });
          if (setErr) {
            console.error('[OAuth Callback] setSession error completo:', setErr);
            throw new Error(`setSession falló: ${setErr.message}`);
          }
          session = data.session;
          console.log('[OAuth Callback] session (desde hash):', session?.user?.email ?? null);
        }
      }

      // 3. Fallback: esperar evento onAuthStateChange (máx 8 seg)
      if (!session) {
        console.log('[OAuth Callback] esperando onAuthStateChange...');
        session = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout: Google no devolvió sesión en 8 segundos')), 8000);
          const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
            console.log('[OAuth Callback] onAuthStateChange event:', _event);
            if (s) {
              clearTimeout(timeout);
              subscription.unsubscribe();
              resolve(s);
            }
          });
        });
        console.log('[OAuth Callback] session (desde evento):', (session as any)?.user?.email ?? null);
      }

      if (!session) {
        throw new Error('Supabase no devolvió sesión válida después de Google OAuth.');
      }

      console.log('[OAuth Callback] user:', (session as any).user?.email);

      // 4. Completar sesión con el backend de Bocara
      const res = await authAPI.oauthComplete((session as any).access_token);
      console.log('[OAuth Callback] backend response:', res.data);

      await setSession(res.data.token, res.data.usuario);

      // 5. Navegar explícitamente al dashboard correcto
      const rol = res.data.usuario?.rol;
      if (rol === 'restaurante') router.replace('/restaurante');
      else if (rol === 'admin') router.replace('/admin');
      else router.replace('/(tabs)/');
    } catch (e: any) {
      console.error('[OAuth Callback] error:', e?.message, e);
      setErrorMsg(e?.message || 'Error al completar el login con Google.');
      setTimeout(() => router.replace('/login'), 4000);
    }
  }

  if (errorMsg) {
    return (
      <View style={s.root}>
        <Text style={s.errorText}>{errorMsg}</Text>
        <Text style={s.hint}>Redirigiendo al login...</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <ActivityIndicator size="large" color={Colors.primary} />
      <Text style={s.text}>Completando login con Google...</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background, padding: 24 },
  text: { marginTop: 16, fontSize: 16, color: Colors.textSecondary },
  errorText: { fontSize: 16, color: '#e53e3e', textAlign: 'center', marginBottom: 8 },
  hint: { fontSize: 13, color: Colors.textLight },
});
