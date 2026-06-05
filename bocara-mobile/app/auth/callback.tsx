import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

export default function AuthCallbackScreen() {
  const [errorMsg, setErrorMsg] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const { setSession } = useAuth();
  const router = useRouter();

  useEffect(() => {
    processCallback();
  }, []);

  async function processCallback() {
    try {
      if (Platform.OS === 'web') {
        console.log('[AUTH CALLBACK] URL:', window.location.href);
        const url = new URL(window.location.href);
        const params = Object.fromEntries(url.searchParams.entries());
        console.log('[AUTH CALLBACK] params:', params);

        const tokenHash = url.searchParams.get('token_hash');
        const type      = url.searchParams.get('type') as any;

        // ── Confirmación de email por link (Supabase envía token_hash + type) ──
        if (tokenHash && type) {
          console.log('[AUTH CALLBACK] procesando confirmación de email, type:', type);
          const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) {
            console.error('[AUTH CALLBACK] verifyOtp error:', error.message);
            setErrorMsg('El enlace de confirmación expiró o ya fue usado. Vuelve a la app e inicia sesión.');
            setTimeout(() => router.replace('/login'), 4000);
            return;
          }
          // Cerrar sesión automática — el usuario debe iniciar sesión en la app
          await supabase.auth.signOut();
          setConfirmed(true);
          setTimeout(() => router.replace('/login'), 3000);
          return;
        }
      }

      // ── Google OAuth — leer tokens del hash fragment ────────────────────────
      let { data: { session } } = await supabase.auth.getSession();
      console.log('[OAuth Callback] session (inmediata):', session?.user?.email ?? null);

      if (!session && Platform.OS === 'web') {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);

        const hashError = params.get('error');
        const hashErrorDesc = params.get('error_description');
        if (hashError) {
          throw new Error(`OAuth error en URL hash: ${hashError} — ${hashErrorDesc}`);
        }

        const access_token  = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        console.log('[OAuth Callback] tokens en hash:', { access_token: !!access_token, refresh_token: !!refresh_token });

        if (access_token) {
          const { data, error: setErr } = await supabase.auth.setSession({
            access_token,
            refresh_token: refresh_token || '',
          });
          if (setErr) throw new Error(`setSession falló: ${setErr.message}`);
          session = data.session;
          console.log('[OAuth Callback] session (desde hash):', session?.user?.email ?? null);
        }
      }

      // Fallback: esperar onAuthStateChange (máx 8 seg)
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
      }

      if (!session) throw new Error('Supabase no devolvió sesión válida después de Google OAuth.');

      console.log('[OAuth Callback] user:', (session as any).user?.email);

      const res = await authAPI.oauthComplete((session as any).access_token);
      console.log('[OAuth Callback] backend response:', res.data);

      await setSession(res.data.token, res.data.usuario);

      const rol = res.data.usuario?.rol;
      if (rol === 'restaurante') router.replace('/restaurante');
      else if (rol === 'admin') router.replace('/admin');
      else router.replace('/(tabs)/');
    } catch (e: any) {
      console.error('[AUTH CALLBACK] error:', e?.message, e);
      setErrorMsg(e?.message || 'Error al completar el proceso. Intenta de nuevo.');
      setTimeout(() => router.replace('/login'), 4000);
    }
  }

  if (confirmed) {
    return (
      <View style={s.root}>
        <Text style={s.successIcon}>✅</Text>
        <Text style={s.successTitle}>¡Correo confirmado!</Text>
        <Text style={s.successText}>Tu cuenta está activa. Vuelve a la app e inicia sesión.</Text>
        <Text style={s.hint}>Redirigiendo...</Text>
      </View>
    );
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
      <Text style={s.text}>Procesando...</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background, padding: 24 },
  text: { marginTop: 16, fontSize: 16, color: Colors.textSecondary },
  successIcon: { fontSize: 56, marginBottom: 16 },
  successTitle: { fontSize: 24, fontWeight: '900', color: Colors.brown, marginBottom: 8, textAlign: 'center' },
  successText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 8 },
  errorText: { fontSize: 16, color: '#e53e3e', textAlign: 'center', marginBottom: 8 },
  hint: { fontSize: 13, color: Colors.textLight, textAlign: 'center' },
});
