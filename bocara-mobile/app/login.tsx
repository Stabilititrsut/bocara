import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useAuth } from '@/src/context/AuthContext';
import { supabase } from '@/src/services/supabase';
import { authAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

WebBrowser.maybeCompleteAuthSession();

type Modo = 'cliente' | 'restaurante' | 'admin';

export default function LoginScreen() {
  const [modo, setModo] = useState<Modo>('cliente');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [logoTaps, setLogoTaps] = useState(0);
  const { login, setSession } = useAuth();
  const router = useRouter();

  const esRest = modo === 'restaurante';
  const esAdmin = modo === 'admin';

  function setModoLimpio(m: Modo) { setModo(m); setErrorMsg(''); }

  function handleLogoTap() {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (next >= 5) { setModo('admin'); setLogoTaps(0); }
  }

  async function handleLogin() {
    setErrorMsg('');
    if (!email || !password) { setErrorMsg('Ingresa tu correo y contraseña.'); return; }
    setLoading(true);
    try {
      await login(email.toLowerCase().trim(), password);
    } catch (e: any) {
      setErrorMsg(e.message || 'Credenciales incorrectas. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setErrorMsg('');
    setGoogleLoading(true);
    try {
      const redirectTo = Platform.OS === 'web'
        ? `${window.location.origin}/auth/callback`
        : Linking.createURL('/auth/callback');

      if (Platform.OS === 'web') {
        const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
        if (error) setErrorMsg('No se pudo iniciar el login con Google.');
        return;
      }

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data?.url) { setErrorMsg('No se pudo iniciar el login con Google.'); return; }

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') return;

      const url = result.url;
      const params = new URLSearchParams(url.includes('#') ? url.split('#')[1] : url.split('?')[1]);
      const access_token = params.get('access_token');
      const refresh_token = params.get('refresh_token');
      if (!access_token) { setErrorMsg('No se pudo obtener la sesión de Google.'); return; }

      await supabase.auth.setSession({ access_token, refresh_token: refresh_token || '' });
      const res = await authAPI.oauthComplete(access_token);
      await setSession(res.data.token, res.data.usuario);
    } catch (e: any) {
      setErrorMsg(e.message || 'Error al iniciar sesión con Google.');
    } finally {
      setGoogleLoading(false);
    }
  }

  /* ─── ADMIN ─── */
  if (esAdmin) {
    return (
      <KeyboardAvoidingView style={s.rootDark} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scrollDark} keyboardShouldPersistTaps="handled">
          <View style={s.inner}>
            <TouchableOpacity style={s.logoArea} onPress={handleLogoTap} activeOpacity={1}>
              <Text style={[s.logo, { color: '#818CF8' }]}>Boca<Text style={{ color: '#fff' }}>ra</Text></Text>
              <View style={s.adminPill}>
                <Ionicons name="lock-closed" size={12} color="#A5B4FC" />
                <Text style={s.adminPillText}>ADMINISTRADOR</Text>
              </View>
            </TouchableOpacity>

            <View style={s.darkCard}>
              <Text style={s.darkCardTitle}>Acceso restringido</Text>
              <Text style={s.darkCardSub}>Solo para administradores de plataforma.</Text>

              {errorMsg ? (
                <View style={s.errorBox}>
                  <Ionicons name="warning-outline" size={15} color="#B91C1C" />
                  <Text style={s.errorText}>{errorMsg}</Text>
                </View>
              ) : null}

              <Text style={s.darkLabel}>Correo electrónico</Text>
              <View style={[s.inputWrap, { backgroundColor: '#334155' }]}>
                <Ionicons name="mail-outline" size={18} color="#64748B" />
                <TextInput style={[s.input, { color: '#fff' }]} placeholder="admin@bocara.gt"
                  placeholderTextColor="#475569" keyboardType="email-address" autoCapitalize="none"
                  value={email} onChangeText={(v) => { setEmail(v); setErrorMsg(''); }} />
              </View>

              <Text style={s.darkLabel}>Contraseña</Text>
              <View style={[s.inputWrap, { backgroundColor: '#334155' }]}>
                <Ionicons name="lock-closed-outline" size={18} color="#64748B" />
                <TextInput style={[s.input, { color: '#fff' }]} placeholder="••••••••"
                  placeholderTextColor="#475569" secureTextEntry={!showPass}
                  value={password} onChangeText={(v) => { setPassword(v); setErrorMsg(''); }} />
                <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                  <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color="#64748B" />
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={[s.btnPill, { backgroundColor: '#4F46E5' }]} onPress={handleLogin} disabled={loading}>
                <Text style={s.btnPillText}>{loading ? 'Verificando...' : 'Ingresar'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={s.linkBtn} onPress={() => setModoLimpio('cliente')}>
                <Ionicons name="arrow-back" size={14} color="#64748B" />
                <Text style={[s.linkBtnText, { color: '#64748B' }]}>Volver al login de clientes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  /* ─── CLIENTE / RESTAURANTE ─── */
  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={s.inner}>

          <TouchableOpacity style={s.logoArea} onPress={handleLogoTap} activeOpacity={1}>
            <View style={s.logoCircle}>
              <Image
                source={require('@/assets/images/logo.png')}
                style={s.logoImg}
                contentFit="cover"
              />
            </View>
            <Text style={s.tagline}>
              {esRest ? 'Panel para negocios' : 'Rescata comida · Ahorra dinero'}
            </Text>
          </TouchableOpacity>

          {/* Toggle cliente / restaurante */}
          <View style={s.modeToggle}>
            <TouchableOpacity style={[s.modeBtn, !esRest && s.modeBtnActive]} onPress={() => setModoLimpio('cliente')}>
              <Ionicons name="person-outline" size={15} color={!esRest ? Colors.white : Colors.textSecondary} />
              <Text style={[s.modeBtnText, !esRest && s.modeBtnTextActive]}>Soy cliente</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.modeBtn, esRest && s.modeBtnActive]} onPress={() => setModoLimpio('restaurante')}>
              <Ionicons name="storefront-outline" size={15} color={esRest ? Colors.white : Colors.textSecondary} />
              <Text style={[s.modeBtnText, esRest && s.modeBtnTextActive]}>Tengo un negocio</Text>
            </TouchableOpacity>
          </View>

          <View style={s.formCard}>
            {esRest && (
              <View style={s.restBanner}>
                <Ionicons name="storefront" size={16} color={Colors.primary} />
                <Text style={s.restBannerText}>Administra tus bolsas, cupones, pedidos y ganancias desde aquí.</Text>
              </View>
            )}

            {!esRest && (
              <>
                <TouchableOpacity style={s.googleBtn} onPress={handleGoogleLogin} disabled={googleLoading}>
                  <Text style={s.googleG}>G</Text>
                  <Text style={s.googleText}>{googleLoading ? 'Conectando...' : 'Continuar con Google'}</Text>
                </TouchableOpacity>
                <View style={s.orRow}>
                  <View style={s.orLine} />
                  <Text style={s.orText}>o ingresa con tu correo</Text>
                  <View style={s.orLine} />
                </View>
              </>
            )}

            {errorMsg ? (
              <View style={s.errorBox}>
                <Ionicons name="warning-outline" size={15} color="#B91C1C" />
                <Text style={s.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            <Text style={s.inputLabel}>Correo electrónico</Text>
            <View style={s.inputWrap}>
              <Ionicons name="mail-outline" size={18} color={Colors.textSecondary} />
              <TextInput style={s.input} placeholder="tu@correo.com" placeholderTextColor={Colors.textLight}
                keyboardType="email-address" autoCapitalize="none"
                value={email} onChangeText={(v) => { setEmail(v); setErrorMsg(''); }} />
            </View>

            <Text style={s.inputLabel}>Contraseña</Text>
            <View style={s.inputWrap}>
              <Ionicons name="lock-closed-outline" size={18} color={Colors.textSecondary} />
              <TextInput style={s.input} placeholder="••••••••" placeholderTextColor={Colors.textLight}
                secureTextEntry={!showPass}
                value={password} onChangeText={(v) => { setPassword(v); setErrorMsg(''); }} />
              <TouchableOpacity onPress={() => setShowPass(!showPass)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={s.btnPill} onPress={handleLogin} disabled={loading} activeOpacity={0.85}>
              <Text style={s.btnPillText}>{loading ? 'Verificando...' : 'Ingresar'}</Text>
            </TouchableOpacity>

            <View style={s.divider}>
              <View style={s.dividerLine} />
              <Text style={s.dividerText}>¿No tienes cuenta?</Text>
              <View style={s.dividerLine} />
            </View>

            {!esRest && (
              <>
                <TouchableOpacity style={s.btnOutline} onPress={() => router.push('/registro-cliente')}>
                  <Ionicons name="person-add-outline" size={16} color={Colors.primary} />
                  <Text style={s.btnOutlineText}>Crear cuenta gratis</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btnOutline, { marginTop: 10, borderColor: Colors.border }]} onPress={() => router.push('/registro-telefono')}>
                  <Ionicons name="phone-portrait-outline" size={16} color={Colors.textSecondary} />
                  <Text style={[s.btnOutlineText, { color: Colors.textSecondary }]}>Ingresar con teléfono</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={[s.btnOutline, { marginTop: 10, borderColor: esRest ? Colors.primary : Colors.border }]}
              onPress={() => router.push('/registro-restaurante')}
            >
              <Ionicons name="storefront-outline" size={16} color={esRest ? Colors.primary : Colors.textSecondary} />
              <Text style={[s.btnOutlineText, { color: esRest ? Colors.primary : Colors.textSecondary }]}>
                Registrar mi negocio
              </Text>
            </TouchableOpacity>
          </View>

          {logoTaps > 0 && (
            <Text style={s.tapHint}>{5 - logoTaps} taps más para acceso admin</Text>
          )}
          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.surface },
  rootDark: { flex: 1, backgroundColor: '#0F172A' },
  scroll: { flexGrow: 1, alignItems: 'center', backgroundColor: Colors.surface },
  scrollDark: { flexGrow: 1, alignItems: 'center', backgroundColor: '#0F172A' },
  inner: { width: '100%', maxWidth: 480, paddingHorizontal: 24, paddingTop: 16 } as any,

  logoArea: { alignItems: 'center', paddingTop: 28, paddingBottom: 24 },
  logoCircle: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.white,
    overflow: 'hidden', marginBottom: 14,
    elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.10, shadowRadius: 16,
  },
  logoImg: { width: 120, height: 120, borderRadius: 60, overflow: 'hidden' } as any,
  tagline: { fontSize: 14, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },

  adminPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#312E81', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginTop: 12, borderWidth: 1, borderColor: '#4338CA' },
  adminPillText: { color: '#A5B4FC', fontSize: 11, fontWeight: '800', letterSpacing: 1 },

  modeToggle: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: 20, padding: 4, marginBottom: 20, gap: 4 },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 16, gap: 6 },
  modeBtnActive: {
    backgroundColor: Colors.primary,
    elevation: 3, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6,
  },
  modeBtnText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  modeBtnTextActive: { color: Colors.white, fontWeight: '700' },

  formCard: {
    backgroundColor: Colors.white, borderRadius: 28, padding: 24,
    elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.1, shadowRadius: 24,
  },

  restBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: Colors.accentLight, borderRadius: 14, padding: 14, marginBottom: 20 },
  restBannerText: { fontSize: 13, color: Colors.primary, flex: 1, lineHeight: 19, fontWeight: '500' },

  googleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: Colors.border, borderRadius: 50, paddingVertical: 15, marginBottom: 4, gap: 10 },
  googleG: { fontSize: 20, fontWeight: '900', color: '#4285F4' },
  googleText: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },

  orRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 18, gap: 10 },
  orLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  orText: { color: Colors.textLight, fontSize: 12 },

  errorBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FEF2F2', borderRadius: 12, padding: 12, marginBottom: 16 },
  errorText: { color: '#B91C1C', fontSize: 13, fontWeight: '600', lineHeight: 18, flex: 1 },

  inputLabel: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, marginBottom: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 16, paddingHorizontal: 16, marginBottom: 16, gap: 10 },
  input: { flex: 1, fontSize: 15, color: Colors.textPrimary, paddingVertical: 14 },

  btnPill: {
    backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center', marginTop: 4, marginBottom: 4,
    elevation: 4, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10,
  },
  btnPillText: { color: Colors.white, fontWeight: '800', fontSize: 16 },

  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20, gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { color: Colors.textLight, fontSize: 12 },

  btnOutline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: Colors.primary, borderRadius: 50, paddingVertical: 14 },
  btnOutlineText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },

  darkCard: { backgroundColor: '#1E293B', borderRadius: 28, padding: 24, borderWidth: 1, borderColor: '#334155' },
  darkCardTitle: { fontSize: 24, fontWeight: '900', color: Colors.white, marginBottom: 6 },
  darkCardSub: { fontSize: 13, color: '#64748B', marginBottom: 20, lineHeight: 18 },
  darkLabel: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 8 },

  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, padding: 10 },
  linkBtnText: { fontSize: 13, fontWeight: '600' },
  tapHint: { textAlign: 'center', color: Colors.textLight, fontSize: 12, marginTop: 16 },
});
