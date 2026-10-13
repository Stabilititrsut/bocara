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
    if (!referencia.trim()) {
      return Alert.alert('Falta el comprobante', 'Ingresa la referencia de la transferencia bancaria realizada.');
    }
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

  // Ventana de liquidación (backend: services/liquidaciones.js#ventanaLiquidacion).
  // Fuera de los 5 primeros días hábiles el backend NO genera cortes nuevos,
  // pero sí paga las liquidaciones ya generadas: el botón paga solo eso, y se
  // deshabilita si el restaurante no tiene ninguna generada. Sin el campo
  // (backend anterior) no se bloquea nada.
  const ventana = data?.ventana_liquidacion;
  const fueraDeVentana = !!ventana && !ventana.dentro;
  const ddmm = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—');
  // Acumulado del mes en curso por comercio (aún no liquidable; backend:
  // services/liquidaciones.js#resumirAcumuladoMes). Sin el campo (backend
  // anterior) la sección no se muestra.
  const acumulado = data?.acumulado_mes_en_curso;
  const nombreMes = (mes?: string) => {
    if (!mes) return '';
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${MESES[Number(mes.slice(5, 7)) - 1] || mes} ${mes.slice(0, 4)}`;
  };
  const montoPagable = (r: any): number => fueraDeVentana
    ? (r.liquidaciones_pendientes || []).reduce((s: number, l: any) => s + (l.monto || 0), 0)
    : r.neto;

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
            {ventana && (
              <View style={[s.ventanaCard, fueraDeVentana ? s.ventanaCerrada : s.ventanaAbierta]}>
                <Text style={[s.ventanaTitulo, { color: fueraDeVentana ? '#FBBF24' : '#4ADE80' }]}>
                  {fueraDeVentana
                    ? '⏸️ Fuera de la ventana de liquidación mensual'
                    : `🟢 Ventana de liquidación abierta · día hábil ${ventana.dia_habil} de 5`}
                </Text>
                <Text style={s.ventanaTexto}>
                  {fueraDeVentana
                    ? `Las liquidaciones mensuales solo pueden procesarse durante los primeros 5 días hábiles del mes. Próxima apertura: ${ddmm(ventana.proxima_apertura)}. Las liquidaciones ya generadas sí pueden pagarse.`
                    : `Puedes generar y pagar liquidaciones hasta el ${ddmm(ventana.cierra)} (lunes a viernes).`}
                </Text>
              </View>
            )}
            {acumulado && (
              <View style={s.acumCard}>
                <Text style={s.acumTitulo}>📈 Acumulado del mes en curso por comercio · {nombreMes(acumulado.mes)}</Text>
                <Text style={s.acumTexto}>
                  Ventas pagadas del mes que se liquidarán en el próximo corte
                  {ventana ? ` (desde el ${ddmm(fueraDeVentana ? ventana.proxima_apertura : ventana.abre)})` : ''}.
                  Solo entran al corte los pedidos entregados; los que siguen en curso se indican aparte.
                </Text>
                {acumulado.negocios.length === 0 ? (
                  <Text style={[s.acumTexto, { marginTop: 8 }]}>Sin ventas en lo que va del mes.</Text>
                ) : (
                  <>
                    {acumulado.negocios.map((r: any) => (
                      <View key={r.negocio_id} style={s.acumFila}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Text style={s.acumNombre} numberOfLines={1}>{r.nombre}</Text>
                          <Text style={s.acumPedidos}>{r.pedidos} pedido{r.pedidos !== 1 ? 's' : ''}</Text>
                        </View>
                        <View style={s.acumCifras}>
                          <View style={s.acumCifra}>
                            <Text style={s.acumLabel}>Ventas brutas</Text>
                            <Text style={s.acumVal}>Q{r.bruto.toFixed(2)}</Text>
                          </View>
                          <View style={s.acumCifra}>
                            <Text style={s.acumLabel}>Comisión Bocara</Text>
                            <Text style={[s.acumVal, { color: Colors.orange }]}>Q{r.comisionBocara.toFixed(2)}</Text>
                          </View>
                          <View style={s.acumCifra}>
                            <Text style={s.acumLabel}>Saldo neto</Text>
                            <Text style={[s.acumVal, { color: Colors.green }]}>Q{r.neto.toFixed(2)}</Text>
                          </View>
                        </View>
                        {r.pedidos_en_curso > 0 && (
                          <Text style={s.acumNota}>
                            Incluye {r.pedidos_en_curso} pedido{r.pedidos_en_curso !== 1 ? 's' : ''} aún sin entregar (Q{r.neto_en_curso.toFixed(2)}).
                          </Text>
                        )}
                        {r.pedidosSinDesglose > 0 && (
                          <Text style={[s.acumNota, { color: '#F59E0B' }]}>
                            ⚠️ {r.pedidosSinDesglose} pedido{r.pedidosSinDesglose !== 1 ? 's' : ''} sin monto neto calculado (no sumado).
                          </Text>
                        )}
                      </View>
                    ))}
                    <View style={[s.acumFila, { borderBottomWidth: 0 }]}>
                      <View style={s.acumCifras}>
                        <View style={s.acumCifra}>
                          <Text style={s.acumLabel}>Total ventas</Text>
                          <Text style={s.acumVal}>Q{acumulado.totales.bruto.toFixed(2)}</Text>
                        </View>
                        <View style={s.acumCifra}>
                          <Text style={s.acumLabel}>Total comisión</Text>
                          <Text style={[s.acumVal, { color: Colors.orange }]}>Q{acumulado.totales.comisionBocara.toFixed(2)}</Text>
                        </View>
                        <View style={s.acumCifra}>
                          <Text style={s.acumLabel}>Total neto</Text>
                          <Text style={[s.acumVal, { color: Colors.green }]}>Q{acumulado.totales.neto.toFixed(2)}</Text>
                        </View>
                      </View>
                    </View>
                  </>
                )}
              </View>
            )}
            {acumulado && <Text style={s.seccionTitulo}>Pagable ahora (meses cerrados)</Text>}
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
                      <Text style={s.cardNetoLabel}>neto + propinas + envío</Text>
                    </View>
                  </View>

                  {/* Desglose explícito: de dónde sale cada quetzal, nunca mezclado */}
                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>Ventas brutas (producto)</Text>
                    <Text style={s.cardFinVal}>Q{r.bruto.toFixed(2)}</Text>
                  </View>
                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>− Comisión Bocara (TL 25% / Promo 20%)</Text>
                    <Text style={[s.cardFinVal, { color: Colors.orange }]}>Q{r.comisionBocara.toFixed(2)}</Text>
                  </View>
                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>Cargo de plataforma (3.5%, no afecta este pago)</Text>
                    <Text style={[s.cardFinVal, { color: '#64748B' }]}>Q{r.cargoPlataforma.toFixed(2)}</Text>
                  </View>
                  <View style={s.cardFinRow}>
                    <Text style={s.cardFinLabel}>+ Propinas (100% restaurante)</Text>
                    <Text style={[s.cardFinVal, { color: Colors.green }]}>Q{r.propinas.toFixed(2)}</Text>
                  </View>

                  {/* Pedidos sin desglose calculado — nunca se aproxima, se avisa */}
                  {r.pedidosSinDesglose > 0 && (
                    <View style={s.sinBancoWarn}>
                      <Text style={s.sinBancoWarnText}>
                        ⚠️ {r.pedidosSinDesglose} pedido{r.pedidosSinDesglose !== 1 ? 's' : ''} sin monto neto calculado —
                        excluido{r.pedidosSinDesglose !== 1 ? 's' : ''} de este pago. Revisar antes de liquidar.
                      </Text>
                    </View>
                  )}

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

                  {(() => {
                    const monto = montoPagable(r);
                    const bloqueada = fueraDeVentana && monto <= 0;
                    return (
                      <>
                        {fueraDeVentana && !bloqueada && monto < r.neto && (
                          <Text style={s.ventanaNota}>
                            Solo se paga lo ya generado (Q{monto.toFixed(2)}). El resto se liquida desde el {ddmm(ventana?.proxima_apertura)}.
                          </Text>
                        )}
                        <TouchableOpacity
                          style={[s.btnPagar, (procesando === r.negocio_id || bloqueada) && s.btnDisabled, bloqueada && s.btnBloqueado]}
                          onPress={() => { setModalPago({ ...r, neto: monto }); setReferencia(''); }}
                          disabled={!!procesando || bloqueada}
                        >
                          {procesando === r.negocio_id
                            ? <ActivityIndicator color={Colors.white} size="small" />
                            : <Text style={s.btnPagarText}>
                                {bloqueada
                                  ? `🔒 Liquidación disponible desde el ${ddmm(ventana?.proxima_apertura)}`
                                  : `💸 Registrar transferencia · Q${monto.toFixed(2)}`}
                              </Text>
                          }
                        </TouchableOpacity>
                      </>
                    );
                  })()}
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
                  {/* Desglose de dónde salió el monto pagado — auditable sin ambigüedad */}
                  <View style={[s.histDetails, { marginTop: 6 }]}>
                    <Text style={s.histDetail}>Ventas: Q{(liq.ventas_brutas || 0).toFixed(2)}</Text>
                    <Text style={s.histDetail}>Comisión Bocara: Q{(liq.comision_bocara || 0).toFixed(2)}</Text>
                    {(liq.comision_plataforma || 0) > 0 && (
                      <Text style={s.histDetail}>Cargo plataforma: Q{liq.comision_plataforma.toFixed(2)}</Text>
                    )}
                    {(liq.propinas || 0) > 0 && (
                      <Text style={s.histDetail}>Propinas: Q{liq.propinas.toFixed(2)}</Text>
                    )}
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
            <Text style={s.modalTitle}>Registrar transferencia realizada</Text>
            <Text style={s.modalNombre}>{modalPago?.nombre}</Text>

            <View style={s.modalResumen}>
              <View style={s.modalResumenRow}>
                <Text style={s.modalResumenLabel}>Monto neto a pagar</Text>
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

            <Text style={s.modalLabel}>Número de referencia / comprobante</Text>
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
                <Text style={s.modalConfirmarText}>Registrar como pagado</Text>
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
  btnBloqueado: { backgroundColor: '#475569' },
  ventanaCard: { borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1 },
  ventanaAbierta: { backgroundColor: '#052E16', borderColor: '#166534' },
  ventanaCerrada: { backgroundColor: '#422006', borderColor: '#92400E' },
  ventanaTitulo: { fontSize: 13, fontWeight: '800', marginBottom: 4 },
  ventanaTexto: { fontSize: 12, color: '#CBD5E1', lineHeight: 17 },
  ventanaNota: { fontSize: 11, color: '#FBBF24', marginBottom: 8 },
  acumCard: { backgroundColor: DARK, borderRadius: 16, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#1D4ED8' },
  acumTitulo: { fontSize: 14, fontWeight: '900', color: Colors.white, marginBottom: 4 },
  acumTexto: { fontSize: 12, color: '#94A3B8', lineHeight: 17 },
  acumFila: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#334155' },
  acumNombre: { fontSize: 14, fontWeight: '800', color: Colors.white, flex: 1, marginRight: 8 },
  acumPedidos: { fontSize: 11, color: '#94A3B8' },
  acumCifras: { flexDirection: 'row', gap: 8, marginTop: 6 },
  acumCifra: { flex: 1, backgroundColor: '#1A2744', borderRadius: 10, padding: 8 },
  acumLabel: { fontSize: 10, color: '#94A3B8', fontWeight: '600' },
  acumVal: { fontSize: 14, fontWeight: '900', color: '#E2E8F0', marginTop: 2 },
  acumNota: { fontSize: 11, color: '#94A3B8', marginTop: 6 },
  seccionTitulo: { fontSize: 11, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
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
