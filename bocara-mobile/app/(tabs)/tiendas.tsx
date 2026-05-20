import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { bolsasAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const CATEGORIAS_FILTER = ['Todas', 'Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica'];

export default function TiendasScreen() {
  const [bolsas, setBolsas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [catFilter, setCatFilter] = useState('Todas');

  async function cargar() {
    try {
      const res = await bolsasAPI.listar({ activo: true });
      setBolsas(res.data || []);
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { cargar(); }, []);

  // Build unique restaurant map
  const restaurantesMap = new Map<string, { negocio: any; count: number }>();
  bolsas.forEach(b => {
    if (b.negocios?.nombre) {
      const entry = restaurantesMap.get(b.negocios.nombre);
      if (entry) entry.count++;
      else restaurantesMap.set(b.negocios.nombre, { negocio: b.negocios, count: 1 });
    }
  });
  const todos = Array.from(restaurantesMap.values())
    .sort((a, b) => (b.negocio.calificacion_promedio || 0) - (a.negocio.calificacion_promedio || 0));
  const restaurantes = catFilter === 'Todas'
    ? todos
    : todos.filter(({ negocio }) => negocio.categoria === catFilter);

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={s.headerTitle}>Tiendas</Text></View>
        <View style={s.loadingBox}><ActivityIndicator color={Colors.primary} size="large" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Tiendas</Text>
          <Text style={s.headerSub}>{restaurantes.length} restaurante{restaurantes.length !== 1 ? 's' : ''}</Text>
        </View>
      </View>

      {/* Category filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
        {CATEGORIAS_FILTER.map(cat => (
          <TouchableOpacity key={cat} style={[s.chip, catFilter === cat && s.chipActive]} onPress={() => setCatFilter(cat)}>
            <Text style={[s.chipText, catFilter === cat && s.chipTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.primary} />}
      >
        {restaurantes.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="storefront-outline" size={40} color={Colors.textLight} />
            <Text style={s.emptyTitle}>Sin tiendas</Text>
            <Text style={s.emptyText}>No hay restaurantes activos en esta categoría</Text>
          </View>
        ) : (
          restaurantes.map(({ negocio, count }) => {
            const rating = negocio.calificacion_promedio || 0;
            return (
              <View key={negocio.nombre} style={s.card}>
                <View style={s.cardImgWrap}>
                  {negocio.imagen_url ? (
                    <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
                  ) : (
                    <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface }]}>
                      <Text style={{ fontSize: 36 }}>🏪</Text>
                    </View>
                  )}
                </View>
                <View style={s.cardInfo}>
                  <Text style={s.cardNombre} numberOfLines={1}>{negocio.nombre}</Text>
                  {negocio.categoria && <Text style={s.cardCat}>{negocio.categoria}</Text>}
                  <View style={s.cardMeta}>
                    <View style={s.ratingRow}>
                      <Ionicons name="star" size={13} color={Colors.accent} />
                      <Text style={s.ratingText}>{rating > 0 ? rating.toFixed(1) : 'Nuevo'}</Text>
                    </View>
                    <View style={s.metaSep} />
                    <Text style={s.countText}>{count} bolsa{count !== 1 ? 's' : ''}</Text>
                    {negocio.zona && <>
                      <View style={s.metaSep} />
                      <Text style={s.zonaText}>{negocio.zona}</Text>
                    </>}
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
              </View>
            );
          })
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: { paddingHorizontal: 20, paddingVertical: 18, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 3 },

  filterRow: { maxHeight: 52, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  filterContent: { paddingHorizontal: 20, paddingVertical: 10, gap: 8 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 50, paddingHorizontal: 16, paddingVertical: 7 },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  scroll: { padding: 20 },

  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white, borderRadius: 20, marginBottom: 14, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  cardImgWrap: { width: 84, height: 84, backgroundColor: Colors.surface },
  cardInfo: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginBottom: 3 },
  cardCat: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  ratingText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  metaSep: { width: 3, height: 3, borderRadius: 2, backgroundColor: Colors.textLight },
  countText: { fontSize: 12, color: Colors.textSecondary },
  zonaText: { fontSize: 12, color: Colors.textLight },

  empty: { paddingTop: 80, alignItems: 'center', gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
