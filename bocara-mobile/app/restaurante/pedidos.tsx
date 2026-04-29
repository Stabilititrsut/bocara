import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, RefreshControl, Alert, ActivityIndicator } from 'react-native';
import { pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const ESTADOS = ['todos', 'confirmado', 'listo', 'recogido'];
const ESTADO_COLORS: Record<string, string> = {
  pendiente: Colors.textLight, confirmado: Colors.orange,
  listo: Colors.green, recogido: Colors.textSecondary, cancelado: Colors.error,
};

export default function PedidosRestauranteScreen() {
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filtro, setFiltro] = useState('todos');

  const cargar = useCallback(async () => {
    try {
      const res = await pedidosAPI.restaurante();
      setPedidos(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function cambiarEstado(id: string, nuevoEstado: string) {
    try {
      await pedidosAPI.actualizarEstado(id, nuevoEstado);
      cargar();
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  const filtrados = pedidos.filter((p) => filtro === 'todos' || p.estado === filtro);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>Pedidos</Text></View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filtros} contentContainerStyle={{ paddingHorizontal: 14 }}>
        {ESTADOS.map((e) => (
          <TouchableOpacity key={e} style={[s.filtroChip, filtro === e && s.filtroActive]} onPress={() => setFiltro(e)}>
            <Text style={[s.filtroText, filtro === e && s.filtroTextActive]}>{e.charAt(0).toUpperCase() + e.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {filtrados.length === 0 && (
          <View style={s.empty}><Text style={{ fontSize: 40 }}>📋</Text><Text style={s.emptyText}>No hay pedidos en esta categoría</Text></View>
        )}
        {filtrados.map((p: any) => (
          <View key={p.id} style={s.card}>
            <View style={s.cardHeader}>
              <View>
                <Text style={s.codigo}>{p.codigo_recogida}</Text>
                <Text style={s.bolsaNombre}>{p.bolsas?.nombre}</Text>
              </View>
              <View>
                <Text style={s.total}>Q{p.total?.toFixed(2)}</Text>
                <View style={[s.estadoBadge, { backgroundColor: ESTADO_COLORS[p.estado] + '20' }]}>
                  <Text style={[s.estadoText, { color: ESTADO_COLORS[p.estado] }]}>{p.estado}</Text>
                </View>
              </View>
            </View>
            <View style={s.infoRow}>
              <Text style={s.infoText}>⏰ {p.hora_recogida_inicio?.slice(0, 5)} - {p.hora_recogida_fin?.slice(0, 5)}</Text>
              <Text style={s.infoText}>{p.tipo_entrega === 'envio' ? '🏍️ Envío' : '🏪 Recogida'}</Text>
              <Text style={s.infoText}>{new Date(p.created_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}</Text>
            </View>
            {p.estado === 'confirmado' && (
              <TouchableOpacity style={s.btnListo} onPress={() => cambiarEstado(p.id, 'listo')}>
                <Text style={s.btnListoText}>✓ Marcar como listo</Text>
              </TouchableOpacity>
            )}
            {p.estado === 'listo' && (
              <TouchableOpacity style={[s.btnListo, { backgroundColor: Colors.brown }]} onPress={() => cambiarEstado(p.id, 'recogido')}>
                <Text style={s.btnListoText}>✓ Confirmar recogida</Text>
              </TouchableOpacity>
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
  filtros: { maxHeight: 52, marginVertical: 10 },
  filtroChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7, marginRight: 8, backgroundColor: Colors.white },
  filtroActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  filtroText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  filtroTextActive: { color: Colors.white },
  scroll: { padding: 14 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  codigo: { fontSize: 18, fontWeight: '900', color: Colors.brown, letterSpacing: 2 },
  bolsaNombre: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  total: { fontSize: 18, fontWeight: '900', color: Colors.orange, textAlign: 'right' },
  estadoBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4, alignSelf: 'flex-end' },
  estadoText: { fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  infoText: { fontSize: 12, color: Colors.textSecondary },
  btnListo: { backgroundColor: Colors.green, borderRadius: 10, padding: 10, alignItems: 'center' },
  btnListoText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
});
