import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Dimensions, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { promocionesAPI } from '@/src/services/api';

const GOLD = '#C8960C';
const YELLOW = '#FFD600';
const DARK = '#0A2A2A';
const { width: SW } = Dimensions.get('window');
const CARD_W = Math.floor((SW - 48) / 2);
const CARD_H = 255;
const CARD_IMG_H = 140;

const CATEGORIAS = [
  'Todos', 'Panadería', 'Restaurante', 'Cafetería',
  'Supermercado', 'Sushi', 'Pizza', 'Comida Típica',
];

function PromoCard({ bolsa, onPress }: { bolsa: any; onPress: () => void }) {
  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const agotada = bolsa.cantidad_disponible === 0;
  console.log('[PROMOS] imagen_url:', bolsa.imagen_url || '(sin imagen)');

  return (
    <TouchableOpacity
      style={[s.promoCard, { width: CARD_W, height: CARD_H }, agotada && { opacity: 0.45 }]}
      onPress={onPress}
      activeOpacity={0.88}
    >
      <View style={[s.promoImgWrap, { height: CARD_IMG_H }]}>
        {bolsa.imagen_url ? (
          <Image source={{ uri: bolsa.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#F5F0EB', justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={{ fontSize: 38 }}>🏷️</Text>
          </View>
        )}
        {desc > 0 && (
          <View style={s.discBadge}>
            <Text style={s.discText}>{desc}% DTO</Text>
          </View>
        )}
      </View>
      <View style={s.promoInfo}>
        <Text style={s.negocioLabel} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
        <Text style={s.promoNombre} numberOfLines={2}>{bolsa.nombre}</Text>
        <View style={s.precioRow}>
          <View>
            <Text style={s.precioOriginal}>Q{bolsa.precio_original?.toFixed(2)}</Text>
            <Text style={s.precioDescuento}>Q{bolsa.precio_descuento?.toFixed(2)}</Text>
          </View>
          {!agotada && (
            <TouchableOpacity style={s.addBtn} onPress={onPress}>
              <Ionicons name="add" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function PromocionesScreen() {
  const [bolsas, setBolsas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [catSelected, setCatSelected] = useState('Todos');
  const router = useRouter();

  const cargar = useCallback(async () => {
    try {
      const res = await promocionesAPI.listar();
      setBolsas(res.data || []);
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const filtradas = catSelected === 'Todos'
    ? bolsas
    : bolsas.filter(b => b.negocios?.categoria === catSelected);

  const destacada = filtradas.reduce((best: any, b: any) => {
    const d = b.precio_original > 0 ? (1 - b.precio_descuento / b.precio_original) : 0;
    const dBest = best && best.precio_original > 0 ? (1 - best.precio_descuento / best.precio_original) : 0;
    return d > dBest ? b : best;
  }, null);

  function renderGrid(items: any[]) {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push(
        <View key={i} style={s.gridRow}>
          <PromoCard bolsa={items[i]} onPress={() => router.push(`/negocio/${items[i].negocio_id}` as any)} />
          {items[i + 1]
            ? <PromoCard bolsa={items[i + 1]} onPress={() => router.push(`/negocio/${items[i + 1].negocio_id}` as any)} />
            : <View style={{ width: CARD_W }} />
          }
        </View>
      );
    }
    return rows;
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Promociones</Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />
        }
      >
        {/* CATEGORY CHIPS */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow}>
          {CATEGORIAS.map(cat => (
            <TouchableOpacity
              key={cat}
              style={[s.chip, catSelected === cat && s.chipActive]}
              onPress={() => setCatSelected(cat)}
            >
              <Text style={[s.chipText, catSelected === cat && s.chipTextActive]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {loading ? (
          <View style={s.loadingBox}>
            <ActivityIndicator color={GOLD} size="large" />
            <Text style={s.loadingText}>Cargando promociones...</Text>
          </View>
        ) : (
          <>
            {/* BANNER DESTACADO */}
            {destacada && (
              <TouchableOpacity
                style={s.banner}
                onPress={() => router.push(`/negocio/${destacada.negocio_id}` as any)}
                activeOpacity={0.9}
              >
                <View style={s.bannerLeft}>
                  <View style={s.bannerSavePill}>
                    <Text style={s.bannerSaveText}>
                      Ahorra hasta {destacada.precio_original > 0
                        ? Math.round((1 - destacada.precio_descuento / destacada.precio_original) * 100) : 0}%
                    </Text>
                  </View>
                  <Text style={s.bannerNombre} numberOfLines={2}>{destacada.nombre}</Text>
                  <Text style={s.bannerNegocio}>{destacada.negocios?.nombre}</Text>
                </View>
                {destacada.imagen_url ? (
                  <Image source={{ uri: destacada.imagen_url }} style={s.bannerImg} contentFit="cover" />
                ) : (
                  <View style={[s.bannerImg, { backgroundColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' }]}>
                    <Text style={{ fontSize: 40 }}>🏷️</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}

            {/* GRID */}
            {filtradas.length > 0 ? (
              <View style={s.gridContainer}>
                {renderGrid(filtradas)}
              </View>
            ) : (
              <View style={s.emptyState}>
                <Text style={{ fontSize: 48 }}>🏷️</Text>
                <Text style={s.emptyTitle}>Sin promociones</Text>
                <Text style={s.emptySub}>
                  {catSelected !== 'Todos'
                    ? `No hay promociones en ${catSelected} ahora`
                    : 'No hay promociones disponibles en este momento'}
                </Text>
              </View>
            )}
          </>
        )}

        <View style={{ height: 110 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },

  header: {
    paddingHorizontal: 20, paddingVertical: 16, backgroundColor: '#FFFFFF',
    borderBottomWidth: 1, borderBottomColor: '#D8E4E4',
  },
  headerTitle: { fontSize: 24, fontWeight: '900', color: DARK },

  chipsRow: { paddingHorizontal: 20, paddingVertical: 14, gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 50, backgroundColor: '#F4F7F7', borderWidth: 1.5, borderColor: '#D8E4E4' },
  chipActive: { backgroundColor: DARK, borderColor: DARK },
  chipText: { fontSize: 13, fontWeight: '700', color: '#5A7070' },
  chipTextActive: { color: '#FFFFFF' },

  loadingBox: { paddingVertical: 60, alignItems: 'center', gap: 16 },
  loadingText: { color: '#5A7070', fontSize: 14 },

  banner: {
    flexDirection: 'row', backgroundColor: GOLD, borderRadius: 20,
    marginHorizontal: 16, marginBottom: 20, padding: 20, overflow: 'hidden',
    alignItems: 'center', minHeight: 120,
  },
  bannerLeft: { flex: 1, marginRight: 12 },
  bannerSavePill: { backgroundColor: YELLOW, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 50, alignSelf: 'flex-start', marginBottom: 8 },
  bannerSaveText: { fontSize: 12, fontWeight: '800', color: DARK },
  bannerNombre: { fontSize: 18, fontWeight: '900', color: '#FFFFFF', lineHeight: 22, marginBottom: 6 },
  bannerNegocio: { fontSize: 12, color: 'rgba(10,42,42,0.7)', fontWeight: '600' },
  bannerImg: { width: 90, height: 90, borderRadius: 16 },

  gridContainer: { paddingHorizontal: 16, paddingTop: 4 },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },

  promoCard: { backgroundColor: '#FFFFFF', borderRadius: 20, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  promoImgWrap: { backgroundColor: '#F4F7F7', justifyContent: 'center', alignItems: 'center' },
  discBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: DARK, borderRadius: 50, paddingHorizontal: 9, paddingVertical: 4 },
  discText: { color: GOLD, fontSize: 10, fontWeight: '900' },
  promoInfo: { padding: 12 },
  negocioLabel: { fontSize: 10, color: '#5A7070', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  promoNombre: { fontSize: 13, fontWeight: '800', color: DARK, lineHeight: 18, marginBottom: 8 },
  precioRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  precioOriginal: { fontSize: 10, color: '#5A7070', textDecorationLine: 'line-through' },
  precioDescuento: { fontSize: 18, fontWeight: '900', color: GOLD },
  addBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: DARK, alignItems: 'center', justifyContent: 'center' },

  emptyState: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: DARK, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#5A7070', textAlign: 'center', marginTop: 6, lineHeight: 20 },
});
