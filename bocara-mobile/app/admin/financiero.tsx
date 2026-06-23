import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator, Share, Alert, Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

let XLSX: any = null;
try { XLSX = require('xlsx'); } catch {}

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';
const GREEN  = '#16A34A';

type Periodo = '7d' | '30d' | 'todo';

function card(extra?: any) {
  return {
    backgroundColor: CARD, borderRadius: 16,
    borderWidth: 1, borderColor: BORDER,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
    ...extra,
  };
}

export default function AdminFinancieroScreen() {
  const [datos,         setDatos]         = useState<any>(null);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [periodo,       setPeriodo]       = useState<Periodo>('30d');
  const [expandido,     setExpandido]     = useState<string | null>(null);
  const [pedidos,       setPedidos]       = useState<any[]>([]);
  const [mostrarPedidos, setMostrarPedidos] = useState(false);
  const [exporting,     setExporting]     = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [finRes, pedRes] = await Promise.all([
        adminAPI.financiero(periodo),
        adminAPI.pedidosTodos({ limite: 200 }),
      ]);
      setDatos(finRes.data);
      // Solo pedidos realmente completados (recogidos por el cliente)
      setPedidos((pedRes.data || []).filter((p: any) => p.estado === 'recogido'));
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [periodo]);

  useEffect(() => { cargar(); }, [cargar]);

  async function exportarExcel() {
    if (!datos?.resumen?.length) return Alert.alert('Sin datos', 'No hay datos para exportar en este período.');
    if (!XLSX) return Alert.alert('Error', 'Librería XLSX no disponible.');

    setExporting(true);
    try {
      const wb = XLSX.utils.book_new();

      const hoja1: any[][] = [
        ['Bocara — Reporte Financiero', '', `Período: ${periodo}`],
        [],
        ['Métrica', 'Valor'],
        ['Pedidos completados', datos.totales.pedidos],
        ['Ventas brutas (Q)', datos.totales.bruto],
        ['Comisión Bocara 25% (Q)', datos.totales.comision],
        ['Pago a restaurantes 75% (Q)', datos.totales.neto],
        ['Fecha exportación', new Date().toLocaleDateString('es-GT')],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hoja1), 'Dashboard');

      const hoja2: any[][] = [
        ['Restaurante', 'Zona', 'Pedidos', 'Ventas brutas (Q)', 'Comisión Bocara (Q)', 'Pago neto (Q)', 'Promedio por pedido (Q)'],
        ...datos.resumen.map((r: any) => [
          r.nombre, r.zona || '', r.pedidos,
          Number(r.bruto.toFixed(2)),
          Number(r.comision.toFixed(2)),
          Number(r.neto.toFixed(2)),
          r.pedidos > 0 ? Number((r.bruto / r.pedidos).toFixed(2)) : 0,
        ]),
        ['TOTAL', '', datos.totales.pedidos,
          Number(datos.totales.bruto.toFixed(2)),
          Number(datos.totales.comision.toFixed(2)),
          Number(datos.totales.neto.toFixed(2)), ''],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hoja2), 'Por Restaurante');

      const hoja3: any[][] = [
        ['Código', 'Restaurante', 'Cliente', 'Fecha', 'Total (Q)', 'Comisión (Q)', 'Estado'],
        ...pedidos.slice(0, 500).map((p: any) => [ // pedidos ya filtrados por estado=recogido
          p.codigo_recogida || '—',
          p.negocios?.nombre || '—',
          p.usuarios?.nombre || '—',
          new Date(p.created_at || p.creado_en || 0).toLocaleDateString('es-GT'),
          Number((p.total || 0).toFixed(2)),
          Number(((p.total || 0) * 0.25).toFixed(2)),
          p.estado,
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hoja3), 'Pedidos Detallados');

      const fecha    = new Date().toISOString().slice(0, 10);
      const filename = `bocara-reporte-${fecha}.xlsx`;
      const buffer   = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });

      if (Platform.OS === 'web') {
        const byteChars = atob(buffer);
        const byteNums  = new Array(byteChars.length).fill(0).map((_, i) => byteChars.charCodeAt(i));
        const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const path = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(path, buffer, { encoding: FileSystem.EncodingType.Base64 });
        await Share.share({ url: path, title: filename });
      }
    } catch (e: any) {
      Alert.alert('Error al exportar', e.message || 'Intenta de nuevo.');
    } finally { setExporting(false); }
  }

  if (loading) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: BG }}>
      <ActivityIndicator color={GOLD} size="large" />
    </View>
  );

  const totales = datos?.totales || { bruto: 0, comision: 0, neto: 0, pedidos: 0 };
  const resumen = datos?.resumen || [];

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>FINANZAS</Text>
          <Text style={s.headerTitle}>Módulo financiero</Text>
        </View>
        <TouchableOpacity style={[s.exportBtn, exporting && { opacity: 0.6 }]} onPress={exportarExcel} disabled={exporting}>
          {exporting
            ? <ActivityIndicator color="#fff" size="small" />
            : <><Ionicons name="download" size={15} color="#fff" /><Text style={s.exportBtnText}>Excel</Text></>}
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
      >
        {/* Resumen total */}
        <Text style={s.sectionTitle}>Resumen del período</Text>
        <View style={[card(), { marginBottom: 20, overflow: 'hidden' }]}>
          {[
            { label: 'Pedidos completados', val: String(totales.pedidos), color: TEXT,  icon: 'bag-check'  as any },
            { label: 'Ventas brutas',       val: `Q${totales.bruto.toFixed(2)}`,     color: TEXT,  icon: 'trending-up' as any },
            { label: 'Comisión Bocara (25%)', val: `Q${totales.comision.toFixed(2)}`, color: GOLD,  icon: 'wallet'     as any },
            { label: 'Pago a restaurantes (75%)', val: `Q${totales.neto.toFixed(2)}`, color: GREEN, icon: 'storefront' as any },
          ].map(({ label, val, color, icon }, i, arr) => (
            <View key={label} style={[s.totalRow, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: BORDER }]}>
              <View style={s.totalIconWrap}>
                <Ionicons name={icon} size={18} color={color} />
              </View>
              <Text style={s.totalLabel}>{label}</Text>
              <Text style={[s.totalVal, { color }]}>{val}</Text>
            </View>
          ))}
        </View>

        {/* Por restaurante */}
        <Text style={s.sectionTitle}>Desglose por restaurante</Text>
        {resumen.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <Ionicons name="stats-chart-outline" size={40} color={BORDER} />
            <Text style={{ color: TEXT2, fontSize: 14, marginTop: 10 }}>Sin transacciones en este período</Text>
          </View>
        ) : resumen.map((r: any) => (
          <TouchableOpacity
            key={r.negocio_id}
            style={[card(), { marginBottom: 8, overflow: 'hidden' }]}
            onPress={() => setExpandido(expandido === r.negocio_id ? null : r.negocio_id)}
          >
            <View style={s.restRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.restNombre}>{r.nombre}</Text>
                {r.zona ? <Text style={s.restZona}>Zona {r.zona}</Text> : null}
              </View>
              <View style={{ alignItems: 'flex-end', marginRight: 8 }}>
                <Text style={[s.restNeto, { color: GREEN }]}>Q{r.neto.toFixed(2)}</Text>
                <Text style={s.restSub}>{r.pedidos} pedidos</Text>
              </View>
              <Ionicons name={expandido === r.negocio_id ? 'chevron-up' : 'chevron-down'} size={16} color={TEXT2} />
            </View>

            {expandido === r.negocio_id && (
              <View style={{ borderTopWidth: 1, borderTopColor: BORDER }}>
                {[
                  { label: 'Ventas brutas',              val: `Q${r.bruto.toFixed(2)}`,          color: TEXT  },
                  { label: 'Comisión Bocara (25%)',       val: `-Q${r.comision.toFixed(2)}`,      color: '#DC2626' },
                  { label: 'Pago al restaurante (75%)',  val: `Q${r.neto.toFixed(2)}`,            color: GREEN },
                  { label: 'Promedio por pedido',        val: r.pedidos > 0 ? `Q${(r.bruto / r.pedidos).toFixed(2)}` : '—', color: TEXT2 },
                ].map(({ label, val, color }, i, arr) => (
                  <View key={label} style={[s.detailRow, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: BORDER }]}>
                    <Text style={s.detailLabel}>{label}</Text>
                    <Text style={[s.detailVal, { color }]}>{val}</Text>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        ))}

        {/* Transacciones recientes */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <Text style={s.sectionTitle}>Transacciones recientes</Text>
          <TouchableOpacity onPress={() => setMostrarPedidos(!mostrarPedidos)}>
            <Text style={{ color: GOLD, fontSize: 13, fontWeight: '700' }}>
              {mostrarPedidos ? 'Ocultar' : `Ver todas (${pedidos.length})`}
            </Text>
          </TouchableOpacity>
        </View>

        {mostrarPedidos && pedidos.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: 32 }}>
            <Ionicons name="receipt-outline" size={36} color={BORDER} />
            <Text style={{ color: TEXT2, fontSize: 14, marginTop: 10 }}>Sin ventas registradas aún</Text>
            <Text style={{ color: TEXT2, fontSize: 12, marginTop: 4 }}>Total: Q0.00</Text>
          </View>
        )}
        {mostrarPedidos && pedidos.slice(0, 50).map((p: any) => (
          <View key={p.id} style={[card(), s.txRow]}>
            <View style={{ flex: 1 }}>
              <Text style={s.txCodigo}>{p.codigo_recogida || '—'}</Text>
              <Text style={s.txNegocio}>{p.negocios?.nombre || '—'}</Text>
              <Text style={s.txFecha}>{new Date(p.created_at || p.creado_en || 0).toLocaleDateString('es-GT')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.txTotal}>Q{(p.total || 0).toFixed(2)}</Text>
              <Text style={{ fontSize: 11, color: '#DC2626', marginTop: 1 }}>-Q{((p.total || 0) * 0.25).toFixed(2)}</Text>
              <View style={[s.txEstado, { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }]}>
                <Text style={[s.txEstadoText, { color: '#166534' }]}>recogido</Text>
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
  root:       { flex: 1, backgroundColor: BG },
  header:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:  { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  exportBtn:   { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: GOLD, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  exportBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  periodos:        { flexDirection: 'row', padding: 12, gap: 8, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  periodoChip:     { flex: 1, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: BORDER, alignItems: 'center', backgroundColor: BG },
  periodoActive:   { backgroundColor: GOLD, borderColor: GOLD },
  periodoText:     { fontSize: 13, fontWeight: '600', color: TEXT2 },
  periodoTextActive: { color: '#fff', fontWeight: '800' },

  scroll:        { padding: 14 },
  sectionTitle:  { fontSize: 11, fontWeight: '700', color: TEXT2, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 },

  totalRow:     { flexDirection: 'row', alignItems: 'center', padding: 14 },
  totalIconWrap: { width: 32, height: 32, borderRadius: 10, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  totalLabel:   { flex: 1, fontSize: 13, color: TEXT2 },
  totalVal:     { fontSize: 16, fontWeight: '900' },

  restRow:    { flexDirection: 'row', alignItems: 'center', padding: 14 },
  restNombre: { fontSize: 14, fontWeight: '700', color: TEXT },
  restZona:   { fontSize: 11, color: TEXT2, marginTop: 1 },
  restNeto:   { fontSize: 16, fontWeight: '900' },
  restSub:    { fontSize: 11, color: TEXT2, marginTop: 2 },

  detailRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12 },
  detailLabel: { fontSize: 13, color: TEXT2 },
  detailVal:  { fontSize: 14, fontWeight: '700' },

  txRow:    { padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  txCodigo: { fontSize: 13, fontWeight: '800', color: TEXT, letterSpacing: 1 },
  txNegocio: { fontSize: 12, color: TEXT2, marginTop: 1 },
  txFecha:  { fontSize: 11, color: TEXT2, marginTop: 1 },
  txTotal:  { fontSize: 15, fontWeight: '900', color: TEXT },
  txEstado: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, marginTop: 4, alignSelf: 'flex-end', borderWidth: 1 },
  txEstadoText: { fontSize: 10, fontWeight: '700' },
});
