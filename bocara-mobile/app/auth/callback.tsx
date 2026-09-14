import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

export default function AuthCallbackScreen() {
  const [state, setState] = useState<'loading' | 'confirmed' | 'expired' | 'error'>('loading');
  const [intentRole, setIntentRole] = useState<string | null>(null);
  const [fallbackRoute, setFallbackRoute] = useState<string>('/login');
  const [errorDetail, setErrorDetail] = useState('');
  const { setSession } = useAuth();
  const router = useRouter();

  useEffect(() => {
    let active = true;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelSessionWait: (() => void) | undefined;
    const processCallback = async () => {
      try {
        const intentRaw = await AsyncStorage.getItem('bocara_pending_intent');
        if (!active) return;
        const intent = intentRaw ? JSON.parse(intentRaw) : null;

        if (Platform.OS === 'web') {
          const url = new URL(window.location.href);

          // ── Error de Supabase (ej. otp_expired, access_denied) ───────────────
          const errorParam    = url.searchParams.get('error');
          const errorCode     = url.searchParams.get('error_code');
          const errorDesc     = url.searchParams.get('error_description');
          if (errorParam) {
            const isExpired = errorCode === 'otp_expired' || errorParam === 'access_denied';
            setIntentRole(intent?.role ?? null);
            setFallbackRoute(intent?.returnTo || '/login');
            setErrorDetail(errorDesc || errorParam);
            setState(isExpired ? 'expired' : 'error');
            return;
          }

          const tokenHash = url.searchParams.get('token_hash');
          const type      = url.searchParams.get('type') as any;

          // ── Confirmación de email por link ───────────────────────────────────
          if (tokenHash && type) {
            const { data: otpData, error: otpErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
            if (!active) return;
            if (otpErr) {
              setIntentRole(intent?.role ?? null);
              setFallbackRoute(intent?.returnTo || '/login');
              setState('expired');
              return;
            }

            const userMeta = otpData?.user?.user_metadata;

            // Determinar rol: intent > user_metadata > 'cliente'
            const resolvedRole = intent?.role || userMeta?.rol || userMeta?.role || 'cliente';
            const redirectTarget = intent?.returnTo
              || (resolvedRole === 'restaurante' ? '/registro-restaurante' : '/login');

            // Marcar email como confirmado en el intent para que el form lo detecte
            const updatedIntent = {
              ...(intent || {}),
              role: resolvedRole,
              emailConfirmed: true,
            };
            await AsyncStorage.setItem('bocara_pending_intent', JSON.stringify(updatedIntent));
            if (!active) return;
            // Mantener la sesión de Supabase para que el form la use

            setIntentRole(resolvedRole);
            setState('confirmed');
            redirectTimer = setTimeout(() => { if (active) router.replace(redirectTarget as any); }, 2000);
            return;
          }
        }

        // ── Google OAuth — leer tokens del hash fragment ──────────────────────
        let { data: { session } } = await supabase.auth.getSession();
        if (!active) return;

        if (!session && Platform.OS === 'web') {
          const hash = window.location.hash.substring(1);
          const params = new URLSearchParams(hash);

          const hashError = params.get('error');
          const hashErrorDesc = params.get('error_description');
          if (hashError) throw new Error(`OAuth error: ${hashError} — ${hashErrorDesc}`);

          const access_token  = params.get('access_token');
          const refresh_token = params.get('refresh_token');

          if (access_token) {
            const { data, error: setErr } = await supabase.auth.setSession({ access_token, refresh_token: refresh_token || '' });
            if (!active) return;
            if (setErr) throw new Error(`setSession falló: ${setErr.message}`);
            session = data.session;
          }
        }

        if (!session) {
          session = await new Promise<Session | null>((resolve, reject) => {
            let subscription: { unsubscribe: () => void } | undefined;
            let settled = false;
            const cleanup = () => {
              settled = true;
              clearTimeout(timeout);
              subscription?.unsubscribe();
            };
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error('Timeout: no se recibió sesión en 8 segundos'));
            }, 8000);
            cancelSessionWait = () => { cleanup(); resolve(null); };
            subscription = supabase.auth.onAuthStateChange((_event, session) => {
              if (session && !settled) { cleanup(); resolve(session); }
            }).data.subscription;
            // Cubre también una entrega síncrona durante la suscripción.
            if (settled) subscription.unsubscribe();
          });
        }
        if (!active) return;

        if (!session) throw new Error('Supabase no devolvió sesión válida.');

        const res = await authAPI.oauthComplete((session as any).access_token);
        if (!active) return;
        await setSession(res.data.token, res.data.usuario);
        await AsyncStorage.removeItem('bocara_pending_intent');
        if (!active) return;

        const rol = res.data.usuario?.rol;
        if (rol === 'restaurante') router.replace('/restaurante');
        else if (rol === 'admin') router.replace('/admin');
        else router.replace('/(tabs)/');
      } catch (e: any) {
        if (!active) return;
        console.warn('[AUTH CALLBACK] No se pudo completar la autenticación.');
        setErrorDetail(e?.message || 'Error inesperado.');
        setState('error');
        redirectTimer = setTimeout(() => { if (active) router.replace('/login'); }, 4000);
      }
    };
    void processCallback();
    return () => {
      active = false;
      clearTimeout(redirectTimer);
      cancelSessionWait?.();
    };
  }, [router, setSession]);

  if (state === 'confirmed') {
    const esRestaurante = intentRole === 'restaurante';
    return (
      <View style={s.root}>
        <Text style={s.icon}>✅</Text>
        <Text style={s.title}>¡Correo confirmado!</Text>
        <Text style={s.text}>
          {esRestaurante
            ? 'Continuando con el registro de tu negocio...'
            : 'Tu cuenta está activa. Redirigiendo...'}
        </Text>
      </View>
    );
  }

  if (state === 'expired') {
    return (
      <View style={s.root}>
        <Text style={s.icon}>⏰</Text>
        <Text style={s.title}>Enlace expirado</Text>
        <Text style={s.text}>El enlace de confirmación expiró o ya fue usado.</Text>
        <Text style={s.hint}>Solicita un nuevo correo de confirmación.</Text>
        {intentRole === 'restaurante' ? (
          <TouchableOpacity style={s.btn} onPress={() => router.replace('/registro-restaurante' as any)}>
            <Text style={s.btnText}>Volver a registro de negocio</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={() => router.replace('/login')}>
          <Text style={s.btnSecondaryText}>Ir a login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={s.root}>
        <Text style={s.icon}>❌</Text>
        <Text style={s.title}>Error de autenticación</Text>
        <Text style={s.text}>{errorDetail || 'Ocurrió un error. Intenta de nuevo.'}</Text>
        <TouchableOpacity style={s.btn} onPress={() => router.replace(fallbackRoute as any)}>
          <Text style={s.btnText}>Reintentar</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={() => router.replace('/login')}>
          <Text style={s.btnSecondaryText}>Ir a login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <ActivityIndicator size="large" color={Colors.primary} />
      <Text style={s.loadingText}>Procesando confirmación...</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root:             { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background, padding: 32 },
  icon:             { fontSize: 56, marginBottom: 16 },
  title:            { fontSize: 22, fontWeight: '900', color: Colors.brown, marginBottom: 8, textAlign: 'center' },
  text:             { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 8 },
  hint:             { fontSize: 13, color: Colors.textLight, textAlign: 'center', marginBottom: 24 },
  loadingText:      { marginTop: 16, fontSize: 15, color: Colors.textSecondary },
  btn:              { backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, marginTop: 12, width: '100%', alignItems: 'center' },
  btnText:          { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnSecondary:     { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: Colors.border },
  btnSecondaryText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 15 },
});
