import { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, RefreshControl, ActivityIndicator } from 'react-native';
import { negociosAPI, pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';

export default function DashboardRestauranteScreen() {
  const { usuario } = useAuth();
  const [negocio, setNegocio] = useState<any>(null);
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [negRes, pedRes] = await Promise.all([negociosAPI.miNegocio(), pedidosAPI.restaurante()]);
      setNegocio(negRes.data);
      const todayPedidos = (pedRes.data || []).filter((p: any) => {
        const d = new Date(p.created_at);
        return d.toDateString() === new Date().toDateString();
      });
      setPedidos(pedRes.data || []);
      setStats({
        hoy: todayPedidos.length,
        pendientes: (pedRes.data || []).filter((p: any) => p.estado === 'confirmado').length,
        ingresos: todayPedidos.reduce((s: number, p: any) => s + (p.total || 0), 0),
        total: negRes.data?.total_bolsas_vendidas || 0,
      });
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  // ─── Estado: negocio en revisión ───
  if (negocio?.estado_verificacion === 'pendiente' || (!negocio?.activo && negocio?.estado_verificacion !== 'rechazado')) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView
          contentContainerStyle={s.scrollCenter}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          <View style={s.pendingCard}>
            <Text style={s.pendingEmoji}>⏳</Text>
            <Text style={s.pendingTitle}>Solicitud en revisión</Text>
            <Text style={s.pendingSub}>
              Hola, {usuario?.nombre}. Tu negocio <Text style={{ fontWeight: '900' }}>{negocio?.nombre || '...'}</Text> está siendo revisado por el equipo de Bocara.
            </Text>
            <View style={s.pendingDivider} />
            <Text style={s.pendingStep}>✅ Solicitud recibida</Text>
            <Text style={s.pendingStep}>⏳ Verificación de documentos (24-48h)</Text>
            <Text style={[s.pendingStep, { color: Colors.textLight }]}>🔜 Activación y publicación</Text>
            <View style={s.pendingDivider} />
            <Text style={s.pendingHint}>
              Te notificaremos por la app cuando tu negocio sea aprobado. También puedes actualizar tu información desde "Mi negocio".
            </Text>
            <TouchableOpacity style={s.refreshBtn} onPress={() => { setRefreshing(true); cargar(); }}>
              <Text style={s.refreshBtnText}>↻ Verificar estado</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Estado: negocio rechazado ───
  if (negocio?.estado_verificacion === 'rechazado') {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.scrollCenter}>
          <View style={[s.pendingCard, s.rejectedCard]}>
            <Text style={s.pendingEmoji}>❌</Text>
            <Text style={s.pendingTitle}>Solicitud rechazada</Text>
            {negocio.motivo_rechazo && (
              <View style={s.motivoCard}>
                <Text style={s.motivoLabel}>Motivo:</Text>
                <Text style={s.motivoText}>{negocio.motivo_rechazo}</Text>
              </View>
            )}
            <Text style={s.pendingHint}>
              Revisa los datos desde "Mi negocio", corrígelos y contacta a soporte para reabrir tu solicitud.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Dashboard normal (negocio activo) ───
  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        <View style={s.header}>
          <Text style={s.greeting}>¡Hola, {usuario?.nombre}! 👋</Text>
          <Text style={s.negocioNombre}>{negocio?.nombre || 'Mi Negocio'}</Text>
          {negocio?.verificado && <View style={s.verificadoBadge}><Text style={s.verificadoText}>✓ Verificado</Text></View>}
        </View>

        <Text style={s.sectionTitle}>📊 Resumen de hoy</Text>
        <View style={s.statsGrid}>
          {[
            { val: stats?.hoy || 0,                              label: 'Pedidos hoy',   emoji: '📦', color: Colors.orange },
            { val: stats?.pendientes || 0,                       label: 'Por entregar',  emoji: '⏳', color: Colors.green },
            { val: `Q${(stats?.ingresos || 0).toFixed(0)}`,      label: 'Ingresos hoy',  emoji: '💰', color: Colors.brown },
            { val: stats?.total || 0,                            label: 'Total vendidas', emoji: '🥡', color: Colors.textSecondary },
          ].map(({ val, label, emoji, color }) => (
            <View key={label} style={s.statCard}>
              <Text style={{ fontSize: 28 }}>{emoji}</Text>
              <Text style={[s.statVal, { color }]}>{val}</Text>
              <Text style={s.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <Text style={s.sectionTitle}>📋 Pedidos recientes</Text>
        {pedidos.length === 0 ? (
          <View style={s.emptyCard}><Text style={s.emptyText}>Aún no tienes pedidos. ¡Crea tu primera bolsa!</Text></View>
        ) : (
          pedidos.slice(0, 5).map((p: any) => (
            <View key={p.id} style={s.pedidoCard}>
              <View style={{ flex: 1 }}>
                <Text style={s.pedidoNombre}>{p.bolsas?.nombre}</Text>
                <Text style={s.pedidoHora}>{new Date(p.created_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}</Text>
              </View>
              <View>
                <Text style={s.pedidoTotal}>Q{p.total?.toFixed(2)}</Text>
                <View style={[s.estadoBadge, { backgroundColor: p.estado === 'listo' ? Colors.greenLight : Colors.orangeLight }]}>
                  <Text style={[s.estadoText, { color: p.estado === 'listo' ? Colors.green : Colors.orange }]}>{p.estado}</Text>
                </View>
              </View>
            </View>
          ))
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16 },
  scrollCenter: { flexGrow: 1, padding: 16, justifyContent: 'center' },
  // Pending / rejected states
  pendingCard: { backgroundColor: Colors.white, borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 2, borderColor: '#F59E0B40' },
  rejectedCard: { borderColor: Colors.error + '40' },
  pendingEmoji: { fontSize: 56, marginBottom: 12 },
  pendingTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown, marginBottom: 10, textAlign: 'center' },
  pendingSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  pendingDivider: { height: 1, backgroundColor: Colors.border, alignSelf: 'stretch', marginVertical: 16 },
  pendingStep: { fontSize: 14, color: Colors.brown, fontWeight: '600', marginBottom: 8, alignSelf: 'flex-start' },
  pendingHint: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  refreshBtn: { backgroundColor: Colors.brownLight, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 20 },
  refreshBtnText: { color: Colors.brown, fontWeight: '800', fontSize: 14 },
  motivoCard: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, alignSelf: 'stretch', marginBottom: 16, borderWidth: 1, borderColor: Colors.error + '30' },
  motivoLabel: { fontSize: 12, fontWeight: '800', color: Colors.error, marginBottom: 4 },
  motivoText: { fontSize: 13, color: Colors.brown },
  // Normal dashboard
  header: { backgroundColor: Colors.brown, borderRadius: 20, padding: 20, marginBottom: 20 },
  greeting: { fontSize: 14, color: Colors.orangeLight },
  negocioNombre: { fontSize: 24, fontWeight: '900', color: Colors.white, marginTop: 4 },
  verificadoBadge: { backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4, alignSelf: 'flex-start', marginTop: 8 },
  verificadoText: { color: Colors.white, fontSize: 12, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCard: { flex: 1, minWidth: '45%', backgroundColor: Colors.white, borderRadius: 16, padding: 14, alignItems: 'center', gap: 4, elevation: 2 },
  statVal: { fontSize: 24, fontWeight: '900' },
  statLabel: { fontSize: 11, color: Colors.textSecondary, textAlign: 'center' },
  emptyCard: { backgroundColor: Colors.white, borderRadius: 14, padding: 20, alignItems: 'center' },
  emptyText: { color: Colors.textSecondary, fontSize: 14, textAlign: 'center' },
  pedidoCard: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 8, alignItems: 'center', elevation: 1 },
  pedidoNombre: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  pedidoHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  pedidoTotal: { fontSize: 16, fontWeight: '800', color: Colors.orange, textAlign: 'right' },
  estadoBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4, alignSelf: 'flex-end' },
  estadoText: { fontSize: 11, fontWeight: '700' },
});
