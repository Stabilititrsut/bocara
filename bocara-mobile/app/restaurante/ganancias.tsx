import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

type Periodo = 'dia' | 'semana' | 'mes';

const PERIODOS: { key: Periodo; label: string }[] = [
  { key: 'dia',    label: 'Hoy' },
  { key: 'semana', label: '7 días' },
  { key: 'mes',    label: '30 días' },
];

export default function GananciasScreen() {
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async (p: Periodo = periodo) => {
    try {
      const res = await negociosAPI.ganancias(p);
      setData(res.data);
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [periodo]);

  useEffect(() => { cargar(periodo); }, [periodo]);

  if (loading) return (
    <View style={s.loading}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const resumen = data?.resumen || {};
  const liquidaciones = data?.liquidaciones || [];
  const banco = data?.negocio?.datos_bancarios;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>💰 Mis ganancias</Text>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(periodo); }} tintColor={Colors.orange} />}
      >
        {/* Selector de periodo */}
        <View style={s.periodoRow}>
          {PERIODOS.map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              style={[s.periodoBtn, periodo === key && s.periodoBtnActive]}
              onPress={() => setPeriodo(key)}
            >
              <Text style={[s.periodoBtnText, periodo === key && s.periodoBtnTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Card principal */}
        <View style={s.mainCard}>
          <Text style={s.mainCardLabel}>Lo que recibirás (75%)</Text>
          <Text style={s.mainCardVal}>Q{(resumen.neto_restaurante || 0).toFixed(2)}</Text>
          <Text style={s.mainCardSub}>{resumen.total_pedidos || 0} pedidos completados</Text>
        </View>

        {/* Desglose financiero */}
        <View style={s.desglose}>
          <Text style={s.desgloseTitle}>Desglose</Text>
          {[
            { label: 'Ventas brutas',       val: resumen.ventas_brutas || 0,       color: Colors.textPrimary },
            { label: 'Comisión Bocara (25%)', val: -(resumen.comision_bocara || 0), color: Colors.error, neg: true },
            { label: 'Tu ganancia neta',    val: resumen.neto_restaurante || 0,    color: Colors.green, bold: true },
          ].map(({ label, val, color, bold, neg }) => (
            <View key={label} style={s.desgloseRow}>
              <Text style={s.desgloseLabel}>{label}</Text>
              <Text style={[s.desgloseVal, { color }, bold && s.desgloseBold]}>
                {neg ? '−' : ''}Q{Math.abs(val).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>

        {/* Datos bancarios registrados */}
        {banco ? (
          <View style={s.bancoCard}>
            <Text style={s.bancoTitle}>🏦 Cuenta para pagos</Text>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Banco</Text>
              <Text style={s.bancoVal}>{banco.banco || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Número</Text>
              <Text style={s.bancoVal}>{banco.numero_cuenta || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Tipo</Text>
              <Text style={s.bancoVal}>{banco.tipo_cuenta || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Titular</Text>
              <Text style={s.bancoVal}>{banco.titular || '—'}</Text>
            </View>
            <Text style={s.bancoHint}>Los pagos se realizan cada semana los viernes.</Text>
          </View>
        ) : (
          <View style={s.sinBancoCard}>
            <Text style={{ fontSize: 28, marginBottom: 8 }}>🏦</Text>
            <Text style={s.sinBancoTitle}>Sin datos bancarios</Text>
            <Text style={s.sinBancoSub}>Agrega tu cuenta bancaria desde "Mi negocio" para recibir pagos.</Text>
          </View>
        )}

        {/* Historial de liquidaciones */}
        <Text style={s.sectionTitle}>Historial de pagos</Text>
        {liquidaciones.length === 0 ? (
          <View style={s.emptyLiq}>
            <Text style={s.emptyLiqText}>Aún no tienes pagos registrados.</Text>
          </View>
        ) : (
          liquidaciones.map((liq: any) => (
            <View key={liq.id} style={s.liqCard}>
              <View style={s.liqHeader}>
                <View style={[s.liqEstado, liq.estado === 'pagado' && s.liqEstadoPagado]}>
                  <Text style={[s.liqEstadoText, liq.estado === 'pagado' && s.liqEstadoTextPagado]}>
                    {liq.estado === 'pagado' ? '✅ Pagado' : '⏳ Pendiente'}
                  </Text>
                </View>
                <Text style={s.liqMonto}>Q{(liq.monto || 0).toFixed(2)}</Text>
              </View>
              <View style={s.liqDetails}>
                <Text style={s.liqDetail}>{liq.total_pedidos || '—'} pedidos</Text>
                <Text style={s.liqDetail}>
                  {liq.pagado_en
                    ? `Pagado: ${new Date(liq.pagado_en).toLocaleDateString('es-GT')}`
                    : liq.created_at
                      ? new Date(liq.created_at).toLocaleDateString('es-GT')
                      : '—'}
                </Text>
              </View>
              {liq.datos_transferencia?.referencia && (
                <Text style={s.liqRef}>Ref: {liq.datos_transferencia.referencia}</Text>
              )}
            </View>
          ))
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scroll: { padding: 16 },
  periodoRow: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14, padding: 4, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  periodoBtn: { flex: 1, padding: 10, alignItems: 'center', borderRadius: 10 },
  periodoBtnActive: { backgroundColor: Colors.orange },
  periodoBtnText: { fontSize: 14, fontWeight: '700', color: Colors.textSecondary },
  periodoBtnTextActive: { color: Colors.white },
  mainCard: { backgroundColor: Colors.brown, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16 },
  mainCardLabel: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '600', marginBottom: 4 },
  mainCardVal: { fontSize: 48, fontWeight: '900', color: Colors.white },
  mainCardSub: { fontSize: 13, color: Colors.orangeLight, marginTop: 4 },
  desglose: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  desgloseTitle: { fontSize: 13, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  desgloseRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  desgloseLabel: { fontSize: 13, color: Colors.textSecondary },
  desgloseVal: { fontSize: 14, fontWeight: '700' },
  desgloseBold: { fontSize: 16, fontWeight: '900' },
  bancoCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  bancoTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  bancoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  bancoLabel: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  bancoVal: { fontSize: 13, color: Colors.textPrimary, fontWeight: '700' },
  bancoHint: { fontSize: 11, color: Colors.textLight, marginTop: 10, fontStyle: 'italic' },
  sinBancoCard: { backgroundColor: Colors.brownLight, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 16 },
  sinBancoTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  sinBancoSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12, marginTop: 4 },
  emptyLiq: { backgroundColor: Colors.white, borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16 },
  emptyLiqText: { fontSize: 13, color: Colors.textSecondary },
  liqCard: { backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: Colors.border },
  liqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  liqEstado: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#F59E0B40' },
  liqEstadoPagado: { backgroundColor: '#D1FAE5', borderColor: '#34D39940' },
  liqEstadoText: { fontSize: 12, fontWeight: '800', color: '#92400E' },
  liqEstadoTextPagado: { color: '#065F46' },
  liqMonto: { fontSize: 18, fontWeight: '900', color: Colors.brown },
  liqDetails: { flexDirection: 'row', justifyContent: 'space-between' },
  liqDetail: { fontSize: 12, color: Colors.textSecondary },
  liqRef: { fontSize: 11, color: Colors.textLight, marginTop: 4 },
});
