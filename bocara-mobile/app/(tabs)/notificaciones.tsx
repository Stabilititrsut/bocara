import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { notificacionesAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const TIPO_CONFIG: Record<string, { emoji: string; color: string }> = {
  pago_confirmado:     { emoji: '✅', color: '#22C55E' },
  nuevo_pedido:        { emoji: '🛍️', color: Colors.orange },
  pedido_listo:        { emoji: '🔔', color: Colors.orange },
  bolsa_recogida:      { emoji: '⭐', color: '#F5A623' },
  recordatorio_recogida: { emoji: '⏰', color: '#3B82F6' },
  nueva_bolsa:         { emoji: '🥡', color: Colors.orange },
  default:             { emoji: '📬', color: Colors.textSecondary },
};

function NotifCard({ notif, onMarcar }: { notif: any; onMarcar: (id: string) => void }) {
  const cfg = TIPO_CONFIG[notif.tipo] || TIPO_CONFIG.default;
  const fecha = new Date(notif.created_at || notif.creado_en);
  const fechaStr = isNaN(fecha.getTime()) ? '' : fecha.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <TouchableOpacity
      style={[s.card, !notif.leida && s.cardUnread]}
      onPress={() => !notif.leida && onMarcar(notif.id)}
      activeOpacity={0.85}
    >
      <View style={[s.iconBox, { backgroundColor: cfg.color + '20' }]}>
        <Text style={{ fontSize: 22 }}>{cfg.emoji}</Text>
      </View>
      <View style={s.cardContent}>
        <View style={s.cardTop}>
          <Text style={s.cardTitulo} numberOfLines={1}>{notif.titulo}</Text>
          {!notif.leida && <View style={s.unreadDot} />}
        </View>
        <Text style={s.cardMensaje} numberOfLines={2}>{notif.mensaje}</Text>
        <Text style={s.cardFecha}>{fechaStr}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function NotificacionesScreen() {
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await notificacionesAPI.listar();
      setNotifs(res.data || []);
    } catch { setNotifs([]); } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function marcarLeida(id: string) {
    try {
      await notificacionesAPI.marcarLeida(id);
      setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, leida: true } : n));
    } catch { }
  }

  const sinLeer = notifs.filter((n) => !n.leida).length;

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

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
          <Text style={{ fontSize: 48 }}>📭</Text>
          <Text style={s.emptyTitle}>Sin notificaciones</Text>
          <Text style={s.emptyText}>Aquí verás tus pedidos confirmados, recordatorios y más</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {sinLeer > 0 && (
            <Text style={s.sectionLabel}>Sin leer ({sinLeer})</Text>
          )}
          {notifs.filter((n) => !n.leida).map((n) => (
            <NotifCard key={n.id} notif={n} onMarcar={marcarLeida} />
          ))}
          {notifs.some((n) => n.leida) && (
            <Text style={[s.sectionLabel, { marginTop: 16 }]}>Anteriores</Text>
          )}
          {notifs.filter((n) => n.leida).map((n) => (
            <NotifCard key={n.id} notif={n} onMarcar={marcarLeida} />
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
  header: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingTop: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown, flex: 1 },
  badge: { backgroundColor: Colors.orange, borderRadius: 12, minWidth: 24, height: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '900' },
  scroll: { padding: 16 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: Colors.textLight, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
  card: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 10, elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4 },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: Colors.orange },
  iconBox: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  cardContent: { flex: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardTitulo: { fontSize: 14, fontWeight: '800', color: Colors.brown, flex: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.orange },
  cardMensaje: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  cardFecha: { fontSize: 11, color: Colors.textLight, marginTop: 6 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
