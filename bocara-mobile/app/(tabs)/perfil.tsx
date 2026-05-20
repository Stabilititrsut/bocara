import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { authAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

function calcularNivel(puntos: number) {
  if (puntos < 50)  return { nombre: 'Bronce',    emoji: '🥉', color: '#CD7F32', next: 50,  pctBase: 0   };
  if (puntos < 150) return { nombre: 'Plata',     emoji: '🥈', color: '#9E9E9E', next: 150, pctBase: 50  };
  if (puntos < 300) return { nombre: 'Oro',       emoji: '🥇', color: '#FF9800', next: 300, pctBase: 150 };
  return             { nombre: 'Embajador', emoji: '👑', color: Colors.primary, next: null, pctBase: 300 };
}

const MENU_ITEMS = [
  { icon: 'receipt-outline',    label: 'Mis pedidos',        route: '/(tabs)/pedidos' },
  { icon: 'heart-outline',      label: 'Mis favoritos',      route: '/(tabs)/explore' },
  { icon: 'notifications-outline', label: 'Notificaciones', route: '/(tabs)/explore' },
  { icon: 'headset-outline',    label: 'Contacto y soporte', route: '/soporte' },
  { icon: 'settings-outline',   label: 'Configuración',      route: '/configuracion' },
];

export default function PerfilScreen() {
  const { usuario, logout, actualizarUsuario } = useAuth();
  const router = useRouter();

  useEffect(() => {
    authAPI.perfil().then((res) => actualizarUsuario(res.data)).catch(() => {});
  }, []);

  async function handleLogout() {
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: logout },
    ]);
  }

  if (!usuario) return <View style={s.loadingBox}><ActivityIndicator color={Colors.primary} /></View>;

  const puntos = usuario.puntos || 0;
  const nivel = calcularNivel(puntos);
  const rango = nivel.next ? nivel.next - nivel.pctBase : 100;
  const progreso = nivel.next ? Math.min(puntos - nivel.pctBase, rango) : rango;
  const pct = Math.round((progreso / rango) * 100);
  const inicialesNombre = `${usuario.nombre?.[0] || ''}${usuario.apellido?.[0] || ''}`.toUpperCase();

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header de perfil */}
        <View style={s.profileCard}>
          <View style={s.avatarCircle}>
            <Text style={s.avatarText}>{inicialesNombre || '?'}</Text>
          </View>
          <Text style={s.nombre}>{usuario.nombre} {usuario.apellido || ''}</Text>
          <Text style={s.email}>{usuario.email}</Text>
          <View style={[s.nivelPill, { backgroundColor: nivel.color + '18', borderColor: nivel.color + '40' }]}>
            <Text style={s.nivelPillText}>{nivel.emoji}</Text>
            <Text style={[s.nivelPillLabel, { color: nivel.color }]}>Nivel {nivel.nombre}</Text>
          </View>
        </View>

        {/* Tarjeta de puntos */}
        <View style={s.puntosCard}>
          <View style={s.puntosRow}>
            <Ionicons name="star" size={28} color="rgba(255,255,255,0.9)" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.puntosVal}>{puntos}</Text>
              <Text style={s.puntosLabel}>Puntos Bocara</Text>
            </View>
            <TouchableOpacity style={s.canjeBtn}>
              <Text style={s.canjeBtnText}>Canjear</Text>
            </TouchableOpacity>
          </View>
          <View style={s.progresoBg}>
            <View style={[s.progresoFill, { width: `${pct}%` as any }]} />
          </View>
          <Text style={s.progresoText}>
            {nivel.next ? `${nivel.next - puntos} puntos para nivel ${calcularNivel(nivel.next).nombre}` : '¡Nivel máximo alcanzado! 🎉'}
          </Text>
        </View>

        {/* Stats de impacto */}
        <Text style={s.sectionTitle}>Mi impacto ambiental</Text>
        <View style={s.statsRow}>
          {[
            { icon: 'bag-outline', val: usuario.total_bolsas_salvadas || 0, label: 'Bolsas\nrescatadas', color: Colors.primary },
            { icon: 'leaf-outline', val: `${(usuario.total_co2_salvado_kg || 0).toFixed(1)}kg`, label: 'CO₂\nevitado', color: '#388E3C' },
            { icon: 'wallet-outline', val: `Q${(usuario.total_ahorrado || 0).toFixed(0)}`, label: 'Total\nahorrado', color: '#1976D2' },
          ].map((stat) => (
            <View key={stat.label} style={s.statCard}>
              <Ionicons name={stat.icon as any} size={22} color={stat.color} />
              <Text style={[s.statVal, { color: stat.color }]}>{stat.val}</Text>
              <Text style={s.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Equivalencias CO2 */}
        {(usuario.total_co2_salvado_kg || 0) > 0 && (
          <View style={s.equivCard}>
            <Text style={s.equivTitle}>¿Qué significa tu impacto?</Text>
            <View style={s.equivItem}>
              <Ionicons name="car-outline" size={16} color={Colors.primary} />
              <Text style={s.equivText}>{((usuario.total_co2_salvado_kg || 0) / 0.21).toFixed(0)} km no recorridos en auto</Text>
            </View>
            <View style={s.equivItem}>
              <Ionicons name="leaf-outline" size={16} color={Colors.primary} />
              <Text style={s.equivText}>Como plantar {Math.max(1, Math.ceil((usuario.total_co2_salvado_kg || 0) / 22))} árbol{Math.ceil((usuario.total_co2_salvado_kg || 0) / 22) !== 1 ? 'es' : ''}</Text>
            </View>
            <View style={s.equivItem}>
              <Ionicons name="restaurant-outline" size={16} color={Colors.primary} />
              <Text style={s.equivText}>{usuario.total_bolsas_salvadas || 0} comidas que no se desperdiciaron</Text>
            </View>
          </View>
        )}

        {/* Menú */}
        <View style={s.menuCard}>
          {MENU_ITEMS.map(({ icon, label, route }, idx) => (
            <TouchableOpacity key={label} style={[s.menuItem, idx < MENU_ITEMS.length - 1 && s.menuItemBorder]} onPress={() => router.push(route as any)}>
              <View style={s.menuIconBox}>
                <Ionicons name={icon as any} size={20} color={Colors.primary} />
              </View>
              <Text style={s.menuLabel}>{label}</Text>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={18} color={Colors.error} />
          <Text style={s.logoutText}>Cerrar sesión</Text>
        </TouchableOpacity>

        <Text style={s.version}>Bocara Food · Guatemala</Text>
        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.surface },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16 },

  profileCard: { backgroundColor: Colors.white, borderRadius: 24, padding: 24, alignItems: 'center', marginBottom: 16, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
  avatarCircle: { width: 84, height: 84, borderRadius: 42, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  avatarText: { fontSize: 32, fontWeight: '800', color: Colors.white },
  nombre: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  email: { fontSize: 13, color: Colors.textSecondary, marginTop: 3 },
  nivelPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginTop: 12 },
  nivelPillText: { fontSize: 16 },
  nivelPillLabel: { fontWeight: '700', fontSize: 13 },

  puntosCard: { backgroundColor: Colors.primary, borderRadius: 22, padding: 18, marginBottom: 24 },
  puntosRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  puntosVal: { fontSize: 30, fontWeight: '900', color: Colors.white },
  puntosLabel: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  canjeBtn: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  canjeBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  progresoBg: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10, height: 8, marginBottom: 8 },
  progresoFill: { borderRadius: 10, height: 8, backgroundColor: Colors.accent },
  progresoText: { fontSize: 12, color: 'rgba(255,255,255,0.7)' },

  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, marginBottom: 12 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.white, borderRadius: 18, padding: 14, alignItems: 'center', gap: 6, elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4 },
  statVal: { fontSize: 18, fontWeight: '900' },
  statLabel: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center', lineHeight: 14 },

  equivCard: { backgroundColor: Colors.white, borderRadius: 18, padding: 16, marginBottom: 24, elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4 },
  equivTitle: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary, marginBottom: 12 },
  equivItem: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  equivText: { fontSize: 13, color: Colors.textSecondary, flex: 1, lineHeight: 18 },

  menuCard: { backgroundColor: Colors.white, borderRadius: 20, overflow: 'hidden', marginBottom: 16, elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  menuIconBox: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center' },
  menuLabel: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },

  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: Colors.error, borderRadius: 16, padding: 14, marginBottom: 16 },
  logoutText: { color: Colors.error, fontWeight: '700', fontSize: 15 },
  version: { textAlign: 'center', fontSize: 12, color: Colors.textLight },
});
