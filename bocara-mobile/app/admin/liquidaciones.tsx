import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Alert, TextInput, Modal, RefreshControl,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

export default function AdminLiquidacionesScreen() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [modalPago, setModalPago] = useState<any | null>(null);
  const [referencia, setReferencia] = useState('');
  const [tab, setTab] = useState<'pendientes' | 'historial'>('pendientes');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.liquidaciones();
      setData(res.data);
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function confirmarPago() {
    if (!modalPago) return;
    setProcesando(modalPago.negocio_id);
    setModalPago(null);
    try {
      await adminAPI.pagarLiquidacion(modalPago.negocio_id, {
        datos_transferencia: { referencia, banco: modalPago.datos_bancarios?.banco },
      });
      await cargar();
      Alert.alert('✅ Liquidación registrada', `Se notificó a ${modalPago.nombre} del pago de Q${modalPago.neto.toFixed(2)}.`);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setProcesando(null);
      setReferencia('');
    }
  }

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK2 }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const pendientes = data?.pendientes || [];
  const historial = data?.historial || [];
  const totalPendiente = pendientes.reduce((s: number, r: any) => s + r.neto, 0);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>FINANZAS · BOCARA</Text>
          <Text style={s.headerTitle}>Liquidaciones</Text>
        </View>
        <View style={s.totalCard}>
          <Text style={s.totalLabel}>Total pendiente</Text>
          <Text style={s.totalVal}>Q{totalPendiente.toFixed(2)}</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, tab === 'pendientes' && s.tabActive]} onPress={() => setTab('pendientes')}>
          <Text style={[s.tabText, tab === 'pendientes' && s.tabTextActive]}>
            Pendientes {pendientes.length > 0 ? `(${pendientes.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'historial' && s.tabActive]} onPress={() => setTab('historial')}>
          <Text style={[s.tabText, tab === 'historial' && s.tabTextActive]}>Historial</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {tab === 'pendientes' && (
          <>
            {pendientes.length === 0 ? (
              <View style={s.emptyState}>
                <Text style={{ fontSize: 48 }}>💸</Text>
                <Text style={s.emptyTitle}>Sin liquidaciones pendientes</Text>
                <Text style={s.emptySub}>Todos los restaurantes están al día.</Text>
              </View>
            ) : (
              pendientes.map((r: any) => (
                <View key={r.negocio_id} style={s.card}>
                  <View style={s.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.cardNombre}>{r.nombre}</Text>
                      <Text style={s.cardPedidos}>{r.pedidos} pedido{r.pedidos !== 1 ? 's' : ''} completado{r.pedidos !== 1 ? 's' : ''}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={s.cardNeto}>Q{r.neto.toFixed(2)}</Text>
                      <Text style={s.cardNetoLabel}>75% neto</Text>
                    </View>
                  </View>

                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>Ventas brutas</Text>
                    <Text style={s.cardFinVal}>Q{r.bruto.toFixed(2)}</Text>
                  </View>
                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>Comisión Bocara (25%)</Text>
                    <Text style={[s.cardFinVal, { color: Colors.orange }]}>Q{(r.bruto * 0.25).toFixed(2)}</Text>
                  </View>

                  {/* Datos bancarios */}
                  {r.datos_bancarios ? (
                    <View style={s.bancoInfo}>
                      <Text style={s.bancoInfoText}>
                        🏦 {r.datos_bancarios.banco} · {r.datos_bancarios.numero_cuenta} · {r.datos_bancarios.tipo_cuenta}
                      </Text>
                      <Text style={s.bancoInfoText}>👤 {r.datos_bancarios.titular}</Text>
                    </View>
                  ) : (
                    <View style={s.sinBancoWarn}>
                      <Text style={s.sinBancoWarnText}>⚠️ Sin datos bancarios registrados</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[s.btnPagar, procesando === r.negocio_id && s.btnDisabled]}
                    onPress={() => { setModalPago(r); setReferencia(''); }}
                    disabled={!!procesando}
                  >
                    {procesando === r.negocio_id
                      ? <ActivityIndicator color={Colors.white} size="small" />
                      : <Text style={s.btnPagarText}>💸 Marcar como pagado · Q{r.neto.toFixed(2)}</Text>
                    }
                  </TouchableOpacity>
                </View>
              ))
            )}
          </>
        )}

        {tab === 'historial' && (
          <>
            {historial.length === 0 ? (
              <View style={s.emptyState}>
                <Text style={{ fontSize: 48 }}>📋</Text>
                <Text style={s.emptyTitle}>Sin historial</Text>
                <Text style={s.emptySub}>Aún no hay liquidaciones registradas.</Text>
              </View>
            ) : (
              historial.map((liq: any) => (
                <View key={liq.id} style={s.histCard}>
                  <View style={s.histHeader}>
                    <Text style={s.histNombre}>{liq.negocios?.nombre || 'Negocio'}</Text>
                    <Text style={s.histMonto}>Q{(liq.monto || 0).toFixed(2)}</Text>
                  </View>
                  <View style={s.histDetails}>
                    <Text style={s.histDetail}>
                      {liq.pagado_en
                        ? `✅ Pagado: ${new Date(liq.pagado_en).toLocaleDateString('es-GT')}`
                        : new Date(liq.created_at).toLocaleDateString('es-GT')}
                    </Text>
                    {liq.total_pedidos ? <Text style={s.histDetail}>{liq.total_pedidos} pedidos</Text> : null}
                    {liq.datos_transferencia?.referencia ? (
                      <Text style={s.histDetail}>Ref: {liq.datos_transferencia.referencia}</Text>
                    ) : null}
                  </View>
                </View>
              ))
            )}
          </>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal de confirmación de pago */}
      <Modal visible={!!modalPago} transparent animationType="slide" onRequestClose={() => setModalPago(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Confirmar pago</Text>
            <Text style={s.modalNombre}>{modalPago?.nombre}</Text>

            <View style={s.modalResumen}>
              <View style={s.modalResumenRow}>
                <Text style={s.modalResumenLabel}>Monto a pagar (75%)</Text>
                <Text style={s.modalResumenVal}>Q{modalPago?.neto?.toFixed(2)}</Text>
              </View>
              {modalPago?.datos_bancarios && (
                <>
                  <View style={s.modalResumenRow}>
                    <Text style={s.modalResumenLabel}>Banco</Text>
                    <Text style={s.modalResumenVal}>{modalPago.datos_bancarios.banco}</Text>
                  </View>
                  <View style={s.modalResumenRow}>
                    <Text style={s.modalResumenLabel}>Cuenta</Text>
                    <Text style={s.modalResumenVal}>{modalPago.datos_bancarios.numero_cuenta}</Text>
                  </View>
                  <View style={s.modalResumenRow}>
                    <Text style={s.modalResumenLabel}>Titular</Text>
                    <Text style={s.modalResumenVal}>{modalPago.datos_bancarios.titular}</Text>
                  </View>
                </>
              )}
            </View>

            <Text style={s.modalLabel}>Número de referencia / comprobante (opcional)</Text>
            <TextInput
              style={s.modalInput}
              placeholder="Ej: TRF-202501-0042"
              placeholderTextColor="#64748B"
              value={referencia}
              onChangeText={setReferencia}
              autoFocus
            />

            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelar} onPress={() => setModalPago(null)}>
                <Text style={s.modalCancelarText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalConfirmar} onPress={confirmarPago}>
                <Text style={s.modalConfirmarText}>Confirmar pago</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK2 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  totalCard: { backgroundColor: Colors.orange, borderRadius: 12, padding: 12, alignItems: 'center' },
  totalLabel: { fontSize: 10, color: 'rgba(255,255,255,0.8)', fontWeight: '600' },
  totalVal: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  tabRow: { flexDirection: 'row', backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  tab: { flex: 1, padding: 14, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: Colors.orange },
  tabText: { fontSize: 14, fontWeight: '600', color: '#64748B' },
  tabTextActive: { color: Colors.orange, fontWeight: '800' },
  scroll: { padding: 16 },
  emptyState: { alignItems: 'center', paddingVertical: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.white, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#64748B', marginTop: 6 },
  card: { backgroundColor: DARK, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#334155' },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cardNombre: { fontSize: 16, fontWeight: '900', color: Colors.white },
  cardPedidos: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  cardNeto: { fontSize: 22, fontWeight: '900', color: Colors.green },
  cardNetoLabel: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  cardFinRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#334155' },
  cardFinLabel: { fontSize: 12, color: '#94A3B8' },
  cardFinVal: { fontSize: 12, color: '#E2E8F0', fontWeight: '700' },
  bancoInfo: { backgroundColor: '#1A2744', borderRadius: 10, padding: 10, marginTop: 10, marginBottom: 12 },
  bancoInfoText: { fontSize: 12, color: '#94A3B8', marginBottom: 2 },
  sinBancoWarn: { backgroundColor: '#451A03', borderRadius: 10, padding: 10, marginTop: 10, marginBottom: 12 },
  sinBancoWarnText: { fontSize: 12, color: '#F59E0B', fontWeight: '700' },
  btnPagar: { backgroundColor: Colors.green, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnPagarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  histCard: { backgroundColor: DARK, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  histHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  histNombre: { fontSize: 15, fontWeight: '800', color: Colors.white },
  histMonto: { fontSize: 16, fontWeight: '900', color: '#6EE7B7' },
  histDetails: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  histDetail: { fontSize: 11, color: '#64748B' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: DARK, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderTopWidth: 1, borderTopColor: '#334155' },
  modalTitle: { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 4 },
  modalNombre: { fontSize: 14, color: '#94A3B8', marginBottom: 16 },
  modalResumen: { backgroundColor: '#1A2744', borderRadius: 12, padding: 14, marginBottom: 16 },
  modalResumenRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#334155' },
  modalResumenLabel: { fontSize: 12, color: '#94A3B8' },
  modalResumenVal: { fontSize: 13, color: Colors.white, fontWeight: '700' },
  modalLabel: { fontSize: 13, color: '#94A3B8', fontWeight: '600', marginBottom: 8 },
  modalInput: { backgroundColor: '#1A2744', borderRadius: 12, padding: 14, fontSize: 14, color: Colors.white, borderWidth: 1, borderColor: '#334155', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancelar: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelarText: { color: '#94A3B8', fontWeight: '700', fontSize: 14 },
  modalConfirmar: { flex: 1, backgroundColor: Colors.green, borderRadius: 12, padding: 14, alignItems: 'center' },
  modalConfirmarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
