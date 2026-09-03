import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, Platform, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const MENU_ITEMS = [
  { icon: 'receipt-outline',    label: 'Mis pedidos',        route: '/(tabs)/pedidos' },
  { icon: 'ticket-outline',     label: 'Cupones',            route: '/cupones' },
  { icon: 'people-outline',     label: 'Referidos',          route: '/referidos' },
  { icon: 'heart-outline',      label: 'Mis favoritos',      route: '/(tabs)/favoritos' },
  { icon: 'notifications-outline', label: 'Notificaciones', route: '/(tabs)/notificaciones' },
  { icon: 'headset-outline',    label: 'Contacto y soporte', route: '/soporte' },
  { icon: 'settings-outline',   label: 'Configuración',      route: '/configuracion' },
];

export default function PerfilScreen() {
  const { usuario, logout } = useAuth();
  const router = useRouter();
  const [resumen, setResumen] = useState({ bolsas_rescatadas: 0, total_ahorrado: 0 });

  useEffect(() => {
    // Puntos desactivados por el momento: no refrescar perfil (evita cargar puntos innecesariamente)
    // authAPI.perfil().then((res) => actualizarUsuario(res.data)).catch(() => {});
    pedidosAPI.getResumenCliente().then(({ data }) => setResumen(data)).catch(() => {});
  }, []);

  async function handleLogout() {
    if (Platform.OS === 'web') {
      if ((window as any).confirm('¿Seguro que quieres cerrar sesión?')) {
        await logout();
        router.replace('/login');
      }
      return;
    }
    Alert.alert('Cerrar sesión', '¿Seguro que quieres salir?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Salir', style: 'destructive', onPress: async () => { await logout(); router.replace('/login'); } },
    ]);
  }

  if (!usuario) return <View style={s.loadingBox}><ActivityIndicator color={Colors.primary} /></View>;

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
        </View>

        {/* Stats */}
        <Text style={s.sectionTitle}>Mi actividad</Text>
        <View style={s.statsRow}>
          {[
            { icon: 'bag-outline', val: resumen.bolsas_rescatadas, label: 'Bolsas\nrescatadas', color: Colors.primary },
            { icon: 'wallet-outline', val: `Q${resumen.total_ahorrado.toFixed(2)}`, label: 'Total\nahorrado', color: Colors.textSecondary },
          ].map((stat) => (
            <View key={stat.label} style={s.statCard}>
              <Ionicons name={stat.icon as any} size={22} color={stat.color} />
              <Text style={[s.statVal, { color: stat.color }]}>{stat.val}</Text>
              <Text style={s.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>


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

  profileCard: { backgroundColor: Colors.white, borderRadius: 28, padding: 28, alignItems: 'center', marginBottom: 16, elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.09, shadowRadius: 14 },
  avatarCircle: { width: 96, height: 96, borderRadius: 48, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  avatarText: { fontSize: 36, fontWeight: '900', color: Colors.white },
  nombre: { fontSize: 26, fontWeight: '900', color: Colors.textPrimary },
  email: { fontSize: 13, color: Colors.textSecondary, marginTop: 4 },

  sectionTitle: { fontSize: 20, fontWeight: '900', color: Colors.textPrimary, marginBottom: 14 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: Colors.white, borderRadius: 20, padding: 16, alignItems: 'center', gap: 7, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.08, shadowRadius: 10 },
  statVal: { fontSize: 20, fontWeight: '900' },
  statLabel: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center', lineHeight: 14 },



  menuCard: { backgroundColor: Colors.white, borderRadius: 24, overflow: 'hidden', marginBottom: 16, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 18, gap: 14 },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  menuIconBox: { width: 42, height: 42, borderRadius: 14, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center' },
  menuLabel: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '600' },

  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: Colors.error, borderRadius: 50, paddingVertical: 16, marginBottom: 16 },
  logoutText: { color: Colors.error, fontWeight: '800', fontSize: 15 },
  version: { textAlign: 'center', fontSize: 12, color: Colors.textLight },
});
