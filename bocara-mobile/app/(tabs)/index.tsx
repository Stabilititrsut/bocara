import { useEffect, useState, useCallback } from 'react';
import { getCache, setCache } from '@/src/utils/cache';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView, Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { negociosAPI, notificacionesAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';
import { useLocation } from '@/src/context/LocationContext';
import { useCart } from '@/src/context/CartContext';

const { width: SW } = Dimensions.get('window');
const CARD_W = Math.floor((SW - 52) / 2);
const CARD_H = 210;
const CARD_IMG_H = 120;

const CATEGORIAS = [
  { label: 'Todos',          emoji: '✨', bg: '#F8FAF8' },
  { label: 'Panadería',     emoji: '🥐', bg: '#FFF3E0' },
  { label: 'Restaurante',   emoji: '🍽️', bg: '#FCE4EC' },
  { label: 'Cafetería',     emoji: '☕', bg: '#EDE7F6' },
  { label: 'Supermercado',  emoji: '🛒', bg: '#F1F8E9' },
  { label: 'Sushi',         emoji: '🍣', bg: '#E3F2FD' },
  { label: 'Pizza',         emoji: '🍕', bg: '#FFF8E1' },
  { label: 'Comida Típica', emoji: '🫕', bg: '#F3E5F5' },
  { label: 'Otros',         emoji: '📦', bg: '#E8F5E9' },
];

function NegocioCard({ negocio, onPress }: { negocio: any; onPress: () => void }) {
  const catEntry = CATEGORIAS.find(c => c.label === negocio.categoria);
  const catEmoji = catEntry?.emoji || '🏪';
  const catBg = catEntry?.bg || '#F8FAF8';

  return (
    <TouchableOpacity style={[s.negocioCard, { width: CARD_W, height: CARD_H }]} onPress={onPress} activeOpacity={0.88}>
      <View style={[s.negocioImgWrap, { height: CARD_IMG_H }]}>
        {negocio.imagen_url ? (
          <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: catBg, justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={{ fontSize: 36 }}>{catEmoji}</Text>
          </View>
        )}
        {negocio.max_descuento > 0 && (
          <View style={s.negocioDiscBadge}>
            <Text style={s.negocioDiscText}>-{negocio.max_descuento}%</Text>
          </View>
        )}
      </View>
      <View style={s.negocioInfo}>
        <Text style={s.negocioNombre} numberOfLines={1}>{negocio.nombre}</Text>
        {negocio.zona ? <Text style={s.negocioZona}>Zona {negocio.zona}</Text> : null}
        <Text style={s.negocioCount}>
          {negocio.cantidad_bolsas} disponible{negocio.cantidad_bolsas !== 1 ? 's' : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  const [negocios, setNegocios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorNet, setErrorNet] = useState('');
  const [catSelected, setCatSelected] = useState('Todos');
  const [sinLeerCount, setSinLeerCount] = useState(0);
  const router = useRouter();
  const { usuario } = useAuth();
  const { locationName, permissionStatus, requestPermission, loading: locLoading } = useLocation();
  const { cantidad: cantidadCarrito } = useCart();

  useEffect(() => {
    notificacionesAPI.listar().then((r) => {
      setSinLeerCount((r.data || []).filter((n: any) => !n.leida).length);
    }).catch(() => {});
  }, []);

  const cargar = useCallback(async () => {
    setErrorNet('');
    const cacheKey = 'negocios_feed';
    const cached = await getCache<any[]>(cacheKey);
    if (cached) { setNegocios(cached); setLoading(false); }
    try {
      const res = await negociosAPI.feed();
      const fresh = res.data || [];
      setNegocios(fresh);
      setCache(cacheKey, fresh);
    } catch (e: any) {
      if (!cached) {
        setNegocios([]);
        if (e.message?.includes('internet') || e.message?.includes('Network')) setErrorNet('Sin conexión.');
      }
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { setLoading(true); cargar(); }, [cargar]);

  const filtrados = catSelected === 'Todos'
    ? negocios
    : negocios.filter(n => n.categoria?.toLowerCase() === catSelected.toLowerCase());
  const totalDisponibles = negocios.reduce((sum, n) => sum + (n.cantidad_bolsas || 0), 0);

  const nombreCorto = usuario?.nombre ? usuario.nombre.split(' ')[0] : null;
  const locDenied = permissionStatus === 'denied';
  const tieneUbicacion = !!locationName;

  function renderGrid(items: any[]) {
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push(
        <View key={i} style={s.gridRow}>
          <NegocioCard negocio={items[i]} onPress={() => router.push(`/tienda/${items[i].id}` as any)} />
          {items[i + 1]
            ? <NegocioCard negocio={items[i + 1]} onPress={() => router.push(`/tienda/${items[i + 1].id}` as any)} />
            : <View style={{ width: CARD_W }} />
          }
        </View>
      );
    }
    return rows;
  }

  return (
    <SafeAreaView style={s.root}>
      {/* ── HEADER ── */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <TouchableOpacity style={s.avatar} onPress={() => router.push('/(tabs)/perfil')}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={s.avatarLogo}
              contentFit="cover"
            />
          </TouchableOpacity>
          <View>
            <Text style={s.greeting}>Hola, {nombreCorto || 'Bocara'} 👋</Text>
            <TouchableOpacity
              onPress={!tieneUbicacion && !locDenied ? requestPermission : undefined}
              style={s.locRow}
              activeOpacity={tieneUbicacion ? 1 : 0.7}
            >
              <Ionicons name="location" size={11} color={Colors.accent} />
              <Text style={s.locText} numberOfLines={1}>
                {locLoading ? 'Buscando...' : locationName || 'Guatemala'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={s.headerRight}>
          <TouchableOpacity style={s.headerIconBtn} onPress={() => router.push('/(tabs)/notificaciones' as any)}>
            <Ionicons name="notifications-outline" size={22} color={Colors.primary} />
            {sinLeerCount > 0 && <View style={s.notifDot} />}
          </TouchableOpacity>
          <TouchableOpacity style={s.headerIconBtn} onPress={() => router.push('/(tabs)/carrito' as any)}>
            <Ionicons name="bag-outline" size={22} color={Colors.primary} />
            {cantidadCarrito > 0 && (
              <View style={s.cartBadge}>
                <Text style={s.cartBadgeText}>{cantidadCarrito > 9 ? '9+' : cantidadCarrito}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* ── SCROLLABLE CONTENT ── */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.primary} />
        }
      >
        {/* SEARCH PILL */}
        <TouchableOpacity style={s.searchPill} onPress={() => router.push('/(tabs)/buscar' as any)} activeOpacity={0.8}>
          <Ionicons name="search-outline" size={17} color={Colors.textSecondary} />
          <Text style={s.searchPlaceholder}>Restaurantes, categorías, zonas...</Text>
          <View style={s.filterBtn}>
            <Ionicons name="options-outline" size={17} color={Colors.primary} />
          </View>
        </TouchableOpacity>

        {/* HERO BANNER */}
        <View style={s.heroBanner}>
          <View style={StyleSheet.absoluteFill}>
            <View style={s.heroDeco1} />
            <View style={s.heroDeco2} />
            <View style={s.heroDeco3} />
          </View>
          <View style={s.heroContent}>
            <Text style={s.heroTag}>Guatemala · Rescata comida</Text>
            <Text style={s.heroTitle}>Descubre más.{'\n'}Ahorra mejor.</Text>
            <TouchableOpacity style={s.heroCTA} onPress={() => router.push('/(tabs)/tiendas' as any)}>
              <Text style={s.heroCTAText}>Ver negocios</Text>
              <Ionicons name="arrow-forward" size={13} color={Colors.primary} />
            </TouchableOpacity>
          </View>
          <View style={s.heroCounter}>
            <Text style={s.heroCounterNum}>{totalDisponibles}</Text>
            <Text style={s.heroCounterLabel}>productos</Text>
          </View>
        </View>

        {/* CATEGORÍAS */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catRow} contentContainerStyle={s.catContent}>
          {CATEGORIAS.map(({ label, emoji, bg }) => {
            const active = catSelected === label;
            return (
              <TouchableOpacity key={label} style={s.catItem} onPress={() => setCatSelected(label)} activeOpacity={0.8}>
                <View style={[s.catCircle, { backgroundColor: active ? Colors.primary : bg }]}>
                  <Text style={s.catEmoji}>{emoji}</Text>
                </View>
                <Text style={[s.catLabel, active && s.catLabelActive]} numberOfLines={2}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {loading ? (
          <View style={s.loadingBox}>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={s.loadingText}>Buscando restaurantes...</Text>
          </View>
        ) : (
          <View style={s.feedContent}>
            {errorNet ? (
              <View style={s.alertBanner}>
                <Ionicons name="wifi-outline" size={14} color={Colors.error} />
                <Text style={s.alertText}>{errorNet}</Text>
                <TouchableOpacity onPress={cargar}><Text style={s.alertAction}>Reintentar</Text></TouchableOpacity>
              </View>
            ) : null}

            {filtrados.length > 0 ? (
              <View style={s.section}>
                <View style={s.sectionHeader}>
                  <Text style={s.sectionTitle}>
                    {catSelected === 'Todos' ? 'Negocios disponibles' : catSelected}
                  </Text>
                  {catSelected !== 'Todos' && (
                    <TouchableOpacity onPress={() => setCatSelected('Todos')}>
                      <Text style={s.seeAll}>Ver todos</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {renderGrid(filtrados)}
              </View>
            ) : (
              <View style={s.empty}>
                <View style={s.emptyIcon}>
                  <Ionicons name="restaurant-outline" size={36} color={Colors.textLight} />
                </View>
                <Text style={s.emptyTitle}>Sin resultados</Text>
                <Text style={s.emptyText}>
                  {catSelected !== 'Todos'
                    ? `No hay negocios en ${catSelected} ahora`
                    : 'No hay negocios disponibles'}
                </Text>
                {catSelected !== 'Todos' && (
                  <TouchableOpacity style={s.emptyBtn} onPress={() => setCatSelected('Todos')}>
                    <Text style={s.emptyBtnText}>Ver todos</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        )}

        <View style={{ height: 110 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14, backgroundColor: Colors.white,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarLogo: { width: 44, height: 44, borderRadius: 22 },
  greeting: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  locText: { fontSize: 12, color: Colors.textSecondary, maxWidth: 180 },
  headerRight: { flexDirection: 'row', gap: 8 },
  headerIconBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.error, borderWidth: 1.5, borderColor: Colors.white },
  cartBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: Colors.error, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 1.5, borderColor: Colors.white },
  cartBadgeText: { color: '#fff', fontSize: 8, fontWeight: '800' },

  searchPill: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5',
    borderRadius: 50, marginHorizontal: 20, marginTop: 18, marginBottom: 4,
    paddingLeft: 16, paddingRight: 6, paddingVertical: 6, gap: 10,
  },
  searchPlaceholder: { flex: 1, fontSize: 14, color: Colors.textLight, paddingVertical: 8 },
  filterBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },

  heroBanner: {
    backgroundColor: Colors.primary, borderRadius: 24,
    marginHorizontal: 20, marginTop: 18, marginBottom: 20,
    height: 190, overflow: 'hidden', flexDirection: 'row',
    alignItems: 'flex-end', justifyContent: 'space-between',
  },
  heroDeco1: { position: 'absolute', width: 220, height: 220, borderRadius: 110, backgroundColor: 'rgba(232,130,12,0.12)', top: -90, right: -60 },
  heroDeco2: { position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(232,130,12,0.08)', bottom: -60, left: -30 },
  heroDeco3: { position: 'absolute', width: 70, height: 70, borderRadius: 35, backgroundColor: 'rgba(255,255,255,0.04)', top: 50, left: '45%' },
  heroContent: { padding: 22, flex: 1 },
  heroTag: { fontSize: 11, color: Colors.accent, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  heroTitle: { fontSize: 26, fontWeight: '900', color: Colors.white, lineHeight: 30, letterSpacing: -0.5, marginBottom: 16 },
  heroCTA: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.accent, borderRadius: 50, paddingHorizontal: 16, paddingVertical: 9, alignSelf: 'flex-start' },
  heroCTAText: { color: Colors.white, fontWeight: '800', fontSize: 13 },
  heroCounter: { alignItems: 'center', paddingRight: 22, paddingBottom: 22 },
  heroCounterNum: { fontSize: 36, fontWeight: '900', color: Colors.white },
  heroCounterLabel: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 },

  catRow: { maxHeight: 110 },
  catContent: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10, gap: 16 },
  catItem: { alignItems: 'center', width: 68 },
  catCircle: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 7 },
  catEmoji: { fontSize: 26 },
  catLabel: { fontSize: 11, fontWeight: '700', color: Colors.textSecondary, textAlign: 'center' },
  catLabelActive: { color: Colors.primary },

  loadingBox: { paddingVertical: 60, alignItems: 'center', gap: 16 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 56, gap: 12 },
  emptyIcon: { width: 84, height: 84, borderRadius: 42, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, maxWidth: 280 },
  emptyBtn: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 28, paddingVertical: 13, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },

  alertBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF2F2', padding: 12, paddingHorizontal: 16, marginHorizontal: 20, borderRadius: 14, gap: 8, marginBottom: 16 },
  alertText: { flex: 1, fontSize: 12, color: Colors.error, fontWeight: '600' },
  alertAction: { color: Colors.error, fontWeight: '800', fontSize: 12 },

  feedContent: { paddingTop: 8 },

  section: { marginBottom: 28 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 19, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.3 },
  seeAll: { fontSize: 13, color: Colors.accent, fontWeight: '700' },

  gridRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 16 },

  negocioCard: { backgroundColor: Colors.white, borderRadius: 20, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  negocioImgWrap: { backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  negocioDiscBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: Colors.accent, borderRadius: 50, paddingHorizontal: 9, paddingVertical: 4 },
  negocioDiscText: { color: Colors.white, fontSize: 10, fontWeight: '900' },
  negocioInfo: { padding: 12 },
  negocioNombre: { fontSize: 13, fontWeight: '900', color: Colors.textPrimary, marginBottom: 2 },
  negocioZona: { fontSize: 11, color: Colors.textSecondary, marginBottom: 2 },
  negocioCount: { fontSize: 11, color: Colors.accent, fontWeight: '700' },
});
