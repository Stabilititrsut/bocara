import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet,
  SafeAreaView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { favoritosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const EMOJI_MAP: Record<string, string> = {
  Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒',
  Sushi: '🍣', Pizza: '🍕', 'Comida Típica': '🫕', Otro: '🍱',
};

export default function FavoritosScreen() {
  const [favoritos, setFavoritos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await favoritosAPI.listar();
      setFavoritos(res.data || []);
    } catch {
      setFavoritos([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) {
    return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>❤️ Mis favoritos</Text>
      </View>

      {favoritos.length === 0 ? (
        <View style={s.empty}>
          <Text style={{ fontSize: 52 }}>❤️</Text>
          <Text style={s.emptyTitle}>Sin favoritos aún</Text>
          <Text style={s.emptyText}>Guarda tus negocios favoritos tocando el corazón en cada bolsa</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {favoritos.map((fav) => {
            const negocio = fav.negocios || fav;
            const emoji = EMOJI_MAP[negocio.categoria] || '🍱';
            return (
              <View key={fav.id} style={s.card}>
                <View style={s.cardImg}>
                  {negocio.imagen_url ? (
                    <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
                  ) : (
                    <Text style={{ fontSize: 36 }}>{emoji}</Text>
                  )}
                </View>
                <View style={s.cardBody}>
                  <Text style={s.cardNombre}>{negocio.nombre}</Text>
                  <Text style={s.cardMeta}>{emoji} {negocio.categoria}</Text>
                  <Text style={s.cardZona}>📍 {negocio.zona}</Text>
                  {(negocio.calificacion_promedio || 0) > 0 && (
                    <Text style={s.cardRating}>⭐ {Number(negocio.calificacion_promedio).toFixed(1)}</Text>
                  )}
                </View>
                <Text style={s.heart}>❤️</Text>
              </View>
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
  header: {
    padding: 20, paddingTop: 16, backgroundColor: Colors.white,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scroll: { padding: 16 },
  card: {
    flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 16,
    marginBottom: 12, elevation: 2, overflow: 'hidden', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4,
  },
  cardImg: {
    width: 80, height: 80, backgroundColor: Colors.brownLight,
    justifyContent: 'center', alignItems: 'center',
  },
  cardBody: { flex: 1, padding: 12 },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginBottom: 4 },
  cardMeta: { fontSize: 12, color: Colors.textSecondary, marginBottom: 2 },
  cardZona: { fontSize: 12, color: Colors.textSecondary, marginBottom: 2 },
  cardRating: { fontSize: 12, color: Colors.orange, fontWeight: '700' },
  heart: { fontSize: 20, paddingRight: 14 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
