import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];

export default function RegistroRestauranteScreen() {
  const [form, setForm] = useState({
    nombre: '', apellido: '', email: '', password: '',
    nombre_negocio: '', direccion_negocio: '', categoria: '', telefono: '',
  });
  const [loading, setLoading] = useState(false);
  const { registroRestaurante } = useAuth();
  const router = useRouter();
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleRegistro() {
    if (!form.nombre || !form.email || !form.password || !form.nombre_negocio)
      return Alert.alert('Error', 'Completa todos los campos requeridos');
    setLoading(true);
    try {
      await registroRestaurante(form);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.back()} style={s.back}>
          <Text style={s.backText}>← Volver</Text>
        </TouchableOpacity>
        <Text style={s.title}>Registra tu negocio</Text>
        <Text style={s.subtitle}>Únete a Bocara y reduce el desperdicio de alimentos</Text>

        <Text style={s.section}>👤 Datos del propietario</Text>
        {[
          { key: 'nombre', label: 'Nombre *', placeholder: 'María' },
          { key: 'apellido', label: 'Apellido', placeholder: 'González' },
          { key: 'email', label: 'Correo *', placeholder: 'maria@negocio.com', keyboard: 'email-address' as any },
          { key: 'password', label: 'Contraseña *', placeholder: 'Mínimo 6 caracteres', secure: true },
        ].map(({ key, label, placeholder, keyboard, secure }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
              keyboardType={keyboard || 'default'} autoCapitalize={key === 'email' ? 'none' : 'words'}
              secureTextEntry={secure} value={(form as any)[key]} onChangeText={set(key)}
            />
          </View>
        ))}

        <Text style={s.section}>🍽️ Datos del negocio</Text>
        {[
          { key: 'nombre_negocio', label: 'Nombre del negocio *', placeholder: 'Panadería San Marcos' },
          { key: 'direccion_negocio', label: 'Dirección', placeholder: 'Zona 10, Guatemala City' },
          { key: 'telefono', label: 'Teléfono', placeholder: '2345-6789', keyboard: 'phone-pad' as any },
        ].map(({ key, label, placeholder, keyboard }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
              keyboardType={keyboard || 'default'} value={(form as any)[key]} onChangeText={set(key)}
            />
          </View>
        ))}

        <Text style={s.label}>Categoría</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          {CATEGORIAS.map((cat) => (
            <TouchableOpacity
              key={cat}
              style={[s.chip, form.categoria === cat && s.chipSelected]}
              onPress={() => setForm((f) => ({ ...f, categoria: cat }))}
            >
              <Text style={[s.chipText, form.categoria === cat && s.chipTextSelected]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <TouchableOpacity style={s.btn} onPress={handleRegistro} disabled={loading}>
          <Text style={s.btnText}>{loading ? 'Registrando...' : '🚀 Registrar negocio'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingTop: 56 },
  back: { marginBottom: 20 },
  backText: { color: Colors.orange, fontWeight: '700', fontSize: 15 },
  title: { fontSize: 26, fontWeight: '900', color: Colors.brown, marginBottom: 4 },
  subtitle: { fontSize: 13, color: Colors.textSecondary, marginBottom: 24 },
  section: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 16, marginTop: 8 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 16,
  },
  chip: {
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, backgroundColor: Colors.white,
  },
  chipSelected: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextSelected: { color: Colors.white },
  btn: { backgroundColor: Colors.orange, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
