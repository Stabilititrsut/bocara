import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const COMISION = 0.25;

type PedidoGrupo = {
  fecha: string;
  pedidos: any[];
  bruto: number;
  comision: number;
  neto: number;
};

function agruparPorFecha(pedidos: any[]): PedidoGrupo[] {
  const map: Record<string, any[]> = {};
  for (const p of pedidos) {
    const raw = p.created_at || p.creado_en || '';
    const fecha = raw ? new Date(raw).toLocaleDateString('es-GT', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Sin fecha';
    if (!map[fecha]) map[fecha] = [];
    map[fecha].push(p);
  }
  return Object.entries(map).map(([fecha, items]) => {
    const bruto = items.reduce((s, p) => s + (p.total || 0), 0);
    return {
      fecha,
      pedidos: items,
      bruto,
      comision: bruto * COMISION,
      neto: bruto * (1 - COMISION),
    };
  });
}

type Periodo = '7d' | '30d' | 'todo';

export default function HistorialRestauranteScreen() {
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>('7d');
  const [expandido, setExpandido] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await pedidosAPI.restaurante();
      const completados = (res.data || []).filter((p: any) => p.estado === 'recogido');
      setPedidos(completados);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function filtrarPorPeriodo(todos: any[]) {
    if (periodo === 'todo') return todos;
    const dias = periodo === '7d' ? 7 : 30;
    const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
    return todos.filter((p: any) => {
      const t = new Date(p.created_at || p.creado_en || 0).getTime();
      return t >= corte;
    });
  }

  const filtrados = filtrarPorPeriodo(pedidos);
  const grupos = agruparPorFecha(filtrados);

  const totalBruto = filtrados.reduce((s, p) => s + (p.total || 0), 0);
  const totalComision = totalBruto * COMISION;
  const totalNeto = totalBruto * (1 - COMISION);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>💰 Historial</Text>
      </View>

      {/* Filtros de período */}
      <View style={s.periodos}>
        {(['7d', '30d', 'todo'] as Periodo[]).map((p) => (
          <TouchableOpacity
            key={p}
            style={[s.periodoChip, periodo === p && s.periodoActive]}
            onPress={() => setPeriodo(p)}
          >
            <Text style={[s.periodoText, periodo === p && s.periodoTextActive]}>
              {p === '7d' ? 'Últimos 7 días' : p === '30d' ? 'Últimos 30 días' : 'Todo'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {/* Resumen total */}
        <View style={s.resumenCard}>
          <Text style={s.resumenTitle}>Resumen del período</Text>
          <View style={s.resumenGrid}>
            <View style={s.resumenItem}>
              <Text style={s.resumenEmoji}>📦</Text>
              <Text style={s.resumenVal}>{filtrados.length}</Text>
              <Text style={s.resumenLabel}>Pedidos entregados</Text>
            </View>
            <View style={s.resumenItem}>
              <Text style={s.resumenEmoji}>💵</Text>
              <Text style={[s.resumenVal, { color: Colors.textSecondary }]}>Q{totalBruto.toFixed(2)}</Text>
              <Text style={s.resumenLabel}>Ventas brutas</Text>
            </View>
            <View style={s.resumenItem}>
              <Text style={s.resumenEmoji}>🤝</Text>
              <Text style={[s.resumenVal, { color: Colors.error }]}>-Q{totalComision.toFixed(2)}</Text>
              <Text style={s.resumenLabel}>Comisión Bocara (25%)</Text>
            </View>
            <View style={[s.resumenItem, s.resumenItemNeto]}>
              <Text style={s.resumenEmoji}>✅</Text>
              <Text style={[s.resumenVal, { color: Colors.green, fontSize: 22 }]}>Q{totalNeto.toFixed(2)}</Text>
              <Text style={s.resumenLabel}>Tu ganancia neta</Text>
            </View>
          </View>
        </View>

        {filtrados.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>📊</Text>
            <Text style={s.emptyText}>No hay ventas completadas en este período</Text>
          </View>
        )}

        {/* Grupos por día */}
        {grupos.map((g) => (
          <View key={g.fecha} style={s.grupoCard}>
            <TouchableOpacity style={s.grupoHeader} onPress={() => setExpandido(expandido === g.fecha ? null : g.fecha)}>
              <View style={{ flex: 1 }}>
                <Text style={s.grupoFecha}>{g.fecha}</Text>
                <Text style={s.grupoCount}>{g.pedidos.length} pedido{g.pedidos.length !== 1 ? 's' : ''}</Text>
              </View>
              <View style={s.grupoTotales}>
                <Text style={s.grupoNeto}>Q{g.neto.toFixed(2)}</Text>
                <Text style={s.grupoComision}>-Q{g.comision.toFixed(2)} comisión</Text>
              </View>
              <Text style={s.chevron}>{expandido === g.fecha ? '▲' : '▼'}</Text>
            </TouchableOpacity>

            {expandido === g.fecha && (
              <View style={s.pedidosLista}>
                {g.pedidos.map((p: any, i: number) => (
                  <View key={p.id} style={[s.pedidoRow, i < g.pedidos.length - 1 && s.pedidoRowBorder]}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.pedidoCodigo}>{p.codigo_recogida}</Text>
                      <Text style={s.pedidoBolsa}>{p.bolsas?.nombre || '—'}</Text>
                    </View>
                    <View style={s.pedidoMontos}>
                      <Text style={s.pedidoBruto}>Q{(p.total || 0).toFixed(2)}</Text>
                      <Text style={s.pedidoNeto}>→ Q{((p.total || 0) * (1 - COMISION)).toFixed(2)}</Text>
                    </View>
                  </View>
                ))}

                {/* Subtotal del día */}
                <View style={s.subtotalRow}>
                  <View style={s.subtotalItem}>
                    <Text style={s.subtotalLabel}>Bruto</Text>
                    <Text style={s.subtotalVal}>Q{g.bruto.toFixed(2)}</Text>
                  </View>
                  <View style={s.subtotalItem}>
                    <Text style={s.subtotalLabel}>Comisión</Text>
                    <Text style={[s.subtotalVal, { color: Colors.error }]}>-Q{g.comision.toFixed(2)}</Text>
                  </View>
                  <View style={s.subtotalItem}>
                    <Text style={s.subtotalLabel}>Tu ganancia</Text>
                    <Text style={[s.subtotalVal, { color: Colors.green }]}>Q{g.neto.toFixed(2)}</Text>
                  </View>
                </View>
              </View>
            )}
          </View>
        ))}

        {/* Nota comisión */}
        {filtrados.length > 0 && (
          <View style={s.notaCard}>
            <Text style={s.notaTitle}>ℹ️ Sobre la comisión Bocara</Text>
            <Text style={s.notaText}>
              Bocara retiene el 25% de cada venta como comisión por el servicio de plataforma,
              visibilidad y gestión de pagos. El 75% restante es tuyo.
            </Text>
          </View>
        )}

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
  periodos: { flexDirection: 'row', padding: 12, gap: 8, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  periodoChip: { flex: 1, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center', backgroundColor: Colors.background },
  periodoActive: { backgroundColor: Colors.brown, borderColor: Colors.brown },
  periodoText: { fontSize: 12, fontWeight: '600', color: Colors.textSecondary },
  periodoTextActive: { color: Colors.white, fontWeight: '800' },
  scroll: { padding: 14 },
  resumenCard: { backgroundColor: Colors.brown, borderRadius: 20, padding: 20, marginBottom: 16 },
  resumenTitle: { fontSize: 16, fontWeight: '800', color: Colors.white, marginBottom: 16 },
  resumenGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  resumenItem: { flex: 1, minWidth: '45%', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, padding: 12, alignItems: 'center', gap: 4 },
  resumenItemNeto: { backgroundColor: 'rgba(91,165,32,0.25)', borderWidth: 1.5, borderColor: Colors.green },
  resumenEmoji: { fontSize: 24 },
  resumenVal: { fontSize: 18, fontWeight: '900', color: Colors.white },
  resumenLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  grupoCard: { backgroundColor: Colors.white, borderRadius: 16, marginBottom: 10, elevation: 2, overflow: 'hidden' },
  grupoHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 8 },
  grupoFecha: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  grupoCount: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  grupoTotales: { alignItems: 'flex-end' },
  grupoNeto: { fontSize: 18, fontWeight: '900', color: Colors.green },
  grupoComision: { fontSize: 11, color: Colors.error, marginTop: 2 },
  chevron: { fontSize: 12, color: Colors.textLight, marginLeft: 4 },
  pedidosLista: { borderTopWidth: 1, borderTopColor: Colors.border },
  pedidoRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  pedidoRowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  pedidoCodigo: { fontSize: 14, fontWeight: '800', color: Colors.brown, letterSpacing: 1 },
  pedidoBolsa: { fontSize: 12, color: Colors.textSecondary, marginTop: 1 },
  pedidoMontos: { alignItems: 'flex-end' },
  pedidoBruto: { fontSize: 13, color: Colors.textSecondary, textDecorationLine: 'line-through' },
  pedidoNeto: { fontSize: 14, fontWeight: '700', color: Colors.green },
  subtotalRow: { flexDirection: 'row', backgroundColor: Colors.brownLight, padding: 12, gap: 4 },
  subtotalItem: { flex: 1, alignItems: 'center' },
  subtotalLabel: { fontSize: 10, color: Colors.textSecondary, fontWeight: '600', marginBottom: 2 },
  subtotalVal: { fontSize: 14, fontWeight: '800', color: Colors.brown },
  notaCard: { backgroundColor: Colors.orangeLight, borderRadius: 14, padding: 14, marginTop: 8 },
  notaTitle: { fontSize: 13, fontWeight: '800', color: Colors.brown, marginBottom: 6 },
  notaText: { fontSize: 12, color: Colors.brown, lineHeight: 18 },
});
