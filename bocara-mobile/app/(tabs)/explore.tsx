import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
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

const TIPO_EMOJI: Record<string, string> = {
  nuevo_pedido: '📦',
  pedido_listo: '🔔',
  promo: '🎫',
  sistema: '⚙️',
  bienvenida: '🌱',
};

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
    return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Notificaciones</Text>
        {sinLeer > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{sinLeer}</Text>
          </View>
        )}
      </View>

      {notifs.length === 0 ? (
        <View style={s.empty}>
          <Text style={{ fontSize: 52 }}>🔔</Text>
          <Text style={s.emptyTitle}>Sin notificaciones</Text>
          <Text style={s.emptyText}>Aquí aparecerán avisos sobre tus pedidos, bolsas disponibles y ofertas especiales</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {notifs.map((n) => (
            <TouchableOpacity
              key={n.id}
              style={[s.card, !n.leida && s.cardUnread]}
              onPress={() => !n.leida && marcarLeida(n.id)}
              activeOpacity={0.85}
            >
              <View style={[s.iconBox, !n.leida && s.iconBoxUnread]}>
                <Text style={{ fontSize: 22 }}>{TIPO_EMOJI[n.tipo] || '🔔'}</Text>
              </View>
              <View style={s.content}>
                <Text style={[s.titulo, !n.leida && s.tituloUnread]}>{n.titulo}</Text>
                <Text style={s.mensaje} numberOfLines={2}>{n.mensaje}</Text>
                <Text style={s.fecha}>{new Date(n.created_at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
              </View>
              {!n.leida && <View style={s.dot} />}
            </TouchableOpacity>
          ))}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 20, paddingTop: 16,
    backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown, flex: 1 },
  badge: {
    backgroundColor: Colors.orange, borderRadius: 12, minWidth: 24, height: 24,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  scroll: { padding: 16 },
  card: {
    flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14,
    padding: 14, marginBottom: 10, alignItems: 'center', elevation: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4,
  },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: Colors.orange },
  iconBox: {
    backgroundColor: Colors.brownLight, borderRadius: 10,
    width: 46, height: 46, alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  iconBoxUnread: { backgroundColor: Colors.orangeLight },
  content: { flex: 1 },
  titulo: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  tituloUnread: { fontWeight: '800', color: Colors.brown },
  mensaje: { fontSize: 13, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },
  fecha: { fontSize: 11, color: Colors.textLight, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.orange, marginLeft: 8 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
