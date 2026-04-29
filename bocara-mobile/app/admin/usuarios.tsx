import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, RefreshControl, Alert, TextInput, ActivityIndicator } from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

export default function AdminUsuariosScreen() {
  const [usuarios, setUsuarios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [rolFiltro, setRolFiltro] = useState('todos');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.usuarios();
      setUsuarios(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function cambiarRol(id: string, nuevoRol: string) {
    Alert.alert('Cambiar rol', `¿Cambiar a ${nuevoRol}?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Confirmar', onPress: async () => { await adminAPI.gestionarUsuario(id, { rol: nuevoRol }); cargar(); } },
    ]);
  }

  const filtrados = usuarios.filter((u) => {
    const matchBusq = !busqueda || u.nombre?.toLowerCase().includes(busqueda.toLowerCase()) || u.email?.toLowerCase().includes(busqueda.toLowerCase());
    const matchRol = rolFiltro === 'todos' || u.rol === rolFiltro;
    return matchBusq && matchRol;
  });

  const ROL_COLORS: Record<string, string> = { cliente: Colors.orange, restaurante: Colors.brown, admin: Colors.green };

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>Gestión de usuarios</Text></View>
      <View style={s.searchRow}>
        <TextInput style={s.search} placeholder="Buscar usuario..." placeholderTextColor={Colors.textLight} value={busqueda} onChangeText={setBusqueda} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filtros} contentContainerStyle={{ paddingHorizontal: 12 }}>
        {['todos', 'cliente', 'restaurante', 'admin'].map((r) => (
          <TouchableOpacity key={r} style={[s.chip, rolFiltro === r && s.chipActive]} onPress={() => setRolFiltro(r)}>
            <Text style={[s.chipText, rolFiltro === r && s.chipTextActive]}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}>
        <Text style={s.count}>{filtrados.length} usuarios</Text>
        {filtrados.map((u) => (
          <View key={u.id} style={s.card}>
            <View style={s.cardTop}>
              <View style={s.avatarBox}><Text style={{ fontSize: 20 }}>👤</Text></View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.nombre}>{u.nombre} {u.apellido || ''}</Text>
                <Text style={s.email}>{u.email}</Text>
                <Text style={s.fecha}>Desde {new Date(u.created_at).toLocaleDateString('es-GT')}</Text>
              </View>
              <View style={[s.rolBadge, { backgroundColor: ROL_COLORS[u.rol] + '20' }]}>
                <Text style={[s.rolText, { color: ROL_COLORS[u.rol] }]}>{u.rol}</Text>
              </View>
            </View>
            <View style={s.stats}>
              <Text style={s.statItem}>📦 {u.total_bolsas_salvadas} bolsas</Text>
              <Text style={s.statItem}>⭐ {u.puntos} pts</Text>
              <Text style={s.statItem}>💰 Q{u.total_ahorrado?.toFixed(0)}</Text>
            </View>
            {u.rol !== 'admin' && (
              <View style={s.actions}>
                {u.rol === 'cliente' && (
                  <TouchableOpacity style={s.actionBtn} onPress={() => cambiarRol(u.id, 'restaurante')}>
                    <Text style={s.actionText}>→ Restaurante</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[s.actionBtn, { borderColor: Colors.green }]} onPress={() => cambiarRol(u.id, 'admin')}>
                  <Text style={[s.actionText, { color: Colors.green }]}>→ Admin</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  searchRow: { padding: 12, paddingBottom: 0 },
  search: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary },
  filtros: { maxHeight: 52, marginVertical: 10 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginRight: 8, backgroundColor: Colors.white },
  chipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  scroll: { padding: 14 },
  count: { fontSize: 13, color: Colors.textSecondary, marginBottom: 12 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 10, elevation: 2 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  avatarBox: { backgroundColor: Colors.brownLight, borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nombre: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  email: { fontSize: 12, color: Colors.textSecondary, marginTop: 1 },
  fecha: { fontSize: 11, color: Colors.textLight, marginTop: 1 },
  rolBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  rolText: { fontSize: 12, fontWeight: '700' },
  stats: { flexDirection: 'row', gap: 16, backgroundColor: Colors.background, borderRadius: 10, padding: 8, marginBottom: 8 },
  statItem: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  actionBtn: { borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  actionText: { color: Colors.orange, fontSize: 12, fontWeight: '700' },
});
