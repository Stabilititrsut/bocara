import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

type Modo = 'cliente' | 'restaurante' | 'admin';

const MODO_CONFIG = {
  cliente:     { bg: Colors.brown,   accent: Colors.orange,   label: 'Iniciar sesión',       banner: null },
  restaurante: { bg: Colors.brown,   accent: Colors.brown,    label: 'Panel de restaurante',  banner: 'Administra tus bolsas, cupones, pedidos y ganancias desde aquí.' },
  admin:       { bg: '#0F172A',      accent: '#6366F1',       label: 'Acceso administrador',  banner: 'Área restringida — solo para administradores de plataforma.' },
};

export default function LoginScreen() {
  const [modo, setModo] = useState<Modo>('cliente');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoTaps, setLogoTaps] = useState(0);
  const { login } = useAuth();
  const router = useRouter();

  const cfg = MODO_CONFIG[modo];
  const esRest = modo === 'restaurante';
  const esAdmin = modo === 'admin';

  function handleLogoTap() {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (next >= 5) {
      setModo('admin');
      setLogoTaps(0);
    }
  }

  async function handleLogin() {
    if (!email || !password) return Alert.alert('Error', 'Ingresa email y contraseña');
    setLoading(true);
    try {
      await login(email.toLowerCase().trim(), password);
    } catch (e: any) {
      Alert.alert('Error al ingresar', e.message || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  }

  const rootBg = esAdmin ? '#0F172A' : Colors.brown;

  return (
    <KeyboardAvoidingView style={[s.root, { backgroundColor: rootBg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <TouchableOpacity style={s.header} onPress={handleLogoTap} activeOpacity={1}>
          {esAdmin ? (
            <>
              <Text style={[s.logo, { color: '#6366F1' }]}>Boca<Text style={{ color: Colors.white }}>ra</Text></Text>
              <View style={s.adminPill}>
                <Text style={s.adminPillText}>🔐 ADMIN</Text>
              </View>
              <Text style={[s.tagline, { color: '#94A3B8' }]}>Panel de administración de plataforma</Text>
            </>
          ) : (
            <>
              <Text style={s.logo}>Boca<Text style={s.logoAccent}>ra</Text></Text>
              <Text style={s.tagline}>
                {esRest ? '🏪 Panel para negocios' : 'Rescata comida · Ahorra dinero 🌱'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Toggle modo cliente/restaurante */}
        {!esAdmin && (
          <View style={s.modoRow}>
            <TouchableOpacity
              style={[s.modoBtn, !esRest && s.modoBtnActive]}
              onPress={() => setModo('cliente')}
            >
              <Text style={[s.modoBtnText, !esRest && s.modoBtnTextActive]}>👤 Soy cliente</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modoBtn, esRest && s.modoBtnActive]}
              onPress={() => setModo('restaurante')}
            >
              <Text style={[s.modoBtnText, esRest && s.modoBtnTextActive]}>🏪 Tengo un negocio</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={[s.card, esAdmin && s.cardAdmin]}>
          <Text style={[s.title, esAdmin && { color: Colors.white }]}>{cfg.label}</Text>

          {cfg.banner && (
            <View style={[s.restBanner, esAdmin && s.adminBanner]}>
              <Text style={[s.restBannerText, esAdmin && { color: '#94A3B8' }]}>{cfg.banner}</Text>
            </View>
          )}

          <Text style={[s.label, esAdmin && { color: '#64748B' }]}>Correo electrónico</Text>
          <TextInput
            style={[s.input, esAdmin && s.inputAdmin]}
            placeholder={esAdmin ? 'admin@bocara.gt' : 'tu@correo.com'}
            placeholderTextColor={Colors.textLight}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />

          <Text style={[s.label, esAdmin && { color: '#64748B' }]}>Contraseña</Text>
          <TextInput
            style={[s.input, esAdmin && s.inputAdmin]}
            placeholder="••••••••"
            placeholderTextColor={Colors.textLight}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity
            style={[s.btn, esRest && s.btnRest, esAdmin && s.btnAdmin]}
            onPress={handleLogin}
            disabled={loading}
          >
            <Text style={s.btnText}>{loading ? 'Verificando...' : 'Ingresar'}</Text>
          </TouchableOpacity>

          {esAdmin && (
            <TouchableOpacity style={s.backLink} onPress={() => setModo('cliente')}>
              <Text style={s.backLinkText}>← Volver al login de clientes</Text>
            </TouchableOpacity>
          )}

          {!esAdmin && (
            <>
              <View style={s.divider}>
                <View style={s.dividerLine} />
                <Text style={s.dividerText}>¿No tienes cuenta?</Text>
                <View style={s.dividerLine} />
              </View>

              {!esRest && (
                <TouchableOpacity style={s.btnOutline} onPress={() => router.push('/registro-cliente')}>
                  <Text style={s.btnOutlineText}>Registrarme como cliente</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[s.btnOutline, { marginTop: esRest ? 0 : 10, borderColor: esRest ? Colors.orange : Colors.brown }]}
                onPress={() => router.push('/registro-restaurante')}
              >
                <Text style={[s.btnOutlineText, esRest && { color: Colors.orange }]}>
                  🏪 Registrar mi negocio
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Acceso admin oculto (5 taps en logo) */}
        {!esAdmin && logoTaps > 0 && (
          <Text style={s.tapHint}>{5 - logoTaps} taps más para acceso admin</Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 20 },
  logo: { fontSize: 52, fontWeight: '900', color: Colors.white, letterSpacing: -1 },
  logoAccent: { color: Colors.orange },
  tagline: { color: Colors.orangeLight, fontSize: 14, marginTop: 4, textAlign: 'center' },
  adminPill: { backgroundColor: '#312E81', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginTop: 8, borderWidth: 1, borderColor: '#6366F1' },
  adminPillText: { color: '#A5B4FC', fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  modoRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, padding: 4, marginBottom: 16 },
  modoBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 11 },
  modoBtnActive: { backgroundColor: Colors.white },
  modoBtnText: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  modoBtnTextActive: { color: Colors.brown, fontWeight: '800' },
  card: { backgroundColor: Colors.white, borderRadius: 24, padding: 28 },
  cardAdmin: { backgroundColor: '#1E293B', borderWidth: 1, borderColor: '#334155' },
  title: { fontSize: 22, fontWeight: '800', color: Colors.brown, marginBottom: 16 },
  restBanner: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 12, marginBottom: 16 },
  adminBanner: { backgroundColor: '#312E81', borderColor: '#4338CA', borderWidth: 1 },
  restBannerText: { fontSize: 13, color: Colors.brown, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.inputBg, borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 16 },
  inputAdmin: { backgroundColor: '#334155', color: Colors.white },
  btn: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  btnRest: { backgroundColor: Colors.brown },
  btnAdmin: { backgroundColor: '#4F46E5' },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  backLink: { marginTop: 16, alignItems: 'center' },
  backLinkText: { color: '#64748B', fontSize: 13, fontWeight: '600' },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { marginHorizontal: 12, color: Colors.textLight, fontSize: 13 },
  btnOutline: { borderWidth: 2, borderColor: Colors.brown, borderRadius: 14, padding: 14, alignItems: 'center' },
  btnOutlineText: { color: Colors.brown, fontWeight: '700', fontSize: 15 },
  tapHint: { textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 16 },
});
