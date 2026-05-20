import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { notificacionesAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

interface Notificacion {
  id: string;
  titulo: string;
  mensaje: string;
  leida: boolean;
  tipo: string;
  created_at: string;
}

const TIPO_CONFIG: Record<string, { icon: string; color: string; bg: string }> = {
  nuevo_pedido: { icon: 'bag',           color: Colors.primary,   bg: Colors.accentLight },
  pedido_listo: { icon: 'checkmark-circle', color: Colors.accent, bg: Colors.accentLight },
  promo:        { icon: 'pricetag',      color: '#FF9800',        bg: '#FFF3E0' },
  sistema:      { icon: 'settings',     color: Colors.textSecondary, bg: Colors.surface },
  bienvenida:   { icon: 'leaf',         color: Colors.primary,   bg: Colors.accentLight },
};

function formatFecha(iso: string) {
  return new Date(iso).toLocaleDateString('es-GT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function NotificacionesScreen() {
  const [notifs, setNotifs] = useState<Notificacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await notificacionesAPI.listar();
      setNotifs(res.data || []);
    } catch {
      setNotifs([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function marcarLeida(id: string) {
    try {
      await notificacionesAPI.marcarLeida(id);
      setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, leida: true } : n));
    } catch {}
  }

  const sinLeer = notifs.filter((n) => !n.leida).length;

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Notificaciones</Text>
        </View>
        <View style={s.loadingBox}><ActivityIndicator color={Colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Notificaciones</Text>
          {sinLeer > 0 && <Text style={s.headerSub}>{sinLeer} sin leer</Text>}
        </View>
        {sinLeer > 0 && (
          <View style={s.sinLeerBadge}>
            <Text style={s.sinLeerText}>{sinLeer}</Text>
          </View>
        )}
      </View>

      {notifs.length === 0 ? (
        <View style={s.empty}>
          <View style={s.emptyIconWrap}>
            <Ionicons name="notifications-outline" size={40} color={Colors.textLight} />
          </View>
          <Text style={s.emptyTitle}>Sin notificaciones</Text>
          <Text style={s.emptyText}>Aquí aparecerán avisos sobre tus pedidos, bolsas disponibles y ofertas especiales</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {notifs.map((n) => {
            const cfg = TIPO_CONFIG[n.tipo] || TIPO_CONFIG.sistema;
            return (
              <TouchableOpacity
                key={n.id}
                style={[s.card, !n.leida && s.cardUnread]}
                onPress={() => !n.leida && marcarLeida(n.id)}
                activeOpacity={0.85}
              >
                <View style={[s.iconBox, { backgroundColor: cfg.bg }]}>
                  <Ionicons name={cfg.icon as any} size={22} color={cfg.color} />
                </View>
                <View style={s.content}>
                  <Text style={[s.titulo, !n.leida && s.tituloUnread]}>{n.titulo}</Text>
                  <Text style={s.mensaje} numberOfLines={2}>{n.mensaje}</Text>
                  <Text style={s.fecha}>{formatFecha(n.created_at)}</Text>
                </View>
                {!n.leida && <View style={[s.dot, { backgroundColor: cfg.color }]} />}
              </TouchableOpacity>
            );
          })}
          <View style={{ height: 30 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16,
    backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  headerSub: { fontSize: 12, color: Colors.primary, fontWeight: '600', marginTop: 2 },
  sinLeerBadge: { backgroundColor: Colors.primary, borderRadius: 14, minWidth: 28, height: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  sinLeerText: { color: Colors.white, fontSize: 13, fontWeight: '800' },

  scroll: { padding: 16 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.white, borderRadius: 18, padding: 14, marginBottom: 10,
    elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6,
  },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: Colors.primary },
  iconBox: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  content: { flex: 1 },
  titulo: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  tituloUnread: { fontWeight: '800' },
  mensaje: { fontSize: 13, color: Colors.textSecondary, marginTop: 3, lineHeight: 18 },
  fecha: { fontSize: 11, color: Colors.textLight, marginTop: 5 },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 10 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 32 },
  emptyIconWrap: { width: 90, height: 90, borderRadius: 45, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
