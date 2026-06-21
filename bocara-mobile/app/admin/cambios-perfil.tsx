import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, TextInput, RefreshControl, Modal,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

export default function AdminCambiosPerfilScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [modalRechazo, setModalRechazo] = useState<{ id: string; nombre: string } | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.cambiosPerfil();
      setItems(res.data || []);
    } catch (e: any) {
      showToast('Error cargando solicitudes: ' + (e.message || ''), false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function aprobar(id: string, nombre: string) {
    setProcesando(id);
    try {
      await adminAPI.aprobarCambioPerfil(id);
      setItems(prev => prev.filter(i => i.id !== id));
      showToast(`✅ Cambios de "${nombre}" aprobados y aplicados`);
    } catch (e: any) {
      showToast(`Error: ${e.message || 'No se pudo aprobar'}`, false);
    } finally {
      setProcesando(null);
    }
  }

  async function rechazar() {
    if (!modalRechazo) return;
    const { id, nombre } = modalRechazo;
    setProcesando(id);
    setModalRechazo(null);
    try {
      await adminAPI.rechazarCambioPerfil(id, motivoRechazo);
      setItems(prev => prev.filter(i => i.id !== id));
      showToast(`"${nombre}" rechazado. Restaurante notificado.`);
    } catch (e: any) {
      showToast(`Error: ${e.message || 'No se pudo rechazar'}`, false);
    } finally {
      setProcesando(null);
      setMotivoRechazo('');
    }
  }

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK2 }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const pendientes = items.filter(i => i.estado === 'pendiente');
  const procesados = items.filter(i => i.estado !== 'pendiente');

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>PANEL ADMIN</Text>
          <Text style={s.headerTitle}>Cambios de perfil</Text>
        </View>
        <View style={s.badge}>
          <Text style={s.badgeText}>{pendientes.length}</Text>
        </View>
      </View>

      {toast && (
        <View style={[s.toast, toast.ok ? s.toastOk : s.toastErr]}>
          <Text style={s.toastText}>{toast.msg}</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />
        }
      >
        {pendientes.length === 0 && procesados.length === 0 ? (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>✅</Text>
            <Text style={s.emptyTitle}>Sin solicitudes</Text>
            <Text style={s.emptySub}>No hay solicitudes de cambio de perfil pendientes.</Text>
          </View>
        ) : null}

        {pendientes.length > 0 && (
          <>
            <Text style={s.seccion}>Pendientes de revisión</Text>
            {pendientes.map((item) => (
              <SolicitudCard
                key={item.id}
                item={item}
                procesando={procesando}
                onAprobar={() => aprobar(item.id, item.negocios?.nombre || 'Negocio')}
                onRechazar={() => { setModalRechazo({ id: item.id, nombre: item.negocios?.nombre || 'Negocio' }); setMotivoRechazo(''); }}
              />
            ))}
          </>
        )}

        {procesados.length > 0 && (
          <>
            <Text style={[s.seccion, { marginTop: 20 }]}>Historial reciente</Text>
            {procesados.map((item) => (
              <SolicitudCard
                key={item.id}
                item={item}
                procesando={procesando}
                readonly
              />
            ))}
          </>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      <Modal visible={!!modalRechazo} transparent animationType="slide" onRequestClose={() => setModalRechazo(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar cambios de "{modalRechazo?.nombre}"</Text>
            <Text style={s.modalSub}>El restaurante recibirá una notificación con el motivo (opcional).</Text>
            <TextInput
              style={s.modalInput}
              placeholder="Ej: La dirección no es válida..."
              placeholderTextColor="#64748B"
              value={motivoRechazo}
              onChangeText={setMotivoRechazo}
              multiline
              autoFocus
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelar} onPress={() => setModalRechazo(null)}>
                <Text style={s.modalCancelarText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalRechazar} onPress={rechazar}>
                <Text style={s.modalRechazarText}>Rechazar y notificar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const CAMPO_LABELS: Record<string, string> = {
  nombre: 'Nombre', descripcion: 'Descripción', direccion: 'Dirección',
  zona: 'Zona', ciudad: 'Ciudad', telefono: 'Teléfono', categoria: 'Categoría',
  latitud: 'Latitud', longitud: 'Longitud', punto_referencia: 'Punto de referencia',
  google_maps_url: 'Google Maps', waze_url: 'Waze',
};

function SolicitudCard({ item, procesando, onAprobar, onRechazar, readonly }: any) {
  const propietario = item.negocios?.usuarios;
  const negocio = item.negocios;
  const cambios = item.cambios || {};
  const esPendiente = item.estado === 'pendiente';

  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNombre}>{negocio?.nombre || '—'}</Text>
          <Text style={s.cardProp}>
            {propietario ? `${propietario.nombre || ''} ${propietario.apellido || ''}`.trim() : '—'}
            {propietario?.email ? `  ·  ${propietario.email}` : ''}
          </Text>
        </View>
        <View style={[s.estadoBadge, esPendiente ? s.estadoPendiente : item.estado === 'aprobado' ? s.estadoAprobado : s.estadoRechazado]}>
          <Text style={s.estadoText}>
            {esPendiente ? '⏳ Pendiente' : item.estado === 'aprobado' ? '✅ Aprobado' : '❌ Rechazado'}
          </Text>
        </View>
      </View>

      <Text style={s.seccionLabel}>Cambios solicitados:</Text>
      {Object.entries(cambios).map(([campo, valor]) => (
        <View key={campo} style={s.campoRow}>
          <Text style={s.campoLabel}>{CAMPO_LABELS[campo] || campo}:</Text>
          <Text style={s.campoValor} numberOfLines={2}>{String(valor)}</Text>
        </View>
      ))}

      {item.motivo_rechazo && (
        <View style={s.motivoBox}>
          <Text style={s.motivoText}>Motivo de rechazo: {item.motivo_rechazo}</Text>
        </View>
      )}

      <Text style={s.fecha}>
        {new Date(item.created_at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short', year: 'numeric' })}
        {' · '}
        {new Date(item.created_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
      </Text>

      {!readonly && esPendiente && (
        <View style={s.cardActions}>
          <TouchableOpacity
            style={[s.btnRechazar, procesando === item.id && s.btnDisabled]}
            onPress={onRechazar}
            disabled={procesando === item.id}
          >
            {procesando === item.id
              ? <ActivityIndicator color={Colors.error} size="small" />
              : <Text style={s.btnRechazarText}>✕ Rechazar</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btnAprobar, procesando === item.id && s.btnDisabled]}
            onPress={onAprobar}
            disabled={procesando === item.id}
          >
            {procesando === item.id
              ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.btnAprobarText}>✓ Aprobar y aplicar</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK2 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  badge: {
    backgroundColor: Colors.orange, borderRadius: 16, minWidth: 32, height: 32,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10,
  },
  badgeText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  toast: { position: 'absolute', top: 70, left: 16, right: 16, zIndex: 99, borderRadius: 12, padding: 14 },
  toastOk: { backgroundColor: '#14532D' },
  toastErr: { backgroundColor: '#450A0A' },
  toastText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  scroll: { padding: 16 },
  seccion: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  empty: { alignItems: 'center', paddingVertical: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.white, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#64748B', marginTop: 6 },
  card: {
    backgroundColor: DARK, borderRadius: 16, padding: 16,
    marginBottom: 14, borderWidth: 1, borderColor: '#334155',
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  cardNombre: { fontSize: 16, fontWeight: '900', color: Colors.white },
  cardProp: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  estadoBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  estadoPendiente: { backgroundColor: '#451A03' },
  estadoAprobado: { backgroundColor: '#14532D' },
  estadoRechazado: { backgroundColor: '#450A0A' },
  estadoText: { fontSize: 11, fontWeight: '800', color: Colors.white },
  seccionLabel: { fontSize: 11, color: '#64748B', fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  campoRow: { flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'flex-start' },
  campoLabel: { fontSize: 12, color: '#64748B', fontWeight: '700', minWidth: 100 },
  campoValor: { fontSize: 13, color: '#E2E8F0', flex: 1, flexShrink: 1 },
  motivoBox: { backgroundColor: '#450A0A', borderRadius: 8, padding: 10, marginTop: 8, marginBottom: 4 },
  motivoText: { fontSize: 12, color: '#FCA5A5', fontWeight: '600' },
  fecha: { fontSize: 10, color: '#475569', marginTop: 10, marginBottom: 4 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btnAprobar: { flex: 1, backgroundColor: Colors.green, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnAprobarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
  btnRechazar: {
    flex: 1, backgroundColor: DARK, borderWidth: 1.5, borderColor: Colors.error,
    borderRadius: 12, padding: 14, alignItems: 'center',
  },
  btnRechazarText: { color: Colors.error, fontWeight: '800', fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: DARK, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, borderTopWidth: 1, borderTopColor: '#334155',
  },
  modalTitle: { fontSize: 16, fontWeight: '900', color: Colors.white, marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#94A3B8', marginBottom: 16 },
  modalInput: {
    backgroundColor: '#1A2744', borderRadius: 12, padding: 14, fontSize: 14,
    color: Colors.white, minHeight: 80, textAlignVertical: 'top',
    borderWidth: 1, borderColor: '#334155', marginBottom: 16,
  },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancelar: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelarText: { color: '#94A3B8', fontWeight: '700', fontSize: 14 },
  modalRechazar: { flex: 1, backgroundColor: Colors.error, borderRadius: 12, padding: 14, alignItems: 'center' },
  modalRechazarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
