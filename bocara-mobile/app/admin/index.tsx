import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#C8A97E';
const GREEN  = '#22C55E';
const BLUE   = '#3B82F6';
const SCREEN = Dimensions.get('window').width;

const CACHE_STATS = 'bocara_admin_stats_v3';
const CACHE_FIN   = 'bocara_admin_fin_v3';

function card(extra?: any) {
  return {
    backgroundColor: CARD,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    ...extra,
  };
}

function Sk({ w, h, r = 8 }: { w?: number | string; h: number; r?: number }) {
  return <View style={{ width: w as any ?? '100%', height: h, borderRadius: r, backgroundColor: '#F3F4F6' }} />;
}

function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 6 }}>
      {data.map((d) => (
        <View key={d.label} style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 8, color: TEXT2, marginBottom: 2, textAlign: 'center' }}>
            {d.value > 0 ? (d.value > 999 ? `Q${(d.value/1000).toFixed(1)}k` : `Q${d.value.toFixed(0)}`) : ''}
          </Text>
          <View style={{ width: '100%', height: 80, justifyContent: 'flex-end' }}>
            <View style={{
              width: '100%',
              height: max > 0 ? Math.max((d.value / max) * 76, d.value > 0 ? 4 : 0) : 0,
              backgroundColor: GOLD,
              borderRadius: 4,
            }} />
          </View>
          <Text style={{ fontSize: 9, color: TEXT2, marginTop: 4, textAlign: 'center' }}>{d.label}</Text>
        </View>
      ))}
    </View>
  );
}

function buildChartData(pedidos: any[]) {
  const now   = new Date();
  const labels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const days: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days[d.toDateString()] = 0;
  }
  pedidos.forEach((p) => {
    const key = new Date(p.created_at || p.creado_en || 0).toDateString();
    if (key in days) days[key] = (days[key] || 0) + (p.total || 0);
  });
  return Object.entries(days).map(([ds, v]) => ({
    label: labels[new Date(ds).getDay()],
    value: v,
  }));
}

export default function AdminDashboard() {
  const [stats,      setStats]      = useState<any>(null);
  const [financiero, setFinanciero] = useState<any>(null);
  const [pedidos,    setPedidos]    = useState<any[]>([]);
  const [skelStats,  setSkelStats]  = useState(true);
  const [skelFin,    setSkelFin]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollingRef = useRef<any>(null);
  const { logout, usuario } = useAuth();
  const router = useRouter();

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(CACHE_STATS).catch(() => null),
      AsyncStorage.getItem(CACHE_FIN).catch(() => null),
    ]).then(([sc, fc]) => {
      if (sc) { try { setStats(JSON.parse(sc)); setSkelStats(false); } catch {} }
      if (fc) { try { setFinanciero(JSON.parse(fc)); setSkelFin(false); } catch {} }
    });
    loadStats();
    const t = setTimeout(loadFinanciero, 400);
    pollingRef.current = setInterval(loadStats, 30000);
    return () => { clearInterval(pollingRef.current); clearTimeout(t); };
  }, []);

  async function loadStats() {
    try {
      const res = await adminAPI.stats();
      setStats(res.data);
      setSkelStats(false);
      setLastUpdated(new Date());
      AsyncStorage.setItem(CACHE_STATS, JSON.stringify(res.data)).catch(() => {});
    } catch {}
  }

  async function loadFinanciero() {
    try {
      const [finRes, pedRes] = await Promise.all([
        adminAPI.financiero('30d'),
        adminAPI.pedidosTodos({ limite: 100 }),
      ]);
      setFinanciero(finRes.data);
      setPedidos(pedRes.data || []);
      setSkelFin(false);
      AsyncStorage.setItem(CACHE_FIN, JSON.stringify(finRes.data)).catch(() => {});
    } catch {}
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStats(), loadFinanciero()]);
    setRefreshing(false);
  }, []);

  const comision  = stats?.comision_generada || 0;
  const ingresos  = stats?.ingresos_totales  || 0;
  const resumen   = financiero?.resumen || [];
  const chartData = buildChartData(pedidos);

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>BOCARA ADMIN</Text>
          <Text style={s.headerTitle}>Dashboard</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {lastUpdated && (
            <View style={s.liveChip}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>{lastUpdated.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}</Text>
            </View>
          )}
          <TouchableOpacity onPress={logout} style={s.logoutBtn}>
            <Ionicons name="log-out-outline" size={18} color={TEXT2} />
            <Text style={s.logoutText}>Salir</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {/* Alerta pendientes */}
        {!skelStats && stats?.negocios_sin_verificar > 0 && (
          <TouchableOpacity style={s.alertCard} onPress={() => router.push('/admin/verificacion' as any)}>
            <Ionicons name="warning" size={20} color="#D97706" />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={s.alertTitle}>
                {stats.negocios_sin_verificar} restaurante{stats.negocios_sin_verificar !== 1 ? 's' : ''} pendientes de aprobación
              </Text>
              <Text style={s.alertSub}>Toca para revisar →</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Métricas principales */}
        <Text style={s.sectionTitle}>Resumen general</Text>
        <View style={s.metricsGrid}>
          {skelStats ? (
            [1,2,3,4].map(k => (
              <View key={k} style={[card(), s.metricCard]}>
                <Sk h={12} w={60} r={4} />
                <Sk h={28} w={80} r={6} />
                <Sk h={10} w={50} r={4} />
              </View>
            ))
          ) : [
            { label: 'Ventas brutas',   val: `Q${ingresos.toFixed(0)}`,    sub: 'total acumulado',     color: TEXT,   icon: 'trending-up'     as any },
            { label: 'Comisión Bocara', val: `Q${comision.toFixed(0)}`,    sub: '25% de ventas',       color: GOLD,   icon: 'wallet'          as any },
            { label: 'Restaurantes',    val: stats?.negocios_activos || 0, sub: 'activos',             color: GREEN,  icon: 'storefront'      as any },
            { label: 'Pedidos totales', val: stats?.total_pedidos || 0,    sub: `${stats?.pedidos_completados || 0} completados`, color: BLUE, icon: 'bag-check' as any },
          ].map(({ label, val, sub, color, icon }) => (
            <View key={label} style={[card(), s.metricCard]}>
              <Ionicons name={icon} size={20} color={color} style={{ marginBottom: 6 }} />
              <Text style={[s.metricVal, { color }]}>{val}</Text>
              <Text style={s.metricLabel}>{label}</Text>
              <Text style={s.metricSub}>{sub}</Text>
            </View>
          ))}
        </View>

        {/* Gráfico */}
        <Text style={s.sectionTitle}>Ventas últimos 7 días</Text>
        <View style={[card(), s.chartCard]}>
          {skelFin
            ? <Sk h={120} r={8} />
            : <>
                <BarChart data={chartData} />
                <Text style={s.chartCaption}>
                  Total 7d: Q{chartData.reduce((a, d) => a + d.value, 0).toFixed(2)}
                </Text>
              </>
          }
        </View>

        {/* Resumen financiero */}
        <Text style={s.sectionTitle}>Resumen financiero</Text>
        <View style={[card(), { marginBottom: 20 }]}>
          {[
            { label: 'Ventas brutas',           val: `Q${ingresos.toFixed(2)}`,             color: TEXT   },
            { label: 'Comisión Bocara (25%)',    val: `Q${comision.toFixed(2)}`,             color: GOLD   },
            { label: 'Pago restaurantes (75%)',  val: `Q${(ingresos * 0.75).toFixed(2)}`,   color: GREEN  },
          ].map(({ label, val, color }, i, arr) => (
            <View key={label} style={[s.finRow, i < arr.length - 1 && s.finRowBorder]}>
              <Text style={s.finLabel}>{label}</Text>
              {skelStats ? <Sk h={16} w={80} r={4} /> : <Text style={[s.finVal, { color }]}>{val}</Text>}
            </View>
          ))}
        </View>

        {/* Tabla restaurantes */}
        <Text style={s.sectionTitle}>Top restaurantes (30 días)</Text>
        <View style={[card(), { marginBottom: 20, overflow: 'hidden' }]}>
          <View style={s.tableHead}>
            <Text style={[s.th, { flex: 2 }]}>Restaurante</Text>
            <Text style={s.th}>Pedidos</Text>
            <Text style={s.th}>Ventas</Text>
            <Text style={s.th}>Comisión</Text>
          </View>
          {skelFin ? (
            [1,2,3].map(k => (
              <View key={k} style={s.tableRow}>
                <Sk h={14} w="60%" r={4} />
              </View>
            ))
          ) : resumen.length === 0 ? (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ color: TEXT2, fontSize: 13 }}>Sin ventas en el período</Text>
            </View>
          ) : (
            resumen.slice(0, 10).map((r: any, i: number) => (
              <TouchableOpacity
                key={r.negocio_id}
                style={[s.tableRow, i % 2 === 1 && { backgroundColor: '#F9FAFB' }]}
                onPress={() => router.push(`/admin/restaurante-detalle?id=${r.negocio_id}` as any)}
              >
                <View style={{ flex: 2 }}>
                  <Text style={s.tdName} numberOfLines={1}>{r.nombre}</Text>
                  {r.zona ? <Text style={s.tdSub}>{r.zona}</Text> : null}
                </View>
                <Text style={s.td}>{r.pedidos}</Text>
                <Text style={[s.td, { color: TEXT }]}>Q{r.bruto.toFixed(0)}</Text>
                <Text style={[s.td, { color: GOLD, fontWeight: '700' }]}>Q{r.comision.toFixed(0)}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Estadísticas secundarias */}
        <Text style={s.sectionTitle}>Más datos</Text>
        <View style={s.statsRow}>
          {skelStats ? [1,2,3].map(k => (
            <View key={k} style={[card(), s.statMini]}><Sk h={20} w={50} r={4} /></View>
          )) : [
            { label: 'Usuarios',     val: stats?.total_usuarios || 0,       color: BLUE      },
            { label: 'Sin verificar', val: stats?.negocios_sin_verificar || 0, color: '#F59E0B' },
          ].map(({ label, val, color }) => (
            <View key={label} style={[card(), s.statMini]}>
              <Text style={[s.statVal, { color }]}>{val}</Text>
              <Text style={s.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {!skelStats && (
          <View style={s.ecoCard}>
            <Text style={{ fontSize: 28, marginBottom: 4 }}>🌿</Text>
            <Text style={s.ecoBig}>{stats?.pedidos_completados || 0}</Text>
            <Text style={s.ecoLabel}>bolsas rescatadas</Text>
          </View>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: BG },
  header:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:  { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  liveChip:   { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F0FDF4', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#BBF7D0' },
  liveDot:    { width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN },
  liveText:   { fontSize: 11, color: '#166534', fontWeight: '600' },
  logoutBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  logoutText: { fontSize: 13, color: TEXT2, fontWeight: '600' },
  scroll:     { padding: 16 },

  alertCard:  { flexDirection: 'row', backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FDE68A', borderRadius: 12, padding: 14, marginBottom: 16, alignItems: 'center' },
  alertTitle: { fontSize: 13, fontWeight: '700', color: '#92400E' },
  alertSub:   { fontSize: 11, color: '#B45309', marginTop: 2 },

  sectionTitle: { fontSize: 11, fontWeight: '700', color: TEXT2, marginBottom: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.8 },

  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  metricCard:  { flex: 1, minWidth: (SCREEN - 52) / 2, padding: 14, gap: 2 },
  metricVal:   { fontSize: 22, fontWeight: '900' },
  metricLabel: { fontSize: 12, color: TEXT, fontWeight: '600' },
  metricSub:   { fontSize: 10, color: TEXT2 },

  chartCard:    { padding: 16, marginBottom: 20 },
  chartCaption: { fontSize: 11, color: TEXT2, marginTop: 8, textAlign: 'right' },

  finRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14 },
  finRowBorder: { borderBottomWidth: 1, borderBottomColor: BORDER },
  finLabel:     { fontSize: 13, color: TEXT2 },
  finVal:       { fontSize: 15, fontWeight: '800' },

  tableHead:  { flexDirection: 'row', padding: 10, borderBottomWidth: 1, borderBottomColor: BORDER, backgroundColor: '#F9FAFB' },
  th:         { flex: 1, fontSize: 10, color: TEXT2, fontWeight: '700', textTransform: 'uppercase', textAlign: 'center' },
  tableRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  tdName:     { fontSize: 13, fontWeight: '700', color: TEXT },
  tdSub:      { fontSize: 10, color: TEXT2 },
  td:         { flex: 1, fontSize: 12, color: TEXT2, textAlign: 'center' },

  statsRow:   { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statMini:   { flex: 1, padding: 12, alignItems: 'center', gap: 4 },
  statVal:    { fontSize: 18, fontWeight: '900' },
  statLabel:  { fontSize: 10, color: TEXT2, textAlign: 'center' },

  ecoCard:    { backgroundColor: '#F0FDF4', borderRadius: 16, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#BBF7D0', marginBottom: 8 },
  ecoBig:     { fontSize: 44, fontWeight: '900', color: '#166534' },
  ecoLabel:   { fontSize: 14, fontWeight: '600', color: '#15803D' },
});
