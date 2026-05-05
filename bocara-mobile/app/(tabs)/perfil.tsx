import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { authAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

// Niveles: Bronce / Plata / Oro / Embajador
function calcularNivel(puntos: number) {
  if (puntos < 50)  return { nombre: 'Bronce',     emoji: '🥉', color: '#CD7F32', next: 50,  pctBase: 0   };
  if (puntos < 150) return { nombre: 'Plata',      emoji: '🥈', color: '#9CA3AF', next: 150, pctBase: 50  };
  if (puntos < 300) return { nombre: 'Oro',        emoji: '🥇', color: '#F5A623', next: 300, pctBase: 150 };
  return             { nombre: 'Embajador', emoji: '👑', color: Colors.orange, next: null, pctBase: 300 };
}

function StatCard({ emoji, value, label, color }: any) {
  return (
    <View style={[s.stat, { borderTopColor: color }]}>
      <Text style={{ fontSize: 24, marginBottom: 4 }}>{emoji}</Text>
      <Text style={[s.statVal, { color }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

export default function PerfilScreen() {
  const { usuario, logout, actualizarUsuario } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    authAPI.perfil()
      .then((res) => actualizarUsuario(res.data))
      .catch(() => {});
  }, []);

  async function handleLogout() {
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: logout },
    ]);
  }

  if (!usuario) return <View style={s.loading}><ActivityIndicator color={Colors.orange} /></View>;

  const puntos = usuario.puntos || 0;
  const nivel = calcularNivel(puntos);
  const rango = nivel.next ? nivel.next - nivel.pctBase : 100;
  const progreso = nivel.next ? Math.min(puntos - nivel.pctBase, rango) : rango;
  const pct = Math.round((progreso / rango) * 100);

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Cabecera */}
        <View style={s.profileHeader}>
          <View style={s.avatar}>
            <Text style={{ fontSize: 40 }}>👤</Text>
          </View>
          <Text style={s.nombre}>{usuario.nombre} {usuario.apellido || ''}</Text>
          <Text style={s.email}>{usuario.email}</Text>
          <View style={[s.nivelBadge, { backgroundColor: nivel.color + '20', borderColor: nivel.color + '50' }]}>
            <Text style={[s.nivelText, { color: nivel.color }]}>{nivel.emoji} Nivel {nivel.nombre}</Text>
          </View>
        </View>

        {/* Tarjeta de puntos */}
        <View style={s.puntosCard}>
          <View style={s.puntosRow}>
            <Text style={s.puntosEmoji}>⭐</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.puntosVal}>{puntos}</Text>
              <Text style={s.puntosLabel}>Puntos Bocara</Text>
            </View>
            <TouchableOpacity style={s.canjeBtn}>
              <Text style={s.canjeBtnText}>Canjear</Text>
            </TouchableOpacity>
          </View>
          <View style={s.progresoBg}>
            <View style={[s.progresoFill, { width: `${pct}%` as any, backgroundColor: nivel.color }]} />
          </View>
          {nivel.next ? (
            <Text style={s.progresoText}>{nivel.next - puntos} puntos para nivel {calcularNivel(nivel.next).nombre}</Text>
          ) : (
            <Text style={s.progresoText}>¡Nivel máximo alcanzado! 🎉</Text>
          )}
        </View>

        {/* Impacto ambiental */}
        <Text style={s.sectionTitle}>🌍 Mi impacto ambiental</Text>
        <View style={s.statsRow}>
          <StatCard emoji="🥡" value={usuario.total_bolsas_salvadas || 0} label="Bolsas rescatadas" color={Colors.orange} />
          <StatCard emoji="🌿" value={`${(usuario.total_co2_salvado_kg || 0).toFixed(1)} kg`} label="CO₂ evitado" color={Colors.green} />
          <StatCard emoji="💰" value={`Q${(usuario.total_ahorrado || 0).toFixed(0)}`} label="Ahorrado" color={Colors.brown} />
        </View>

        {/* Equivalencias */}
        {(usuario.total_co2_salvado_kg || 0) > 0 && (
          <View style={s.equivCard}>
            <Text style={s.equivTitle}>¿Qué significa tu impacto?</Text>
            <Text style={s.equivItem}>🚗 Equivale a {((usuario.total_co2_salvado_kg || 0) / 0.21).toFixed(0)} km no recorridos en auto</Text>
            <Text style={s.equivItem}>🌳 Como plantar {Math.max(1, Math.ceil((usuario.total_co2_salvado_kg || 0) / 22))} árbol{Math.ceil((usuario.total_co2_salvado_kg || 0) / 22) !== 1 ? 'es' : ''}</Text>
            <Text style={s.equivItem}>🍽️ {usuario.total_bolsas_salvadas || 0} comidas que no se desperdiciaron</Text>
          </View>
        )}

        {/* Menú */}
        <View style={s.menu}>
          {[
            { emoji: '📦', label: 'Mis pedidos',           onPress: () => router.push('/(tabs)/pedidos') },
            { emoji: '❤️', label: 'Mis favoritos',         onPress: () => router.push('/(tabs)/explore' as any) },
            { emoji: '🔔', label: 'Notificaciones',        onPress: () => router.push('/(tabs)/explore' as any) },
            { emoji: '📞', label: 'Contacto y soporte',    onPress: () => router.push('/soporte' as any) },
            { emoji: '⚙️', label: 'Configuración',         onPress: () => router.push('/configuracion' as any) },
          ].map(({ emoji, label, onPress }) => (
            <TouchableOpacity key={label} style={s.menuItem} onPress={onPress}>
              <Text style={{ fontSize: 20 }}>{emoji}</Text>
              <Text style={s.menuLabel}>{label}</Text>
              <Text style={s.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Text style={s.logoutText}>Cerrar sesión</Text>
        </TouchableOpacity>

        <Text style={s.version}>Bocara Food v2.0 · Guatemala</Text>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16 },
  profileHeader: { alignItems: 'center', paddingVertical: 24, backgroundColor: Colors.white, borderRadius: 20, marginBottom: 16, elevation: 2 },
  avatar: { backgroundColor: Colors.brownLight, borderRadius: 50, width: 96, height: 96, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  nombre: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  email: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },
  nivelBadge: { borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginTop: 10 },
  nivelText: { fontWeight: '700', fontSize: 13 },
  puntosCard: { backgroundColor: Colors.brown, borderRadius: 20, padding: 18, marginBottom: 16 },
  puntosRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  puntosEmoji: { fontSize: 32, marginRight: 12 },
  puntosVal: { fontSize: 32, fontWeight: '900', color: Colors.white },
  puntosLabel: { fontSize: 13, color: Colors.orangeLight },
  canjeBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  canjeBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  progresoBg: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10, height: 8, marginBottom: 6 },
  progresoFill: { borderRadius: 10, height: 8 },
  progresoText: { fontSize: 12, color: Colors.orangeLight },
  sectionTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  stat: { flex: 1, backgroundColor: Colors.white, borderRadius: 14, padding: 12, alignItems: 'center', borderTopWidth: 3, elevation: 1 },
  statVal: { fontSize: 18, fontWeight: '900' },
  statLabel: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center', marginTop: 2 },
  equivCard: { backgroundColor: Colors.greenLight, borderRadius: 16, padding: 16, marginBottom: 20 },
  equivTitle: { fontSize: 14, fontWeight: '800', color: Colors.green, marginBottom: 10 },
  equivItem: { fontSize: 13, color: Colors.brown, marginBottom: 6, lineHeight: 20 },
  menu: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden', marginBottom: 16 },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  menuLabel: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  menuArrow: { fontSize: 20, color: Colors.textLight },
  logoutBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 16 },
  logoutText: { color: Colors.error, fontWeight: '700', fontSize: 15 },
  version: { textAlign: 'center', fontSize: 12, color: Colors.textLight },
});
