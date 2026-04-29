import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator, Share, Alert,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

type Periodo = '7d' | '30d' | 'todo';

export default function AdminFinancieroScreen() {
  const [datos, setDatos] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [expandido, setExpandido] = useState<string | null>(null);
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [mostrarPedidos, setMostrarPedidos] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [finRes, pedRes] = await Promise.all([
        adminAPI.financiero(periodo),
        adminAPI.pedidosTodos({ limite: 200 }),
      ]);
      setDatos(finRes.data);
      setPedidos(pedRes.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, [periodo]);

  useEffect(() => { cargar(); }, [cargar]);

  async function exportarCSV() {
    if (!datos?.resumen?.length) return Alert.alert('Sin datos', 'No hay datos para exportar en este período.');
    const encabezado = 'Negocio,Zona,Pedidos,Ventas brutas (Q),Comisión Bocara (Q),Pago neto (Q)';
    const filas = datos.resumen.map((r: any) =>
      `${r.nombre},${r.zona},${r.pedidos},${r.bruto.toFixed(2)},${r.comision.toFixed(2)},${r.neto.toFixed(2)}`
    );
    const totalRow = `TOTAL,,${datos.totales.pedidos},${datos.totales.bruto.toFixed(2)},${datos.totales.comision.toFixed(2)},${datos.totales.neto.toFixed(2)}`;
    const csv = [encabezado, ...filas, totalRow].join('\n');
    try {
      await Share.share({ message: csv, title: `Bocara_Financiero_${periodo}.csv` });
    } catch {}
  }

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK2 }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const totales = datos?.totales || { bruto: 0, comision: 0, neto: 0, pedidos: 0 };
  const resumen = datos?.resumen || [];

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>💰 Módulo Financiero</Text>
        <TouchableOpacity style={s.exportBtn} onPress={exportarCSV}>
          <Text style={s.exportBtnText}>📤 Exportar</Text>
        </TouchableOpacity>
      </View>

      {/* Período */}
      <View style={s.periodos}>
        {(['7d', '30d', 'todo'] as Periodo[]).map((p) => (
          <TouchableOpacity key={p} style={[s.periodoChip, periodo === p && s.periodoActive]} onPress={() => setPeriodo(p)}>
            <Text style={[s.periodoText, periodo === p && s.periodoTextActive]}>
              {p === '7d' ? '7 días' : p === '30d' ? '30 días' : 'Todo'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {/* Resumen total */}
        <View style={s.totalCard}>
          <Text style={s.totalTitle}>Resumen del período</Text>
          <View style={s.totalGrid}>
            <View style={s.totalItem}>
              <Text style={s.totalEmoji}>📦</Text>
              <Text style={s.totalVal}>{totales.pedidos}</Text>
              <Text style={s.totalLabel}>Pedidos completados</Text>
            </View>
            <View style={s.totalItem}>
              <Text style={s.totalEmoji}>💵</Text>
              <Text style={[s.totalVal, { color: '#94A3B8' }]}>Q{totales.bruto.toFixed(2)}</Text>
              <Text style={s.totalLabel}>Ventas brutas</Text>
            </View>
            <View style={[s.totalItem, s.totalItemComision]}>
              <Text style={s.totalEmoji}>🏦</Text>
              <Text style={[s.totalVal, { color: Colors.orange }]}>Q{totales.comision.toFixed(2)}</Text>
              <Text style={s.totalLabel}>Comisión Bocara (25%)</Text>
            </View>
            <View style={[s.totalItem, s.totalItemNeto]}>
              <Text style={s.totalEmoji}>🏪</Text>
              <Text style={[s.totalVal, { color: '#86EFAC' }]}>Q{totales.neto.toFixed(2)}</Text>
              <Text style={s.totalLabel}>Pago a restaurantes (75%)</Text>
            </View>
          </View>
        </View>

        {/* Por restaurante */}
        <Text style={s.sectionTitle}>Desglose por restaurante</Text>
        {resumen.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 40 }}>📊</Text>
            <Text style={s.emptyText}>Sin transacciones en este período</Text>
          </View>
        )}

        {resumen.map((r: any) => (
          <TouchableOpacity
            key={r.negocio_id}
            style={s.restCard}
            onPress={() => setExpandido(expandido === r.negocio_id ? null : r.negocio_id)}
          >
            <View style={s.restCardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.restNombre}>{r.nombre}</Text>
                {r.zona ? <Text style={s.restZona}>{r.zona}</Text> : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={s.restNeto}>Q{r.neto.toFixed(2)}</Text>
                <Text style={s.restComision}>-Q{r.comision.toFixed(2)} comisión</Text>
                <Text style={s.restPedidos}>{r.pedidos} pedidos</Text>
              </View>
              <Text style={s.chevron}>{expandido === r.negocio_id ? '▲' : '▼'}</Text>
            </View>

            {expandido === r.negocio_id && (
              <View style={s.restDetail}>
                {[
                  { label: 'Ventas brutas', val: `Q${r.bruto.toFixed(2)}`, color: '#94A3B8' },
                  { label: 'Comisión Bocara (25%)', val: `-Q${r.comision.toFixed(2)}`, color: '#FCA5A5' },
                  { label: 'Pago al restaurante (75%)', val: `Q${r.neto.toFixed(2)}`, color: '#86EFAC' },
                  { label: 'Promedio por pedido', val: r.pedidos > 0 ? `Q${(r.bruto / r.pedidos).toFixed(2)}` : '—', color: '#94A3B8' },
                ].map(({ label, val, color }, i, arr) => (
                  <View key={label} style={[s.detailRow, i < arr.length - 1 && s.detailRowBorder]}>
                    <Text style={s.detailLabel}>{label}</Text>
                    <Text style={[s.detailVal, { color }]}>{val}</Text>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        ))}

        {/* Transacciones recientes */}
        <View style={s.pedidosHeader}>
          <Text style={s.sectionTitle}>Transacciones recientes</Text>
          <TouchableOpacity onPress={() => setMostrarPedidos(!mostrarPedidos)}>
            <Text style={s.togglePedidos}>{mostrarPedidos ? 'Ocultar' : 'Ver todas'}</Text>
          </TouchableOpacity>
        </View>

        {mostrarPedidos && pedidos.slice(0, 50).map((p: any) => (
          <View key={p.id} style={s.txRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.txCodigo}>{p.codigo_recogida || '—'}</Text>
              <Text style={s.txNegocio}>{p.negocios?.nombre || '—'}</Text>
              <Text style={s.txFecha}>{new Date(p.created_at || p.creado_en || 0).toLocaleDateString('es-GT')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.txTotal}>Q{(p.total || 0).toFixed(2)}</Text>
              <Text style={s.txComision}>-Q{((p.total || 0) * 0.25).toFixed(2)}</Text>
              <View style={[s.txEstado, { backgroundColor: p.estado === 'recogido' ? '#064E3B' : '#451A03' }]}>
                <Text style={[s.txEstadoText, { color: p.estado === 'recogido' ? '#34D399' : '#FCD34D' }]}>{p.estado}</Text>
              </View>
            </View>
          </View>
        ))}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white },
  exportBtn: { backgroundColor: '#1D4ED8', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  exportBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  periodos: { flexDirection: 'row', padding: 12, gap: 8, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  periodoChip: { flex: 1, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: '#334155', alignItems: 'center', backgroundColor: '#1E293B' },
  periodoActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  periodoText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  periodoTextActive: { color: Colors.white, fontWeight: '800' },
  scroll: { padding: 14 },
  totalCard: { backgroundColor: DARK, borderRadius: 20, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#334155' },
  totalTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.8 },
  totalGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  totalItem: { flex: 1, minWidth: '45%', backgroundColor: '#0F172A', borderRadius: 14, padding: 12, alignItems: 'center', gap: 4 },
  totalItemComision: { borderWidth: 1, borderColor: '#92400E', backgroundColor: '#1C0F03' },
  totalItemNeto: { borderWidth: 1, borderColor: '#065F46', backgroundColor: '#021F16' },
  totalEmoji: { fontSize: 22 },
  totalVal: { fontSize: 18, fontWeight: '900', color: Colors.white },
  totalLabel: { fontSize: 10, color: '#64748B', textAlign: 'center' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: '#64748B', textAlign: 'center' },
  restCard: { backgroundColor: DARK, borderRadius: 16, marginBottom: 10, borderWidth: 1, borderColor: '#334155', overflow: 'hidden' },
  restCardTop: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 8 },
  restNombre: { fontSize: 15, fontWeight: '800', color: Colors.white },
  restZona: { fontSize: 12, color: '#64748B', marginTop: 2 },
  restNeto: { fontSize: 18, fontWeight: '900', color: '#86EFAC' },
  restComision: { fontSize: 11, color: '#FCA5A5', marginTop: 2 },
  restPedidos: { fontSize: 11, color: '#64748B', marginTop: 2 },
  chevron: { fontSize: 12, color: '#334155', marginLeft: 4 },
  restDetail: { borderTopWidth: 1, borderTopColor: '#334155' },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  detailRowBorder: { borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  detailLabel: { fontSize: 13, color: '#64748B' },
  detailVal: { fontSize: 14, fontWeight: '700' },
  pedidosHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  togglePedidos: { color: Colors.orange, fontSize: 13, fontWeight: '700' },
  txRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: DARK, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#334155' },
  txCodigo: { fontSize: 13, fontWeight: '800', color: Colors.white, letterSpacing: 1 },
  txNegocio: { fontSize: 12, color: '#64748B', marginTop: 1 },
  txFecha: { fontSize: 11, color: '#475569', marginTop: 1 },
  txTotal: { fontSize: 15, fontWeight: '900', color: Colors.white },
  txComision: { fontSize: 11, color: '#FCA5A5', marginTop: 1 },
  txEstado: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, marginTop: 4, alignSelf: 'flex-end' },
  txEstadoText: { fontSize: 10, fontWeight: '700' },
});
