import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, TextInput, Linking, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { negociosAPI, favoritosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';

const GOLD = '#C8A97E';
const DARK = '#111827';
const BG = '#F8FAFC';
const { width: SW } = Dimensions.get('window');
const CARD_W = Math.floor((SW - 48) / 2);
const CARD_H = 275;
const CARD_IMG_H = 150;
const COVER_H = 230;

type ChipKey = 'todos' | 'tiempo_limitado' | 'promociones' | 'descuentos' | 'precio_bajo';

const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'todos',          label: 'Todos' },
  { key: 'tiempo_limitado', label: '⏱️ Tiempo Limitado' },
  { key: 'promociones',    label: '🏷️ Promociones' },
  { key: 'descuentos',     label: '🔥 Más descuento' },
  { key: 'precio_bajo',    label: '💰 Precio bajo' },
];

// ─── Product Card ─────────────────────────────────────────────────────────────
function ProductCard({
  item, fallbackImg, cartCount, onAdd,
}: { item: any; fallbackImg?: string; cartCount: number; onAdd: () => void }) {
  const pct = item.precio_original > 0
    ? Math.round((1 - item.precio_descuento / item.precio_original) * 100) : 0;
  const agotado = item.cantidad_disponible === 0;
  const imgSrc = item.imagen_url || fallbackImg;

  return (
    <View style={[pc.card, { width: CARD_W, minHeight: CARD_H }, agotado && pc.agotado]}>
      <View style={[pc.imgWrap, { height: CARD_IMG_H }]}>
        {imgSrc ? (
          <Image
            source={{ uri: imgSrc }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
            onError={() => {}}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, pc.placeholder]}>
            <Text style={{ fontSize: 40 }}>{item.tipo === 'cupon' ? '🏷️' : '⏱️'}</Text>
          </View>
        )}
        {pct > 0 && (
          <View style={[pc.badge, agotado && { backgroundColor: '#9CA3AF' }]}>
            <Text style={pc.badgeText}>{agotado ? 'Agotado' : `${pct}% DTO`}</Text>
          </View>
        )}
        {item.tipo === 'cupon' && !agotado && (
          <View style={pc.promoBadge}><Text style={pc.promoText}>PROMO</Text></View>
        )}
      </View>

      <View style={pc.body}>
        <Text style={pc.nombre} numberOfLines={2}>{item.nombre}</Text>
        {!!item.descripcion && (
          <Text style={pc.desc} numberOfLines={1}>{item.descripcion}</Text>
        )}
        {!!item.hora_recogida_inicio && (
          <Text style={pc.horario}>
            ⏰ {item.hora_recogida_inicio.slice(0, 5)} – {item.hora_recogida_fin.slice(0, 5)}
          </Text>
        )}
        {item.cantidad_disponible > 0 && item.cantidad_disponible <= 3 && (
          <Text style={pc.pocas}>¡Solo {item.cantidad_disponible} disponible{item.cantidad_disponible > 1 ? 's' : ''}!</Text>
        )}
        <View style={pc.precioRow}>
          <View>
            {item.precio_original > item.precio_descuento && (
              <Text style={pc.orig}>Q{item.precio_original.toFixed(2)}</Text>
            )}
            <Text style={pc.precio}>Q{item.precio_descuento.toFixed(2)}</Text>
          </View>
          {!agotado && (
            <TouchableOpacity
              style={[pc.addBtn, cartCount > 0 && pc.addBtnActive]}
              onPress={onAdd}
              activeOpacity={0.85}
            >
              {cartCount > 0
                ? <Text style={pc.addBtnCount}>{cartCount}</Text>
                : <Ionicons name="add" size={20} color="#fff" />}
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function NegocioDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { items: cartItems, agregar, total, cantidad } = useCart();

  const [negocio, setNegocio] = useState<any>(null);
  const [tiempoLimitado, setTiempoLimitado] = useState<any[]>([]);
  const [promociones, setPromociones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<ChipKey>('todos');
  const [favorito, setFavorito] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      negociosAPI.detalle(id),
      negociosAPI.bolsas(id),
      favoritosAPI.check(id).catch(() => ({ data: { es_favorito: false } })),
    ]).then(([negRes, bolsasRes, favRes]) => {
      setNegocio(negRes.data);
      const grouped = bolsasRes.data || {};
      setTiempoLimitado(grouped.tiempo_limitado || []);
      setPromociones(grouped.promociones || []);
      setFavorito(favRes.data?.es_favorito ?? false);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  async function toggleFav() {
    if (toggling) return;
    setToggling(true);
    try {
      if (favorito) { await favoritosAPI.quitar(id!); setFavorito(false); }
      else { await favoritosAPI.agregar(id!); setFavorito(true); }
    } catch { } finally { setToggling(false); }
  }

  function getCartCount(itemId: string) {
    return cartItems.find(i => i.bolsa.id === itemId)?.cantidad || 0;
  }

  function abrirMapa(tipo: 'google' | 'waze') {
    if (!negocio) return;
    let url = '';
    if (tipo === 'google') {
      url = negocio.google_maps_url
        || (negocio.latitud && negocio.longitud
          ? `https://www.google.com/maps/dir/?api=1&destination=${negocio.latitud},${negocio.longitud}`
          : '');
    } else {
      url = negocio.waze_url
        || (negocio.latitud && negocio.longitud
          ? `https://waze.com/ul?ll=${negocio.latitud},${negocio.longitud}&navigate=yes`
          : '');
    }
    if (url) Linking.openURL(url).catch(() => {});
  }

  const tieneUbicacion = !!(
    negocio?.google_maps_url || negocio?.waze_url ||
    (negocio?.latitud && negocio?.longitud)
  );

  // Build merged list with section tag for filtering
  const todosItems = [
    ...tiempoLimitado.map(b => ({ ...b, _sec: 'tiempo_limitado' })),
    ...promociones.map(b => ({ ...b, _sec: 'promociones' })),
  ];

  function filtrar(arr: any[]) {
    let res = arr;
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(b =>
        b.nombre?.toLowerCase().includes(q) ||
        b.descripcion?.toLowerCase().includes(q)
      );
    }
    if (chip === 'tiempo_limitado') res = res.filter(b => b._sec === 'tiempo_limitado');
    if (chip === 'promociones')     res = res.filter(b => b._sec === 'promociones');
    if (chip === 'descuentos')      res = [...res].sort((a, b) => {
      const da = a.precio_original > 0 ? (1 - a.precio_descuento / a.precio_original) : 0;
      const db = b.precio_original > 0 ? (1 - b.precio_descuento / b.precio_original) : 0;
      return db - da;
    });
    if (chip === 'precio_bajo') res = [...res].sort((a, b) => a.precio_descuento - b.precio_descuento);
    return res;
  }

  const activo = search.trim() || chip !== 'todos';
  const filtradosTodo = filtrar(todosItems);
  const filtTiempo = filtrar(tiempoLimitado.map(b => ({ ...b, _sec: 'tiempo_limitado' })));
  const filtPromos = filtrar(promociones.map(b => ({ ...b, _sec: 'promociones' })));

  function renderGrid(list: any[]) {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < list.length; i += 2) {
      rows.push(
        <View key={i} style={s.gridRow}>
          <ProductCard
            item={list[i]}
            fallbackImg={negocio?.imagen_url}
            cartCount={getCartCount(list[i].id)}
            onAdd={() => agregar(list[i])}
          />
          {list[i + 1] ? (
            <ProductCard
              item={list[i + 1]}
              fallbackImg={negocio?.imagen_url}
              cartCount={getCartCount(list[i + 1].id)}
              onAdd={() => agregar(list[i + 1])}
            />
          ) : (
            <View style={{ width: CARD_W }} />
          )}
        </View>
      );
    }
    return rows;
  }

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator color={GOLD} size="large" />
      </View>
    );
  }

  const cartBarH = 72 + insets.bottom;

  return (
    <View style={s.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: cantidad > 0 ? cartBarH + 16 : 32 }}
      >
        {/* ── COVER ────────────────────────────────────── */}
        <View style={[s.cover, { height: COVER_H + insets.top }]}>
          {negocio?.imagen_url ? (
            <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: GOLD }]} />
          )}
          <View style={s.coverOverlay} />

          <View style={[s.coverTop, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity style={s.iconBtn} onPress={() => router.back()}>
              <Ionicons name="arrow-back" size={20} color="#fff" />
            </TouchableOpacity>

            <View style={s.searchPill}>
              <Ionicons name="search-outline" size={14} color="#9CA3AF" />
              <TextInput
                style={s.searchInput}
                placeholder={`Buscar en ${negocio?.nombre || 'el restaurante'}`}
                placeholderTextColor="#9CA3AF"
                value={search}
                onChangeText={setSearch}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')}>
                  <Ionicons name="close-circle" size={16} color="#9CA3AF" />
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity style={s.iconBtn} onPress={toggleFav}>
              <Ionicons
                name={favorito ? 'heart' : 'heart-outline'}
                size={20}
                color={favorito ? '#EF4444' : '#fff'}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── INFO CARD ────────────────────────────────── */}
        <View style={s.infoCard}>
          <View style={s.infoTop}>
            <View style={s.miniLogo}>
              {negocio?.imagen_url ? (
                <Image source={{ uri: negocio.imagen_url }} style={s.miniLogoImg} contentFit="cover" />
              ) : (
                <View style={[s.miniLogoImg, { backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ fontSize: 22 }}>🏪</Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.negNombre}>{negocio?.nombre}</Text>
              <View style={s.metaRow}>
                {negocio?.calificacion_promedio > 0 && (
                  <View style={s.ratingChip}>
                    <Ionicons name="star" size={11} color={GOLD} />
                    <Text style={s.ratingText}>{negocio.calificacion_promedio.toFixed(1)}</Text>
                  </View>
                )}
                {negocio?.zona ? <Text style={s.metaText}>Zona {negocio.zona}</Text> : null}
                {negocio?.ciudad ? <Text style={s.metaText}>· {negocio.ciudad}</Text> : null}
              </View>
              <View style={s.pickupRow}>
                <Ionicons name="storefront-outline" size={13} color={GOLD} />
                <Text style={s.pickupText}>Retiro en el local</Text>
              </View>
            </View>
          </View>

          {(negocio?.direccion || negocio?.punto_referencia) && (
            <View style={s.addressRow}>
              <Ionicons name="location-outline" size={14} color="#6B7280" />
              <Text style={s.addressText} numberOfLines={3}>
                {[negocio?.direccion, negocio?.punto_referencia].filter(Boolean).join(' · ')}
              </Text>
            </View>
          )}

          {negocio?.descripcion ? (
            <Text style={s.descripcion} numberOfLines={3}>{negocio.descripcion}</Text>
          ) : null}

          {tieneUbicacion ? (
            <View style={s.navBtns}>
              <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('google')} activeOpacity={0.85}>
                <Text style={s.navBtnEmoji}>🗺️</Text>
                <Text style={s.navBtnText}>Google Maps</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('waze')} activeOpacity={0.85}>
                <Text style={s.navBtnEmoji}>🚗</Text>
                <Text style={s.navBtnText}>Waze</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={s.sinUbicacion}>Este restaurante aún no ha configurado su ubicación.</Text>
          )}
        </View>

        {/* ── CHIPS ────────────────────────────────────── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.chipsRow}
          contentContainerStyle={s.chipsContent}
        >
          {CHIPS.map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              style={[s.chip, chip === key && s.chipActive]}
              onPress={() => setChip(key)}
              activeOpacity={0.8}
            >
              <Text style={[s.chipText, chip === key && s.chipTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* ── PRODUCTS ─────────────────────────────────── */}
        <View style={s.productsArea}>
          {activo ? (
            filtradosTodo.length > 0 ? (
              <View style={s.section}>
                <Text style={s.sectionTitle}>
                  {search.trim()
                    ? `Resultados para "${search}"`
                    : CHIPS.find(c => c.key === chip)?.label}
                </Text>
                {renderGrid(filtradosTodo)}
              </View>
            ) : (
              <View style={s.emptyState}>
                <Text style={{ fontSize: 40 }}>🔍</Text>
                <Text style={s.emptyTitle}>Sin resultados</Text>
                <TouchableOpacity onPress={() => { setSearch(''); setChip('todos'); }}>
                  <Text style={s.emptyLink}>Limpiar filtros</Text>
                </TouchableOpacity>
              </View>
            )
          ) : (
            <>
              {chip !== 'promociones' && filtTiempo.length > 0 && (
                <View style={s.section}>
                  <Text style={s.sectionTitle}>⏱️ Disponibles por Tiempo Limitado</Text>
                  {renderGrid(filtTiempo)}
                </View>
              )}
              {chip !== 'tiempo_limitado' && filtPromos.length > 0 && (
                <View style={s.section}>
                  <Text style={s.sectionTitle}>🏷️ Promociones</Text>
                  {renderGrid(filtPromos)}
                </View>
              )}
              {todosItems.length === 0 && (
                <View style={s.emptyState}>
                  <Text style={{ fontSize: 48 }}>🕐</Text>
                  <Text style={s.emptyTitle}>Sin productos activos</Text>
                  <Text style={s.emptySub}>
                    Este restaurante aún no tiene productos disponibles.
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* ── CART BAR ─────────────────────────────────── */}
      {cantidad > 0 && (
        <View style={[s.cartBar, { paddingBottom: insets.bottom + 12 }]}>
          <View style={s.cartBarLeft}>
            <View style={s.cartBadge}>
              <Text style={s.cartBadgeText}>{cantidad}</Text>
            </View>
            <Text style={s.cartBarInfo}>
              {cantidad} producto{cantidad !== 1 ? 's' : ''} · Q{total.toFixed(2)}
            </Text>
          </View>
          <TouchableOpacity
            style={s.cartBarBtn}
            onPress={() => router.push('/(tabs)/carrito' as any)}
            activeOpacity={0.9}
          >
            <Text style={s.cartBarBtnText}>Ver carrito</Text>
            <Ionicons name="arrow-forward" size={16} color={DARK} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── ProductCard styles ───────────────────────────────────────────────────────
const pc = StyleSheet.create({
  card: {
    backgroundColor: '#fff', borderRadius: 20, overflow: 'hidden',
    elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.07, shadowRadius: 10,
  },
  agotado: { opacity: 0.45 },
  imgWrap: { backgroundColor: '#F5F0EB', justifyContent: 'center', alignItems: 'center' },
  placeholder: { backgroundColor: '#F5F0EB', justifyContent: 'center', alignItems: 'center' },
  badge: {
    position: 'absolute', top: 10, left: 10, backgroundColor: DARK,
    borderRadius: 50, paddingHorizontal: 9, paddingVertical: 4,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '900' },
  promoBadge: {
    position: 'absolute', top: 10, right: 10, backgroundColor: '#7C3AED',
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
  },
  promoText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  body: { padding: 12, flex: 1 },
  nombre: { fontSize: 13, fontWeight: '800', color: DARK, lineHeight: 18, marginBottom: 3 },
  desc: { fontSize: 11, color: '#6B7280', marginBottom: 4 },
  horario: { fontSize: 10, color: '#9CA3AF', marginBottom: 4 },
  pocas: { fontSize: 10, color: '#EF4444', fontWeight: '700', marginBottom: 4 },
  precioRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 4 },
  orig: { fontSize: 10, color: '#C4C4C4', textDecorationLine: 'line-through' },
  precio: { fontSize: 18, fontWeight: '900', color: DARK },
  addBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: DARK,
    alignItems: 'center', justifyContent: 'center',
    elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 4,
  },
  addBtnActive: { backgroundColor: GOLD },
  addBtnCount: { color: '#fff', fontWeight: '900', fontSize: 13 },
});

// ─── Screen styles ────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },

  cover: { backgroundColor: GOLD, position: 'relative' },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.32)' },
  coverTop: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingBottom: 16,
  },
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.40)', alignItems: 'center', justifyContent: 'center',
  },
  searchPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.93)', borderRadius: 24,
    paddingHorizontal: 12, paddingVertical: 8, gap: 8,
  },
  searchInput: { flex: 1, fontSize: 13, color: DARK, padding: 0 },

  infoCard: {
    backgroundColor: '#fff', borderRadius: 28, marginHorizontal: 16,
    marginTop: -32, padding: 20,
    elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.10, shadowRadius: 16, marginBottom: 4,
  },
  infoTop: { flexDirection: 'row', gap: 14, marginBottom: 10 },
  miniLogo: {
    width: 64, height: 64, borderRadius: 16, overflow: 'hidden',
    elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10, shadowRadius: 6,
  },
  miniLogoImg: { width: 64, height: 64 },
  negNombre: { fontSize: 19, fontWeight: '900', color: DARK, marginBottom: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' },
  ratingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FEF3C7', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3,
  },
  ratingText: { fontSize: 12, color: '#92400E', fontWeight: '700' },
  metaText: { fontSize: 12, color: '#6B7280', fontWeight: '500' },
  pickupRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  pickupText: { fontSize: 12, fontWeight: '700', color: GOLD },
  addressRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    marginTop: 4, marginBottom: 8,
  },
  addressText: { flex: 1, fontSize: 12, color: '#6B7280', lineHeight: 18 },
  descripcion: { fontSize: 13, color: '#6B7280', lineHeight: 20, marginBottom: 12 },
  navBtns: { flexDirection: 'row', gap: 10, marginTop: 8 },
  navBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: BG, borderRadius: 14, paddingVertical: 11,
    borderWidth: 1.5, borderColor: '#E5E7EB',
  },
  navBtnEmoji: { fontSize: 16 },
  navBtnText: { fontSize: 13, fontWeight: '700', color: DARK },
  sinUbicacion: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 10, fontStyle: 'italic' },

  chipsRow: { maxHeight: 56 },
  chipsContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: {
    borderWidth: 1.5, borderColor: '#E5E7EB', borderRadius: 50,
    paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: DARK, borderColor: DARK },
  chipText: { fontSize: 13, color: '#6B7280', fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '700' },

  productsArea: { paddingHorizontal: 16, paddingTop: 8 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 17, fontWeight: '900', color: DARK, marginBottom: 14, letterSpacing: -0.3 },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },

  emptyState: { alignItems: 'center', paddingVertical: 56, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: DARK },
  emptySub: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 20, maxWidth: 260 },
  emptyLink: { fontSize: 14, fontWeight: '700', color: GOLD, marginTop: 4 },

  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: GOLD, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 14,
    elevation: 14, shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15, shadowRadius: 12,
  },
  cartBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cartBadge: {
    backgroundColor: DARK, borderRadius: 16, minWidth: 28, height: 28,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
  },
  cartBadgeText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  cartBarInfo: { fontSize: 15, fontWeight: '700', color: DARK },
  cartBarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: DARK, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10,
  },
  cartBarBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
