import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, TextInput, ActivityIndicator, Modal, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#C8A97E';

type Filtro = 'todos' | 'pendientes' | 'verificados' | 'suspendidos' | 'inactivos';

export default function AdminNegociosScreen() {
  const router = useRouter();
  const [negocios,   setNegocios]   = useState<any[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda,   setBusqueda]   = useState('');
  const [filtro,     setFiltro]     = useState<Filtro>('pendientes');
  const [procesando, setProcesando] = useState<string | null>(null);

  // Modal suspensión
  const [suspendModal, setSuspendModal] = useState<any>(null);
  const [motivo,       setMotivo]       = useState('');
  const [motivoError,  setMotivoError]  = useState(false);

  // Modal rechazo
  const [rechazarModal, setRechazarModal] = useState<any>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negocios();
      setNegocios(res.data || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function aprobar(n: any) {
    setProcesando(n.id);
    try {
      await adminAPI.verificarNegocio(n.id);
      cargar();
    } catch (e: any) {
      console.error('[negocios] aprobar error:', e.message);
    } finally { setProcesando(null); }
  }

  async function rechazar() {
    if (!rechazarModal) return;
    setProcesando(rechazarModal.id);
    setRechazarModal(null);
    try {
      await adminAPI.rechazarNegocio(rechazarModal.id, motivoRechazo.trim() || undefined);
      cargar();
    } catch (e: any) {
      console.error('[negocios] rechazar error:', e.message);
    } finally { setProcesando(null); setMotivoRechazo(''); }
  }

  async function confirmarSuspender() {
    if (!suspendModal) return;
    if (!motivo.trim()) { setMotivoError(true); return; }
    const { id, nombre } = suspendModal;
    setSuspendModal(null);
    setProcesando(id);
    try {
      await adminAPI.toggleNegocio(id, motivo.trim());
      const wa = encodeURIComponent(
        `Tu cuenta en Bocara ha sido suspendida. Motivo: ${motivo.trim()}. Contáctanos para más información.`
      );
      Linking.openURL(`https://wa.me/50251077949?text=${wa}`);
      cargar();
    } catch (e: any) {
      console.error('[negocios] suspender error:', e.message);
    } finally { setProcesando(null); setMotivo(''); setMotivoError(false); }
  }

  async function activar(id: string) {
    setProcesando(id);
    try {
      await adminAPI.toggleNegocio(id);
      cargar();
    } catch (e: any) {
      console.error('[negocios] activar error:', e.message);
    } finally { setProcesando(null); }
  }

  const filtrados = negocios.filter((n) => {
    const match = !busqueda ||
      n.nombre?.toLowerCase().includes(busqueda.toLowerCase()) ||
      n.zona?.toLowerCase().includes(busqueda.toLowerCase());
    switch (filtro) {
      case 'pendientes':   return match && !n.verificado;
      case 'verificados':  return match && n.verificado && n.activo !== false;
      case 'suspendidos':  return match && n.verificado && n.activo === false;
      case 'inactivos':    return match && !n.verificado && n.activo === false;
      default: return match;
    }
  });

  const pendienteCount   = negocios.filter(n => !n.verificado).length;
  const suspendidoCount  = negocios.filter(n => n.verificado && n.activo === false).length;

  if (loading) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: BG }}>
      <ActivityIndicator color={GOLD} size="large" />
    </View>
  );

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>GESTIÓN</Text>
          <Text style={s.headerTitle}>Negocios</Text>
        </View>
        {pendienteCount > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{pendienteCount} pendientes</Text>
          </View>
        )}
      </View>

      {/* Búsqueda */}
      <View style={s.searchWrap}>
        <Ionicons name="search" size={16} color={TEXT2} style={{ marginRight: 8 }} />
        <TextInput
          style={s.searchInput}
          placeholder="Buscar por nombre o zona..."
          placeholderTextColor="#9CA3AF"
          value={busqueda}
          onChangeText={setBusqueda}
        />
        {busqueda.length > 0 && (
          <TouchableOpacity onPress={() => setBusqueda('')}>
            <Ionicons name="close-circle" size={18} color={TEXT2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filtros */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filtrosBar} contentContainerStyle={{ paddingHorizontal: 14, gap: 8 }}>
        {([
          ['todos',       'Todos'],
          ['pendientes',  `Pendientes${pendienteCount > 0 ? ` (${pendienteCount})` : ''}`],
          ['verificados', 'Verificados'],
          ['suspendidos', `Suspendidos${suspendidoCount > 0 ? ` (${suspendidoCount})` : ''}`],
          ['inactivos',   'Inactivos'],
        ] as [Filtro, string][]).map(([f, label]) => (
          <TouchableOpacity key={f} style={[s.chip, filtro === f && s.chipActive]} onPress={() => setFiltro(f)}>
            <Text style={[s.chipText, filtro === f && s.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
      >
        <Text style={s.count}>{filtrados.length} negocio{filtrados.length !== 1 ? 's' : ''}</Text>

        {filtrados.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: 60 }}>
            <Ionicons name="storefront-outline" size={48} color={BORDER} />
            <Text style={{ fontSize: 15, color: TEXT2, marginTop: 12, textAlign: 'center' }}>
              No hay negocios en esta categoría
            </Text>
          </View>
        )}

        {filtrados.map((n) => (
          <TouchableOpacity
            key={n.id}
            style={s.card}
            activeOpacity={0.85}
            onPress={() => router.push(`/admin/restaurante-detalle?id=${n.id}` as any)}
          >
            {/* Top row */}
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.nombre}>{n.nombre}</Text>
                <Text style={s.meta}>{[n.categoria, n.zona && `Zona ${n.zona}`, n.ciudad].filter(Boolean).join(' · ')}</Text>
                {n.telefono && <Text style={s.meta}>{n.telefono}</Text>}
                {n.email && <Text style={s.meta}>{n.email}</Text>}
                <Text style={s.stats}>
                  {n.total_bolsas_vendidas || 0} vendidas
                  {n.calificacion_promedio ? `  ·  ★ ${n.calificacion_promedio.toFixed(1)}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                {n.verificado
                  ? <View style={s.chipVer}><Text style={s.chipVerText}>Verificado</Text></View>
                  : <View style={s.chipPend}><Text style={s.chipPendText}>Pendiente</Text></View>}
                {n.activo === false && <View style={s.chipInac}><Text style={s.chipInacText}>Inactivo</Text></View>}
              </View>
            </View>

            {/* Actions */}
            <View style={s.actionsRow}>
              {!n.verificado && (
                <>
                  <TouchableOpacity style={s.btnAprobar} onPress={() => aprobar(n)} disabled={!!procesando}>
                    {procesando === n.id
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <><Ionicons name="checkmark" size={14} color="#fff" /><Text style={s.btnAprobarText}>Aprobar</Text></>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.btnRechazar}
                    onPress={() => { setRechazarModal(n); setMotivoRechazo(''); }}
                    disabled={!!procesando}
                  >
                    <Ionicons name="close" size={14} color="#DC2626" />
                    <Text style={s.btnRechazarText}>Rechazar</Text>
                  </TouchableOpacity>
                </>
              )}
              {n.verificado && n.activo !== false && (
                <TouchableOpacity
                  style={s.btnSuspender}
                  onPress={() => { setSuspendModal(n); setMotivo(''); setMotivoError(false); }}
                  disabled={!!procesando}
                >
                  {procesando === n.id
                    ? <ActivityIndicator color="#D97706" size="small" />
                    : <><Ionicons name="pause-circle" size={14} color="#D97706" /><Text style={s.btnSuspenderText}>Suspender</Text></>}
                </TouchableOpacity>
              )}
              {n.activo === false && (
                <TouchableOpacity style={s.btnActivar} onPress={() => activar(n.id)} disabled={!!procesando}>
                  {procesando === n.id
                    ? <ActivityIndicator color="#16A34A" size="small" />
                    : <><Ionicons name="play-circle" size={14} color="#16A34A" /><Text style={s.btnActivarText}>Activar</Text></>}
                </TouchableOpacity>
              )}
              <TouchableOpacity style={s.btnVer} onPress={() => router.push(`/admin/restaurante-detalle?id=${n.id}` as any)}>
                <Ionicons name="eye-outline" size={14} color={TEXT2} />
                <Text style={s.btnVerText}>Ver perfil</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal: Suspender (obligatorio motivo) */}
      <Modal visible={!!suspendModal} transparent animationType="slide" onRequestClose={() => setSuspendModal(null)}>
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Ionicons name="warning" size={20} color="#D97706" style={{ marginRight: 8 }} />
              <Text style={s.modalTitle}>Suspender negocio</Text>
            </View>
            <Text style={s.modalSub}>{suspendModal?.nombre}</Text>
            <Text style={s.modalLabel}>
              Motivo de suspensión <Text style={{ color: '#DC2626' }}>*</Text>
            </Text>
            <TextInput
              style={[s.modalInput, motivoError && { borderColor: '#DC2626' }]}
              value={motivo}
              onChangeText={(v) => { setMotivo(v); if (v.trim()) setMotivoError(false); }}
              placeholder="Ej. Incumplimiento de términos de uso..."
              placeholderTextColor="#9CA3AF"
              multiline
              autoFocus
            />
            {motivoError && (
              <Text style={{ color: '#DC2626', fontSize: 12, marginTop: -8, marginBottom: 10 }}>
                El motivo es obligatorio para suspender
              </Text>
            )}
            <Text style={s.modalNote}>
              Se enviará un email al restaurante y se abrirá WhatsApp con el motivo.
            </Text>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setSuspendModal(null)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalSuspendBtn} onPress={confirmarSuspender}>
                <Ionicons name="pause-circle" size={16} color="#fff" />
                <Text style={s.modalSuspendText}>Suspender</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal: Rechazar */}
      <Modal visible={!!rechazarModal} transparent animationType="fade" onRequestClose={() => setRechazarModal(null)}>
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar negocio</Text>
            <Text style={s.modalSub}>{rechazarModal?.nombre}</Text>
            <Text style={s.modalLabel}>Motivo (opcional)</Text>
            <TextInput
              style={s.modalInput}
              value={motivoRechazo}
              onChangeText={setMotivoRechazo}
              placeholder="Ej. Documentación incompleta..."
              placeholderTextColor="#9CA3AF"
              multiline
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setRechazarModal(null)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalSuspendBtn, { backgroundColor: '#DC2626' }]} onPress={rechazar}>
                <Ionicons name="close-circle" size={16} color="#fff" />
                <Text style={s.modalSuspendText}>Rechazar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: BG },
  header:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:  { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  badge:      { backgroundColor: '#FEF3C7', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: '#FDE68A' },
  badgeText:  { color: '#92400E', fontSize: 12, fontWeight: '800' },

  searchWrap:  { flexDirection: 'row', alignItems: 'center', margin: 12, backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 14, paddingVertical: 10 },
  searchInput: { flex: 1, fontSize: 14, color: TEXT },

  filtrosBar:   { maxHeight: 48, marginBottom: 4 },
  chip:         { borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: CARD },
  chipActive:   { backgroundColor: GOLD, borderColor: GOLD },
  chipText:     { fontSize: 12, color: TEXT2, fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '800' },

  scroll:  { padding: 14 },
  count:   { fontSize: 11, color: TEXT2, marginBottom: 10, fontWeight: '600' },

  card:     { backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: BORDER, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  cardTop:  { flexDirection: 'row', marginBottom: 12 },
  nombre:   { fontSize: 15, fontWeight: '800', color: TEXT },
  meta:     { fontSize: 12, color: TEXT2, marginTop: 2 },
  stats:    { fontSize: 11, color: TEXT2, marginTop: 4 },

  chipVer:      { backgroundColor: '#F0FDF4', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#BBF7D0' },
  chipVerText:  { fontSize: 11, color: '#166534', fontWeight: '700' },
  chipPend:     { backgroundColor: '#FFFBEB', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#FDE68A' },
  chipPendText: { fontSize: 11, color: '#92400E', fontWeight: '700' },
  chipInac:     { backgroundColor: '#F9FAFB', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: BORDER },
  chipInacText: { fontSize: 11, color: TEXT2, fontWeight: '600' },

  actionsRow:       { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: BORDER, paddingTop: 12 },
  btnAprobar:       { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#16A34A', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnAprobarText:   { color: '#fff', fontWeight: '700', fontSize: 12 },
  btnRechazar:      { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnRechazarText:  { color: '#DC2626', fontWeight: '700', fontSize: 12 },
  btnSuspender:     { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FDE68A', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnSuspenderText: { color: '#D97706', fontWeight: '700', fontSize: 12 },
  btnActivar:       { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnActivarText:   { color: '#16A34A', fontWeight: '700', fontSize: 12 },
  btnVer:           { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnVerText:       { color: TEXT2, fontWeight: '600', fontSize: 12 },

  overlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard:   { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderTopWidth: 1, borderTopColor: BORDER },
  modalTitle:  { fontSize: 18, fontWeight: '900', color: TEXT, marginBottom: 2 },
  modalSub:    { fontSize: 14, color: TEXT2, marginBottom: 16 },
  modalLabel:  { fontSize: 13, color: TEXT, fontWeight: '600', marginBottom: 8 },
  modalNote:   { fontSize: 12, color: TEXT2, marginBottom: 16, lineHeight: 18 },
  modalInput:  { backgroundColor: BG, borderRadius: 12, borderWidth: 1, borderColor: BORDER, padding: 14, fontSize: 14, color: TEXT, minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  modalActions:    { flexDirection: 'row', gap: 10 },
  modalCancelBtn:  { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 13, alignItems: 'center' },
  modalCancelText: { color: TEXT2, fontWeight: '600', fontSize: 14 },
  modalSuspendBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#D97706', borderRadius: 12, padding: 13 },
  modalSuspendText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
