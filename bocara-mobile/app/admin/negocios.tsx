import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, RefreshControl, Alert, TextInput, ActivityIndicator } from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

export default function AdminNegociosScreen() {
  const [negocios, setNegocios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<'todos' | 'sin_verificar'>('todos');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negocios();
      setNegocios(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function verificar(id: string) {
    try { await adminAPI.verificarNegocio(id); cargar(); }
    catch (e: any) { Alert.alert('Error', e.message); }
  }

  async function toggle(id: string, activo: boolean) {
    Alert.alert(activo ? 'Desactivar negocio' : 'Activar negocio', '¿Confirmar esta acción?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Confirmar', onPress: async () => { await adminAPI.toggleNegocio(id); cargar(); } },
    ]);
  }

  const filtrados = negocios.filter((n) => {
    const matchBusq = !busqueda || n.nombre.toLowerCase().includes(busqueda.toLowerCase());
    const matchFiltro = filtro === 'todos' || !n.verificado;
    return matchBusq && matchFiltro;
  });

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>Gestión de negocios</Text></View>
      <View style={s.searchRow}>
        <TextInput style={s.search} placeholder="Buscar negocio..." placeholderTextColor={Colors.textLight} value={busqueda} onChangeText={setBusqueda} />
      </View>
      <View style={s.filtros}>
        {(['todos', 'sin_verificar'] as const).map((f) => (
          <TouchableOpacity key={f} style={[s.filtroChip, filtro === f && s.filtroActive]} onPress={() => setFiltro(f)}>
            <Text style={[s.filtroText, filtro === f && s.filtroTextActive]}>{f === 'todos' ? 'Todos' : 'Sin verificar'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}>
        {filtrados.map((n) => (
          <View key={n.id} style={s.card}>
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.nombre}>{n.nombre}</Text>
                <Text style={s.categoria}>{n.categoria} · {n.zona}</Text>
                <Text style={s.stats}>📦 {n.total_bolsas_vendidas} vendidas · ⭐ {n.calificacion_promedio?.toFixed(1) || '–'}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                {n.verificado
                  ? <View style={s.verificadoBadge}><Text style={s.verificadoText}>✓ Verificado</Text></View>
                  : <View style={s.pendienteBadge}><Text style={s.pendienteText}>⏳ Pendiente</Text></View>}
                {!n.activo && <View style={s.inactivoBadge}><Text style={s.inactivoText}>Inactivo</Text></View>}
              </View>
            </View>
            <View style={s.actions}>
              {!n.verificado && (
                <TouchableOpacity style={s.btnVerificar} onPress={() => verificar(n.id)}>
                  <Text style={s.btnVerificarText}>✓ Verificar</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={[s.btnToggle, n.activo && s.btnToggleActivo]} onPress={() => toggle(n.id, n.activo)}>
                <Text style={[s.btnToggleText, n.activo && s.btnToggleTextoActivo]}>{n.activo ? 'Desactivar' : 'Activar'}</Text>
              </TouchableOpacity>
            </View>
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
  filtros: { flexDirection: 'row', padding: 12, gap: 8 },
  filtroChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: Colors.white },
  filtroActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  filtroText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  filtroTextActive: { color: Colors.white },
  scroll: { padding: 14 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2 },
  cardTop: { flexDirection: 'row', marginBottom: 12 },
  nombre: { fontSize: 16, fontWeight: '800', color: Colors.brown },
  categoria: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  stats: { fontSize: 12, color: Colors.textLight, marginTop: 4 },
  verificadoBadge: { backgroundColor: Colors.greenLight, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  verificadoText: { fontSize: 12, color: Colors.green, fontWeight: '700' },
  pendienteBadge: { backgroundColor: Colors.orangeLight, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  pendienteText: { fontSize: 12, color: Colors.orange, fontWeight: '700' },
  inactivoBadge: { backgroundColor: Colors.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  inactivoText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  btnVerificar: { flex: 1, backgroundColor: Colors.green, borderRadius: 10, padding: 10, alignItems: 'center' },
  btnVerificarText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  btnToggle: { flex: 1, borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 10, padding: 10, alignItems: 'center' },
  btnToggleActivo: { borderColor: Colors.error },
  btnToggleText: { color: Colors.orange, fontWeight: '700', fontSize: 13 },
  btnToggleTextoActivo: { color: Colors.error },
});
