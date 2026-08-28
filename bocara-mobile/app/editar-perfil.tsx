import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { authAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

// Mismo criterio que registro-cliente.tsx: número guatemalteco, 8 dígitos,
// inicia con 2-7. Se mantiene idéntico a propósito para que un perfil nunca
// termine con un teléfono que la validación de registro habría rechazado.
const GT_PHONE_REGEX = /^[234567]\d{7}$/;

function validatePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!GT_PHONE_REGEX.test(digits))
    return 'Número guatemalteco inválido (8 dígitos, inicia con 2, 3, 4, 5, 6 o 7)';
  return null;
}

export default function EditarPerfilScreen() {
  const { usuario, actualizarUsuario } = useAuth();
  const router = useRouter();

  const original = {
    nombre: usuario?.nombre || '',
    apellido: usuario?.apellido || '',
    telefono: usuario?.telefono || '',
  };

  const [form, setForm] = useState(original);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  const hayCambios =
    form.nombre.trim() !== original.nombre ||
    form.apellido.trim() !== original.apellido ||
    form.telefono.trim() !== original.telefono;

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.nombre.trim()) next.nombre = 'El nombre es requerido';
    if (form.telefono.trim()) {
      const phoneErr = validatePhone(form.telefono.trim());
      if (phoneErr) next.telefono = phoneErr;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleGuardar() {
    if (!hayCambios || loading) return;
    if (!validate()) return;
    setLoading(true);
    try {
      const payload = {
        nombre: form.nombre.trim(),
        apellido: form.apellido.trim(),
        telefono: form.telefono.trim().replace(/\D/g, ''),
      };
      const { data } = await authAPI.actualizarPerfil(payload);
      actualizarUsuario(data);
      router.back();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'No se pudo guardar. Intenta de nuevo.');
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
        <Text style={s.title}>Editar perfil</Text>
        <Text style={s.subtitle}>Mantén tus datos actualizados</Text>

        <Text style={s.label}>Nombre *</Text>
        <TextInput
          style={[s.input, errors.nombre ? s.inputError : null]}
          placeholder="Juan"
          placeholderTextColor={Colors.textLight}
          autoCapitalize="words"
          value={form.nombre}
          onChangeText={set('nombre')}
        />
        {errors.nombre ? <Text style={s.errorText}>{errors.nombre}</Text> : null}

        <Text style={s.label}>Apellido</Text>
        <TextInput
          style={s.input}
          placeholder="García"
          placeholderTextColor={Colors.textLight}
          autoCapitalize="words"
          value={form.apellido}
          onChangeText={set('apellido')}
        />

        <Text style={s.label}>Teléfono</Text>
        <TextInput
          style={[s.input, errors.telefono ? s.inputError : null]}
          placeholder="55555555"
          placeholderTextColor={Colors.textLight}
          keyboardType="phone-pad"
          value={form.telefono}
          onChangeText={set('telefono')}
        />
        {errors.telefono ? <Text style={s.errorText}>{errors.telefono}</Text> : null}

        <Text style={s.label}>Correo electrónico</Text>
        <View style={s.lockedInput}>
          <Text style={s.lockedText}>{usuario?.email}</Text>
          <Text style={s.lockedIcon}>🔒</Text>
        </View>
        <Text style={s.lockedHint}>
          Es con lo que inicias sesión, así que no se puede cambiar aquí. Si necesitas actualizarlo, contacta a bocara@bocarafood.com.
        </Text>

        <TouchableOpacity
          style={[s.btn, (!hayCambios || loading) && s.btnDisabled]}
          onPress={handleGuardar}
          disabled={!hayCambios || loading}
        >
          <Text style={s.btnText}>{loading ? 'Guardando...' : 'Guardar cambios'}</Text>
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
  title: { fontSize: 28, fontWeight: '900', color: Colors.brown, marginBottom: 4 },
  subtitle: { fontSize: 14, color: Colors.textSecondary, marginBottom: 28 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: Colors.textPrimary, marginBottom: 4,
  },
  inputError: { borderColor: '#e53e3e' },
  errorText: { color: '#e53e3e', fontSize: 12, marginBottom: 12, marginTop: 2 },
  lockedInput: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, padding: 14, marginBottom: 6,
  },
  lockedText: { fontSize: 15, color: Colors.textSecondary },
  lockedIcon: { fontSize: 14 },
  lockedHint: { fontSize: 12, color: Colors.textLight, lineHeight: 18, marginBottom: 20 },
  btn: {
    backgroundColor: Colors.orange, borderRadius: 14, padding: 16,
    alignItems: 'center', marginTop: 8,
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
