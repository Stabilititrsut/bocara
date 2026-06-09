import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, TextInput, ActivityIndicator, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';

type Filtro = 'todos' | 'pendientes' | 'verificados' | 'inactivos';

export default function AdminNegociosScreen() {
  const router = useRouter();
  const [negocios, setNegocios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [rechazarModal, setRechazarModal] = useState<any>(null);
  const [motivo, setMotivo] = useState('');
  const [confirmando, setConfirmando] = useState<{ id: string; accion: 'aprobar' | 'toggle'; activo?: boolean } | null>(null);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<Record<string, string>>({});

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negocios();
      setNegocios(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function confirmarAccion() {
    if (!confirmando) return;
    const { id, accion } = confirmando;
    setProcesando(id);
    setConfirmando(null);
    setErrorMsg(prev => ({ ...prev, [id]: '' }));
    try {
      if (accion === 'aprobar') {
        await adminAPI.verificarNegocio(id);
      } else {
        await adminAPI.toggleNegocio(id);
      }
      cargar();
    } catch (e: any) {
      setErrorMsg(prev => ({ ...prev, [id]: e.message || 'Error al procesar' }));
    } finally {
      setProcesando(null);
    }
  }

  async function rechazar(id: string) {
    setProcesando(id);
    try {
      await adminAPI.rechazarNegocio(id, motivo.trim() || undefined);
      setRechazarModal(null);
      setMotivo('');
      cargar();
    } catch (e: any) {
      setErrorMsg(prev => ({ ...prev, [id]: e.message || 'Error al rechazar' }));
    } finally {
      setProcesando(null);
    }
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
          <TouchableOpacity key={n.id} style={s.card} activeOpacity={0.85}
            onPress={() => router.push(`/admin/restaurante-detalle?id=${n.id}` as any)}>

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

            {errorMsg[n.id] ? (
              <View style={s.errorCard}><Text style={s.errorText}>⚠️ {errorMsg[n.id]}</Text></View>
            ) : null}

            {confirmando?.id === n.id ? (
              <View style={s.confirmCard}>
                <Text style={s.confirmText}>
                  {confirmando.accion === 'aprobar'
                    ? `¿Aprobar "${n.nombre}"? El propietario será notificado.`
                    : `¿${confirmando.activo ? 'Suspender' : 'Activar'} "${n.nombre}"?`}
                </Text>
                <View style={s.confirmRow}>
                  <TouchableOpacity style={s.confirmNo} onPress={() => setConfirmando(null)}>
                    <Text style={s.confirmNoText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.confirmSi, confirmando.accion === 'aprobar' ? s.confirmSiGreen : s.confirmSiOrange, procesando === n.id && { opacity: 0.5 }]}
                    onPress={confirmarAccion}
                    disabled={procesando === n.id}
                  >
                    {procesando === n.id
                      ? <ActivityIndicator color={Colors.white} size="small" />
                      : <Text style={s.confirmSiText}>Confirmar</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={s.actions}>
                {!n.verificado && (
                  <>
                    <TouchableOpacity style={s.btnAprobar} onPress={() => setConfirmando({ id: n.id, accion: 'aprobar' })} disabled={!!procesando}>
                      {procesando === n.id ? <ActivityIndicator color='#6EE7B7' size="small" /> : <Text style={s.btnAprobarText}>✓ Aprobar</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity style={s.btnRechazar} onPress={() => { setRechazarModal(n); setMotivo(''); }} disabled={!!procesando}>
                      <Text style={s.btnRechazarText}>✕ Rechazar</Text>
                    </TouchableOpacity>
                  </>
                )}
                {n.verificado && (
                  <TouchableOpacity
                    style={[s.btnToggle, n.activo === false && s.btnToggleActivar]}
                    onPress={() => setConfirmando({ id: n.id, accion: 'toggle', activo: n.activo !== false })}
                    disabled={!!procesando}
                  >
                    <Text style={[s.btnToggleText, n.activo === false && s.btnToggleTextActivar]}>
                      {n.activo === false ? '▶ Activar' : '⏸ Suspender'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </TouchableOpacity>
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
  errorCard: { backgroundColor: '#450A0A', borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: '#991B1B' },
  errorText: { color: '#FCA5A5', fontSize: 12, fontWeight: '600' },
  confirmCard: { backgroundColor: '#1A2744', borderRadius: 10, padding: 12, marginBottom: 4, borderWidth: 1.5, borderColor: '#334155' },
  confirmText: { color: '#E2E8F0', fontSize: 13, lineHeight: 18, marginBottom: 10 },
  confirmRow: { flexDirection: 'row', gap: 8 },
  confirmNo: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 8, padding: 10, alignItems: 'center' },
  confirmNoText: { color: '#94A3B8', fontWeight: '700', fontSize: 13 },
  confirmSi: { flex: 1, borderRadius: 8, padding: 10, alignItems: 'center' },
  confirmSiGreen: { backgroundColor: '#065F46' },
  confirmSiOrange: { backgroundColor: Colors.orange },
  confirmSiText: { color: Colors.white, fontWeight: '800', fontSize: 13 },
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
