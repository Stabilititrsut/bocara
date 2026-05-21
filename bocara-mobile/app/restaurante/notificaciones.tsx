import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { notificacionesAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const TIPO_CONFIG: Record<string, { emoji: string; color: string }> = {
  negocio_aprobado:  { emoji: '🎉', color: '#22C55E' },
  negocio_rechazado: { emoji: '❌', color: '#EF4444' },
  bolsa_aprobada:    { emoji: '✅', color: '#22C55E' },
  bolsa_rechazada:   { emoji: '❌', color: '#EF4444' },
  nuevo_pedido:      { emoji: '🛍️', color: Colors.orange },
  pedido_listo:      { emoji: '🔔', color: Colors.orange },
  default:           { emoji: '📬', color: Colors.textSecondary },
};

export default function RestauranteNotificacionesScreen() {
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollingRef = useRef<any>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await notificacionesAPI.listar();
      setNotifs(res.data || []);
    } catch { setNotifs([]); } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    cargar();
    pollingRef.current = setInterval(cargar, 30000);
    return () => clearInterval(pollingRef.current);
  }, [cargar]);

  async function marcarLeida(id: string) {
    try {
      await notificacionesAPI.marcarLeida(id);
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, leida: true } : n));
    } catch { }
  }

  const sinLeer = notifs.filter(n => !n.leida).length;

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Notificaciones</Text>
        {sinLeer > 0 && (
          <View style={s.badge}><Text style={s.badgeText}>{sinLeer}</Text></View>
        )}
      </View>

      {notifs.length === 0 ? (
        <View style={s.empty}>
          <Text style={{ fontSize: 48 }}>📭</Text>
          <Text style={s.emptyTitle}>Sin notificaciones</Text>
          <Text style={s.emptyText}>Aquí verás aprobaciones, pedidos nuevos y avisos del equipo Bocara</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {notifs.map((n) => {
            const cfg = TIPO_CONFIG[n.tipo] || TIPO_CONFIG.default;
            return (
              <TouchableOpacity
                key={n.id}
                style={[s.card, !n.leida && s.cardUnread]}
                onPress={() => !n.leida && marcarLeida(n.id)}
                activeOpacity={0.85}
              >
                <View style={[s.iconBox, { backgroundColor: cfg.color + '20' }]}>
                  <Text style={{ fontSize: 22 }}>{cfg.emoji}</Text>
                </View>
                <View style={s.cardContent}>
                  <View style={s.cardTop}>
                    <Text style={s.cardTitulo} numberOfLines={1}>{n.titulo}</Text>
                    {!n.leida && <View style={s.unreadDot} />}
                  </View>
                  <Text style={s.cardCuerpo} numberOfLines={3}>{n.cuerpo || n.mensaje}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingTop: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown, flex: 1 },
  badge: { backgroundColor: Colors.orange, borderRadius: 12, minWidth: 24, height: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '900' },
  scroll: { padding: 16 },
  card: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 10, elevation: 1 },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: Colors.orange },
  iconBox: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  cardContent: { flex: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardTitulo: { fontSize: 14, fontWeight: '800', color: Colors.brown, flex: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.orange },
  cardCuerpo: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
