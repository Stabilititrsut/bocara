import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import CalendarioPicker from '@/components/CalendarioPicker';
import { hoyGuatemala } from '@/src/utils/horarioRecogida';

// Historial OPERATIVO de pedidos: código, producto, fecha/hora y estado.
// Sin montos — ingresos, comisiones y pagos viven solo en /restaurante/ganancias,
// así las dos pantallas no pueden mostrar cifras que no cuadren entre sí.

// Guatemala no usa horario de verano: UTC−6 todo el año.
const OFFSET_GUATEMALA_MS = 6 * 60 * 60 * 1000;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// { dia: 'YYYY-MM-DD', hora: 'HH:MM' } en hora de Guatemala, o null.
function instanteGuatemala(iso?: string | null): { dia: string; hora: string } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const local = new Date(t - OFFSET_GUATEMALA_MS).toISOString();
  return { dia: local.slice(0, 10), hora: local.slice(11, 16) };
}

function etiquetaDia(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  return `${d} de ${MESES[m - 1] || ''} de ${a}`;
}

const ESTADO_LABELS: Record<string, string> = {
  pendiente: 'Pendiente', pagado: 'Pagado', confirmado: 'Confirmado', en_preparacion: 'En preparación',
  listo: 'Listo para recoger', completado: 'Recogido', recogido: 'Recogido', cancelado: 'Cancelado',
};
const ESTADO_COLORS: Record<string, string> = {
  pendiente: '#9CA3AF', pagado: '#E8820C', confirmado: '#E8820C', en_preparacion: '#7C3AED',
  listo: '#16A34A', completado: '#4B5563', recogido: '#4B5563', cancelado: '#DC2626',
};

// Nombre del producto: la bolsa principal, más cuántos productos adicionales
// trae el pedido (pedidos con varios items en snapshot_financiero.lineas).
function productoDe(p: any): string {
  const nombre = p.bolsas?.nombre || 'Producto';
  const lineas = Array.isArray(p.snapshot_financiero?.lineas) ? p.snapshot_financiero.lineas : [];
  const unidades = lineas.length > 0
    ? lineas.reduce((s: number, l: any) => s + (Number(l.cantidad) || 0), 0)
    : Math.max(1, Number(p.cantidad) || 1);
  const extra = lineas.length > 1 ? ` + ${lineas.length - 1} producto${lineas.length - 1 !== 1 ? 's' : ''} más` : '';
  return `${nombre}${extra}${unidades > 1 ? ` · ${unidades} unid.` : ''}`;
}

type Grupo = { dia: string; pedidos: any[] };

// Agrupa por día (hora de Guatemala), del más reciente al más antiguo.
function agruparPorDia(pedidos: any[]): Grupo[] {
  const map = new Map<string, any[]>();
  for (const p of pedidos) {
    const dia = instanteGuatemala(p.created_at || p.creado_en)?.dia || 'sin-fecha';
    if (!map.has(dia)) map.set(dia, []);
    map.get(dia)!.push(p);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([dia, items]) => ({
      dia,
      pedidos: items.sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || ''))),
    }));
}

// 'mes' consulta al backend un mes calendario completo (hora de Guatemala,
// GET /pedidos/restaurante?mes=AAAA-MM); los demás filtran la lista completa.
type Periodo = '7d' | '30d' | 'mes' | 'todo';

const ETIQUETA_PERIODO: Record<Periodo, string> = {
  '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', mes: 'Por mes', todo: 'Todo',
};

export default function HistorialRestauranteScreen() {
  const router = useRouter();
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>('7d');
  const mesActual = hoyGuatemala().slice(0, 7);
  const [mes, setMes] = useState(mesActual);
  const [cargandoMes, setCargandoMes] = useState(false);
  const consulta = useRef(0);
  const porMes = periodo === 'mes';

  const cargar = useCallback(async () => {
    const id = ++consulta.current;
    try {
      const res = await pedidosAPI.restaurante(porMes ? { mes } : undefined);
      if (id !== consulta.current) return; // llegó un cambio de mes/periodo más nuevo
      // Con ?mes= el backend responde { mes, pedidos }; sin él, la lista directa.
      setPedidos(porMes ? (res.data?.pedidos || []) : (res.data || []));
    } catch { } finally {
      if (id === consulta.current) { setLoading(false); setRefreshing(false); setCargandoMes(false); }
    }
  }, [porMes, mes]);

  useEffect(() => { cargar(); }, [cargar]);

  function filtrarPorPeriodo(todos: any[]) {
    if (periodo === 'todo' || periodo === 'mes') return todos;
    const dias = periodo === '7d' ? 7 : 30;
    const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
    return todos.filter((p: any) => new Date(p.created_at || p.creado_en || 0).getTime() >= corte);
  }

  const filtrados = filtrarPorPeriodo(pedidos);
  const grupos = agruparPorDia(filtrados);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        {/* Historial es una pestaña oculta (sin ícono en la barra): este es su camino de vuelta. */}
        <TouchableOpacity
          onPress={() => router.push('/restaurante/pedidos' as any)}
          style={s.volverBtn}
          accessibilityRole="button"
          accessibilityLabel="Volver a Pedidos"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={s.volverText}>‹ Volver a Pedidos</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>📋 Historial de pedidos</Text>
        <Text style={s.headerSub}>Tus ingresos y pagos están en Ganancias.</Text>
      </View>

      {/* Filtros de período */}
      <View style={s.periodos}>
        {(['7d', '30d', 'mes', 'todo'] as Periodo[]).map((p) => (
          <TouchableOpacity
            key={p}
            style={[s.periodoChip, periodo === p && s.periodoActive]}
            onPress={() => { if (p !== periodo) { setCargandoMes(p === 'mes' || periodo === 'mes'); setPeriodo(p); } }}
          >
            <Text style={[s.periodoText, periodo === p && s.periodoTextActive]}>{ETIQUETA_PERIODO[p]}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {porMes && (
        <View style={s.selectorMes}>
          <CalendarioPicker
            label="Mes a consultar"
            modo="mes"
            value={mes}
            maxDate={mesActual}
            onChange={(m) => { if (m !== mes) { setCargandoMes(true); setMes(m); } }}
          />
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {cargandoMes && <ActivityIndicator color={Colors.orange} style={{ marginBottom: 12 }} />}

        {filtrados.length > 0 && (
          <Text style={s.conteo}>{filtrados.length} pedido{filtrados.length !== 1 ? 's' : ''} en el período</Text>
        )}

        {filtrados.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>📋</Text>
            <Text style={s.emptyText}>No hay pedidos en este período</Text>
          </View>
        )}

        {grupos.map((g) => (
          <View key={g.dia} style={s.grupoCard}>
            <View style={s.grupoHeader}>
              <Text style={s.grupoFecha}>{g.dia === 'sin-fecha' ? 'Sin fecha' : etiquetaDia(g.dia)}</Text>
              <Text style={s.grupoCount}>{g.pedidos.length} pedido{g.pedidos.length !== 1 ? 's' : ''}</Text>
            </View>
            {g.pedidos.map((p: any, i: number) => {
              const color = ESTADO_COLORS[p.estado] || '#6B7280';
              return (
                <View key={p.id} style={[s.pedidoRow, i < g.pedidos.length - 1 && s.pedidoRowBorder]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.pedidoCodigo}>{p.codigo_recogida || '—'}</Text>
                    <Text style={s.pedidoProducto} numberOfLines={2}>{productoDe(p)}</Text>
                  </View>
                  <View style={s.pedidoDerecha}>
                    <Text style={s.pedidoHora}>{instanteGuatemala(p.created_at || p.creado_en)?.hora || '—'}</Text>
                    <View style={[s.estadoBadge, { backgroundColor: `${color}1A`, borderColor: `${color}55` }]}>
                      <Text style={[s.estadoText, { color }]}>{ESTADO_LABELS[p.estado] || p.estado || '—'}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        ))}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  headerSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  volverBtn: { alignSelf: 'flex-start', marginBottom: 6 },
  volverText: { fontSize: 14, fontWeight: '700', color: Colors.orange },
  periodos: { flexDirection: 'row', padding: 12, gap: 8, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  selectorMes: { paddingHorizontal: 12, paddingBottom: 12, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  periodoChip: { flex: 1, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center', backgroundColor: Colors.background },
  periodoActive: { backgroundColor: Colors.brown, borderColor: Colors.brown },
  periodoText: { fontSize: 12, fontWeight: '600', color: Colors.textSecondary },
  periodoTextActive: { color: Colors.white, fontWeight: '800' },
  scroll: { padding: 14 },
  conteo: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600', marginBottom: 10 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  grupoCard: { backgroundColor: Colors.white, borderRadius: 16, marginBottom: 10, elevation: 2, overflow: 'hidden' },
  grupoHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, backgroundColor: Colors.brownLight },
  grupoFecha: { fontSize: 14, fontWeight: '800', color: Colors.brown },
  grupoCount: { fontSize: 12, color: Colors.textSecondary },
  pedidoRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  pedidoRowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  pedidoCodigo: { fontSize: 14, fontWeight: '800', color: Colors.brown, letterSpacing: 1 },
  pedidoProducto: { fontSize: 12, color: Colors.textSecondary, marginTop: 1 },
  pedidoDerecha: { alignItems: 'flex-end', gap: 4 },
  pedidoHora: { fontSize: 13, fontWeight: '700', color: Colors.brown, fontVariant: ['tabular-nums'] },
  estadoBadge: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  estadoText: { fontSize: 11, fontWeight: '700' },
});
