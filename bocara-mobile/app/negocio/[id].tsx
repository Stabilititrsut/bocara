import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Linking, ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { negociosAPI, pedidosAPI, favoritosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import ProductCard, { CARD_W } from '@/components/ProductCard';

// ─── Palette ────────────────────────────────────────────────────────────────
const GOLD  = '#C8A97E';
const DARK  = '#1A1A1A';
const SURF  = '#F5F0EB';
const GRAY  = '#8A8A8A';

const { width: SW } = Dimensions.get('window');
const COVER_H   = 200;
const LOGO_SIZE = 72;
const LOGO_R    = LOGO_SIZE / 2;   // 36 — how many px the logo overlaps the cover

type FilterKey = 'todos' | 'descuentos' | 'vendidos' | 'precio';

const CHIPS: { key: FilterKey; label: string }[] = [
  { key: 'todos',      label: 'Todos' },
  { key: 'descuentos', label: 'Descuentos' },
  { key: 'vendidos',   label: 'Más vendidos' },
  { key: 'precio',     label: 'Precio ↑' },
];

// ─── Mini card para "Volver a pedir" ────────────────────────────────────────
function PrevioCard({ item, fallback }: { item: any; fallback?: string }) {
  const router = useRouter();
  const { agregar } = useCart();
  const imgSrc = item.imagen_url || fallback;
  return (
    <TouchableOpacity
      style={pv.card}
      onPress={() => router.push(`/producto/${item.id}` as any)}
      activeOpacity={0.88}
    >
      <View style={pv.img}>
        {imgSrc ? (
          <Image source={{ uri: imgSrc }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, pv.placeholder]}>
            <Text style={{ fontSize: 26 }}>🥐</Text>
          </View>
        )}
      </View>
      <Text style={pv.nombre} numberOfLines={2}>{item.nombre}</Text>
      <View style={pv.row}>
        <Text style={pv.precio}>Q{item.precio_descuento?.toFixed(2)}</Text>
        <TouchableOpacity style={pv.addBtn} onPress={() => agregar(item)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Ionicons name="add" size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ─── Section header ──────────────────────────────────────────────────────────
function SectionHeader({ title }: { title: string }) {
  return <Text style={s.sectionTitle}>{title}</Text>;
}

// ─── 2-column grid renderer ──────────────────────────────────────────────────
function Grid({ items, fallback }: { items: any[]; fallback?: string }) {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(
      <View key={i} style={s.gridRow}>
        <ProductCard item={items[i]} fallbackImg={fallback} />
        {items[i + 1]
          ? <ProductCard item={items[i + 1]} fallbackImg={fallback} />
          : <View style={{ width: CARD_W }} />}
      </View>
    );
  }
  return <>{rows}</>;
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function NegocioDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const insets  = useSafeAreaInsets();
  const { items: cartItems, total, cantidad } = useCart();

  const [negocio,      setNegocio]      = useState<any>(null);
  const [tiempoLimitado, setTiempoLimitado] = useState<any[]>([]);
  const [promocion,    setPromocion]    = useState<any[]>([]);
  const [previos,      setPrevios]      = useState<any[]>([]);
  const [filtro,       setFiltro]       = useState<FilterKey>('todos');
  const [filtradas,    setFiltradas]    = useState<any[]>([]);
  const [favorito,     setFavorito]     = useState(false);
  const [toggling,     setToggling]     = useState(false);
  const [loading,      setLoading]      = useState(true);

  // Carga inicial
  useEffect(() => {
    if (!id) return;
    Promise.all([
      negociosAPI.detalleCompleto(id),
      pedidosAPI.previosEnNegocio(id).catch(() => ({ data: [] })),
      favoritosAPI.check(id).catch(() => ({ data: { es_favorito: false } })),
    ]).then(([negRes, prevRes, favRes]) => {
      const { negocio: neg, bolsas } = negRes.data;
      setNegocio(neg);
      setTiempoLimitado(bolsas?.tiempo_limitado || []);
      setPromocion(bolsas?.promocion || []);
      setPrevios(prevRes.data || []);
      setFavorito(favRes.data?.es_favorito ?? false);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  // Aplicar filtro reactivamente
  useEffect(() => {
    const todos = [
      ...tiempoLimitado.map(b => ({ ...b, _sec: 'tiempo_limitado' })),
      ...promocion.map(b => ({ ...b, _sec: 'promocion' })),
    ];
    let res = todos;
    if (filtro === 'descuentos') {
      res = todos.filter(b => b.precio_original > b.precio_descuento);
    } else if (filtro === 'vendidos') {
      res = [...todos].sort((a, b) => (b.veces_pedido || 0) - (a.veces_pedido || 0));
    } else if (filtro === 'precio') {
      res = [...todos].sort((a, b) => a.precio_descuento - b.precio_descuento);
    }
    setFiltradas(res);
  }, [filtro, tiempoLimitado, promocion]);

  // Mayor descuento disponible para la pill
  const maxDesc = Math.max(
    0,
    ...[...tiempoLimitado, ...promocion].map(b =>
      b.precio_original > 0
        ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0
    )
  );

  async function toggleFav() {
    if (toggling) return;
    setToggling(true);
    try {
      if (favorito) { await favoritosAPI.quitar(id!); setFavorito(false); }
      else          { await favoritosAPI.agregar(id!); setFavorito(true); }
    } catch { } finally { setToggling(false); }
  }

  function abrirMapa(tipo: 'google' | 'waze') {
    const lat = negocio?.latitud, lng = negocio?.longitud;
    const url = tipo === 'google'
      ? negocio?.google_maps_url || (lat && lng ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : '')
      : negocio?.waze_url        || (lat && lng ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` : '');
    if (url) Linking.openURL(url).catch(() => {});
  }

  const tieneUbicacion = !!(negocio?.google_maps_url || negocio?.waze_url || (negocio?.latitud && negocio?.longitud));
  const todoVacio = tiempoLimitado.length === 0 && promocion.length === 0;
  const topPad = Platform.OS === 'ios' ? insets.top : (StatusBar.currentHeight || 0) + 4;
  const cartBarH = 62 + insets.bottom;

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator color={GOLD} size="large" />
      </View>
    );
  }

  // ── Contenido de secciones según filtro ──────────────────────────────────
  const mostrarFiltradas = filtro !== 'todos';
  const filtTiempo = filtradas.filter(b => b._sec === 'tiempo_limitado');
  const filtPromo  = filtradas.filter(b => b._sec === 'promocion');

  return (
    <View style={s.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: cantidad > 0 ? cartBarH + 12 : 24 }}
      >

        {/* ──────────────────────────────────────────────────────────
            CHILD 0 — Cover + Info + Promo pills
        ────────────────────────────────────────────────────────── */}
        <View>
          {/* Cover */}
          <View style={[s.cover, { height: COVER_H + topPad }]}>
            {negocio?.imagen_url
              ? <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
              : <View style={[StyleSheet.absoluteFill, { backgroundColor: GOLD }]} />
            }
            <View style={s.coverOverlay} />

            {/* Top buttons */}
            <View style={[s.coverTop, { paddingTop: topPad + 10 }]}>
              <TouchableOpacity style={s.iconBtn} onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={20} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity style={s.iconBtn} onPress={toggleFav}>
                <Ionicons
                  name={favorito ? 'heart' : 'heart-outline'}
                  size={20}
                  color={favorito ? '#EF4444' : '#fff'}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Info section — logo floats out of cover */}
          <View style={s.infoSection}>
            {/* Floating logo circle */}
            <View style={[s.logoCircle, { marginTop: -LOGO_R }]}>
              {negocio?.imagen_url
                ? <Image source={{ uri: negocio.imagen_url }} style={s.logoImg} contentFit="cover" />
                : <View style={[s.logoImg, { backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' }]}>
                    <Text style={{ fontSize: 26 }}>🏪</Text>
                  </View>
              }
            </View>

            {/* Name + meta */}
            <Text style={s.negNombre}>{negocio?.nombre}</Text>
            <Text style={s.negMeta}>
              {[negocio?.zona && `Zona ${negocio.zona}`, negocio?.categoria].filter(Boolean).join(' · ')}
            </Text>

            {/* Rating */}
            {negocio?.calificacion_promedio > 0 ? (
              <Text style={s.rating}>
                ⭐ {negocio.calificacion_promedio.toFixed(1)}
                {negocio.total_resenas > 0 ? ` · (${negocio.total_resenas} opiniones)` : ''}
              </Text>
            ) : (
              <Text style={s.rating}>⭐ Nuevo</Text>
            )}

            {/* Address */}
            {(negocio?.direccion || negocio?.punto_referencia) && (
              <View style={s.addressRow}>
                <Ionicons name="location-outline" size={13} color={GRAY} />
                <Text style={s.addressText} numberOfLines={2}>
                  {[negocio?.direccion, negocio?.punto_referencia].filter(Boolean).join(' · ')}
                </Text>
              </View>
            )}

            {/* Navigation buttons */}
            {tieneUbicacion && (
              <View style={s.navRow}>
                <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('google')} activeOpacity={0.85}>
                  <Text style={s.navEmoji}>🗺️</Text>
                  <Text style={s.navText}>Google Maps</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('waze')} activeOpacity={0.85}>
                  <Text style={s.navEmoji}>🚗</Text>
                  <Text style={s.navText}>Waze</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Promo pills */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.pillsRow}
              contentContainerStyle={{ gap: 10, paddingRight: 4 }}
            >
              <View style={s.pill}>
                <Text style={s.pillEmoji}>🏷️</Text>
                <Text style={s.pillText}>
                  {maxDesc > 0 ? `Hasta ${maxDesc}% DTO en seleccionados` : 'Descuentos disponibles'}
                </Text>
              </View>
              <View style={[s.pill, s.pillDark]}>
                <Text style={s.pillEmoji}>⏰</Text>
                <Text style={[s.pillText, s.pillTextDark]}>Recogida en local · Sin envío</Text>
              </View>
            </ScrollView>
          </View>
        </View>

        {/* ──────────────────────────────────────────────────────────
            CHILD 1 — Chips (STICKY)
        ────────────────────────────────────────────────────────── */}
        <View style={s.chipsWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.chipsContent}
          >
            {CHIPS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={[s.chip, filtro === key && s.chipActive]}
                onPress={() => setFiltro(key)}
                activeOpacity={0.8}
              >
                <Text style={[s.chipText, filtro === key && s.chipTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* ──────────────────────────────────────────────────────────
            CHILD 2 — Content
        ────────────────────────────────────────────────────────── */}
        <View style={s.content}>

          {/* Volver a pedir (solo si hay historial) */}
          {previos.length > 0 && (
            <View style={s.section}>
              <SectionHeader title="🔁 Volver a pedir" />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12, paddingRight: 4 }}
              >
                {previos.map(item => (
                  <PrevioCard key={item.id} item={item} fallback={negocio?.imagen_url} />
                ))}
              </ScrollView>
            </View>
          )}

          {/* Sin productos */}
          {todoVacio && (
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🛍️</Text>
              <Text style={s.emptyText}>Sin productos disponibles por ahora</Text>
            </View>
          )}

          {/* Filtro activo — lista combinada */}
          {!todoVacio && mostrarFiltradas && (
            <>
              {filtradas.length > 0 ? (
                <View style={s.section}>
                  <SectionHeader title={CHIPS.find(c => c.key === filtro)?.label || ''} />
                  <Grid items={filtradas} fallback={negocio?.imagen_url} />
                </View>
              ) : (
                <View style={s.empty}>
                  <Text style={s.emptyText}>Sin productos en esta categoría</Text>
                </View>
              )}
            </>
          )}

          {/* Todos — secciones separadas */}
          {!todoVacio && !mostrarFiltradas && (
            <>
              {tiempoLimitado.length > 0 && (
                <View style={s.section}>
                  <SectionHeader title="⏱️ Tiempo Limitado" />
                  <Grid items={tiempoLimitado} fallback={negocio?.imagen_url} />
                </View>
              )}
              {promocion.length > 0 && (
                <View style={s.section}>
                  <SectionHeader title="🏷️ Promociones" />
                  <Grid items={promocion} fallback={negocio?.imagen_url} />
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── Cart bar ───────────────────────────────────────── */}
      {cantidad > 0 && (
        <View style={[s.cartBar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={s.cartLeft}>
            <View style={s.cartBadge}>
              <Text style={s.cartBadgeTxt}>{cantidad}</Text>
            </View>
            <Text style={s.cartInfo}>
              {cantidad} producto{cantidad !== 1 ? 's' : ''} · Q{total.toFixed(2)}
            </Text>
          </View>
          <TouchableOpacity
            style={s.cartBtn}
            onPress={() => router.push('/(tabs)/carrito' as any)}
            activeOpacity={0.9}
          >
            <Text style={s.cartBtnTxt}>Ver carrito</Text>
            <Ionicons name="arrow-forward" size={15} color={DARK} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── PrevioCard styles ────────────────────────────────────────────────────────
const pv = StyleSheet.create({
  card: {
    width: 120,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 6,
  },
  img: { height: 90, backgroundColor: SURF },
  placeholder: { backgroundColor: SURF, justifyContent: 'center', alignItems: 'center' },
  nombre: { fontSize: 11, fontWeight: '700', color: DARK, padding: 8, paddingBottom: 4, lineHeight: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 },
  precio: { fontSize: 13, fontWeight: '900', color: GOLD },
  addBtn: { width: 26, height: 26, borderRadius: 13, backgroundColor: DARK, alignItems: 'center', justifyContent: 'center' },
});

// ─── Screen styles ────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Cover
  cover: { backgroundColor: GOLD },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.28)' },
  coverTop: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Info section
  infoSection: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  logoCircle: {
    width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: LOGO_R,
    borderWidth: 3, borderColor: '#fff',
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12, shadowRadius: 6,
    backgroundColor: SURF,
  },
  logoImg: { width: '100%', height: '100%' },
  negNombre: {
    fontSize: 22, fontWeight: '900', color: DARK,
    marginTop: 10, marginBottom: 4,
  },
  negMeta: { fontSize: 13, color: GRAY, marginBottom: 4 },
  rating: { fontSize: 13, color: DARK, fontWeight: '600', marginBottom: 6 },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginBottom: 8 },
  addressText: { flex: 1, fontSize: 12, color: GRAY, lineHeight: 18 },
  navRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  navBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1.5, borderColor: '#E0E0E0', borderRadius: 12,
    paddingVertical: 9, backgroundColor: '#fff',
  },
  navEmoji: { fontSize: 15 },
  navText: { fontSize: 13, fontWeight: '700', color: DARK },

  // Promo pills
  pillsRow: { maxHeight: 56 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: SURF, borderRadius: 50,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  pillDark: { backgroundColor: DARK },
  pillEmoji: { fontSize: 15 },
  pillText: { fontSize: 13, fontWeight: '700', color: DARK },
  pillTextDark: { color: '#fff' },

  // Chips (sticky)
  chipsWrap: {
    backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
    elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 4,
  },
  chipsContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: {
    borderWidth: 1.5, borderColor: '#E0E0E0', borderRadius: 50,
    paddingHorizontal: 16, paddingVertical: 7, backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: DARK, borderColor: DARK },
  chipText: { fontSize: 13, color: DARK, fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '700' },

  // Content
  content: { paddingHorizontal: 16, paddingTop: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 17, fontWeight: '900', color: DARK, marginBottom: 14, letterSpacing: -0.3 },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  empty: { alignItems: 'center', paddingVertical: 56, gap: 10 },
  emptyText: { fontSize: 15, color: GRAY, fontWeight: '600', textAlign: 'center' },

  // Cart bar
  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: GOLD,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 14,
    elevation: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.14, shadowRadius: 10,
  },
  cartLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cartBadge: {
    backgroundColor: DARK, borderRadius: 14, minWidth: 26, height: 26,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7,
  },
  cartBadgeTxt: { color: '#fff', fontWeight: '900', fontSize: 12 },
  cartInfo: { fontSize: 14, fontWeight: '700', color: DARK },
  cartBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: DARK, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  cartBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
