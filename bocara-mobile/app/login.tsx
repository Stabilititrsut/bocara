import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

type Modo = 'cliente' | 'restaurante';

export default function LoginScreen() {
  const [modo, setModo] = useState<Modo>('cliente');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();
  const esRest = modo === 'restaurante';

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

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={[s.header, esRest && s.headerRest]}>
          <Text style={s.logo}>Boca<Text style={s.logoAccent}>ra</Text></Text>
          <Text style={s.tagline}>
            {esRest ? '🏪 Panel para negocios' : 'Rescata comida · Ahorra dinero 🌱'}
          </Text>
        </View>

        {/* Toggle modo */}
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

        <View style={s.card}>
          <Text style={s.title}>{esRest ? 'Panel de restaurante' : 'Iniciar sesión'}</Text>
          {esRest && (
            <View style={s.restBanner}>
              <Text style={s.restBannerText}>
                Administra tus bolsas, cupones, pedidos y ganancias desde aquí.
              </Text>
            </View>
          )}

          <Text style={s.label}>Correo electrónico</Text>
          <TextInput
            style={s.input}
            placeholder="tu@negocio.com"
            placeholderTextColor={Colors.textLight}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
          />

          <Text style={s.label}>Contraseña</Text>
          <TextInput
            style={s.input}
            placeholder="••••••••"
            placeholderTextColor={Colors.textLight}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity
            style={[s.btn, esRest && s.btnRest]}
            onPress={handleLogin}
            disabled={loading}
          >
            <Text style={s.btnText}>{loading ? 'Ingresando...' : 'Iniciar sesión'}</Text>
          </TouchableOpacity>

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
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.brown },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 20 },
  headerRest: {},
  logo: { fontSize: 52, fontWeight: '900', color: Colors.white, letterSpacing: -1 },
  logoAccent: { color: Colors.orange },
  tagline: { color: Colors.orangeLight, fontSize: 14, marginTop: 4, textAlign: 'center' },
  modoRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, padding: 4, marginBottom: 16 },
  modoBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 11 },
  modoBtnActive: { backgroundColor: Colors.white },
  modoBtnText: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  modoBtnTextActive: { color: Colors.brown, fontWeight: '800' },
  card: { backgroundColor: Colors.white, borderRadius: 24, padding: 28 },
  title: { fontSize: 22, fontWeight: '800', color: Colors.brown, marginBottom: 16 },
  restBanner: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 12, marginBottom: 16 },
  restBannerText: { fontSize: 13, color: Colors.brown, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.inputBg, borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 16 },
  btn: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  btnRest: { backgroundColor: Colors.brown },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  dividerText: { marginHorizontal: 12, color: Colors.textLight, fontSize: 13 },
  btnOutline: { borderWidth: 2, borderColor: Colors.brown, borderRadius: 14, padding: 14, alignItems: 'center' },
  btnOutlineText: { color: Colors.brown, fontWeight: '700', fontSize: 15 },
});
