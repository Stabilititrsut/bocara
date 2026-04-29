import { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, SafeAreaView, Alert, ActivityIndicator } from 'react-native';
import { negociosAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const CATEGORIAS = ['Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otro'];

export default function PerfilRestauranteScreen() {
  const [negocio, setNegocio] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { logout, usuario } = useAuth();
  const set = (k: string) => (v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  useEffect(() => {
    negociosAPI.miNegocio().then((res) => {
      setNegocio(res.data);
      setForm({ nombre: res.data.nombre, descripcion: res.data.descripcion || '', direccion: res.data.direccion || '', zona: res.data.zona || '', telefono: res.data.telefono || '', categoria: res.data.categoria || '' });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function guardar() {
    setSaving(true);
    try {
      await negociosAPI.actualizar(negocio.id, form);
      Alert.alert('¡Guardado!', 'Los datos del negocio fueron actualizados');
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  }

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mi negocio</Text>
        <TouchableOpacity style={s.saveBtn} onPress={guardar} disabled={saving}>
          <Text style={s.saveBtnText}>{saving ? '...' : 'Guardar'}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.statsRow}>
          <View style={s.stat}><Text style={s.statVal}>{negocio?.total_bolsas_vendidas || 0}</Text><Text style={s.statLabel}>Bolsas vendidas</Text></View>
          <View style={s.stat}><Text style={s.statVal}>{negocio?.calificacion_promedio?.toFixed(1) || '–'}</Text><Text style={s.statLabel}>Calificación</Text></View>
          <View style={s.stat}><Text style={s.statVal}>{negocio?.total_resenas || 0}</Text><Text style={s.statLabel}>Reseñas</Text></View>
        </View>

        {[
          { key: 'nombre', label: 'Nombre del negocio' },
          { key: 'descripcion', label: 'Descripción', multi: true },
          { key: 'direccion', label: 'Dirección' },
          { key: 'zona', label: 'Zona' },
          { key: 'telefono', label: 'Teléfono', keyboard: 'phone-pad' as any },
        ].map(({ key, label, multi, keyboard }) => (
          <View key={key}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              style={[s.input, multi && { height: 80 }]} placeholder={label} placeholderTextColor={Colors.textLight}
              keyboardType={keyboard} value={form[key]} onChangeText={set(key)}
              multiline={multi} textAlignVertical={multi ? 'top' : 'center'}
            />
          </View>
        ))}

        <Text style={s.label}>Categoría</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
          {CATEGORIAS.map((cat) => (
            <TouchableOpacity key={cat} style={[s.chip, form.categoria === cat && s.chipActive]} onPress={() => setForm((f: any) => ({ ...f, categoria: cat }))}>
              <Text style={[s.chipText, form.categoria === cat && s.chipTextActive]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <TouchableOpacity style={s.logoutBtn} onPress={logout}>
          <Text style={s.logoutText}>Cerrar sesión</Text>
        </TouchableOpacity>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  saveBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  saveBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  scroll: { padding: 16 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stat: { flex: 1, backgroundColor: Colors.white, borderRadius: 14, padding: 12, alignItems: 'center', elevation: 1 },
  statVal: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2, textAlign: 'center' },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 14 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, backgroundColor: Colors.white },
  chipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  logoutBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 14, padding: 14, alignItems: 'center' },
  logoutText: { color: Colors.error, fontWeight: '700', fontSize: 15 },
});
