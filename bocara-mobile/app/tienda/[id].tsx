import { useEffect, useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Linking, ActivityIndicator, Platform, StatusBar,
  ImageBackground,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { negociosAPI, bolsasAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';

const GOLD = '#E8820C';
const DARK = '#2C4A2E';
const SURF = '#FFF4E6';
const GRAY = '#8A8A8A';

const { width: SW } = Dimensions.get('window');
const COVER_H   = 200;
const LOGO_SIZE = 60;
const LOGO_R    = 30;
const CARD_W    = Math.floor((SW - 48) / 2);

type FilterKey = 'todos' | 'descuentos' | 'tiempo_limitado' | 'promociones' | 'mas_vendidos' | 'destacados' | 'precio';

const FILTROS: { key: FilterKey; label: string }[] = [
  { key: 'todos',           label: 'Todos' },
  { key: 'descuentos',      label: 'Descuentos' },
  { key: 'tiempo_limitado', label: 'Tiempo Limitado' },
  { key: 'promociones',     label: 'Promociones' },
  { key: 'mas_vendidos',    label: 'Más vendidos' },
  { key: 'destacados',      label: 'Los mejores' },
  { key: 'precio',          label: 'Precio más bajo' },
];

// ─── Product Card ─────────────────────────────────────────────────────────────
function ProductCard({ bolsa, onAgregar }: { bolsa: any; onAgregar: (b: any) => void }) {
  const router = useRouter();
  const { items } = useCart();
  const cartCount = items.find(i => i.bolsa.id === bolsa.id)?.cantidad || 0;

  const pct = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const agotado   = bolsa.cantidad_disponible === 0;
  const tipoBadge = bolsa.tipo === 'cupon' ? 'PROMO' : 'T.LIM.';

  return (
    <View style={[pc.card, { width: CARD_W }, agotado && pc.agotado]}>
      <TouchableOpacity
        style={pc.imgWrap}
        onPress={() => router.push(`/producto/${bolsa.id}` as any)}
        activeOpacity={0.92}
        disabled={agotado}
      >
        {bolsa.imagen_url ? (
          <Image
            source={{ uri: bolsa.imagen_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={180}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, pc.placeholder]}>
            <Text style={{ fontSize: 36 }}>🥐</Text>
          </View>
        )}

        {/* Descuento — arriba izquierda */}
        {pct > 0 && !agotado && (
          <View style={pc.badgeDisc}>
            <Text style={pc.badgeDiscTxt}>−{pct}%</Text>
          </View>
        )}
        {agotado && (
          <View style={[pc.badgeDisc, { backgroundColor: '#9CA3AF' }]}>
            <Text style={pc.badgeDiscTxt}>Agotado</Text>
          </View>
        )}

        {/* Tipo — arriba derecha */}
        {!agotado && (
          <View style={pc.badgeTipo}>
            <Text style={pc.badgeTipoTxt}>{tipoBadge}</Text>
          </View>
        )}
      </TouchableOpacity>

      <View style={pc.body}>
        <Text style={pc.nombre} numberOfLines={2}>{bolsa.nombre}</Text>
        <View style={pc.bottomRow}>
          <View>
            <Text style={pc.precio}>Q{bolsa.precio_descuento?.toFixed(2)}</Text>
            {bolsa.precio_original > bolsa.precio_descuento && (
              <Text style={pc.orig}>Q{bolsa.precio_original?.toFixed(2)}</Text>
            )}
          </View>
          {!agotado && (
            <TouchableOpacity
              style={[pc.addBtn, cartCount > 0 && pc.addBtnActive]}
              onPress={() => onAgregar(bolsa)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.85}
            >
              {cartCount > 0
                ? <Text style={pc.addBtnCount}>{cartCount}</Text>
                : <Ionicons name="add" size={18} color="#fff" />
              }
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function TiendaScreen() {
  const { id }   = useLocalSearchParams<{ id: string }>();
  const router   = useRouter();
  const insets   = useSafeAreaInsets();
  const { items: cartItems, total, cantidad, agregar } = useCart();

  const [negocio, setNegocio] = useState<any>(null);
  const [bolsas,  setBolsas]  = useState<any[]>([]);
  const [filtro,  setFiltro]  = useState<FilterKey>('todos');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      negociosAPI.detalle(id),
      bolsasAPI.listar({ negocio_id: id }),
    ]).then(([negRes, bolsasRes]) => {
      setNegocio(negRes.data);
      setBolsas(bolsasRes.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  const filtradas = useMemo(() => {
    switch (filtro) {
      case 'descuentos':
        // Usa flag o detecta automáticamente por precio
        return bolsas.filter(b => b.es_descuento || b.precio_original > b.precio_descuento);
      case 'tiempo_limitado':
        // Usa flag o infiere por tipo
        return bolsas.filter(b => b.es_tiempo_limitado || b.tipo !== 'cupon');
      case 'promociones':
        // Usa flag o infiere por tipo cupon
        return bolsas.filter(b => b.es_promocion || b.tipo === 'cupon');
      case 'mas_vendidos':
        return bolsas
          .filter(b => b.es_mas_vendido || (b.veces_pedido || 0) > 0)
          .sort((a, b) => (b.veces_pedido || 0) - (a.veces_pedido || 0));
      case 'destacados':
        return bolsas.filter(b => b.es_destacado);
      case 'precio':
        return [...bolsas].sort((a, b) =>
          (a.precio_descuento ?? a.precio_original) - (b.precio_descuento ?? b.precio_original)
        );
      default:
        return bolsas;
    }
  }, [filtro, bolsas]);

  function abrirMapa(tipo: 'google' | 'waze') {
    const lat = negocio?.latitud, lng = negocio?.longitud;
    const url = tipo === 'google'
      ? negocio?.google_maps_url || (lat && lng ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : '')
      : negocio?.waze_url        || (lat && lng ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` : '');
    if (url) Linking.openURL(url).catch(() => {});
  }

  const tieneUbicacion = !!(negocio?.google_maps_url || negocio?.waze_url || (negocio?.latitud && negocio?.longitud));
  const coverImg = negocio?.foto_portada || negocio?.foto_negocio || negocio?.imagen_url;
  const logoImg  = negocio?.logo_url || negocio?.imagen_url;
  const topPad   = Platform.OS === 'ios' ? insets.top : (StatusBar.currentHeight || 0) + 4;

  function renderGrid(items: any[]) {
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push(
        <View key={i} style={s.gridRow}>
          <ProductCard bolsa={items[i]} onAgregar={agregar} />
          {items[i + 1]
            ? <ProductCard bolsa={items[i + 1]} onAgregar={agregar} />
            : <View style={{ width: CARD_W }} />}
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

  return (
    <View style={s.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: cantidad > 0 ? 84 + insets.bottom : 24 }}
      >

        {/* ── CHILD 0: Header ──────────────────────────────────── */}
        <View>
          <ImageBackground
            source={coverImg ? { uri: coverImg } : undefined}
            style={[s.cover, { height: COVER_H + topPad, backgroundColor: GOLD }]}
            resizeMode="cover"
          >
            <View style={s.coverOverlay} />
            <View style={[s.coverTop, { paddingTop: topPad + 10 }]}>
              <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          </ImageBackground>

          <View style={s.infoSection}>
            {/* Logo flotante sobre el borde de la portada */}
            <View style={[s.logoCircle, { marginTop: -LOGO_R }]}>
              {logoImg ? (
                <Image source={{ uri: logoImg }} style={s.logoImg} contentFit="cover" />
              ) : (
                <View style={[s.logoImg, { alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ fontSize: 22 }}>🏪</Text>
                </View>
              )}
            </View>

            <Text style={s.negNombre}>{negocio?.nombre}</Text>
            <Text style={s.negMeta}>
              {[negocio?.categoria, negocio?.zona && `Zona ${negocio.zona}`].filter(Boolean).join(' · ')}
            </Text>

            <View style={s.retiroBadge}>
              <Text style={s.retiroBadgeTxt}>🏪 Retiro en local</Text>
            </View>

            {(negocio?.direccion || negocio?.punto_referencia) && (
              <View style={s.addressRow}>
                <Ionicons name="location-outline" size={13} color={GRAY} />
                <Text style={s.addressText} numberOfLines={2}>
                  {[negocio?.direccion, negocio?.punto_referencia].filter(Boolean).join(' · ')}
                </Text>
              </View>
            )}

            {tieneUbicacion && (
              <View style={s.navRow}>
                <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('google')} activeOpacity={0.85}>
                  <Text>🗺️</Text>
                  <Text style={s.navBtnTxt}>Google Maps</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.navBtn} onPress={() => abrirMapa('waze')} activeOpacity={0.85}>
                  <Text>🚗</Text>
                  <Text style={s.navBtnTxt}>Waze</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>

        {/* ── CHILD 1: Filtros (STICKY) ─────────────────────────── */}
        <View style={s.filtersWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filtersContent}
          >
            {FILTROS.map(({ key, label }) => (
              <TouchableOpacity
                key={key}
                style={[s.chip, filtro === key && s.chipActive]}
                onPress={() => setFiltro(key)}
                activeOpacity={0.8}
              >
                <Text style={[s.chipTxt, filtro === key && s.chipTxtActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* ── CHILD 2: Grid de productos ───────────────────────── */}
        <View style={s.gridContent}>
          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🛍️</Text>
              <Text style={s.emptyText}>
                {bolsas.length === 0
                  ? 'Sin productos disponibles por ahora'
                  : 'No hay productos en esta categoría'}
              </Text>
            </View>
          ) : (
            renderGrid(filtradas)
          )}
        </View>
      </ScrollView>

      {/* ── Barra de carrito fija ─────────────────────────────── */}
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
            onPress={() => router.push('/pago' as any)}
            activeOpacity={0.9}
          >
            <Text style={s.cartBtnTxt}>Ver carrito</Text>
            <Ionicons name="arrow-forward" size={15} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── ProductCard styles ────────────────────────────────────────────────────────
const pc = StyleSheet.create({
  card: {
    backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden',
    elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8,
  },
  agotado: { opacity: 0.45 },
  imgWrap: { height: 140, backgroundColor: SURF, justifyContent: 'center', alignItems: 'center' },
  placeholder: { backgroundColor: SURF, justifyContent: 'center', alignItems: 'center' },
  badgeDisc: {
    position: 'absolute', top: 10, left: 10,
    backgroundColor: DARK, borderRadius: 50,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  badgeDiscTxt: { fontSize: 10, fontWeight: '900', color: '#fff' },
  badgeTipo: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: GOLD, borderRadius: 50,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  badgeTipoTxt: { fontSize: 9, fontWeight: '900', color: DARK },
  body: { padding: 10 },
  nombre: { fontSize: 13, fontWeight: '700', color: DARK, lineHeight: 18, marginBottom: 8 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  precio: { fontSize: 16, fontWeight: '900', color: DARK },
  orig: { fontSize: 10, color: '#C4C4C4', textDecorationLine: 'line-through', marginTop: 1 },
  addBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: DARK,
    alignItems: 'center', justifyContent: 'center',
    elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15, shadowRadius: 3,
  },
  addBtnActive: { backgroundColor: GOLD },
  addBtnCount: { fontSize: 12, fontWeight: '900', color: '#fff' },
});

// ── Screen styles ─────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  cover: { overflow: 'hidden' },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  coverTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center', justifyContent: 'center',
  },

  infoSection: { backgroundColor: '#fff', paddingHorizontal: 20, paddingBottom: 16 },
  logoCircle: {
    width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: LOGO_R,
    borderWidth: 3, borderColor: '#fff',
    overflow: 'hidden', elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12, shadowRadius: 6,
    backgroundColor: SURF,
  },
  logoImg: { width: '100%', height: '100%' },
  negNombre: { fontSize: 20, fontWeight: '900', color: DARK, marginTop: 10, marginBottom: 3 },
  negMeta: { fontSize: 13, color: GRAY, marginBottom: 10 },
  retiroBadge: {
    alignSelf: 'flex-start', backgroundColor: DARK, borderRadius: 50,
    paddingHorizontal: 12, paddingVertical: 5, marginBottom: 12,
  },
  retiroBadgeTxt: { fontSize: 12, color: '#fff', fontWeight: '700' },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginBottom: 10 },
  addressText: { flex: 1, fontSize: 12, color: GRAY, lineHeight: 18 },
  navRow: { flexDirection: 'row', gap: 10 },
  navBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderColor: '#E0E0E0', borderRadius: 12,
    paddingVertical: 9, backgroundColor: '#fff',
  },
  navBtnTxt: { fontSize: 13, fontWeight: '700', color: DARK },

  filtersWrap: {
    backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
    elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 4,
  },
  filtersContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: {
    borderWidth: 1.5, borderColor: DARK, borderRadius: 50,
    paddingHorizontal: 16, paddingVertical: 7, backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: DARK },
  chipTxt: { fontSize: 13, color: DARK, fontWeight: '600' },
  chipTxtActive: { color: '#fff', fontWeight: '700' },

  gridContent: { padding: 16 },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  empty: { alignItems: 'center', paddingVertical: 56, gap: 12 },
  emptyText: { fontSize: 15, color: GRAY, fontWeight: '600', textAlign: 'center', maxWidth: 220 },

  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    minHeight: 64, backgroundColor: DARK,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 14,
    elevation: 14, shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18, shadowRadius: 12,
  },
  cartLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cartBadge: {
    backgroundColor: GOLD, borderRadius: 14, minWidth: 26, height: 26,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7,
  },
  cartBadgeTxt: { color: DARK, fontWeight: '900', fontSize: 12 },
  cartInfo: { fontSize: 14, fontWeight: '700', color: '#fff' },
  cartBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: GOLD, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 9,
  },
  cartBtnTxt: { color: DARK, fontWeight: '800', fontSize: 13 },
});
