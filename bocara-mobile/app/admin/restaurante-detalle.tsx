import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Alert, Modal, TextInput,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { adminAPI, negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK  = '#1E293B';
const DARK2 = '#0F172A';

type Tab = 'negocio' | 'propietario' | 'bancario';

export default function RestauranteDetalleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();

  const [negocio,    setNegocio]    = useState<any>(null);
  const [propietario, setPropietario] = useState<any>(null);
  const [loading,    setLoading]    = useState(true);
  const [tab,        setTab]        = useState<Tab>('negocio');
  const [procesando, setProcesando] = useState(false);
  const [rechazarModal, setRechazarModal] = useState(false);
  const [motivo,     setMotivo]     = useState('');

  useEffect(() => {
    if (!id) return;
    cargar();
  }, [id]);

  async function cargar() {
    setLoading(true);
    try {
      const negRes = await negociosAPI.detalle(id!);
      const neg    = negRes.data?.negocio || negRes.data;
      setNegocio(neg);

      if (neg?.propietario_id) {
        const usersRes = await adminAPI.usuarios();
        const users    = usersRes.data || [];
        const prop     = users.find((u: any) => u.id === neg.propietario_id);
        setPropietario(prop || null);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'No se pudo cargar el perfil');
    } finally {
      setLoading(false);
    }
  }

  async function aprobar() {
    if (!negocio) return;
    Alert.alert('Aprobar restaurante', `¿Aprobar "${negocio.nombre}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Aprobar', onPress: async () => {
          setProcesando(true);
          try {
            await adminAPI.verificarNegocio(negocio.id);
            await cargar();
            Alert.alert('Aprobado', 'El restaurante fue aprobado y notificado.');
          } catch (e: any) {
            Alert.alert('Error', e.message);
          } finally { setProcesando(false); }
        }
      },
    ]);
  }

  async function rechazar() {
    if (!negocio) return;
    setProcesando(true);
    try {
      await adminAPI.rechazarNegocio(negocio.id, motivo.trim() || undefined);
      setRechazarModal(false);
      setMotivo('');
      await cargar();
      Alert.alert('Rechazado', 'El restaurante fue rechazado.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setProcesando(false); }
  }

  async function toggleSuspender() {
    if (!negocio) return;
    const accion = negocio.activo === false ? 'Activar' : 'Suspender';
    Alert.alert(`${accion} restaurante`, `¿${accion} "${negocio.nombre}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: accion, onPress: async () => {
          setProcesando(true);
          try {
            await adminAPI.toggleNegocio(negocio.id);
            await cargar();
          } catch (e: any) {
            Alert.alert('Error', e.message);
          } finally { setProcesando(false); }
        }
      },
    ]);
  }

  if (loading) return (
    <View style={s.loading}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  if (!negocio) return (
    <SafeAreaView style={s.root}>
      <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
        <Text style={s.backText}>← Volver</Text>
      </TouchableOpacity>
      <View style={s.loading}>
        <Text style={{ color: '#64748B' }}>No se encontró el restaurante</Text>
      </View>
    </SafeAreaView>
  );

  const bancario = negocio.datos_bancarios || {};
  const dpiUrl   = negocio.dpi_foto_url || bancario.dpi_foto_url;
  const estadoColor = negocio.verificado
    ? '#34D399'
    : negocio.estado_verificacion === 'rechazado' ? '#F87171' : '#FCD34D';
  const estadoLabel = negocio.verificado
    ? 'Verificado'
    : negocio.estado_verificacion === 'rechazado' ? 'Rechazado' : 'Pendiente';

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>←  Negocios</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} numberOfLines={1}>{negocio.nombre}</Text>
          <View style={[s.estadoBadge, { backgroundColor: estadoColor + '22' }]}>
            <Text style={[s.estadoText, { color: estadoColor }]}>{estadoLabel}</Text>
          </View>
        </View>
      </View>

      {/* Tabs */}
      <View style={s.tabs}>
        {(['negocio', 'propietario', 'bancario'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[s.tabItem, tab === t && s.tabActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {t === 'negocio' ? '🏪 Negocio' : t === 'propietario' ? '👤 Propietario' : '🏦 Bancario'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {tab === 'negocio' && (
          <>
            <Section title="Información del negocio">
              <Row label="Nombre" val={negocio.nombre} />
              <Row label="Categoría" val={negocio.categoria} />
              <Row label="Zona" val={negocio.zona} />
              <Row label="Ciudad" val={negocio.ciudad} />
              <Row label="Dirección" val={negocio.direccion} />
              <Row label="Teléfono" val={negocio.telefono} />
              <Row label="Email" val={negocio.email} />
              <Row label="Horario" val={negocio.horario_atencion} />
              <Row label="NIT" val={negocio.nit} />
              <Row label="DPI" val={negocio.dpi} />
            </Section>

            <Section title="Descripción">
              <Text style={s.desc}>{negocio.descripcion || 'Sin descripción'}</Text>
            </Section>

            <Section title="Estadísticas">
              <Row label="Bolsas vendidas" val={negocio.total_bolsas_vendidas || 0} />
              <Row label="Calificación" val={negocio.calificacion_promedio ? `⭐ ${negocio.calificacion_promedio.toFixed(1)}` : '—'} />
              <Row label="Estado" val={estadoLabel} valColor={estadoColor} />
              {negocio.motivo_rechazo && <Row label="Motivo rechazo" val={negocio.motivo_rechazo} valColor="#F87171" />}
            </Section>

            {dpiUrl ? (
              <Section title="Foto DPI">
                <Image source={{ uri: dpiUrl }} style={s.dpiImg} resizeMode="contain" />
              </Section>
            ) : (
              <Section title="Foto DPI">
                <Text style={s.noData}>Sin foto DPI cargada</Text>
              </Section>
            )}
          </>
        )}

        {tab === 'propietario' && (
          <>
            {propietario ? (
              <Section title="Datos del propietario">
                <Row label="Nombre" val={`${propietario.nombre || ''} ${propietario.apellido || ''}`.trim()} />
                <Row label="Correo" val={propietario.email} />
                <Row label="Teléfono" val={propietario.telefono} />
                <Row label="Rol" val={propietario.rol} />
                <Row label="Puntos" val={propietario.puntos} />
              </Section>
            ) : (
              <View style={s.emptySection}>
                <Text style={{ fontSize: 32 }}>👤</Text>
                <Text style={s.emptyText}>No se encontraron datos del propietario</Text>
              </View>
            )}
          </>
        )}

        {tab === 'bancario' && (
          <>
            {Object.keys(bancario).length > 0 ? (
              <Section title="Datos bancarios">
                <Row label="Banco" val={bancario.banco} />
                <Row label="Tipo de cuenta" val={bancario.tipo_cuenta} />
                <Row label="Número de cuenta" val={bancario.numero_cuenta || bancario.cuenta} />
                <Row label="Titular" val={bancario.titular || bancario.nombre_titular} />
                <Row label="Moneda" val={bancario.moneda} />
              </Section>
            ) : (
              <View style={s.emptySection}>
                <Text style={{ fontSize: 32 }}>🏦</Text>
                <Text style={s.emptyText}>Sin datos bancarios registrados</Text>
              </View>
            )}
          </>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Action buttons */}
      <View style={s.actions}>
        {!negocio.verificado && (
          <>
            <TouchableOpacity style={s.btnAprobar} onPress={aprobar} disabled={procesando}>
              {procesando ? <ActivityIndicator color="#6EE7B7" size="small" />
                : <Text style={s.btnAprobarText}>✓ Aprobar</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.btnRechazar} onPress={() => setRechazarModal(true)} disabled={procesando}>
              <Text style={s.btnRechazarText}>✕ Rechazar</Text>
            </TouchableOpacity>
          </>
        )}
        {negocio.verificado && (
          <TouchableOpacity
            style={[s.btnToggle, negocio.activo === false && s.btnActivar]}
            onPress={toggleSuspender}
            disabled={procesando}
          >
            {procesando ? <ActivityIndicator color={Colors.white} size="small" />
              : <Text style={s.btnToggleText}>{negocio.activo === false ? '▶ Activar' : '⏸ Suspender'}</Text>}
          </TouchableOpacity>
        )}
      </View>

      {/* Modal rechazo */}
      <Modal visible={rechazarModal} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar negocio</Text>
            <Text style={s.modalSub}>{negocio.nombre}</Text>
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
              <TouchableOpacity style={s.modalCancel} onPress={() => setRechazarModal(false)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalConfirm} onPress={rechazar} disabled={procesando}>
                {procesando ? <ActivityIndicator color="#FCA5A5" size="small" />
                  : <Text style={s.modalConfirmText}>Rechazar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, val, valColor }: { label: string; val?: any; valColor?: string }) {
  if (!val && val !== 0) return null;
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowVal, valColor ? { color: valColor } : undefined]}>{String(val)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: DARK2 },
  loading:      { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: DARK2 },
  header:       { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: DARK, padding: 16, borderBottomWidth: 1, borderBottomColor: '#334155' },
  backBtn:      { paddingRight: 4 },
  backText:     { color: Colors.orange, fontSize: 14, fontWeight: '700' },
  headerTitle:  { fontSize: 18, fontWeight: '900', color: Colors.white },
  estadoBadge:  { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginTop: 2 },
  estadoText:   { fontSize: 11, fontWeight: '700' },
  tabs:         { flexDirection: 'row', backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  tabItem:      { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive:    { borderBottomColor: Colors.orange },
  tabText:      { fontSize: 12, color: '#64748B', fontWeight: '600' },
  tabTextActive: { color: Colors.white, fontWeight: '800' },
  scroll:       { padding: 16 },
  section:      { marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  sectionBody:  { backgroundColor: DARK, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#334155' },
  row:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  rowLabel:     { fontSize: 13, color: '#94A3B8', flex: 1 },
  rowVal:       { fontSize: 13, color: Colors.white, fontWeight: '600', flex: 2, textAlign: 'right' },
  desc:         { fontSize: 13, color: '#94A3B8', padding: 12, lineHeight: 20 },
  noData:       { fontSize: 13, color: '#475569', padding: 12 },
  dpiImg:       { width: '100%', height: 200, borderRadius: 12 },
  emptySection: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyText:    { fontSize: 14, color: '#64748B', textAlign: 'center' },
  actions:      { flexDirection: 'row', gap: 10, padding: 16, backgroundColor: DARK, borderTopWidth: 1, borderTopColor: '#334155' },
  btnAprobar:   { flex: 1, backgroundColor: '#065F46', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnAprobarText: { color: '#6EE7B7', fontWeight: '800', fontSize: 14 },
  btnRechazar:  { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnRechazarText: { color: '#F87171', fontWeight: '800', fontSize: 14 },
  btnToggle:    { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnActivar:   { borderColor: '#065F46', backgroundColor: '#021F16' },
  btnToggleText: { color: '#F87171', fontWeight: '800', fontSize: 14 },
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  modalCard:    { backgroundColor: DARK, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#334155' },
  modalTitle:   { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 4 },
  modalSub:     { fontSize: 14, color: '#94A3B8', marginBottom: 16 },
  modalLabel:   { fontSize: 13, color: '#94A3B8', fontWeight: '600', marginBottom: 8 },
  modalInput:   { backgroundColor: '#334155', borderRadius: 12, padding: 12, color: Colors.white, fontSize: 14, minHeight: 80, textAlignVertical: 'top', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancel:  { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalCancelText: { color: '#94A3B8', fontWeight: '600', fontSize: 14 },
  modalConfirm: { flex: 1, backgroundColor: '#991B1B', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalConfirmText: { color: '#FCA5A5', fontWeight: '800', fontSize: 14 },
});
