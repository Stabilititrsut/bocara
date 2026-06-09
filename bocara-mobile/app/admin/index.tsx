import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { adminAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const DARK    = '#1E293B';
const DARK2   = '#0F172A';
const GOLD    = '#C8A97E';
const SCREEN  = Dimensions.get('window').width;

const CACHE_STATS = 'bocara_admin_stats_v2';
const CACHE_FIN   = 'bocara_admin_fin_v2';

// ── Skeleton box ─────────────────────────────────────────────────────────────
function Sk({ w, h, r = 8 }: { w?: number | string; h: number; r?: number }) {
  return (
    <View style={{ width: w as any ?? '100%', height: h, borderRadius: r, backgroundColor: '#253248' }} />
  );
}

// ── Simple bar chart ──────────────────────────────────────────────────────────
function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <View style={bc.wrap}>
      {data.map((d) => (
        <View key={d.label} style={bc.col}>
          <Text style={bc.val}>
            {d.value > 999 ? `Q${(d.value / 1000).toFixed(1)}k` : d.value > 0 ? `Q${d.value.toFixed(0)}` : ''}
          </Text>
          <View style={bc.barBg}>
            <View style={[bc.bar, { height: max > 0 ? Math.max((d.value / max) * 80, d.value > 0 ? 4 : 0) : 0 }]} />
          </View>
          <Text style={bc.label}>{d.label}</Text>
        </View>
      ))}
    </View>
  );
}

const bc = StyleSheet.create({
  wrap:  { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 4 },
  col:   { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barBg: { width: '100%', height: 80, justifyContent: 'flex-end' },
  bar:   { width: '100%', backgroundColor: GOLD, borderRadius: 4 },
  val:   { fontSize: 8, color: '#64748B', marginBottom: 2, textAlign: 'center' },
  label: { fontSize: 9, color: '#64748B', marginTop: 4, textAlign: 'center' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildChartData(pedidos: any[]) {
  const now   = new Date();
  const days: Record<string, number> = {};
  const labels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
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

// ── Main component ────────────────────────────────────────────────────────────
export default function AdminDashboard() {
  const [stats,     setStats]     = useState<any>(null);
  const [financiero, setFinanciero] = useState<any>(null);
  const [pedidos,   setPedidos]   = useState<any[]>([]);
  const [skelStats, setSkelStats] = useState(true);
  const [skelFin,   setSkelFin]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollingRef = useRef<any>(null);
  const { logout, usuario } = useAuth();
  const router = useRouter();

  // Load cache → UI visible immediately, then refresh in background
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
    pollingRef.current = setInterval(() => { loadStats(); }, 30000);
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

  const comision = stats?.comision_generada || 0;
  const ingresos = stats?.ingresos_totales || 0;
  const resumen  = financiero?.resumen || [];
  const chartData = buildChartData(pedidos);

  return (
    <SafeAreaView style={s.root}>
      {/* ── Header ── */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>BOCARA ADMIN</Text>
          <Text style={s.headerTitle}>Dashboard</Text>
          {lastUpdated && (
            <Text style={s.headerSub}>
              ● Actualizado {lastUpdated.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={logout} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {/* ── Alerta pendientes ── */}
        {!skelStats && stats?.negocios_sin_verificar > 0 && (
          <TouchableOpacity style={s.alertCard} onPress={() => router.push('/admin/verificacion' as any)}>
            <Text style={{ fontSize: 24 }}>⚠️</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.alertTitle}>
                {stats.negocios_sin_verificar} restaurante{stats.negocios_sin_verificar !== 1 ? 's' : ''} pendientes
              </Text>
              <Text style={s.alertSub}>Toca para revisar →</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* ── Métricas principales ── */}
        <Text style={s.sectionTitle}>Métricas generales</Text>
        <View style={s.metricsGrid}>
          {skelStats ? (
            [1,2,3,4].map(k => (
              <View key={k} style={s.metricCard}>
                <Sk h={22} w={60} r={6} />
                <Sk h={30} w={80} r={6} />
                <Sk h={14} w={70} r={4} />
              </View>
            ))
          ) : [
            { label: 'Ventas brutas', val: `Q${ingresos.toFixed(0)}`, sub: 'últimos 30d', color: Colors.white, icon: '💵' },
            { label: 'Comisión Bocara', val: `Q${comision.toFixed(0)}`, sub: '25% de ventas', color: GOLD, icon: '💰' },
            { label: 'Restaurantes', val: stats?.negocios_activos || 0, sub: 'activos', color: '#34D399', icon: '🏪' },
            { label: 'Pedidos totales', val: stats?.total_pedidos || 0, sub: 'completados: ' + (stats?.pedidos_completados || 0), color: '#60A5FA', icon: '📦' },
          ].map(({ label, val, sub, color, icon }) => (
            <View key={label} style={s.metricCard}>
              <Text style={{ fontSize: 24 }}>{icon}</Text>
              <Text style={[s.metricVal, { color }]}>{val}</Text>
              <Text style={s.metricLabel}>{label}</Text>
              <Text style={s.metricSub}>{sub}</Text>
            </View>
          ))}
        </View>

        {/* ── Gráfico ventas últimos 7 días ── */}
        <Text style={s.sectionTitle}>Ventas últimos 7 días</Text>
        <View style={s.chartCard}>
          {skelFin ? (
            <View style={{ gap: 8 }}>
              <Sk h={100} r={8} />
              <Sk h={12} w={120} r={4} />
            </View>
          ) : (
            <>
              <BarChart data={chartData} />
              <Text style={s.chartCaption}>
                Total 7d: Q{chartData.reduce((a, d) => a + d.value, 0).toFixed(2)}
              </Text>
            </>
          )}
        </View>

        {/* ── Desglose financiero ── */}
        <Text style={s.sectionTitle}>Resumen financiero (30 días)</Text>
        <View style={s.finCard}>
          {[
            { label: 'Ventas brutas', val: `Q${ingresos.toFixed(2)}`, color: Colors.white },
            { label: 'Comisión Bocara (25%)', val: `Q${comision.toFixed(2)}`, color: GOLD },
            { label: 'Pago restaurantes (75%)', val: `Q${(ingresos * 0.75).toFixed(2)}`, color: '#86EFAC' },
          ].map(({ label, val, color }, i, arr) => (
            <View key={label} style={[s.finRow, i < arr.length - 1 && s.finRowBorder]}>
              <Text style={s.finLabel}>{label}</Text>
              {skelStats ? <Sk h={18} w={80} r={4} /> : <Text style={[s.finVal, { color }]}>{val}</Text>}
            </View>
          ))}
        </View>

        {/* ── Tabla restaurantes ── */}
        <Text style={s.sectionTitle}>Top restaurantes (30 días)</Text>
        <View style={s.tableCard}>
          <View style={s.tableHeader}>
            <Text style={[s.thCell, { flex: 2 }]}>Restaurante</Text>
            <Text style={s.thCell}>Pedidos</Text>
            <Text style={s.thCell}>Ventas</Text>
            <Text style={s.thCell}>Comisión</Text>
          </View>
          {skelFin ? (
            [1,2,3].map(k => (
              <View key={k} style={s.tableRow}>
                <Sk h={14} w="60%" r={4} />
              </View>
            ))
          ) : resumen.length === 0 ? (
            <View style={{ padding: 20, alignItems: 'center' }}>
              <Text style={{ color: '#64748B', fontSize: 13 }}>Sin ventas en el período</Text>
            </View>
          ) : (
            resumen.slice(0, 10).map((r: any, i: number) => (
              <TouchableOpacity
                key={r.negocio_id}
                style={[s.tableRow, i % 2 === 0 && s.tableRowAlt]}
                onPress={() => router.push(`/admin/restaurante-detalle?id=${r.negocio_id}` as any)}
              >
                <View style={{ flex: 2 }}>
                  <Text style={s.tdName} numberOfLines={1}>{r.nombre}</Text>
                  {r.zona ? <Text style={s.tdZona}>{r.zona}</Text> : null}
                </View>
                <Text style={s.tdCell}>{r.pedidos}</Text>
                <Text style={[s.tdCell, { color: Colors.white }]}>Q{r.bruto.toFixed(0)}</Text>
                <Text style={[s.tdCell, { color: GOLD }]}>Q{r.comision.toFixed(0)}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* ── Métricas secundarias ── */}
        <Text style={s.sectionTitle}>Más métricas</Text>
        <View style={s.statsRow}>
          {skelStats ? (
            [1,2,3].map(k => <View key={k} style={s.statMini}><Sk h={16} w={50} r={4} /></View>)
          ) : [
            { label: 'Usuarios', val: stats?.total_usuarios || 0, color: Colors.orange },
            { label: 'Sin verificar', val: stats?.negocios_sin_verificar || 0, color: '#FCD34D' },
            { label: 'CO₂ ahorrado', val: `${(stats?.co2_total || 0).toFixed(1)} kg`, color: '#34D399' },
          ].map(({ label, val, color }) => (
            <View key={label} style={s.statMini}>
              <Text style={[s.statMiniVal, { color }]}>{val}</Text>
              <Text style={s.statMiniLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {/* ── Impacto ambiental ── */}
        {!skelStats && (
          <View style={s.impactCard}>
            <Text style={s.impactEmoji}>🌿</Text>
            <Text style={s.impactBig}>{stats?.pedidos_completados || 0}</Text>
            <Text style={s.impactLabel}>bolsas de comida rescatadas</Text>
            <Text style={s.impactSub}>≈ {((stats?.co2_total || 0) / 0.21).toFixed(0)} km de emisiones evitadas</Text>
          </View>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: DARK2 },
  header:      { flexDirection: 'row', alignItems: 'center', backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTag:   { color: GOLD, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { color: Colors.white, fontSize: 24, fontWeight: '900', marginTop: 2 },
  headerSub:   { color: '#22C55E', fontSize: 11, marginTop: 2 },
  logoutBtn:   { borderWidth: 1.5, borderColor: '#475569', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  logoutText:  { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  scroll:      { padding: 16 },

  alertCard:   { flexDirection: 'row', backgroundColor: '#451A03', borderWidth: 1, borderColor: '#92400E', borderRadius: 14, padding: 14, marginBottom: 16, alignItems: 'center' },
  alertTitle:  { fontSize: 14, fontWeight: '800', color: '#FDE68A' },
  alertSub:    { fontSize: 12, color: '#D97706', marginTop: 2 },

  sectionTitle: { fontSize: 11, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.8 },

  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  metricCard:  { flex: 1, minWidth: (SCREEN - 52) / 2, backgroundColor: DARK, borderRadius: 16, padding: 14, gap: 4, borderWidth: 1, borderColor: '#334155' },
  metricVal:   { fontSize: 22, fontWeight: '900' },
  metricLabel: { fontSize: 12, color: '#94A3B8', fontWeight: '600' },
  metricSub:   { fontSize: 10, color: '#475569' },

  chartCard:    { backgroundColor: DARK, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: '#334155' },
  chartCaption: { fontSize: 11, color: '#64748B', marginTop: 8, textAlign: 'right' },

  finCard:      { backgroundColor: DARK, borderRadius: 16, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: '#334155' },
  finRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14 },
  finRowBorder: { borderBottomWidth: 1, borderBottomColor: '#334155' },
  finLabel:     { fontSize: 13, color: '#94A3B8' },
  finVal:       { fontSize: 16, fontWeight: '800' },

  tableCard:   { backgroundColor: DARK, borderRadius: 16, marginBottom: 20, borderWidth: 1, borderColor: '#334155', overflow: 'hidden' },
  tableHeader: { flexDirection: 'row', padding: 10, borderBottomWidth: 1, borderBottomColor: '#334155', backgroundColor: '#253248' },
  thCell:      { flex: 1, fontSize: 10, color: '#64748B', fontWeight: '700', textTransform: 'uppercase', textAlign: 'center' },
  tableRow:    { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  tableRowAlt: { backgroundColor: '#0D1B2E' },
  tdName:      { fontSize: 13, fontWeight: '700', color: Colors.white },
  tdZona:      { fontSize: 10, color: '#64748B' },
  tdCell:      { flex: 1, fontSize: 12, color: '#94A3B8', textAlign: 'center' },

  statsRow:     { flexDirection: 'row', gap: 10, marginBottom: 20 },
  statMini:     { flex: 1, backgroundColor: DARK, borderRadius: 12, padding: 12, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: '#334155' },
  statMiniVal:  { fontSize: 18, fontWeight: '900' },
  statMiniLabel: { fontSize: 10, color: '#64748B', textAlign: 'center' },

  impactCard:  { backgroundColor: '#064E3B', borderRadius: 20, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#065F46', marginBottom: 8 },
  impactEmoji: { fontSize: 36, marginBottom: 4 },
  impactBig:   { fontSize: 52, fontWeight: '900', color: '#6EE7B7' },
  impactLabel: { fontSize: 16, fontWeight: '700', color: Colors.white, textAlign: 'center' },
  impactSub:   { fontSize: 13, color: '#34D399', marginTop: 4 },
});
