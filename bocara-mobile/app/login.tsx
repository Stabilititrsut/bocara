import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

type Modo = 'cliente' | 'restaurante' | 'admin';

export default function LoginScreen() {
  const [modo, setModo] = useState<Modo>('cliente');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [logoTaps, setLogoTaps] = useState(0);
  const { login } = useAuth();
  const router = useRouter();

  const esRest = modo === 'restaurante';
  const esAdmin = modo === 'admin';

  function handleLogoTap() {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (next >= 5) { setModo('admin'); setLogoTaps(0); }
  }

  async function handleLogin() {
    if (!email || !password) return Alert.alert('Campos requeridos', 'Ingresa email y contraseña');
    setLoading(true);
    try {
      await login(email.toLowerCase().trim(), password);
    } catch (e: any) {
      Alert.alert('Error al ingresar', e.message || 'Credenciales incorrectas');
    } finally {
      setLoading(false);
    }
  }

  if (esAdmin) {
    return (
      <KeyboardAvoidingView style={s.rootDark} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={s.logoArea} onPress={handleLogoTap} activeOpacity={1}>
            <Text style={[s.logo, { color: '#818CF8' }]}>Boca<Text style={{ color: Colors.white }}>ra</Text></Text>
            <View style={s.adminPill}>
              <Ionicons name="lock-closed" size={12} color="#A5B4FC" />
              <Text style={s.adminPillText}>ADMIN</Text>
            </View>
          </TouchableOpacity>
          <View style={[s.formCard, { backgroundColor: '#1E293B', borderWidth: 1, borderColor: '#334155' }]}>
            <Text style={[s.formTitle, { color: Colors.white }]}>Acceso administrador</Text>
            <View style={[s.inputWrap, { backgroundColor: '#334155' }]}>
              <Ionicons name="mail-outline" size={18} color="#64748B" />
              <TextInput style={[s.input, { color: Colors.white }]} placeholder="admin@bocara.gt" placeholderTextColor="#475569"
                keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
            </View>
            <View style={[s.inputWrap, { backgroundColor: '#334155' }]}>
              <Ionicons name="lock-closed-outline" size={18} color="#64748B" />
              <TextInput style={[s.input, { color: Colors.white }]} placeholder="••••••••" placeholderTextColor="#475569"
                secureTextEntry={!showPass} value={password} onChangeText={setPassword} />
              <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color="#64748B" />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={[s.btnPrimary, { backgroundColor: '#4F46E5' }]} onPress={handleLogin} disabled={loading}>
              <Text style={s.btnPrimaryText}>{loading ? 'Verificando...' : 'Ingresar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.linkBtn} onPress={() => setModo('cliente')}>
              <Ionicons name="arrow-back" size={14} color="#64748B" />
              <Text style={[s.linkBtnText, { color: '#64748B' }]}>Volver al login</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        {/* Logo */}
        <TouchableOpacity style={s.logoArea} onPress={handleLogoTap} activeOpacity={1}>
          <View style={s.logoCircle}>
            <Text style={s.logoEmoji}>🥡</Text>
          </View>
          <Text style={s.logo}>Boca<Text style={s.logoAccent}>ra</Text></Text>
          <Text style={s.tagline}>{esRest ? 'Panel para negocios' : 'Rescata comida · Ahorra dinero'}</Text>
        </TouchableOpacity>

        {/* Toggle cliente/restaurante */}
        <View style={s.modeToggle}>
          <TouchableOpacity style={[s.modeBtn, !esRest && s.modeBtnActive]} onPress={() => setModo('cliente')}>
            <Ionicons name="person-outline" size={15} color={!esRest ? Colors.white : Colors.textSecondary} />
            <Text style={[s.modeBtnText, !esRest && s.modeBtnTextActive]}>Soy cliente</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.modeBtn, esRest && s.modeBtnActive]} onPress={() => setModo('restaurante')}>
            <Ionicons name="storefront-outline" size={15} color={esRest ? Colors.white : Colors.textSecondary} />
            <Text style={[s.modeBtnText, esRest && s.modeBtnTextActive]}>Tengo un negocio</Text>
          </TouchableOpacity>
        </View>

        {/* Formulario */}
        <View style={s.formCard}>
          <Text style={s.formTitle}>{esRest ? 'Acceso a tu negocio' : 'Iniciar sesión'}</Text>

          {esRest && (
            <View style={s.restInfo}>
              <Ionicons name="information-circle-outline" size={16} color={Colors.primary} />
              <Text style={s.restInfoText}>Administra tus bolsas, cupones, pedidos y ganancias desde aquí.</Text>
            </View>
          )}

          <Text style={s.inputLabel}>Correo electrónico</Text>
          <View style={s.inputWrap}>
            <Ionicons name="mail-outline" size={18} color={Colors.textSecondary} />
            <TextInput
              style={s.input}
              placeholder="tu@correo.com"
              placeholderTextColor={Colors.textLight}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
            />
          </View>

          <Text style={s.inputLabel}>Contraseña</Text>
          <View style={s.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={Colors.textSecondary} />
            <TextInput
              style={s.input}
              placeholder="••••••••"
              placeholderTextColor={Colors.textLight}
              secureTextEntry={!showPass}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity onPress={() => setShowPass(!showPass)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={s.btnPrimary} onPress={handleLogin} disabled={loading} activeOpacity={0.85}>
            <Text style={s.btnPrimaryText}>{loading ? 'Verificando...' : 'Ingresar'}</Text>
          </TouchableOpacity>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <Text style={s.dividerText}>¿No tienes cuenta?</Text>
            <View style={s.dividerLine} />
          </View>

          {!esRest && (
            <TouchableOpacity style={s.btnOutline} onPress={() => router.push('/registro-cliente')}>
              <Text style={s.btnOutlineText}>Crear cuenta gratis</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[s.btnOutline, { marginTop: !esRest ? 10 : 0, borderColor: esRest ? Colors.primary : Colors.border }]} onPress={() => router.push('/registro-restaurante')}>
            <Ionicons name="storefront-outline" size={16} color={esRest ? Colors.primary : Colors.textSecondary} />
            <Text style={[s.btnOutlineText, { color: esRest ? Colors.primary : Colors.textSecondary }]}>Registrar mi negocio</Text>
          </TouchableOpacity>
        </View>

        {logoTaps > 0 && !esAdmin && (
          <Text style={s.tapHint}>{5 - logoTaps} taps más para acceso admin</Text>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  rootDark: { flex: 1, backgroundColor: '#0F172A' },
  scroll: { flexGrow: 1, padding: 24 },

  logoArea: { alignItems: 'center', paddingTop: 32, paddingBottom: 24 },
  logoCircle: { width: 76, height: 76, borderRadius: 24, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  logoEmoji: { fontSize: 38 },
  logo: { fontSize: 40, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.5 },
  logoAccent: { color: Colors.primary },
  tagline: { fontSize: 14, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  adminPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#312E81', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginTop: 10, borderWidth: 1, borderColor: '#4338CA' },
  adminPillText: { color: '#A5B4FC', fontSize: 12, fontWeight: '800', letterSpacing: 1 },

  modeToggle: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: 16, padding: 4, marginBottom: 20, gap: 4 },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 12, gap: 6 },
  modeBtnActive: { backgroundColor: Colors.primary },
  modeBtnText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  modeBtnTextActive: { color: Colors.white, fontWeight: '700' },

  formCard: { backgroundColor: Colors.white, borderRadius: 24, padding: 24, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 10 },
  formTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, marginBottom: 20 },
  restInfo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: Colors.accentLight, borderRadius: 12, padding: 12, marginBottom: 20 },
  restInfoText: { fontSize: 13, color: Colors.primary, flex: 1, lineHeight: 18 },

  inputLabel: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 8 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 14, marginBottom: 16, gap: 10 },
  input: { flex: 1, fontSize: 15, color: Colors.textPrimary, paddingVertical: 13 },

  btnPrimary: { backgroundColor: Colors.primary, borderRadius: 16, padding: 16, alignItems: 'center', marginTop: 4, marginBottom: 4 },
  btnPrimaryText: { color: Colors.white, fontWeight: '800', fontSize: 16 },

  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20, gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { color: Colors.textLight, fontSize: 13 },

  btnOutline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 16, padding: 14 },
  btnOutlineText: { color: Colors.textPrimary, fontWeight: '700', fontSize: 14 },

  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, padding: 10 },
  linkBtnText: { fontSize: 13, fontWeight: '600' },
  tapHint: { textAlign: 'center', color: Colors.textLight, fontSize: 12, marginTop: 16 },
});
