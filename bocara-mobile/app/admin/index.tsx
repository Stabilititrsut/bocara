import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { logout, usuario } = useAuth();

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.stats();
      setStats(res.data);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const comision = stats?.comision_generada || 0;
  const ingresos = stats?.ingresos_totales || 0;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>🔐 Panel de Administración</Text>
          <Text style={s.headerTitle}>Bocara Admin</Text>
          <Text style={s.headerUser}>{usuario?.nombre} · {usuario?.email}</Text>
        </View>
        <TouchableOpacity onPress={logout} style={s.logoutBtn}>
          <Text style={s.logoutText}>Salir</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {/* Comisión destacada */}
        <View style={s.comisionCard}>
          <View>
            <Text style={s.comisionLabel}>Comisión total generada (25%)</Text>
            <Text style={s.comisionVal}>Q{comision.toFixed(2)}</Text>
            <Text style={s.comisionSub}>de Q{ingresos.toFixed(2)} en ventas brutas</Text>
          </View>
          <Text style={{ fontSize: 40 }}>💰</Text>
        </View>

        {/* Alerta pendientes */}
        {stats?.negocios_sin_verificar > 0 && (
          <View style={s.alertCard}>
            <Text style={{ fontSize: 28 }}>⚠️</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.alertTitle}>{stats.negocios_sin_verificar} restaurante{stats.negocios_sin_verificar !== 1 ? 's' : ''} pendientes de aprobación</Text>
              <Text style={s.alertSub}>Ve a la pestaña Negocios para revisar</Text>
            </View>
          </View>
        )}

        {/* Grid de métricas */}
        <Text style={s.sectionTitle}>Métricas generales</Text>
        <View style={s.grid}>
          {[
            { label: 'Usuarios', val: stats?.total_usuarios || 0, emoji: '👥', color: Colors.orange },
            { label: 'Negocios activos', val: stats?.negocios_activos || 0, emoji: '🏪', color: Colors.green },
            { label: 'Pedidos totales', val: stats?.total_pedidos || 0, emoji: '📦', color: '#60A5FA' },
            { label: 'Completados', val: stats?.pedidos_completados || 0, emoji: '✅', color: Colors.green },
            { label: 'Sin verificar', val: stats?.negocios_sin_verificar || 0, emoji: '⏳', color: Colors.orange },
            { label: 'CO₂ ahorrado', val: `${(stats?.co2_total || 0).toFixed(1)} kg`, emoji: '🌿', color: Colors.green },
          ].map(({ label, val, emoji, color }) => (
            <View key={label} style={s.statCard}>
              <Text style={{ fontSize: 26 }}>{emoji}</Text>
              <Text style={[s.statVal, { color }]}>{val}</Text>
              <Text style={s.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        {/* Desglose financiero */}
        <Text style={s.sectionTitle}>Resumen financiero</Text>
        <View style={s.finCard}>
          {[
            { label: 'Ventas brutas totales', val: `Q${ingresos.toFixed(2)}`, color: Colors.white },
            { label: 'Comisión Bocara (25%)', val: `Q${comision.toFixed(2)}`, color: Colors.orange },
            { label: 'Pago a restaurantes (75%)', val: `Q${(ingresos * 0.75).toFixed(2)}`, color: '#86EFAC' },
          ].map(({ label, val, color }, i, arr) => (
            <View key={label} style={[s.finRow, i < arr.length - 1 && s.finRowBorder]}>
              <Text style={s.finLabel}>{label}</Text>
              <Text style={[s.finVal, { color }]}>{val}</Text>
            </View>
          ))}
        </View>

        {/* Impacto */}
        <View style={s.impactCard}>
          <Text style={s.impactEmoji}>🌿</Text>
          <Text style={s.impactBig}>{stats?.pedidos_completados || 0}</Text>
          <Text style={s.impactLabel}>bolsas de comida rescatadas</Text>
          <Text style={s.impactSub}>≈ {((stats?.co2_total || 0) / 0.21).toFixed(0)} km de emisiones evitadas</Text>
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1E293B', padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerSub: { color: '#94A3B8', fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  headerTitle: { color: Colors.white, fontSize: 26, fontWeight: '900', marginTop: 2 },
  headerUser: { color: '#64748B', fontSize: 12, marginTop: 2 },
  logoutBtn: { borderWidth: 1.5, borderColor: '#475569', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  logoutText: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  scroll: { padding: 16 },
  comisionCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: Colors.orange, borderRadius: 20, padding: 20, marginBottom: 12 },
  comisionLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600' },
  comisionVal: { fontSize: 32, fontWeight: '900', color: Colors.white, marginTop: 4 },
  comisionSub: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  alertCard: { flexDirection: 'row', backgroundColor: '#451A03', borderWidth: 1, borderColor: '#92400E', borderRadius: 14, padding: 14, marginBottom: 16, alignItems: 'center' },
  alertTitle: { fontSize: 14, fontWeight: '800', color: '#FDE68A' },
  alertSub: { fontSize: 12, color: '#D97706', marginTop: 2 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCard: { flex: 1, minWidth: '30%', backgroundColor: '#1E293B', borderRadius: 16, padding: 12, alignItems: 'center', gap: 4, borderWidth: 1, borderColor: '#334155' },
  statVal: { fontSize: 20, fontWeight: '900' },
  statLabel: { fontSize: 10, color: '#64748B', textAlign: 'center' },
  finCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: '#334155' },
  finRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14 },
  finRowBorder: { borderBottomWidth: 1, borderBottomColor: '#334155' },
  finLabel: { fontSize: 13, color: '#94A3B8' },
  finVal: { fontSize: 16, fontWeight: '800' },
  impactCard: { backgroundColor: '#064E3B', borderRadius: 20, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#065F46' },
  impactEmoji: { fontSize: 36, marginBottom: 4 },
  impactBig: { fontSize: 52, fontWeight: '900', color: '#6EE7B7' },
  impactLabel: { fontSize: 16, fontWeight: '700', color: Colors.white, textAlign: 'center' },
  impactSub: { fontSize: 13, color: '#34D399', marginTop: 4 },
});
