import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, ActivityIndicator, SafeAreaView, Share,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { bolsasAPI, notificacionesAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';
import { useLocation } from '@/src/context/LocationContext';

const CATEGORIAS = ['Todos', 'Panadería', 'Restaurante', 'Cafetería', 'Supermercado', 'Sushi', 'Pizza', 'Comida Típica'];
const ZONAS_GT = ['Todas', 'Zona 1', 'Zona 2', 'Zona 4', 'Zona 9', 'Zona 10', 'Zona 11', 'Zona 12', 'Zona 13', 'Zona 14', 'Zona 15', 'Mixco', 'Villa Nueva'];
const EMOJI_MAP: Record<string, string> = {
  Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒',
  Sushi: '🍣', Pizza: '🍕', 'Comida Típica': '🫕', Otro: '🍱',
};
const CAT_ICONS: Record<string, string> = {
  Todos: 'grid', Panadería: 'cafe', Restaurante: 'restaurant', Cafetería: 'cafe',
  Supermercado: 'cart', Sushi: 'fish', Pizza: 'pizza', 'Comida Típica': 'flame',
};

type DistFiltro = 1 | 3 | 5 | 10 | null;
const DIST_OPCIONES: Array<{ label: string; km: DistFiltro }> = [
  { label: '1 km', km: 1 }, { label: '3 km', km: 3 },
  { label: '5 km', km: 5 }, { label: '10 km', km: 10 }, { label: 'Todos', km: null },
];

function formatDist(km: number | null | undefined): string | null {
  if (km === null || km === undefined) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function getTimeTag(inicio: string, fin: string): { texto: string; color: string } | null {
  if (!inicio || !fin) return null;
  const now = new Date();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fin.split(':').map(Number);
  const ini = new Date(now); ini.setHours(ih, im, 0, 0);
  const end = new Date(now); end.setHours(fh, fm, 0, 0);
  if (now > end) return { texto: 'Vencida', color: Colors.textLight };
  if (now < ini) {
    const mins = Math.round((ini.getTime() - now.getTime()) / 60000);
    if (mins <= 60) return { texto: `Abre en ${mins}m`, color: '#FF9800' };
    return null;
  }
  const mins = Math.round((end.getTime() - now.getTime()) / 60000);
  if (mins <= 30) return { texto: `¡${mins}m restantes!`, color: Colors.error };
  return null;
}

function BolsaCard({ bolsa, onPress }: { bolsa: Bolsa; onPress: () => void }) {
  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const emoji = EMOJI_MAP[bolsa.negocios?.categoria || ''] || '🍱';
  const agotada = bolsa.cantidad_disponible === 0;
  const distStr = formatDist(bolsa.distancia_km);
  const timeTag = getTimeTag(bolsa.hora_recogida_inicio, bolsa.hora_recogida_fin);

  async function compartir() {
    await Share.share({
      message: `🛍️ ¡Mira esta oferta en Bocara!\n${bolsa.negocios?.nombre} — ${bolsa.nombre}\nSolo Q${bolsa.precio_descuento} (antes Q${bolsa.precio_original})\nhttps://bocarafood.com`,
    });
  }

  return (
    <TouchableOpacity style={[s.card, agotada && s.cardAgotada]} onPress={onPress} disabled={agotada} activeOpacity={0.9}>
      <View style={s.cardImgWrap}>
        {bolsa.imagen_url || bolsa.negocios?.imagen_url ? (
          <Image
            source={{ uri: bolsa.imagen_url || bolsa.negocios?.imagen_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={300}
          />
        ) : (
          <View style={s.cardImgPlaceholder}>
            <Text style={{ fontSize: 48 }}>{emoji}</Text>
          </View>
        )}
        <View style={s.cardImgOverlay} />
        <View style={[s.discBadge, agotada && { backgroundColor: Colors.textLight }]}>
          <Text style={s.discBadgeText}>{agotada ? 'Agotada' : `-${desc}%`}</Text>
        </View>
        {bolsa.tipo === 'cupon' && (
          <View style={s.cuponBadge}><Text style={s.cuponText}>Cupón</Text></View>
        )}
        {timeTag && (
          <View style={[s.timeBadge, { backgroundColor: timeTag.color }]}>
            <Text style={s.timeBadgeText}>{timeTag.texto}</Text>
          </View>
        )}
        <TouchableOpacity style={s.shareBtn} onPress={compartir} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="share-social-outline" size={16} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={s.cardBody}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.cardNombre} numberOfLines={1}>{bolsa.nombre}</Text>
          <View style={s.cardMeta}>
            {distStr && (
              <View style={s.metaChip}>
                <Ionicons name="location-outline" size={11} color={Colors.textSecondary} />
                <Text style={s.metaText}>{distStr}</Text>
              </View>
            )}
            <View style={s.metaChip}>
              <Ionicons name="time-outline" size={11} color={Colors.textSecondary} />
              <Text style={s.metaText}>{bolsa.hora_recogida_inicio?.slice(0, 5)}–{bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
            </View>
            <View style={s.metaChip}>
              <Ionicons name="layers-outline" size={11} color={Colors.textSecondary} />
              <Text style={s.metaText}>{bolsa.cantidad_disponible} disp.</Text>
            </View>
          </View>
        </View>
        <View style={s.cardPriceCol}>
          <Text style={s.cardOriginal}>Q{bolsa.precio_original}</Text>
          <Text style={s.cardDescuento}>Q{bolsa.precio_descuento}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function SeccionHome({ titulo, bolsas, onPress }: { titulo: string; bolsas: Bolsa[]; onPress: (b: Bolsa) => void }) {
  if (bolsas.length === 0) return null;
  return (
    <View style={s.seccion}>
      <Text style={s.seccionTitulo}>{titulo}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingRight: 16 }}>
        {bolsas.map((b) => {
          const emoji = EMOJI_MAP[b.negocios?.categoria || ''] || '🍱';
          const desc = b.precio_original > 0 ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;
          return (
            <TouchableOpacity key={b.id} style={s.miniCard} onPress={() => onPress(b)} activeOpacity={0.9}>
              <View style={s.miniImgWrap}>
                {b.imagen_url || b.negocios?.imagen_url ? (
                  <Image source={{ uri: b.imagen_url || b.negocios?.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
                ) : (
                  <Text style={{ fontSize: 30 }}>{emoji}</Text>
                )}
                <View style={s.miniDisc}><Text style={s.miniDiscText}>-{desc}%</Text></View>
              </View>
              <View style={s.miniBody}>
                <Text style={s.miniNegocio} numberOfLines={1}>{b.negocios?.nombre}</Text>
                <Text style={s.miniPrecio}>Q{b.precio_descuento}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default function HomeScreen() {
  const [bolsas, setBolsas] = useState<Bolsa[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorNet, setErrorNet] = useState('');
  const [tab, setTab] = useState<'bolsa' | 'cupon'>('bolsa');
  const [catSelected, setCatSelected] = useState('Todos');
  const [zonaSelected, setZonaSelected] = useState('Todas');
  const [busqueda, setBusqueda] = useState('');
  const [distFiltro, setDistFiltro] = useState<DistFiltro>(null);
  const [sinLeerCount, setSinLeerCount] = useState(0);
  const router = useRouter();
  const { usuario } = useAuth();
  const { coords, locationName, permissionStatus, requestPermission, loading: locLoading } = useLocation();

  useEffect(() => {
    notificacionesAPI.listar().then((r) => {
      setSinLeerCount((r.data || []).filter((n: any) => !n.leida).length);
    }).catch(() => {});
  }, []);

  const cargar = useCallback(async () => {
    setErrorNet('');
    try {
      const params: Record<string, any> = { tipo: tab, activo: true };
      if (coords) { params.lat = coords.lat; params.lng = coords.lng; }
      const res = await bolsasAPI.listar(params);
      setBolsas(res.data || []);
    } catch (e: any) {
      setBolsas([]);
      if (e.message?.includes('internet') || e.message?.includes('Network')) {
        setErrorNet('Sin conexión a internet. Revisa tu red.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab, coords]);

  useEffect(() => { setLoading(true); cargar(); }, [cargar]);

  const filtradas = bolsas.filter((b) => {
    const matchCat = catSelected === 'Todos' || b.negocios?.categoria === catSelected;
    const matchZona = zonaSelected === 'Todas' || b.negocios?.zona === zonaSelected ||
      b.negocios?.zona?.toLowerCase().includes(zonaSelected.toLowerCase());
    const matchBusq = !busqueda ||
      b.negocios?.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
      b.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
      b.negocios?.zona?.toLowerCase().includes(busqueda.toLowerCase());
    const matchDist = distFiltro === null ||
      b.distancia_km === null || b.distancia_km === undefined ||
      (b.distancia_km as number) <= distFiltro;
    return matchCat && matchZona && matchBusq && matchDist;
  });

  const hayFiltro = busqueda || catSelected !== 'Todos' || zonaSelected !== 'Todas' || distFiltro;
  const populares = [...bolsas]
    .filter(b => (b.negocios?.calificacion_promedio || 0) >= 4)
    .sort((a, b) => (b.negocios?.calificacion_promedio || 0) - (a.negocios?.calificacion_promedio || 0))
    .slice(0, 8);
  const ultimasHoras = bolsas.filter(b => {
    if (!b.hora_recogida_fin) return false;
    const [h, m] = b.hora_recogida_fin.split(':').map(Number);
    const fin = new Date(); fin.setHours(h, m, 0, 0);
    const diff = (fin.getTime() - Date.now()) / 60000;
    return diff > 0 && diff <= 90;
  });

  const tieneUbicacion = coords !== null;
  const locDenied = permissionStatus === 'denied';
  const nombreCorto = usuario?.nombre ? usuario.nombre.split(' ')[0] : null;

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerTop}>
          <View>
            <Text style={s.greeting}>{nombreCorto ? `Hola, ${nombreCorto} 👋` : 'Hola 👋'}</Text>
            <TouchableOpacity
              onPress={!tieneUbicacion && !locDenied ? requestPermission : undefined}
              activeOpacity={tieneUbicacion ? 1 : 0.7}
              style={s.locRow}
            >
              <Ionicons name="location" size={13} color={Colors.primary} />
              <Text style={s.headerLoc} numberOfLines={1}>
                {locLoading ? 'Buscando...' : tieneUbicacion ? locationName : locDenied ? 'Sin ubicación' : 'Activar ubicación'}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={s.headerActions}>
            <TouchableOpacity
              onPress={() => router.push('/(tabs)/explore' as any)}
              style={s.iconBtn}
            >
              <Ionicons name="notifications-outline" size={22} color={Colors.textPrimary} />
              {sinLeerCount > 0 && <View style={s.notifDot} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/(tabs)/perfil')} style={s.iconBtn}>
              <Ionicons name="person-outline" size={22} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={s.searchPill}>
          <Ionicons name="search-outline" size={18} color={Colors.textSecondary} />
          <TextInput
            style={s.searchInput}
            placeholder="Busca restaurantes, zonas..."
            placeholderTextColor={Colors.textLight}
            value={busqueda}
            onChangeText={setBusqueda}
          />
          {busqueda.length > 0 && (
            <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>

        {/* Tabs bolsa/cupón */}
        <View style={s.tabRow}>
          <TouchableOpacity style={[s.tabBtn, tab === 'bolsa' && s.tabBtnActive]} onPress={() => setTab('bolsa')}>
            <Text style={[s.tabBtnText, tab === 'bolsa' && s.tabBtnTextActive]}>Bolsas Sorpresa</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tabBtn, tab === 'cupon' && s.tabBtnActive]} onPress={() => setTab('cupon')}>
            <Text style={[s.tabBtnText, tab === 'cupon' && s.tabBtnTextActive]}>Cupones</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Banners de estado */}
      {errorNet ? (
        <View style={s.alertBanner}>
          <Ionicons name="wifi-outline" size={16} color={Colors.error} />
          <Text style={s.alertText}>{errorNet}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={s.alertAction}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : locDenied ? (
        <View style={s.infoBanner}>
          <Ionicons name="location-outline" size={16} color={Colors.primary} />
          <Text style={s.infoText}>Activa la ubicación para ver distancias</Text>
          <TouchableOpacity onPress={requestPermission} style={s.infoAction}>
            <Text style={s.infoActionText}>Activar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Filtros */}
      {tieneUbicacion && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
          {DIST_OPCIONES.map(({ label, km }) => (
            <TouchableOpacity key={label} style={[s.chip, distFiltro === km && s.chipActive]} onPress={() => setDistFiltro(km)}>
              <Text style={[s.chipText, distFiltro === km && s.chipTextActive]}>{km ? `${label}` : 'Todos'}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
        {ZONAS_GT.map((z) => (
          <TouchableOpacity key={z} style={[s.chip, zonaSelected === z && s.chipActive]} onPress={() => setZonaSelected(z)}>
            <Text style={[s.chipText, zonaSelected === z && s.chipTextActive]}>{z}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Categorías con icono */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
        {CATEGORIAS.map((cat) => (
          <TouchableOpacity key={cat} style={[s.catChip, catSelected === cat && s.catChipActive]} onPress={() => setCatSelected(cat)}>
            <Ionicons
              name={(CAT_ICONS[cat] || 'grid') as any}
              size={14}
              color={catSelected === cat ? Colors.white : Colors.primary}
            />
            <Text style={[s.catChipText, catSelected === cat && s.catChipTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Feed */}
      {loading ? (
        <View style={s.loadingBox}>
          <ActivityIndicator color={Colors.primary} size="large" />
          <Text style={s.loadingText}>{locLoading ? 'Obteniendo tu ubicación...' : 'Buscando ofertas...'}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.feed}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {/* Banner verde de Ofertas Activas */}
          {!hayFiltro && bolsas.length > 0 && (
            <View style={s.ofertasBanner}>
              <View>
                <Text style={s.ofertasBannerTag}>Disponible ahora</Text>
                <Text style={s.ofertasBannerTitle}>Ofertas Activas</Text>
                <Text style={s.ofertasBannerSub}>{bolsas.filter(b => b.cantidad_disponible > 0).length} bolsas esperándote</Text>
              </View>
              <View style={s.ofertasBannerIcon}>
                <Text style={{ fontSize: 36 }}>🥡</Text>
              </View>
            </View>
          )}

          {/* Secciones sin filtro */}
          {!hayFiltro && (
            <>
              <SeccionHome titulo="⚡ Últimas horas" bolsas={ultimasHoras} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
              <SeccionHome titulo="⭐ Más populares" bolsas={populares} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
            </>
          )}

          {hayFiltro && filtradas.length > 0 && (
            <View style={s.resultRow}>
              <Text style={s.resultText}>{filtradas.length} resultado{filtradas.length !== 1 ? 's' : ''}</Text>
              <TouchableOpacity onPress={() => { setBusqueda(''); setCatSelected('Todos'); setZonaSelected('Todas'); setDistFiltro(null); }}>
                <Text style={s.resultClear}>Limpiar filtros</Text>
              </TouchableOpacity>
            </View>
          )}

          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <View style={s.emptyIcon}>
                <Ionicons name="restaurant-outline" size={40} color={Colors.textLight} />
              </View>
              <Text style={s.emptyTitle}>Sin resultados</Text>
              <Text style={s.emptyText}>
                {busqueda ? `No encontramos "${busqueda}"` :
                  distFiltro && tieneUbicacion ? 'Prueba aumentando el radio de búsqueda' :
                  `No hay ${tab === 'cupon' ? 'cupones' : 'bolsas'} disponibles ahora`}
              </Text>
              {hayFiltro && (
                <TouchableOpacity style={s.emptyBtn} onPress={() => { setBusqueda(''); setCatSelected('Todos'); setZonaSelected('Todas'); setDistFiltro(null); }}>
                  <Text style={s.emptyBtnText}>Ver todos</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            (hayFiltro ? filtradas : bolsas).map((b) => (
              <BolsaCard key={b.id} bolsa={b} onPress={() => router.push(`/producto/${b.id}` as any)} />
            ))
          )}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  // Header
  header: { backgroundColor: Colors.white, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 20, paddingTop: 12 },
  greeting: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerLoc: { fontSize: 13, color: Colors.primary, fontWeight: '600', maxWidth: 200 },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.error, borderWidth: 1.5, borderColor: Colors.white },

  // Search
  searchPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 16, marginHorizontal: 16, marginTop: 14, paddingHorizontal: 14, paddingVertical: 2, gap: 8 },
  searchInput: { flex: 1, fontSize: 14, color: Colors.textPrimary, paddingVertical: 11 },

  // Tabs
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, gap: 8 },
  tabBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 12, backgroundColor: Colors.surface },
  tabBtnActive: { backgroundColor: Colors.primary },
  tabBtnText: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  tabBtnTextActive: { color: Colors.white, fontWeight: '700' },

  // Banners
  alertBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.errorLight, padding: 10, paddingHorizontal: 16, gap: 8 },
  alertText: { flex: 1, fontSize: 12, color: Colors.error, fontWeight: '600' },
  alertAction: { color: Colors.error, fontWeight: '800', fontSize: 12 },
  infoBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.accentLight, padding: 10, paddingHorizontal: 16, gap: 8 },
  infoText: { flex: 1, fontSize: 12, color: Colors.primary, fontWeight: '600' },
  infoAction: { backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 5 },
  infoActionText: { color: Colors.white, fontWeight: '700', fontSize: 12 },

  // Filtros
  filterRow: { backgroundColor: Colors.white, maxHeight: 52 },
  filterContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textPrimary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: Colors.accentLight, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.accentLight },
  catChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catChipText: { fontSize: 12, color: Colors.primary, fontWeight: '600' },
  catChipTextActive: { color: Colors.white },

  // Loading / empty
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyIcon: { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { backgroundColor: Colors.primary, borderRadius: 14, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },

  // Feed
  feed: { padding: 16, paddingTop: 20 },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  resultText: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  resultClear: { fontSize: 13, color: Colors.primary, fontWeight: '600' },

  // Ofertas banner
  ofertasBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.primary, borderRadius: 20, padding: 20, marginBottom: 24,
  },
  ofertasBannerTag: { fontSize: 11, color: Colors.accent, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  ofertasBannerTitle: { fontSize: 22, fontWeight: '900', color: Colors.white },
  ofertasBannerSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 4 },
  ofertasBannerIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },

  // Secciones mini
  seccion: { marginBottom: 24 },
  seccionTitulo: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, marginBottom: 14 },
  miniCard: { width: 148, backgroundColor: Colors.white, borderRadius: 18, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8 },
  miniImgWrap: { backgroundColor: Colors.surface, height: 100, justifyContent: 'center', alignItems: 'center' },
  miniDisc: { position: 'absolute', top: 8, right: 8, backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  miniDiscText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  miniBody: { padding: 10 },
  miniNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  miniPrecio: { fontSize: 17, fontWeight: '900', color: Colors.primary, marginTop: 3 },

  // Bolsa Card
  card: { backgroundColor: Colors.white, borderRadius: 22, marginBottom: 16, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.08, shadowRadius: 10, overflow: 'hidden' },
  cardAgotada: { opacity: 0.5 },
  cardImgWrap: { height: 160, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  cardImgPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  cardImgOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.04)' },
  discBadge: { position: 'absolute', top: 12, right: 12, backgroundColor: Colors.primary, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  discBadgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 12, left: 12, backgroundColor: Colors.accent, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  cuponText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  timeBadge: { position: 'absolute', bottom: 10, left: 12, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  timeBadgeText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  shareBtn: { position: 'absolute', bottom: 10, right: 12, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 16, padding: 6 },
  cardBody: { padding: 16, flexDirection: 'row', alignItems: 'flex-end' },
  cardNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  cardNombre: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary },
  cardMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontSize: 11, color: Colors.textSecondary },
  cardPriceCol: { alignItems: 'flex-end' },
  cardOriginal: { fontSize: 12, color: Colors.textLight, textDecorationLine: 'line-through' },
  cardDescuento: { fontSize: 24, fontWeight: '900', color: Colors.primary },
});
