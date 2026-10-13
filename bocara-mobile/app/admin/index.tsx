import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import MonitorPedidos from '@/components/MonitorPedidos';
import SelectorPeriodo, {
  mesEnCurso, tituloPeriodo, mesParam, clavePeriodo, type SeleccionPeriodo,
} from '@/components/SelectorPeriodo';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';
const GREEN  = '#22C55E';
const BLUE   = '#3B82F6';
const SCREEN = Dimensions.get('window').width;

// v5: stats trae serie_cobrado (gráfico) y ambos se cachean por periodo + mes.
const CACHE_STATS = 'bocara_admin_stats_v5';
const CACHE_FIN   = 'bocara_admin_fin_v5';

// "Resumen general", gráfico "Cobrado a clientes" y "Resumen financiero" comparten
// periodo (GET /admin/stats); "Top restaurantes" tiene el suyo (GET /admin/financiero).
// Ambos: Hoy · 7 días · 30 días · Mes (con meses históricos) · Todo.

const q = (v: number | null | undefined) => `Q${(v || 0).toFixed(2)}`;

// Columnas de "Top restaurantes": ancho FIJO por columna (mismo valor en
// encabezado y filas, así nunca se desalinean) y sin `flex` — en
// react-native-web, `flex: 1` deja flexBasis 0% y las columnas colapsaban a
// ancho 0, encimando todos los textos. Suman 950; la tabla mide al menos
// ANCHO_MIN_TABLA y lo que sobra se lo lleva la columna Restaurante.
type AlineacionCol = 'left' | 'center' | 'right';
const COL_TOP = {
  nombre:   { ancho: 180, align: 'left' as AlineacionCol },
  unidades: { ancho: 70,  align: 'center' as AlineacionCol },
  ventas:   { ancho: 85,  align: 'right' as AlineacionCol },
  comision: { ancho: 90,  align: 'right' as AlineacionCol },
  neto:     { ancho: 90,  align: 'right' as AlineacionCol },
  comTotal: { ancho: 100, align: 'right' as AlineacionCol },
  total:    { ancho: 90,  align: 'right' as AlineacionCol },
};
const ANCHO_MIN_TABLA = 1000;

function Celda({ col, children, encabezado, crecer, estilo }: {
  col: { ancho: number; align: AlineacionCol };
  children: ReactNode;
  encabezado?: boolean;
  crecer?: boolean;
  estilo?: any;
}) {
  return (
    <View style={[s.celda, { width: col.ancho, minWidth: col.ancho }, crecer && { flexGrow: 1 }]}>
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text
          style={[encabezado ? s.thTexto : s.tdTexto, { textAlign: col.align }, estilo]}
          numberOfLines={encabezado ? 2 : 1}
        >
          {children}
        </Text>
      ) : children}
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

function BarChart({ data }: { data: { key: string; label: string; value: number }[] }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const denso = data.length > 12;
  const cadaN = denso ? Math.ceil(data.length / 8) : 1;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: denso ? 2 : 6 }}>
      {data.map((d, i) => (
        <View key={d.key} style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ fontSize: 8, color: TEXT2, marginBottom: 2, textAlign: 'center' }} numberOfLines={1}>
            {!denso && d.value > 0 ? (d.value > 999 ? `Q${(d.value/1000).toFixed(1)}k` : `Q${d.value.toFixed(2)}`) : ''}
          </Text>
          <View style={{ width: '100%', height: 80, justifyContent: 'flex-end' }}>
            <View style={{
              width: '100%',
              height: max > 0 ? Math.max((d.value / max) * 76, d.value > 0 ? 4 : 0) : 0,
              backgroundColor: GOLD,
              borderRadius: 4,
            }} />
          </View>
          <Text style={{ fontSize: 9, color: TEXT2, marginTop: 4, textAlign: 'center' }} numberOfLines={1}>
            {i % cadaN === 0 || i === data.length - 1 ? d.label : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export default function AdminDashboard() {
  const [stats,      setStats]      = useState<any>(null);
  const [financiero, setFinanciero] = useState<any>(null);
  const [comisionPct, setComisionPct] = useState(25);
  const [comisionPromoPct, setComisionPromoPct] = useState(20);
  const [periodoGeneral, setPeriodoGeneral] = useState<SeleccionPeriodo>(() => ({ periodo: 'todo', mes: mesEnCurso() }));
  const [periodoTop, setPeriodoTop] = useState<SeleccionPeriodo>(() => ({ periodo: '30d', mes: mesEnCurso() }));
  const [skelStats,  setSkelStats]  = useState(true);
  const [skelFin,    setSkelFin]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pollingRef = useRef<any>(null);
  // El polling corre fuera del ciclo de render: lee el periodo vigente de aquí.
  const periodoGeneralRef = useRef<SeleccionPeriodo>(periodoGeneral);
  const periodoTopRef = useRef<SeleccionPeriodo>(periodoTop);
  const claveGeneral = clavePeriodo(periodoGeneral);
  const claveTop = clavePeriodo(periodoTop);
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
    AsyncStorage.getItem(`${CACHE_STATS}_${claveGeneral}`).catch(() => null).then((sc) => {
      if (sc) { try { setStats(JSON.parse(sc)); setSkelStats(false); } catch {} }
      else setSkelStats(true);
    });
    loadStats(periodoGeneral);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveGeneral]);

  useEffect(() => {
    periodoTopRef.current = periodoTop;
    AsyncStorage.getItem(`${CACHE_FIN}_${claveTop}`).catch(() => null).then((fc) => {
      if (fc) { try { setFinanciero(JSON.parse(fc)); setSkelFin(false); } catch {} }
      else setSkelFin(true);
    });
    const t = setTimeout(() => loadFinanciero(periodoTop), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveTop]);

  async function loadStats(sel: SeleccionPeriodo) {
    try {
      const res = await adminAPI.stats(sel.periodo, mesParam(sel));
      // Descarta respuestas de un periodo que el admin ya cambió.
      if (clavePeriodo(sel) !== clavePeriodo(periodoGeneralRef.current)) return;
      setStats(res.data);
      setSkelStats(false);
      setLastUpdated(new Date());
      AsyncStorage.setItem(`${CACHE_STATS}_${clavePeriodo(sel)}`, JSON.stringify(res.data)).catch(() => {});
    } catch {}
  }

  async function loadFinanciero(sel: SeleccionPeriodo) {
    try {
      const finRes = await adminAPI.financiero(sel.periodo, mesParam(sel));
      if (clavePeriodo(sel) !== clavePeriodo(periodoTopRef.current)) return;
      setFinanciero(finRes.data);
      setSkelFin(false);
      AsyncStorage.setItem(`${CACHE_FIN}_${clavePeriodo(sel)}`, JSON.stringify(finRes.data)).catch(() => {});
    } catch {}
  }

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStats(periodoGeneral), loadFinanciero(periodoTop)]);
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveGeneral, claveTop]);

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
  // Las etiquetas muestran la TARIFA configurada (25% / 20%), no el %
  // efectivo de los datos: promociones vendidas antes de existir la tarifa
  // del 20% se cobraron al 25% y hacían decir "Promo (25%)" a la etiqueta.
  const pctTL    = `${comisionPct}%`;
  const pctPromo = `${comisionPromoPct}%`;
  const tituloGeneral = tituloPeriodo(periodoGeneral);
  const tituloTop     = tituloPeriodo(periodoTop);
  const resumen   = financiero?.resumen || [];
  const totalesTop = financiero?.totales;
  // Serie del mismo periodo que las tarjetas (GET /admin/stats → serie_cobrado).
  const chartData = ((stats?.serie_cobrado || []) as { clave: string; etiqueta: string; valor: number }[])
    .map((d) => ({ key: d.clave, label: d.etiqueta, value: d.valor }));
  // Comisión Bocara de una fila (o de los totales) de Top: TL (25%) + Promo (20%).
  const comisionTotalTop = (r: any) => r?.comision_bocara_tiempo_limitado != null
    ? (r.comision_bocara_tiempo_limitado || 0) + (r.comision_bocara_promocion || 0)
    : (r?.comisionBocara || 0);

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

        {/* Monitor operativo en vivo: pedidos en curso con semáforo de tiempo. */}
        <MonitorPedidos />

        {/* Métricas principales — el periodo filtra cobrado y comisiones (y el
            resumen financiero de abajo); restaurantes y pedidos siguen la misma regla. */}
        <Text style={s.sectionTitle}>Resumen general — {tituloGeneral}</Text>
        <SelectorPeriodo valor={periodoGeneral} onChange={setPeriodoGeneral} />
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
        <Text style={s.sectionTitle}>Cobrado a clientes — {tituloGeneral}</Text>
        <View style={[card(), s.chartCard]}>
          {skelStats
            ? <Sk h={120} r={8} />
            : <>
                {chartData.length > 0
                  ? <BarChart data={chartData} />
                  : <Text style={{ color: TEXT2, fontSize: 12 }}>Sin datos de gráfico para este periodo.</Text>}
                <Text style={s.chartCaption}>Total {tituloGeneral}: {q(totalCobrado)}</Text>
              </>
          }
        </View>

        {/* Resumen financiero */}
        <Text style={s.sectionTitle}>Resumen financiero — {tituloGeneral}</Text>
        <Text style={s.sectionCaption}>
          Mismo periodo que el resumen general y el gráfico. La tabla de abajo tiene su propio selector.
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

        {/* Tabla restaurantes (top 10 + totales de todos los del periodo) */}
        <Text style={s.sectionTitle}>Top restaurantes — {tituloTop}</Text>
        <SelectorPeriodo valor={periodoTop} onChange={setPeriodoTop} />
        <View style={[card(), { marginBottom: 20, overflow: 'hidden' }]}>
          {/* 10 columnas: scroll horizontal para que quepan en el teléfono. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={true} contentContainerStyle={{ minWidth: ANCHO_MIN_TABLA }}>
            <View style={{ minWidth: ANCHO_MIN_TABLA, flexGrow: 1 }}>
              <View style={s.tablaFilaHead}>
                <Celda col={COL_TOP.nombre} encabezado crecer>Restaurante</Celda>
                <Celda col={COL_TOP.unidades} encabezado>Unid. TL</Celda>
                <Celda col={COL_TOP.unidades} encabezado>Unid. Promo</Celda>
                <Celda col={COL_TOP.ventas} encabezado>Ventas TL</Celda>
                <Celda col={COL_TOP.ventas} encabezado>Ventas Promo</Celda>
                <Celda col={COL_TOP.comision} encabezado>{`Com. TL (${pctTL})`}</Celda>
                <Celda col={COL_TOP.comision} encabezado>{`Com. Promo (${pctPromo})`}</Celda>
                <Celda col={COL_TOP.comTotal} encabezado>Comisión Total Bocara</Celda>
                <Celda col={COL_TOP.neto} encabezado>Neto Rest.</Celda>
                <Celda col={COL_TOP.total} encabezado>Total</Celda>
              </View>
              {skelFin ? (
                [1,2,3].map(k => (
                  <View key={k} style={[s.tablaFila, { paddingHorizontal: 8, paddingVertical: 12 }]}>
                    <Sk h={14} w={ANCHO_MIN_TABLA - 40} r={4} />
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
                    style={[s.tablaFila, i % 2 === 1 && { backgroundColor: '#F9FAFB' }]}
                    onPress={() => router.push(`/admin/restaurante-detalle?id=${r.negocio_id}` as any)}
                  >
                    <Celda col={COL_TOP.nombre} crecer>
                      <Text style={s.tdName} numberOfLines={1}>{r.nombre}</Text>
                      <Text style={s.tdSub} numberOfLines={1}>{r.zona ? `${r.zona} · ` : ''}{r.pedidos} pedidos</Text>
                    </Celda>
                    <Celda col={COL_TOP.unidades}>{String(r.unidades_tiempo_limitado ?? '—')}</Celda>
                    <Celda col={COL_TOP.unidades}>{String(r.unidades_promocion ?? '—')}</Celda>
                    <Celda col={COL_TOP.ventas} estilo={{ color: TEXT }}>{q(r.ventas_tiempo_limitado ?? r.bruto)}</Celda>
                    <Celda col={COL_TOP.ventas} estilo={{ color: TEXT }}>{q(r.ventas_promocion)}</Celda>
                    <Celda col={COL_TOP.comision} estilo={{ color: GOLD, fontWeight: '700' }}>{q(r.comision_bocara_tiempo_limitado ?? r.comisionBocara)}</Celda>
                    <Celda col={COL_TOP.comision} estilo={{ color: GOLD, fontWeight: '700' }}>{q(r.comision_bocara_promocion)}</Celda>
                    <Celda col={COL_TOP.comTotal} estilo={{ color: GOLD, fontWeight: '900' }}>{q(comisionTotalTop(r))}</Celda>
                    <Celda col={COL_TOP.neto} estilo={{ color: GREEN, fontWeight: '700' }}>{q(r.neto_restaurante ?? r.neto)}</Celda>
                    <Celda col={COL_TOP.total} estilo={{ color: TEXT, fontWeight: '700' }}>{q(r.total ?? r.totalCobrado)}</Celda>
                  </TouchableOpacity>
                ))
              )}
              {!skelFin && resumen.length > 0 && totalesTop && (
                <View style={[s.tablaFila, { backgroundColor: '#FFF7ED', borderBottomWidth: 0 }]}>
                  <Celda col={COL_TOP.nombre} crecer>
                    <Text style={s.tdName}>Total ({resumen.length} restaurante{resumen.length !== 1 ? 's' : ''})</Text>
                  </Celda>
                  <Celda col={COL_TOP.unidades} estilo={{ fontWeight: '700' }}>{String(totalesTop.unidades_tiempo_limitado ?? '—')}</Celda>
                  <Celda col={COL_TOP.unidades} estilo={{ fontWeight: '700' }}>{String(totalesTop.unidades_promocion ?? '—')}</Celda>
                  <Celda col={COL_TOP.ventas} estilo={{ color: TEXT, fontWeight: '700' }}>{q(totalesTop.ventas_tiempo_limitado ?? totalesTop.bruto)}</Celda>
                  <Celda col={COL_TOP.ventas} estilo={{ color: TEXT, fontWeight: '700' }}>{q(totalesTop.ventas_promocion)}</Celda>
                  <Celda col={COL_TOP.comision} estilo={{ color: GOLD, fontWeight: '800' }}>{q(totalesTop.comision_bocara_tiempo_limitado ?? totalesTop.comisionBocara)}</Celda>
                  <Celda col={COL_TOP.comision} estilo={{ color: GOLD, fontWeight: '800' }}>{q(totalesTop.comision_bocara_promocion)}</Celda>
                  <Celda col={COL_TOP.comTotal} estilo={{ color: GOLD, fontWeight: '900' }}>{q(comisionTotalTop(totalesTop))}</Celda>
                  <Celda col={COL_TOP.neto} estilo={{ color: GREEN, fontWeight: '800' }}>{q(totalesTop.neto_restaurante ?? totalesTop.neto)}</Celda>
                  <Celda col={COL_TOP.total} estilo={{ color: TEXT, fontWeight: '800' }}>{q(totalesTop.total ?? totalesTop.totalCobrado)}</Celda>
                </View>
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

  tdName:     { fontSize: 13, fontWeight: '700', color: TEXT },
  tdSub:      { fontSize: 10, color: TEXT2 },
  // Tabla de Top restaurantes (anchos por columna en COL_TOP; sin flex).
  tablaFilaHead: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: BORDER, backgroundColor: '#F9FAFB' },
  tablaFila:     { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: BORDER },
  celda:         { flexShrink: 0, flexGrow: 0, paddingHorizontal: 8, paddingVertical: 10, justifyContent: 'center' },
  thTexto:       { fontSize: 10, color: TEXT2, fontWeight: '700', textTransform: 'uppercase' },
  tdTexto:       { fontSize: 12, color: TEXT2, fontVariant: ['tabular-nums'] },

  statsRow:   { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statMini:   { flex: 1, padding: 12, alignItems: 'center', gap: 4 },
  statVal:    { fontSize: 18, fontWeight: '900' },
  statLabel:  { fontSize: 10, color: TEXT2, textAlign: 'center' },

  ecoCard:    { backgroundColor: '#F0FDF4', borderRadius: 16, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#BBF7D0', marginBottom: 8 },
  ecoBig:     { fontSize: 44, fontWeight: '900', color: '#166534' },
  ecoLabel:   { fontSize: 14, fontWeight: '600', color: '#15803D' },
});
