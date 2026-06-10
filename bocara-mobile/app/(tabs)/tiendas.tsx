import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { negociosAPI, favoritosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const CATEGORIAS_FILTER = [
  'Todas', 'Panadería', 'Restaurante', 'Cafetería',
  'Supermercado', 'Sushi', 'Pizza', 'Comida Típica', 'Otros',
];

export default function TiendasScreen() {
  const router = useRouter();
  const [negocios,   setNegocios]   = useState<any[]>([]);
  const [favIds,     setFavIds]     = useState<Set<string>>(new Set());
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [catFilter,  setCatFilter]  = useState('Todas');

  const cargar = useCallback(async () => {
    try {
      const [feedRes, favRes] = await Promise.all([
        negociosAPI.feed(),
        favoritosAPI.listar().catch(() => ({ data: [] })),
      ]);
      setNegocios(feedRes.data || []);
      setFavIds(new Set((favRes.data || []).map((f: any) => f.negocio_id)));
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function toggleFav(negocioId: string) {
    const isFav = favIds.has(negocioId);
    // Optimistic update
    setFavIds(prev => {
      const next = new Set(prev);
      if (isFav) next.delete(negocioId); else next.add(negocioId);
      return next;
    });
    try {
      if (isFav) await favoritosAPI.quitar(negocioId);
      else       await favoritosAPI.agregar(negocioId);
    } catch {
      // Rollback on error
      setFavIds(prev => {
        const next = new Set(prev);
        if (isFav) next.add(negocioId); else next.delete(negocioId);
        return next;
      });
    }
  }

  const filtrados = catFilter === 'Todas'
    ? negocios
    : negocios.filter(n =>
        (n.categoria || '').toLowerCase().trim() === catFilter.toLowerCase().trim()
      );

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
          <Text style={s.headerSub}>{filtrados.length} restaurante{filtrados.length !== 1 ? 's' : ''}</Text>
        </View>
      </View>

      {/* Filtros de categoría */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.filterRow}
        contentContainerStyle={s.filterContent}
      >
        {CATEGORIAS_FILTER.map(cat => (
          <TouchableOpacity
            key={cat}
            style={[s.chip, catFilter === cat && s.chipActive]}
            onPress={() => setCatFilter(cat)}
            activeOpacity={0.8}
          >
            <Text style={[s.chipText, catFilter === cat && s.chipTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); cargar(); }}
            tintColor={Colors.primary}
          />
        }
      >
        {filtrados.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="storefront-outline" size={40} color={Colors.textLight} />
            <Text style={s.emptyTitle}>Sin tiendas</Text>
            <Text style={s.emptyText}>
              {catFilter === 'Todas'
                ? 'No hay restaurantes disponibles ahora'
                : `No hay restaurantes en "${catFilter}" ahora`}
            </Text>
            {catFilter !== 'Todas' && (
              <TouchableOpacity style={s.emptyBtn} onPress={() => setCatFilter('Todas')}>
                <Text style={s.emptyBtnText}>Ver todas</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filtrados.map((n) => {
            const rating = n.calificacion_promedio || 0;
            const isFav  = favIds.has(n.id);

            return (
              <TouchableOpacity
                key={n.id}
                style={s.card}
                onPress={() => {
                  console.log('[tiendas] abrir tienda:', n.id, n.nombre);
                  router.push(`/tienda/${n.id}` as any);
                }}
                activeOpacity={0.88}
              >
                {/* Imagen */}
                <View style={s.cardImgWrap}>
                  {n.imagen_url ? (
                    <Image
                      source={{ uri: n.imagen_url }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      transition={200}
                    />
                  ) : (
                    <View style={[StyleSheet.absoluteFill, s.imgPlaceholder]}>
                      <Text style={{ fontSize: 32 }}>🏪</Text>
                    </View>
                  )}
                  {n.max_descuento > 0 && (
                    <View style={s.discBadge}>
                      <Text style={s.discBadgeText}>-{n.max_descuento}%</Text>
                    </View>
                  )}
                </View>

                {/* Info */}
                <View style={s.cardInfo}>
                  <Text style={s.cardNombre} numberOfLines={1}>{n.nombre}</Text>
                  {n.categoria ? (
                    <Text style={s.cardCat}>{n.categoria}</Text>
                  ) : null}
                  <View style={s.cardMeta}>
                    <Ionicons name="star" size={12} color={Colors.accent} />
                    <Text style={s.ratingText}>
                      {rating > 0 ? rating.toFixed(1) : 'Nuevo'}
                    </Text>
                    <View style={s.metaSep} />
                    <Text style={s.countText}>
                      {n.cantidad_bolsas} producto{n.cantidad_bolsas !== 1 ? 's' : ''}
                    </Text>
                    {n.zona ? (
                      <>
                        <View style={s.metaSep} />
                        <Text style={s.zonaText}>Zona {n.zona}</Text>
                      </>
                    ) : null}
                  </View>
                </View>

                {/* Botón favorito — TouchableOpacity separado para no disparar el card */}
                <TouchableOpacity
                  style={s.favBtn}
                  onPress={() => toggleFav(n.id)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isFav ? 'heart' : 'heart-outline'}
                    size={20}
                    color={isFav ? '#EF4444' : Colors.textLight}
                  />
                </TouchableOpacity>

                <Ionicons name="chevron-forward" size={16} color={Colors.textLight} style={{ marginRight: 12 }} />
              </TouchableOpacity>
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

  header: {
    paddingHorizontal: 20, paddingVertical: 18,
    backgroundColor: Colors.white,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 3 },

  filterRow: { maxHeight: 52, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  filterContent: { paddingHorizontal: 20, paddingVertical: 10, gap: 8 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 50, paddingHorizontal: 16, paddingVertical: 7 },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  scroll: { padding: 16 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.white, borderRadius: 20,
    marginBottom: 14, overflow: 'hidden',
    elevation: 3, shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10,
  },
  cardImgWrap: { width: 84, height: 84, backgroundColor: Colors.surface },
  imgPlaceholder: { justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface },
  discBadge: {
    position: 'absolute', top: 8, left: 8,
    backgroundColor: Colors.primary, borderRadius: 50,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  discBadgeText: { color: Colors.white, fontSize: 9, fontWeight: '900' },

  cardInfo: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  cardCat: {
    fontSize: 10, color: Colors.textSecondary, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
  },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  ratingText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  metaSep: { width: 3, height: 3, borderRadius: 2, backgroundColor: Colors.textLight },
  countText: { fontSize: 12, color: Colors.textSecondary },
  zonaText: { fontSize: 12, color: Colors.textLight },

  favBtn: { padding: 8, marginLeft: 4 },

  empty: { paddingTop: 80, alignItems: 'center', gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyBtn: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 24, paddingVertical: 10, marginTop: 4 },
  emptyBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
});
