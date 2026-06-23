import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Linking, ActivityIndicator, Platform, StatusBar,
  ImageBackground,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { negociosAPI, pedidosAPI, favoritosAPI, resenasAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import ProductCard, { CARD_W } from '@/components/ProductCard';

// ─── Palette ────────────────────────────────────────────────────────────────
const GOLD  = '#E8820C';
const DARK  = '#2C4A2E';
const SURF  = '#FFF4E6';
const GRAY  = '#8A8A8A';

const { width: SW } = Dimensions.get('window');
const COVER_H   = 220;
const LOGO_SIZE = 70;
const LOGO_R    = LOGO_SIZE / 2;  // 35

type FilterKey = 'todos' | 'descuentos' | 'vendidos' | 'previos' | 'precio';

// ─── Mini card para "Volver a pedir" ────────────────────────────────────────
function PrevioCard({ item, onAgregar }: { item: any; onAgregar: (b: any) => void }) {
  const router = useRouter();
  const imgSrc = item.imagen_url;
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
        <TouchableOpacity
          style={pv.addBtn}
          onPress={() => onAgregar(item)}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Ionicons name="add" size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ─── 2-column grid renderer ──────────────────────────────────────────────────
function Grid({ items, onAgregar, favBolsaIds }: { items: any[]; onAgregar: (b: any) => void; favBolsaIds?: Set<string> }) {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(
      <View key={i} style={s.gridRow}>
        <ProductCard bolsa={items[i]} onAgregar={onAgregar} showFavorite isFavorited={favBolsaIds?.has(items[i].id)} />
        {items[i + 1]
          ? <ProductCard bolsa={items[i + 1]} onAgregar={onAgregar} showFavorite isFavorited={favBolsaIds?.has(items[i + 1].id)} />
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
  const { items: cartItems, total, cantidad, agregar } = useCart();

  const [negocio,        setNegocio]        = useState<any>(null);
  const [tiempoLimitado, setTiempoLimitado] = useState<any[]>([]);
  const [promocion,      setPromocion]      = useState<any[]>([]);
  const [previos,        setPrevios]        = useState<any[]>([]);
  const [filtro,         setFiltro]         = useState<FilterKey>('todos');
  const [filtradas,      setFiltradas]      = useState<any[]>([]);
  const [favorito,       setFavorito]       = useState(false);
  const [toggling,       setToggling]       = useState(false);
  const [favBolsaIds,    setFavBolsaIds]    = useState<Set<string>>(new Set());
  const [resenas,        setResenas]        = useState<any[]>([]);
  const [impacto,        setImpacto]        = useState<{ kg_rescatados: number; unidades_rescatadas: number; pedidos_completados: number; ventas_recuperadas: number } | null>(null);
  const [loading,        setLoading]        = useState(true);

  // Carga inicial
  useEffect(() => {
    if (!id) return;
    Promise.all([
      negociosAPI.detalleCompleto(id),
      pedidosAPI.previosEnNegocio(id).catch(() => ({ data: [] })),
      favoritosAPI.check(id).catch(() => ({ data: { es_favorito: false } })),
      favoritosAPI.listarBolsas().catch(() => ({ data: [] })),
      resenasAPI.listarPorNegocio(id).catch(() => ({ data: [] })),
      negociosAPI.impacto(id).catch(() => ({ data: null })),
    ]).then(([negRes, prevRes, favRes, favBolsasRes, resenasRes, impactoRes]) => {
      const { negocio: neg, bolsas } = negRes.data;
      setNegocio(neg);
      setTiempoLimitado(bolsas?.tiempo_limitado || []);
      setPromocion(bolsas?.promocion || []);
      setPrevios(prevRes.data || []);
      setFavorito(favRes.data?.esFavorito ?? false);
      setFavBolsaIds(new Set((favBolsasRes.data || []).map((b: any) => b.id)));
      setResenas(resenasRes.data || []);
      setImpacto(impactoRes.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  // Si previos se vacía y el filtro activo es 'previos', reset
  useEffect(() => {
    if (filtro === 'previos' && previos.length === 0) setFiltro('todos');
  }, [previos]);

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
    } else if (filtro === 'previos') {
      res = previos.map(b => ({ ...b, _sec: 'previos' }));
    } else if (filtro === 'precio') {
      res = [...todos].sort((a, b) => a.precio_descuento - b.precio_descuento);
    }
    setFiltradas(res);
  }, [filtro, tiempoLimitado, promocion, previos]);

  // Chips dinámicos — "Ordenar otra vez" solo si hay historial
  const chips: { key: FilterKey; label: string }[] = [
    { key: 'todos',      label: 'Todos' },
    { key: 'descuentos', label: 'Descuentos' },
    { key: 'vendidos',   label: 'Más vendidos' },
    ...(previos.length > 0 ? [{ key: 'previos' as FilterKey, label: 'Ordenar otra vez' }] : []),
    { key: 'precio',     label: 'Precio ↑' },
  ];

  // Descuento máximo para la pill informativa
  const maxDesc = Math.max(
    0,
    ...[...tiempoLimitado, ...promocion].map(b =>
      b.precio_original > 0 ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0
    )
  );

  async function toggleFav() {
    if (toggling) return;
    console.log('[negocio] toggleFav id:', id, 'era favorito:', favorito);
    setToggling(true);
    // Optimistic update
    setFavorito(!favorito);
    try {
      let response;
      if (favorito) response = await favoritosAPI.quitar(id!);
      else          response = await favoritosAPI.agregar(id!);
      console.log('[negocio] respuesta API favorito:', response?.data);
    } catch (err: any) {
      console.log('[negocio] error toggle favorito:', err?.message);
      setFavorito(favorito); // revertir
    } finally { setToggling(false); }
  }

  function abrirMapa(tipo: 'google' | 'waze') {
    const lat = negocio?.latitud, lng = negocio?.longitud;
    const url = tipo === 'google'
      ? negocio?.google_maps_url || (lat && lng ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : '')
      : negocio?.waze_url        || (lat && lng ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` : '');
    if (url) Linking.openURL(url).catch(() => {});
  }

  const tieneUbicacion = !!(negocio?.google_maps_url || negocio?.waze_url || (negocio?.latitud && negocio?.longitud));
  const todoVacio      = tiempoLimitado.length === 0 && promocion.length === 0;
  const topPad         = Platform.OS === 'ios' ? insets.top : (StatusBar.currentHeight || 0) + 4;
  const mostrarFiltradas = filtro !== 'todos';

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

        {/* ──────────────────────────────────────────────────────────
            CHILD 0 — Cover + Info + Promo pills
        ────────────────────────────────────────────────────────── */}
        <View>
          {/* Cover con ImageBackground */}
          <ImageBackground
            source={negocio?.imagen_url ? { uri: negocio.imagen_url } : undefined}
            style={[s.cover, { height: COVER_H + topPad, backgroundColor: GOLD }]}
            resizeMode="cover"
          >
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
                  color={favorito ? '#E53935' : '#fff'}
                />
              </TouchableOpacity>
            </View>
          </ImageBackground>

          {/* Info section — logo floats over the cover edge */}
          <View style={s.infoSection}>
            {/* Floating logo */}
            <View style={[s.logoCircle, { marginTop: -LOGO_R }]}>
              {negocio?.logo_url || negocio?.imagen_url ? (
                <Image
                  source={{ uri: negocio.logo_url || negocio.imagen_url }}
                  style={s.logoImg}
                  contentFit="cover"
                />
              ) : (
                <View style={[s.logoImg, { alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ fontSize: 26 }}>🏪</Text>
                </View>
              )}
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
                <Text style={s.pillEmoji}>📦</Text>
                <Text style={[s.pillText, s.pillTextDark]}>Solo recogida en local</Text>
              </View>
            </ScrollView>
          {/* Contribución al aprovechamiento */}
          {impacto && impacto.pedidos_completados > 0 && (
            <View style={s.impactoWrap}>
              <Text style={s.impactoHeading}>Contribución al aprovechamiento</Text>
              <View style={s.impactoRow}>
                <View style={s.impactoItem}>
                  <Text style={s.impactoNum}>{impacto.kg_rescatados.toFixed(1)} kg</Text>
                  <Text style={s.impactoLbl}>🍽️ aprox. aprovechados</Text>
                </View>
                <View style={s.impactoDivider} />
                <View style={s.impactoItem}>
                  <Text style={s.impactoNum}>{impacto.unidades_rescatadas}</Text>
                  <Text style={s.impactoLbl}>🛍️ rescatados</Text>
                </View>
              </View>
              <Text style={s.impactoFooter}>Basado en pedidos efectivamente recogidos.</Text>
            </View>
          )}
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
            {chips.map(({ key, label }) => (
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

          {/* Volver a pedir (solo si hay historial Y filtro es 'todos') */}
          {previos.length > 0 && filtro === 'todos' && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>🔁 Volver a pedir</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12, paddingRight: 4 }}
              >
                {previos.map(item => (
                  <PrevioCard key={item.id} item={item} onAgregar={agregar} />
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
                  <Text style={s.sectionTitle}>
                    {chips.find(c => c.key === filtro)?.label || ''}
                  </Text>
                  <Grid items={filtradas} onAgregar={agregar} favBolsaIds={favBolsaIds} />
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
                  <Text style={s.sectionTitle}>⏱️ Tiempo Limitado</Text>
                  <Grid items={tiempoLimitado} onAgregar={agregar} favBolsaIds={favBolsaIds} />
                </View>
              )}
              {promocion.length > 0 && (
                <View style={s.section}>
                  <Text style={s.sectionTitle}>🏷️ Promociones</Text>
                  <Grid items={promocion} onAgregar={agregar} favBolsaIds={favBolsaIds} />
                </View>
              )}
            </>
          )}

          {/* Reseñas */}
          {resenas.length > 0 && (
            <View style={[s.section, { marginTop: 8 }]}>
              <Text style={s.sectionTitle}>
                ⭐ Opiniones
                {negocio?.calificacion_promedio > 0 ? ` · ${negocio.calificacion_promedio.toFixed(1)}` : ''}
              </Text>
              {resenas.slice(0, 5).map((r: any) => (
                <View key={r.id} style={sr.card}>
                  <View style={sr.top}>
                    <Text style={sr.nombre}>{r.usuarios?.nombre || 'Cliente'}</Text>
                    <Text style={sr.estrellas}>{'★'.repeat(r.calificacion)}{'☆'.repeat(5 - r.calificacion)}</Text>
                  </View>
                  {!!r.comentario && <Text style={sr.comentario}>{r.comentario}</Text>}
                  <Text style={sr.fecha}>{new Date(r.created_at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
                </View>
              ))}
            </View>
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

// ─── Reseña card styles ───────────────────────────────────────────────────────
const sr = StyleSheet.create({
  card: {
    backgroundColor: '#FAFAFA', borderRadius: 16, padding: 14,
    marginBottom: 10, borderWidth: 1, borderColor: '#F0F0F0',
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  nombre: { fontSize: 13, fontWeight: '800', color: DARK },
  estrellas: { fontSize: 12, color: '#FF9800', letterSpacing: 1 },
  comentario: { fontSize: 13, color: '#444', lineHeight: 20, marginBottom: 4 },
  fecha: { fontSize: 11, color: GRAY },
});

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
  cover: { overflow: 'hidden' },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
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
    backgroundColor: '#FFF9E6', borderRadius: 50,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  pillDark: { backgroundColor: DARK },
  pillEmoji: { fontSize: 15 },
  pillText: { fontSize: 13, fontWeight: '700', color: DARK },
  pillTextDark: { color: '#fff' },

  // Contribución al aprovechamiento
  impactoWrap:    { backgroundColor: '#F0FFF4', borderRadius: 12, padding: 12, marginTop: 10 },
  impactoHeading: { fontSize: 11, fontWeight: '700', color: '#2E7D32', marginBottom: 8, textAlign: 'center' },
  impactoRow:     { flexDirection: 'row', alignItems: 'center' },
  impactoItem:    { flex: 1, alignItems: 'center' },
  impactoDivider: { width: 1, height: 36, backgroundColor: '#A5D6A7' },
  impactoNum:     { fontSize: 18, fontWeight: '900', color: '#2E7D32', marginBottom: 2 },
  impactoLbl:     { fontSize: 11, color: '#4CAF50', textAlign: 'center' },
  impactoFooter:  { fontSize: 10, color: '#6B9D6B', marginTop: 8, textAlign: 'center' },

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

  // Cart bar — fondo oscuro con botón dorado
  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    minHeight: 64,
    backgroundColor: DARK,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 14,
    elevation: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
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
