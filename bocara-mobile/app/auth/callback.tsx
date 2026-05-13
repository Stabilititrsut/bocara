import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

// Esta pantalla maneja el callback de Google OAuth.
// En web: Supabase detecta el token de la URL automáticamente (detectSessionInUrl: true).
// En nativo: expo-web-browser redirige a bocaramobile://auth/callback con el token en la URL.
export default function AuthCallbackScreen() {
  const [error, setError] = useState('');
  const { setSession } = useAuth();
  const router = useRouter();

  useEffect(() => {
    processCallback();
  }, []);

  async function processCallback() {
    try {
      // Esperar brevemente para que Supabase detecte la sesión desde la URL (modo web)
      await new Promise((r) => setTimeout(r, 500));

      const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr || !session) {
        setError('No se pudo completar el login con Google. Intenta de nuevo.');
        return;
      }

      const res = await authAPI.oauthComplete(session.access_token);
      await setSession(res.data.token, res.data.usuario);
      // El AuthGuard en _layout.tsx redirigirá automáticamente
    } catch (e: any) {
      setError(e.message || 'Error al completar el login con Google.');
      setTimeout(() => router.replace('/login'), 3000);
    }
  }

  if (error) {
    return (
      <View style={s.root}>
        <Text style={s.errorText}>{error}</Text>
        <Text style={s.hint}>Redirigiendo al login...</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <ActivityIndicator size="large" color={Colors.orange} />
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
