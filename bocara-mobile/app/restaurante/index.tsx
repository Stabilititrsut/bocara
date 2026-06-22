import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { negociosAPI, pedidosAPI, bolsasAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';

const PRIMARY = '#1A1A1A';
const GOLD    = '#C8A97E';
const GOLD_BG = '#F5F0EB';
const WHITE   = '#FFFFFF';
const BORDER  = '#F0EBE5';

const ESTADO_COLOR: Record<string, { bg: string; text: string }> = {
  confirmado: { bg: '#FEF3C7', text: '#92400E' },
  listo:      { bg: '#D1FAE5', text: '#065F46' },
  recogido:   { bg: '#DBEAFE', text: '#1E40AF' },
  cancelado:  { bg: '#FEE2E2', text: '#991B1B' },
};

function MetricCard({ emoji, label, value, accent }: { emoji: string; label: string; value: string | number; accent?: string }) {
  return (
    <View style={s.metricCard}>
      <Text style={{ fontSize: 28, marginBottom: 6 }}>{emoji}</Text>
      <Text style={[s.metricVal, { color: accent || PRIMARY }]}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
    </View>
  );
}

export default function DashboardRestauranteScreen() {
  const { usuario } = useAuth();
  const router = useRouter();
  const [negocio, setNegocio] = useState<any>(null);
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [impacto, setImpacto] = useState<{ kg_rescatados: number; co2_evitado: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [negRes, pedRes, bolRes] = await Promise.allSettled([
        negociosAPI.miNegocio(),
        pedidosAPI.restaurante(),
        bolsasAPI.listar({ mi_negocio: true }),
      ]);

      const neg = negRes.status === 'fulfilled' ? negRes.value.data : null;
      setNegocio(neg);

      if (neg?.id) {
        negociosAPI.impacto(neg.id).then(r => setImpacto(r.data)).catch(() => {});
      }

      const allPedidos = pedRes.status === 'fulfilled' ? (pedRes.value.data || []) : [];
      const today = allPedidos.filter((p: any) => {
        return new Date(p.created_at).toDateString() === new Date().toDateString();
      });
      setPedidos(allPedidos);

      const bolsas = bolRes.status === 'fulfilled' ? (bolRes.value?.data || []) : [];
      const activas = bolsas.filter((b: any) => b.activo).length;

      setStats({
        hoy:     today.length,
        ingresos: today.reduce((s: number, p: any) => s + (p.total || 0), 0),
        activas,
      });
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // ─── Pendiente ───────────────────────────────────────────────────────────────
  if (!loading && (negocio?.estado_verificacion === 'pendiente' || (!negocio?.activo && negocio?.estado_verificacion !== 'rechazado'))) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView
          contentContainerStyle={s.scrollCenter}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
        >
          <View style={s.statusCard}>
            <Text style={s.statusEmoji}>⏳</Text>
            <Text style={s.statusTitle}>Solicitud en revisión</Text>
            <Text style={s.statusSub}>
              Hola, <Text style={{ fontWeight: '700', color: PRIMARY }}>{usuario?.nombre}</Text>. Tu negocio{' '}
              <Text style={{ fontWeight: '900', color: PRIMARY }}>{negocio?.nombre || '...'}</Text> está siendo revisado.
            </Text>

            <View style={s.divider} />

            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: '#22C55E' }]}><Text style={s.stepDotText}>✓</Text></View>
              <Text style={s.stepText}>Solicitud recibida</Text>
            </View>
            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: GOLD }]}><Text style={s.stepDotText}>⏳</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.stepText}>Verificación de documentos</Text>
                <Text style={s.stepSub}>24 – 48 horas hábiles</Text>
              </View>
            </View>
            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: '#CBD5E1' }]}><Text style={s.stepDotText}>🔜</Text></View>
              <Text style={[s.stepText, { color: Colors.textLight }]}>Activación y publicación</Text>
            </View>

            <View style={s.divider} />
            <Text style={s.statusHint}>Te notificaremos cuando tu negocio sea aprobado. También puedes actualizar tu información desde "Mi negocio".</Text>

            <TouchableOpacity style={s.refreshBtn} onPress={() => { setRefreshing(true); cargar(); }}>
              <Text style={s.refreshBtnText}>↻ Verificar estado</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Rechazado ───────────────────────────────────────────────────────────────
  if (!loading && negocio?.estado_verificacion === 'rechazado') {
    const CAMPO_LABELS_R: Record<string, string> = {
      nombre_negocio: 'Nombre del negocio',
      direccion:      'Dirección',
      telefono:       'Teléfono',
      nit:            'NIT',
      dpi_foto_url:   'Foto del DPI',
      datos_bancarios:'Datos bancarios',
      imagen_url:     'Foto del negocio',
    };
    let motivoTexto = '';
    let camposRechazados: string[] = [];
    if (negocio.motivo_rechazo) {
      try {
        const p = JSON.parse(negocio.motivo_rechazo);
        motivoTexto = p.texto || '';
        camposRechazados = Array.isArray(p.campos) ? p.campos : [];
      } catch { motivoTexto = negocio.motivo_rechazo; }
    }
    const camposConLabel = camposRechazados.filter(c => c !== 'otro' && CAMPO_LABELS_R[c]);

    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.scrollCenter}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
        >
          <View style={[s.statusCard, s.rejectedCard]}>
            <Text style={s.statusEmoji}>❌</Text>
            <Text style={s.statusTitle}>Solicitud rechazada</Text>
            {camposConLabel.length > 0 && (
              <View style={s.camposCard}>
                <Text style={s.camposTitle}>Campos que debes corregir:</Text>
                {camposConLabel.map(c => (
                  <Text key={c} style={s.campoItem}>• {CAMPO_LABELS_R[c]}</Text>
                ))}
              </View>
            )}
            {motivoTexto ? (
              <View style={s.motivoCard}>
                <Text style={s.motivoLabel}>Motivo adicional</Text>
                <Text style={s.motivoText}>{motivoTexto}</Text>
              </View>
            ) : null}
            <Text style={s.statusHint}>Corrige los datos desde "Mi negocio" y vuelve a enviar tu solicitud.</Text>
            <TouchableOpacity style={s.corregirBtn} onPress={() => router.push('/restaurante/perfil' as any)}>
              <Text style={s.corregirBtnText}>✏️ Corregir y reenviar →</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Dashboard normal ────────────────────────────────────────────────────────
  const ultimos5 = pedidos.slice(0, 5);
  const faltaDpi = negocio && !negocio.dpi_foto_url && !negocio.datos_bancarios?.dpi_foto_url;

  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
        showsVerticalScrollIndicator={false}
      >
        {/* BUG 5: Advertencia DPI faltante */}
        {faltaDpi && (
          <TouchableOpacity style={s.dpiBanner} onPress={() => router.push('/restaurante/perfil' as any)} activeOpacity={0.85}>
            <Text style={s.dpiBannerText}>⚠️ Completa tu perfil: falta subir la foto del DPI para activar tu cuenta →</Text>
          </TouchableOpacity>
        )}

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.headerGreeting}>Bienvenido</Text>
              <Text style={s.headerNegocio} numberOfLines={1}>{negocio?.nombre || 'Mi Negocio'}</Text>
            </View>
            {negocio?.verificado && (
              <View style={s.verificadoBadge}>
                <Text style={s.verificadoText}>✓ Verificado</Text>
              </View>
            )}
          </View>
          <Text style={s.headerFecha}>
            {new Date().toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })}
          </Text>
        </View>

        {/* Métricas */}
        <Text style={s.sectionTitle}>Resumen de hoy</Text>
        <View style={s.metricsRow}>
          <MetricCard emoji="📦" label="Pedidos"  value={loading ? '—' : (stats?.hoy || 0)}                          accent={GOLD} />
          <MetricCard emoji="💰" label="Ganancias" value={loading ? '—' : `Q${(stats?.ingresos || 0).toFixed(0)}`}   accent='#22C55E' />
          <MetricCard emoji="⏱️" label="Activas"  value={loading ? '—' : (stats?.activas || 0)}                      accent='#60A5FA' />
        </View>

        {/* Impacto acumulado */}
        {impacto && (
          <View style={s.impactoCard}>
            <Text style={s.impactoTitle}>🌍 Tu impacto acumulado</Text>
            {impacto.kg_rescatados === 0 ? (
              <Text style={s.impactoEmpty}>Aún no tienes ventas registradas. ¡Tu impacto empieza con la primera venta!</Text>
            ) : (
              <View style={s.impactoRow}>
                <View style={s.impactoItem}>
                  <Text style={s.impactoNum}>{impacto.kg_rescatados.toFixed(1)}</Text>
                  <Text style={s.impactoLbl}>🍽️ kg comida{'\n'}rescatada</Text>
                </View>
                <View style={s.impactoDivider} />
                <View style={s.impactoItem}>
                  <Text style={s.impactoNum}>{impacto.co2_evitado.toFixed(1)}</Text>
                  <Text style={s.impactoLbl}>🌱 kg CO₂{'\n'}evitado est.</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Últimos pedidos */}
        <Text style={s.sectionTitle}>Últimos pedidos</Text>
        {ultimos5.length === 0 ? (
          <View style={s.emptyCard}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>🥡</Text>
            <Text style={s.emptyText}>Aún no tienes pedidos.</Text>
            <Text style={[s.emptyText, { marginTop: 4, fontSize: 12 }]}>¡Crea tu primera bolsa sorpresa!</Text>
          </View>
        ) : (
          ultimos5.map((p: any) => {
            const est = ESTADO_COLOR[p.estado] || { bg: '#F3F4F6', text: '#6B7280' };
            return (
              <View key={p.id} style={s.pedidoCard}>
                <View style={{ flex: 1 }}>
                  <Text style={s.pedidoNombre} numberOfLines={1}>{p.bolsas?.nombre || 'Bolsa sorpresa'}</Text>
                  <Text style={s.pedidoHora}>
                    {new Date(p.created_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
                    {' · '}{new Date(p.created_at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.pedidoTotal}>Q{(p.total || 0).toFixed(2)}</Text>
                  <View style={[s.estadoBadge, { backgroundColor: est.bg }]}>
                    <Text style={[s.estadoText, { color: est.text }]}>{p.estado}</Text>
                  </View>
                </View>
              </View>
            );
          })
        )}

        {pedidos.length > 5 && (
          <TouchableOpacity style={s.verTodosBtn} onPress={() => router.push('/restaurante/pedidos' as any)}>
            <Text style={s.verTodosBtnText}>Ver todos los pedidos →</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: GOLD_BG },
  loadingWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: GOLD_BG },
  scroll:       { padding: 16 },
  scrollCenter: { flexGrow: 1, padding: 16, justifyContent: 'center' },

  // ─── Status cards (pending/rejected) ───
  statusCard:   { backgroundColor: WHITE, borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 2, borderColor: '#F59E0B40' },
  rejectedCard: { borderColor: Colors.error + '40' },
  statusEmoji:  { fontSize: 56, marginBottom: 12 },
  statusTitle:  { fontSize: 22, fontWeight: '900', color: PRIMARY, marginBottom: 10, textAlign: 'center' },
  statusSub:    { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  statusHint:   { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  divider:      { height: 1, backgroundColor: BORDER, alignSelf: 'stretch', marginVertical: 16 },
  stepRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12, alignSelf: 'stretch' },
  stepDot:      { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  stepDotText:  { fontSize: 12 },
  stepText:     { fontSize: 14, fontWeight: '700', color: PRIMARY, lineHeight: 20 },
  stepSub:      { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  refreshBtn:   { backgroundColor: GOLD_BG, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 20, borderWidth: 1.5, borderColor: GOLD },
  refreshBtnText: { color: PRIMARY, fontWeight: '800', fontSize: 14 },
  camposCard:   { backgroundColor: '#FEE2E2', borderRadius: 12, padding: 14, alignSelf: 'stretch', marginBottom: 16, borderWidth: 1, borderColor: '#FCA5A5' },
  camposTitle:  { fontSize: 12, fontWeight: '800', color: '#DC2626', marginBottom: 8 },
  campoItem:    { fontSize: 13, color: '#991B1B', paddingVertical: 2 },
  motivoCard:   { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, alignSelf: 'stretch', marginBottom: 16, borderWidth: 1, borderColor: Colors.error + '30' },
  motivoLabel:  { fontSize: 12, fontWeight: '800', color: Colors.error, marginBottom: 4 },
  motivoText:   { fontSize: 13, color: PRIMARY },
  corregirBtn:  { backgroundColor: GOLD, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 14, width: '100%', alignItems: 'center', marginTop: 12 },
  corregirBtnText: { color: WHITE, fontWeight: '800', fontSize: 15 },

  // ─── Dashboard normal ───
  header: {
    backgroundColor: PRIMARY, borderRadius: 20, padding: 20, marginBottom: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 4,
  },
  headerTop:      { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  headerGreeting: { fontSize: 12, color: 'rgba(200,169,126,0.7)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  headerNegocio:  { fontSize: 24, fontWeight: '900', color: WHITE, marginTop: 2 },
  headerFecha:    { fontSize: 12, color: 'rgba(255,255,255,0.5)', textTransform: 'capitalize' },
  verificadoBadge: { backgroundColor: GOLD, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, flexShrink: 0, marginLeft: 12 },
  verificadoText:  { color: WHITE, fontSize: 11, fontWeight: '800' },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: PRIMARY, marginBottom: 12, marginTop: 4 },

  metricsRow:  { flexDirection: 'row', gap: 10, marginBottom: 20 },
  metricCard:  {
    flex: 1, backgroundColor: WHITE, borderRadius: 16, padding: 14, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  metricVal:   { fontSize: 22, fontWeight: '900', marginBottom: 2 },
  metricLabel: { fontSize: 11, color: Colors.textSecondary, textAlign: 'center', fontWeight: '600' },

  emptyCard:  { backgroundColor: WHITE, borderRadius: 16, padding: 28, alignItems: 'center', borderWidth: 1.5, borderColor: BORDER, borderStyle: 'dashed' },
  emptyText:  { color: Colors.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  pedidoCard: {
    flexDirection: 'row', backgroundColor: WHITE, borderRadius: 14, padding: 14, marginBottom: 8,
    alignItems: 'center', borderWidth: 1, borderColor: BORDER,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  pedidoNombre: { fontSize: 14, fontWeight: '700', color: PRIMARY },
  pedidoHora:   { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  pedidoTotal:  { fontSize: 16, fontWeight: '900', color: GOLD, textAlign: 'right' },
  estadoBadge:  { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4 },
  estadoText:   { fontSize: 11, fontWeight: '700' },

  verTodosBtn:  { backgroundColor: WHITE, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: GOLD, marginTop: 4 },
  verTodosBtnText: { color: GOLD, fontWeight: '800', fontSize: 14 },

  dpiBanner: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1.5, borderColor: '#FDE68A' },
  dpiBannerText: { fontSize: 13, color: '#92400E', fontWeight: '700', lineHeight: 19 },

  impactoCard:    { backgroundColor: '#F0FFF4', borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1.5, borderColor: '#A5D6A7' },
  impactoTitle:   { fontSize: 14, fontWeight: '800', color: '#2E7D32', marginBottom: 10 },
  impactoEmpty:   { fontSize: 13, color: '#4CAF50', lineHeight: 20 },
  impactoRow:     { flexDirection: 'row', alignItems: 'center' },
  impactoItem:    { flex: 1, alignItems: 'center' },
  impactoDivider: { width: 1, height: 44, backgroundColor: '#A5D6A7' },
  impactoNum:     { fontSize: 24, fontWeight: '900', color: '#2E7D32', marginBottom: 4 },
  impactoLbl:     { fontSize: 11, color: '#4CAF50', textAlign: 'center', lineHeight: 16 },
});
