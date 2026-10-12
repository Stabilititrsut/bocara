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
const GOLD   = '#E8820C';
const GREEN  = '#22C55E';
const BLUE   = '#3B82F6';
const SCREEN = Dimensions.get('window').width;

// v4: la respuesta trae el desglose Tiempo Limitado / Promoción y se cachea por periodo.
const CACHE_STATS = 'bocara_admin_stats_v4';
const CACHE_FIN   = 'bocara_admin_fin_v4';

// "Resumen general" y "Resumen financiero" (GET /admin/stats?periodo=…).
type PeriodoGeneral = 'hoy' | 'semana' | 'mes' | 'todo';
const PERIODOS_GENERAL: { key: PeriodoGeneral; label: string; titulo: string }[] = [
  { key: 'hoy',    label: 'Hoy',    titulo: 'hoy' },
  { key: 'semana', label: 'Semana', titulo: 'últimos 7 días' },
  { key: 'mes',    label: 'Mes',    titulo: 'mes en curso' },
  { key: 'todo',   label: 'Todo',   titulo: 'histórico total' },
];

// "Top restaurantes" (GET /admin/financiero?periodo=…).
type PeriodoTop = 'hoy' | '7d' | '30d' | 'mes' | 'todo';
const PERIODOS_TOP: { key: PeriodoTop; label: string; titulo: string }[] = [
  { key: 'hoy',  label: 'Hoy',     titulo: 'hoy' },
  { key: '7d',   label: '7 días',  titulo: '7 días' },
  { key: '30d',  label: '30 días', titulo: '30 días' },
  { key: 'mes',  label: 'Mes',     titulo: 'mes en curso' },
  { key: 'todo', label: 'Todo',    titulo: 'histórico' },
];

const q = (v: number | null | undefined) => `Q${(v || 0).toFixed(2)}`;
const pct = (v: number | null | undefined, porDefecto: number) => `${v ?? porDefecto}%`;

function Chips<K extends string>({ opciones, valor, onChange }: {
  opciones: { key: K; label: string }[]; valor: K; onChange: (k: K) => void;
}) {
  return (
    <View style={s.chips}>
      {opciones.map(({ key, label }) => (
        <TouchableOpacity key={key} style={[s.chip, valor === key && s.chipActivo]} onPress={() => onChange(key)}>
          <Text style={[s.chipTexto, valor === key && s.chipTextoActivo]}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

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
            {d.value > 0 ? (d.value > 999 ? `Q${(d.value/1000).toFixed(1)}k` : `Q${d.value.toFixed(2)}`) : ''}
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
  const [comisionPct, setComisionPct] = useState(25);
  const [comisionPromoPct, setComisionPromoPct] = useState(20);
  const [periodoGeneral, setPeriodoGeneral] = useState<PeriodoGeneral>('todo');
  const [periodoTop, setPeriodoTop] = useState<PeriodoTop>('30d');
  const [skelStats,  setSkelStats]  = useState(true);
  const [skelFin,    setSkelFin]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollingRef = useRef<any>(null);
  // El polling corre fuera del ciclo de render: lee el periodo vigente de aquí.
  const periodoGeneralRef = useRef<PeriodoGeneral>('todo');
  const { logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    adminAPI.getConfig().then(res => {
      const pct = parseFloat(res.data?.comision_porcentaje);
      if (!isNaN(pct)) setComisionPct(pct);
      const pctPromo = parseFloat(res.data?.comision_promocion_porcentaje);
      if (!isNaN(pctPromo)) setComisionPromoPct(pctPromo);
    }).catch(() => {});
    pollingRef.current = setInterval(() => loadStats(periodoGeneralRef.current), 30000);
    return () => clearInterval(pollingRef.current);
  }, []);

  // Cada cambio de periodo: primero lo cacheado de ESE periodo (pinta al
  // instante), luego la respuesta fresca del servidor.
  useEffect(() => {
    periodoGeneralRef.current = periodoGeneral;
    AsyncStorage.getItem(`${CACHE_STATS}_${periodoGeneral}`).catch(() => null).then((sc) => {
      if (sc) { try { setStats(JSON.parse(sc)); setSkelStats(false); } catch {} }
      else setSkelStats(true);
    });
    loadStats(periodoGeneral);
  }, [periodoGeneral]);

  useEffect(() => {
    AsyncStorage.getItem(`${CACHE_FIN}_${periodoTop}`).catch(() => null).then((fc) => {
      if (fc) { try { setFinanciero(JSON.parse(fc)); setSkelFin(false); } catch {} }
      else setSkelFin(true);
    });
    const t = setTimeout(() => loadFinanciero(periodoTop), 400);
    return () => clearTimeout(t);
  }, [periodoTop]);

  async function loadStats(periodo: PeriodoGeneral) {
    try {
      const res = await adminAPI.stats(periodo);
      // Descarta respuestas de un periodo que el admin ya cambió.
      if (periodo !== periodoGeneralRef.current) return;
      setStats(res.data);
      setSkelStats(false);
      setLastUpdated(new Date());
      AsyncStorage.setItem(`${CACHE_STATS}_${periodo}`, JSON.stringify(res.data)).catch(() => {});
    } catch {}
  }

  async function loadFinanciero(periodo: PeriodoTop) {
    try {
      const [finRes, pedRes] = await Promise.all([
        adminAPI.financiero(periodo),
        adminAPI.pedidosTodos({ limite: 100 }),
      ]);
      setFinanciero(finRes.data);
      setPedidos(pedRes.data || []);
      setSkelFin(false);
      AsyncStorage.setItem(`${CACHE_FIN}_${periodo}`, JSON.stringify(finRes.data)).catch(() => {});
    } catch {}
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStats(periodoGeneral), loadFinanciero(periodoTop)]);
    setRefreshing(false);
  }, [periodoGeneral, periodoTop]);

  const comision         = stats?.comision_generada || 0; // total Bocara NETO: comisión 25% + cargo plataforma 3.5% − descuentos de cupón
  const totalCobrado     = stats?.ingresos_totales  || 0;
  const ventasBrutas     = stats?.ventas_brutas_productos ?? Math.max(0, totalCobrado - (stats?.propinas_totales || 0) - (stats?.cargo_plataforma || 0) + (stats?.descuentos_cupon || 0));
  const comisionBocaraQ  = stats?.comision_bocara   || 0;
  const cargoPlataforma  = stats?.cargo_plataforma  || 0;
  const propinas         = stats?.propinas_totales  || 0;
  const pagoRestaurantes = stats?.pago_restaurantes || 0; // 75% + propinas + envío
  const restaurante75    = pagoRestaurantes - propinas;   // solo la parte del 75% + envío, sin propina
  const descuentosCupon  = stats?.descuentos_cupon  || 0; // absorbido por Bocara, nunca por el restaurante
  const costosEnvio      = stats?.costos_envio      || 0;
  const comisionEsPerdida = comision < 0;
  // Desglose Tiempo Limitado (25%) / Promoción (20%) del backend. Si falta
  // (backend anterior), todo cae en Tiempo Limitado, la única tarifa de antes.
  const rf = stats?.resumen_financiero;
  const ventasTL     = rf?.ventas_tiempo_limitado   ?? ventasBrutas;
  const comisionTL   = rf?.comision_tiempo_limitado ?? comisionBocaraQ;
  const ventasPromo  = rf?.ventas_promocion         ?? 0;
  const comisionPromo = rf?.comision_promocion      ?? 0;
  const totalBocara  = rf?.total_bocara             ?? (comisionBocaraQ + cargoPlataforma);
  const pctTL    = pct(rf?.porcentaje_tiempo_limitado, comisionPct);
  const pctPromo = pct(rf?.porcentaje_promocion, comisionPromoPct);
  const tituloGeneral = PERIODOS_GENERAL.find(p => p.key === periodoGeneral)?.titulo;
  const tituloTop     = PERIODOS_TOP.find(p => p.key === periodoTop)?.titulo;
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

        {/* Métricas principales — el periodo filtra cobrado y comisiones (y el
            resumen financiero de abajo); restaurantes y pedidos siguen la misma regla. */}
        <Text style={s.sectionTitle}>Resumen general — {tituloGeneral}</Text>
        <Chips opciones={PERIODOS_GENERAL} valor={periodoGeneral} onChange={setPeriodoGeneral} />
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
            { label: 'Cobrado a clientes', val: `Q${totalCobrado.toFixed(2)}`, sub: tituloGeneral, color: TEXT, icon: 'trending-up' as any },
            { label: comisionEsPerdida ? 'Bocara: PÉRDIDA' : 'Comisión Bocara', val: `${comisionEsPerdida ? '-' : ''}Q${Math.abs(comision).toFixed(2)}`, sub: descuentosCupon > 0 ? `neto de -Q${descuentosCupon.toFixed(2)} en cupones` : `TL ${pctTL} · Promo ${pctPromo} + 3.5%`, color: comisionEsPerdida ? '#DC2626' : GOLD, icon: comisionEsPerdida ? 'alert-circle' : 'wallet' as any },
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
        <Text style={s.sectionTitle}>Cobrado a clientes — últimos 7 días</Text>
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
        <Text style={s.sectionTitle}>Resumen financiero — {tituloGeneral}</Text>
        <Text style={s.sectionCaption}>
          Mismo periodo que el resumen general. La tabla de abajo tiene su propio selector.
          Desglose separado: nunca mezclar lo que se queda Bocara con lo que recibe el restaurante.
        </Text>
        <View style={[card(), { marginBottom: 20 }]}>
          {[
            { label: 'Ventas Tiempo Limitado (producto)',     val: q(ventasTL),          color: TEXT  },
            { label: `Comisión Tiempo Limitado (${pctTL})`,   val: q(comisionTL),        color: GOLD  },
            { label: 'Ventas Promoción (producto)',           val: q(ventasPromo),       color: TEXT  },
            { label: `Comisión Promoción (${pctPromo})`,      val: q(comisionPromo),     color: GOLD  },
            { label: 'Cargo al cliente (3.5%)',               val: q(cargoPlataforma),   color: GOLD  },
            { label: 'Total Bocara (comisiones + 3.5%)',      val: q(totalBocara),       color: GOLD, bold: true },
            ...(descuentosCupon > 0 ? [
              { label: '— Descuentos de cupón (Bocara los absorbe)', val: `-Q${descuentosCupon.toFixed(2)}`, color: '#DC2626' },
              { label: comisionEsPerdida ? 'Total Bocara neto — PÉRDIDA' : 'Total Bocara neto de cupones', val: `${comisionEsPerdida ? '-' : ''}Q${Math.abs(comision).toFixed(2)}`, color: comisionEsPerdida ? '#DC2626' : GOLD, bold: true },
            ] : []),
            { label: '— Pago restaurantes (producto neto + envío)', val: q(restaurante75), color: GREEN },
            ...(costosEnvio > 0 ? [
              { label: '— Incluye envíos para restaurantes', val: `Q${costosEnvio.toFixed(2)}`, color: GREEN },
            ] : []),
            { label: '— Propinas (100% restaurante)',         val: `Q${propinas.toFixed(2)}`,          color: GREEN },
            { label: 'Total a restaurantes',                  val: `Q${pagoRestaurantes.toFixed(2)}`,  color: GREEN, bold: true },
            { label: 'Total cobrado a clientes',              val: `Q${totalCobrado.toFixed(2)}`,      color: TEXT, bold: true },
          ].map(({ label, val, color, bold }, i, arr) => (
            <View key={label} style={[s.finRow, i < arr.length - 1 && s.finRowBorder]}>
              <Text style={[s.finLabel, bold && { fontWeight: '800', color: TEXT }]}>{label}</Text>
              {skelStats ? <Sk h={16} w={80} r={4} /> : <Text style={[s.finVal, { color }, bold && { fontSize: 17 }]}>{val}</Text>}
            </View>
          ))}
        </View>

        {/* Tabla restaurantes */}
        <Text style={s.sectionTitle}>Top restaurantes — {tituloTop}</Text>
        <Chips opciones={PERIODOS_TOP} valor={periodoTop} onChange={setPeriodoTop} />
        <View style={[card(), { marginBottom: 20, overflow: 'hidden' }]}>
          {/* 9 columnas: scroll horizontal para que quepan en el teléfono. */}
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View style={s.tableHead}>
                <Text style={[s.th, s.colNombre]}>Restaurante</Text>
                <Text style={[s.th, s.colNum]}>Unid. TL</Text>
                <Text style={[s.th, s.colNum]}>Unid. Promo</Text>
                <Text style={[s.th, s.colMonto]}>Ventas TL</Text>
                <Text style={[s.th, s.colMonto]}>Ventas Promo</Text>
                <Text style={[s.th, s.colMonto]}>Com. TL ({pct(financiero?.porcentajes?.tiempo_limitado, comisionPct)})</Text>
                <Text style={[s.th, s.colMonto]}>Com. Promo ({pct(financiero?.porcentajes?.promocion, comisionPromoPct)})</Text>
                <Text style={[s.th, s.colMonto]}>Neto rest.</Text>
                <Text style={[s.th, s.colMonto]}>Total</Text>
              </View>
              {skelFin ? (
                [1,2,3].map(k => (
                  <View key={k} style={s.tableRow}>
                    <Sk h={14} w={300} r={4} />
                  </View>
                ))
              ) : resumen.length === 0 ? (
                <View style={{ padding: 24 }}>
                  <Text style={{ color: TEXT2, fontSize: 13 }}>Sin ventas en el período</Text>
                </View>
              ) : (
                resumen.slice(0, 10).map((r: any, i: number) => (
                  <TouchableOpacity
                    key={r.negocio_id}
                    style={[s.tableRow, i % 2 === 1 && { backgroundColor: '#F9FAFB' }]}
                    onPress={() => router.push(`/admin/restaurante-detalle?id=${r.negocio_id}` as any)}
                  >
                    <View style={s.colNombre}>
                      <Text style={s.tdName} numberOfLines={1}>{r.nombre}</Text>
                      <Text style={s.tdSub} numberOfLines={1}>{r.zona ? `${r.zona} · ` : ''}{r.pedidos} pedidos</Text>
                    </View>
                    <Text style={[s.td, s.colNum]}>{r.unidades_tiempo_limitado ?? '—'}</Text>
                    <Text style={[s.td, s.colNum]}>{r.unidades_promocion ?? '—'}</Text>
                    <Text style={[s.td, s.colMonto, { color: TEXT }]}>{q(r.ventas_tiempo_limitado ?? r.bruto)}</Text>
                    <Text style={[s.td, s.colMonto, { color: TEXT }]}>{q(r.ventas_promocion)}</Text>
                    <Text style={[s.td, s.colMonto, { color: GOLD, fontWeight: '700' }]}>{q(r.comision_bocara_tiempo_limitado ?? r.comisionBocara)}</Text>
                    <Text style={[s.td, s.colMonto, { color: GOLD, fontWeight: '700' }]}>{q(r.comision_bocara_promocion)}</Text>
                    <Text style={[s.td, s.colMonto, { color: GREEN, fontWeight: '700' }]}>{q(r.neto_restaurante ?? r.neto)}</Text>
                    <Text style={[s.td, s.colMonto, { color: TEXT, fontWeight: '700' }]}>{q(r.total ?? r.totalCobrado)}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>
          </ScrollView>
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
  sectionCaption: { fontSize: 11, color: TEXT2, marginTop: -6, marginBottom: 10, lineHeight: 15 },

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
  // Anchos fijos (no flex) dentro del scroll horizontal de Top restaurantes.
  colNombre:  { width: 150, flex: 0, textAlign: 'left' },
  colNum:     { width: 64, flex: 0 },
  colMonto:   { width: 96, flex: 0 },

  chips:          { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip:           { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: BORDER, backgroundColor: CARD },
  chipActivo:     { backgroundColor: GOLD, borderColor: GOLD },
  chipTexto:      { fontSize: 12, fontWeight: '600', color: TEXT2 },
  chipTextoActivo: { color: '#fff', fontWeight: '800' },

  statsRow:   { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statMini:   { flex: 1, padding: 12, alignItems: 'center', gap: 4 },
  statVal:    { fontSize: 18, fontWeight: '900' },
  statLabel:  { fontSize: 10, color: TEXT2, textAlign: 'center' },

  ecoCard:    { backgroundColor: '#F0FDF4', borderRadius: 16, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#BBF7D0', marginBottom: 8 },
  ecoBig:     { fontSize: 44, fontWeight: '900', color: '#166534' },
  ecoLabel:   { fontSize: 14, fontWeight: '600', color: '#15803D' },
});
