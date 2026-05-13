import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const GT_PHONE_REGEX = /^[234567]\d{7}$/;

function validatePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!GT_PHONE_REGEX.test(digits))
    return 'Ingresa un número guatemalteco válido (8 dígitos, inicia con 2, 3, 4, 5, 6 o 7)';
  return null;
}

function validateEmail(value: string): string | null {
  if (!value) return 'El correo es requerido';
  if (!EMAIL_REGEX.test(value))
    return 'Ingresa un correo electrónico válido (ej. usuario@dominio.com)';
  return null;
}

export default function RegistroClienteScreen() {
  const [form, setForm] = useState({ nombre: '', apellido: '', email: '', password: '', telefono: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const { registroCliente } = useAuth();
  const router = useRouter();

  const set = (k: string) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (!form.nombre.trim()) next.nombre = 'El nombre es requerido';

    const emailErr = validateEmail(form.email.trim());
    if (emailErr) next.email = emailErr;

    if (form.telefono.trim()) {
      const phoneErr = validatePhone(form.telefono.trim());
      if (phoneErr) next.telefono = phoneErr;
    }

    if (!form.password) {
      next.password = 'La contraseña es requerida';
    } else if (form.password.length < 6) {
      next.password = 'La contraseña debe tener al menos 6 caracteres';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleRegistro() {
    if (!validate()) return;
    setLoading(true);
    try {
      await registroCliente(form);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  const fields = [
    { key: 'nombre', label: 'Nombre *', placeholder: 'Juan' },
    { key: 'apellido', label: 'Apellido', placeholder: 'García' },
    { key: 'email', label: 'Correo electrónico *', placeholder: 'juan@dominio.com', keyboard: 'email-address' as any },
    { key: 'telefono', label: 'Teléfono', placeholder: '55555555', keyboard: 'phone-pad' as any },
    { key: 'password', label: 'Contraseña *', placeholder: 'Mínimo 6 caracteres', secure: true },
  ];

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.back()} style={s.back}>
          <Text style={s.backText}>← Volver</Text>
        </TouchableOpacity>
        <Text style={s.title}>Crear cuenta</Text>
        <Text style={s.subtitle}>Únete a Bocara y rescata comida</Text>

        {fields.map(({ key, label, placeholder, keyboard, secure }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              style={[s.input, errors[key] ? s.inputError : null]}
              placeholder={placeholder}
              placeholderTextColor={Colors.textLight}
              keyboardType={keyboard || 'default'}
              autoCapitalize={key === 'email' ? 'none' : 'words'}
              secureTextEntry={secure}
              value={(form as any)[key]}
              onChangeText={set(key)}
            />
            {errors[key] ? <Text style={s.errorText}>{errors[key]}</Text> : null}
          </View>
        ))}

        <TouchableOpacity style={s.btn} onPress={handleRegistro} disabled={loading}>
          <Text style={s.btnText}>{loading ? 'Creando cuenta...' : '🎉 Crear cuenta gratis'}</Text>
        </TouchableOpacity>

        <Text style={s.terms}>
          Al registrarte aceptas nuestros{' '}
          <Text style={{ color: Colors.orange }}>Términos y Condiciones</Text>
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 24, paddingTop: 56 },
  back: { marginBottom: 20 },
  backText: { color: Colors.orange, fontWeight: '700', fontSize: 15 },
  title: { fontSize: 28, fontWeight: '900', color: Colors.brown, marginBottom: 4 },
  subtitle: { fontSize: 14, color: Colors.textSecondary, marginBottom: 28 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 4,
  },
  inputError: { borderColor: '#e53e3e' },
  errorText: { color: '#e53e3e', fontSize: 12, marginBottom: 12, marginTop: 2 },
  btn: {
    backgroundColor: Colors.orange, borderRadius: 14, padding: 16,
    alignItems: 'center', marginTop: 8,
  },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  terms: { textAlign: 'center', color: Colors.textLight, fontSize: 12, marginTop: 16 },
});
