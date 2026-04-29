import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, Alert, TextInput, ActivityIndicator, Modal,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';

type Filtro = 'todos' | 'pendientes' | 'verificados' | 'inactivos';

export default function AdminNegociosScreen() {
  const [negocios, setNegocios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [rechazarModal, setRechazarModal] = useState<any>(null);
  const [motivo, setMotivo] = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negocios();
      setNegocios(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function verificar(id: string, nombre: string) {
    Alert.alert('Aprobar negocio', `¿Aprobar "${nombre}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Aprobar', onPress: async () => { await adminAPI.verificarNegocio(id); cargar(); } },
    ]);
  }

  async function rechazar(id: string) {
    try {
      await adminAPI.rechazarNegocio(id, motivo.trim() || undefined);
      setRechazarModal(null);
      setMotivo('');
      cargar();
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  async function toggle(id: string, activo: boolean, nombre: string) {
    Alert.alert(
      activo ? 'Suspender negocio' : 'Activar negocio',
      `¿${activo ? 'Suspender' : 'Activar'} "${nombre}"?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', style: activo ? 'destructive' : 'default', onPress: async () => { await adminAPI.toggleNegocio(id); cargar(); } },
      ]
    );
  }

  const filtrados = negocios.filter((n) => {
    const matchBusq = !busqueda || n.nombre?.toLowerCase().includes(busqueda.toLowerCase()) || n.zona?.toLowerCase().includes(busqueda.toLowerCase());
    switch (filtro) {
      case 'pendientes': return matchBusq && !n.verificado;
      case 'verificados': return matchBusq && n.verificado && n.activo !== false;
      case 'inactivos': return matchBusq && n.activo === false;
      default: return matchBusq;
    }
  });

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  const pendienteCount = negocios.filter(n => !n.verificado).length;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>🏪 Gestión de negocios</Text>
        {pendienteCount > 0 && (
          <View style={s.pendienteBadge}>
            <Text style={s.pendienteBadgeText}>{pendienteCount} pendientes</Text>
          </View>
        )}
      </View>

      <View style={s.searchRow}>
        <TextInput
          style={s.search}
          placeholder="Buscar por nombre o zona..."
          placeholderTextColor="#475569"
          value={busqueda}
          onChangeText={setBusqueda}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filtros} contentContainerStyle={{ paddingHorizontal: 14 }}>
        {([
          ['todos', 'Todos'],
          ['pendientes', `Pendientes${pendienteCount > 0 ? ` (${pendienteCount})` : ''}`],
          ['verificados', 'Verificados'],
          ['inactivos', 'Inactivos'],
        ] as [Filtro, string][]).map(([f, label]) => (
          <TouchableOpacity key={f} style={[s.chip, filtro === f && s.chipActive]} onPress={() => setFiltro(f)}>
            <Text style={[s.chipText, filtro === f && s.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        <Text style={s.count}>{filtrados.length} negocio{filtrados.length !== 1 ? 's' : ''}</Text>

        {filtrados.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 40 }}>🏪</Text>
            <Text style={s.emptyText}>No hay negocios en esta categoría</Text>
          </View>
        )}

        {filtrados.map((n) => (
          <View key={n.id} style={s.card}>
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.nombre}>{n.nombre}</Text>
                <Text style={s.meta}>{n.categoria} · {n.zona}{n.ciudad ? `, ${n.ciudad}` : ''}</Text>
                {n.telefono && <Text style={s.meta}>📞 {n.telefono}</Text>}
                {n.email && <Text style={s.meta}>✉️ {n.email}</Text>}
                <Text style={s.stats}>📦 {n.total_bolsas_vendidas || 0} vendidas · ⭐ {n.calificacion_promedio?.toFixed(1) || '–'}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                {n.verificado
                  ? <View style={s.badgeVer}><Text style={s.badgeVerText}>✓ Verificado</Text></View>
                  : <View style={s.badgePend}><Text style={s.badgePendText}>⏳ Pendiente</Text></View>}
                {n.activo === false && <View style={s.badgeInac}><Text style={s.badgeInacText}>Inactivo</Text></View>}
              </View>
            </View>

            <View style={s.actions}>
              {!n.verificado && (
                <>
                  <TouchableOpacity style={s.btnAprobar} onPress={() => verificar(n.id, n.nombre)}>
                    <Text style={s.btnAprobarText}>✓ Aprobar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnRechazar} onPress={() => { setRechazarModal(n); setMotivo(''); }}>
                    <Text style={s.btnRechazarText}>✕ Rechazar</Text>
                  </TouchableOpacity>
                </>
              )}
              {n.verificado && (
                <TouchableOpacity
                  style={[s.btnToggle, n.activo === false && s.btnToggleActivar]}
                  onPress={() => toggle(n.id, n.activo !== false, n.nombre)}
                >
                  <Text style={[s.btnToggleText, n.activo === false && s.btnToggleTextActivar]}>
                    {n.activo === false ? '▶ Activar' : '⏸ Suspender'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal de rechazo con motivo */}
      <Modal visible={!!rechazarModal} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar negocio</Text>
            <Text style={s.modalSub}>{rechazarModal?.nombre}</Text>
            <Text style={s.modalLabel}>Motivo (opcional)</Text>
            <TextInput
              style={s.modalInput}
              value={motivo}
              onChangeText={setMotivo}
              placeholder="Ej. Documentación incompleta..."
              placeholderTextColor="#64748B"
              multiline
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setRechazarModal(null)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalConfirmBtn} onPress={() => rechazar(rechazarModal.id)}>
                <Text style={s.modalConfirmText}>Rechazar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0F172A' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white },
  pendienteBadge: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  pendienteBadgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  searchRow: { padding: 12, paddingBottom: 4, backgroundColor: DARK },
  search: { backgroundColor: '#334155', borderRadius: 12, padding: 12, fontSize: 14, color: Colors.white },
  filtros: { maxHeight: 52, backgroundColor: DARK, marginBottom: 4 },
  chip: { borderWidth: 1.5, borderColor: '#334155', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginRight: 8, marginVertical: 8, backgroundColor: '#1E293B' },
  chipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { fontSize: 12, color: '#94A3B8', fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '800' },
  scroll: { padding: 14 },
  count: { fontSize: 12, color: '#64748B', marginBottom: 12 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: '#64748B', textAlign: 'center' },
  card: { backgroundColor: DARK, borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  cardTop: { flexDirection: 'row', marginBottom: 12 },
  nombre: { fontSize: 16, fontWeight: '800', color: Colors.white },
  meta: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  stats: { fontSize: 11, color: '#64748B', marginTop: 4 },
  badgeVer: { backgroundColor: '#064E3B', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeVerText: { fontSize: 11, color: '#34D399', fontWeight: '700' },
  badgePend: { backgroundColor: '#451A03', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgePendText: { fontSize: 11, color: '#FCD34D', fontWeight: '700' },
  badgeInac: { backgroundColor: '#1E1E2E', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeInacText: { fontSize: 11, color: '#64748B', fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 10 },
  btnAprobar: { flex: 1, backgroundColor: '#065F46', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnAprobarText: { color: '#6EE7B7', fontWeight: '700', fontSize: 13 },
  btnRechazar: { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnRechazarText: { color: '#F87171', fontWeight: '700', fontSize: 13 },
  btnToggle: { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnToggleActivar: { borderColor: '#065F46' },
  btnToggleText: { color: '#F87171', fontWeight: '700', fontSize: 13 },
  btnToggleTextActivar: { color: '#34D399' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: DARK, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#334155' },
  modalTitle: { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 4 },
  modalSub: { fontSize: 14, color: '#94A3B8', marginBottom: 16 },
  modalLabel: { fontSize: 13, color: '#94A3B8', fontWeight: '600', marginBottom: 8 },
  modalInput: { backgroundColor: '#334155', borderRadius: 12, padding: 12, color: Colors.white, fontSize: 14, minHeight: 80, textAlignVertical: 'top', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancelBtn: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalCancelText: { color: '#94A3B8', fontWeight: '600', fontSize: 14 },
  modalConfirmBtn: { flex: 1, backgroundColor: '#991B1B', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalConfirmText: { color: '#FCA5A5', fontWeight: '800', fontSize: 14 },
});
