import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Alert, TextInput, RefreshControl, Modal,
} from 'react-native';
import { Image } from 'expo-image';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

export default function AdminVerificacionScreen() {
  const [negocios, setNegocios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [modalRechazo, setModalRechazo] = useState<{ id: string; nombre: string } | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');
  const [detalle, setDetalle] = useState<any | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negociosPendientes();
      setNegocios(res.data || []);
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function aprobar(id: string, nombre: string) {
    Alert.alert('Aprobar negocio', `¿Aprobar "${nombre}"? Se notificará al propietario y el negocio estará visible.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Aprobar', style: 'default', onPress: async () => {
          setProcesando(id);
          try {
            await adminAPI.aprobarNegocio(id);
            setNegocios(prev => prev.filter(n => n.id !== id));
            Alert.alert('✅ Aprobado', `${nombre} ya está activo en Bocara.`);
          } catch (e: any) {
            Alert.alert('Error', e.message);
          } finally {
            setProcesando(null);
          }
        },
      },
    ]);
  }

  async function rechazar() {
    if (!modalRechazo) return;
    setProcesando(modalRechazo.id);
    setModalRechazo(null);
    try {
      await adminAPI.rechazarNegocio(modalRechazo.id, motivoRechazo);
      setNegocios(prev => prev.filter(n => n.id !== modalRechazo.id));
      Alert.alert('Rechazado', 'El propietario fue notificado.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
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

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>PANEL DE VERIFICACIÓN</Text>
          <Text style={s.headerTitle}>Restaurantes pendientes</Text>
        </View>
        <View style={s.badge}>
          <Text style={s.badgeText}>{negocios.length}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {negocios.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={{ fontSize: 48 }}>✅</Text>
            <Text style={s.emptyTitle}>Sin pendientes</Text>
            <Text style={s.emptySub}>Todos los restaurantes han sido revisados.</Text>
          </View>
        ) : (
          negocios.map((n) => (
            <View key={n.id} style={s.card}>
              {/* Encabezado del card */}
              <View style={s.cardHeader}>
                {n.imagen_url ? (
                  <Image source={{ uri: n.imagen_url }} style={s.cardImg} contentFit="cover" />
                ) : (
                  <View style={[s.cardImg, s.cardImgPlaceholder]}>
                    <Text style={{ fontSize: 24 }}>🏪</Text>
                  </View>
                )}
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.cardNombre}>{n.nombre}</Text>
                  <Text style={s.cardCategoria}>{n.categoria}</Text>
                  <View style={s.pendienteBadge}>
                    <Text style={s.pendienteBadgeText}>⏳ PENDIENTE</Text>
                  </View>
                </View>
              </View>

              {/* Info del propietario */}
              <View style={s.section}>
                <Text style={s.sectionTitle}>👤 Propietario</Text>
                <InfoRow label="Nombre" val={`${n.usuarios?.nombre || ''} ${n.usuarios?.apellido || ''}`.trim() || '—'} />
                <InfoRow label="Email" val={n.usuarios?.email || n.email || '—'} />
                <InfoRow label="Teléfono" val={n.telefono || '—'} />
              </View>

              {/* Info legal */}
              <View style={s.section}>
                <Text style={s.sectionTitle}>📋 Datos legales</Text>
                <InfoRow label="NIT" val={n.nit || 'No proporcionado'} />
                <InfoRow label="DPI" val={n.dpi || 'No proporcionado'} />
              </View>

              {/* Info del negocio */}
              <View style={s.section}>
                <Text style={s.sectionTitle}>🏪 Negocio</Text>
                <InfoRow label="Dirección" val={n.direccion || '—'} />
                <InfoRow label="Zona" val={n.zona || '—'} />
                <InfoRow label="Ciudad" val={n.ciudad || '—'} />
                <InfoRow label="Horario" val={n.horario_atencion || 'No especificado'} />
                {n.descripcion ? <InfoRow label="Descripción" val={n.descripcion} /> : null}
              </View>

              {/* Datos bancarios */}
              {n.datos_bancarios && (
                <View style={s.section}>
                  <Text style={s.sectionTitle}>🏦 Datos bancarios</Text>
                  <InfoRow label="Banco" val={n.datos_bancarios.banco || '—'} />
                  <InfoRow label="Cuenta" val={n.datos_bancarios.numero_cuenta || '—'} />
                  <InfoRow label="Tipo" val={n.datos_bancarios.tipo_cuenta || '—'} />
                  <InfoRow label="Titular" val={n.datos_bancarios.titular || '—'} />
                </View>
              )}

              {/* Fecha de solicitud */}
              <Text style={s.fechaSolicitud}>
                Solicitud: {n.created_at ? new Date(n.created_at).toLocaleDateString('es-GT', { day: '2-digit', month: 'long', year: 'numeric' }) : '—'}
              </Text>

              {/* Acciones */}
              <View style={s.cardActions}>
                <TouchableOpacity
                  style={[s.btnRechazar, procesando === n.id && s.btnDisabled]}
                  onPress={() => { setModalRechazo({ id: n.id, nombre: n.nombre }); setMotivoRechazo(''); }}
                  disabled={!!procesando}
                >
                  {procesando === n.id
                    ? <ActivityIndicator color={Colors.error} size="small" />
                    : <Text style={s.btnRechazarText}>✕ Rechazar</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.btnAprobar, procesando === n.id && s.btnDisabled]}
                  onPress={() => aprobar(n.id, n.nombre)}
                  disabled={!!procesando}
                >
                  {procesando === n.id
                    ? <ActivityIndicator color={Colors.white} size="small" />
                    : <Text style={s.btnAprobarText}>✓ Aprobar</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal de rechazo */}
      <Modal visible={!!modalRechazo} transparent animationType="slide" onRequestClose={() => setModalRechazo(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar {modalRechazo?.nombre}</Text>
            <Text style={s.modalSub}>Escribe el motivo para notificar al propietario (opcional).</Text>
            <TextInput
              style={s.modalInput}
              placeholder="Ej: La documentación está incompleta..."
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

function InfoRow({ label, val }: { label: string; val: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#334155' }}>
      <Text style={{ fontSize: 12, color: '#64748B', fontWeight: '600' }}>{label}</Text>
      <Text style={{ fontSize: 12, color: '#E2E8F0', fontWeight: '500', flex: 1, textAlign: 'right', marginLeft: 8 }}>{val}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK2 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  badge: { backgroundColor: Colors.orange, borderRadius: 16, minWidth: 32, height: 32, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  badgeText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  scroll: { padding: 16 },
  emptyState: { alignItems: 'center', paddingVertical: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.white, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#64748B', marginTop: 6 },
  card: { backgroundColor: DARK, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#334155' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  cardImg: { width: 60, height: 60, borderRadius: 12 },
  cardImgPlaceholder: { backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' },
  cardNombre: { fontSize: 16, fontWeight: '900', color: Colors.white },
  cardCategoria: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  pendienteBadge: { backgroundColor: '#451A03', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginTop: 6, alignSelf: 'flex-start' },
  pendienteBadgeText: { fontSize: 10, color: '#F59E0B', fontWeight: '800' },
  section: { backgroundColor: '#1A2744', borderRadius: 12, padding: 12, marginBottom: 10 },
  sectionTitle: { fontSize: 12, color: '#94A3B8', fontWeight: '700', marginBottom: 8, textTransform: 'uppercase' },
  fechaSolicitud: { fontSize: 11, color: '#475569', textAlign: 'center', marginBottom: 12 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btnAprobar: { flex: 1, backgroundColor: Colors.green, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnAprobarText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnRechazar: { flex: 1, backgroundColor: '#1E293B', borderWidth: 1.5, borderColor: Colors.error, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnRechazarText: { color: Colors.error, fontWeight: '800', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: DARK, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderTopWidth: 1, borderTopColor: '#334155' },
  modalTitle: { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#94A3B8', marginBottom: 16 },
  modalInput: { backgroundColor: '#1A2744', borderRadius: 12, padding: 14, fontSize: 14, color: Colors.white, minHeight: 80, textAlignVertical: 'top', borderWidth: 1, borderColor: '#334155', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancelar: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelarText: { color: '#94A3B8', fontWeight: '700', fontSize: 14 },
  modalRechazar: { flex: 1, backgroundColor: Colors.error, borderRadius: 12, padding: 14, alignItems: 'center' },
  modalRechazarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
