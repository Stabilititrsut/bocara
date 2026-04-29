import { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { adminAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { logout } = useAuth();

  useEffect(() => {
    adminAPI.stats().then((r) => setStats(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>Panel de Administración</Text>
          <Text style={s.headerTitle}>Bocara Admin</Text>
        </View>
        <TouchableOpacity onPress={logout} style={s.logoutBtn}><Text style={s.logoutText}>Salir</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.sectionTitle}>📊 Métricas de la plataforma</Text>
        <View style={s.grid}>
          {[
            { label: 'Usuarios', val: stats?.total_usuarios || 0, emoji: '👥', color: Colors.orange },
            { label: 'Negocios', val: stats?.total_negocios || 0, emoji: '🏪', color: Colors.brown },
            { label: 'Pedidos', val: stats?.total_pedidos || 0, emoji: '📦', color: Colors.green },
            { label: 'Ingresos', val: `Q${(stats?.ingresos_totales || 0).toFixed(0)}`, emoji: '💰', color: Colors.orange },
            { label: 'Bolsas vendidas', val: stats?.total_bolsas_vendidas || 0, emoji: '🥡', color: Colors.brown },
            { label: 'CO₂ ahorrado', val: `${(stats?.co2_total || 0).toFixed(1)} kg`, emoji: '🌿', color: Colors.green },
          ].map(({ label, val, emoji, color }) => (
            <View key={label} style={s.statCard}>
              <Text style={{ fontSize: 28 }}>{emoji}</Text>
              <Text style={[s.statVal, { color }]}>{val}</Text>
              <Text style={s.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <Text style={s.sectionTitle}>📈 Negocios por verificar</Text>
        <View style={s.alertCard}>
          <Text style={{ fontSize: 28 }}>⏳</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.alertTitle}>{stats?.negocios_sin_verificar || 0} negocios pendientes</Text>
            <Text style={s.alertText}>Revisa la pestaña Negocios para verificarlos</Text>
          </View>
        </View>

        <Text style={s.sectionTitle}>💚 Impacto ambiental total</Text>
        <View style={s.impactCard}>
          <Text style={s.impactBig}>{stats?.total_bolsas_vendidas || 0}</Text>
          <Text style={s.impactLabel}>bolsas de comida rescatadas</Text>
          <Text style={s.impactSub}>≈ {((stats?.co2_total || 0) / 0.21).toFixed(0)} km de emisiones evitadas</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: Colors.brown, padding: 20 },
  headerSub: { color: Colors.orangeLight, fontSize: 12 },
  headerTitle: { color: Colors.white, fontSize: 24, fontWeight: '900' },
  logoutBtn: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  logoutText: { color: Colors.white, fontSize: 13, fontWeight: '600' },
  scroll: { padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 12, marginTop: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  statCard: { flex: 1, minWidth: '30%', backgroundColor: Colors.white, borderRadius: 16, padding: 12, alignItems: 'center', gap: 4, elevation: 2 },
  statVal: { fontSize: 22, fontWeight: '900' },
  statLabel: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center' },
  alertCard: { flexDirection: 'row', backgroundColor: Colors.orangeLight, borderRadius: 14, padding: 16, marginBottom: 20, alignItems: 'center' },
  alertTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  alertText: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  impactCard: { backgroundColor: Colors.greenLight, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20 },
  impactBig: { fontSize: 52, fontWeight: '900', color: Colors.green },
  impactLabel: { fontSize: 16, fontWeight: '700', color: Colors.brown, textAlign: 'center' },
  impactSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 4 },
});
