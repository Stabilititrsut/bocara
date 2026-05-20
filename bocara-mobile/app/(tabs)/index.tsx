import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, ActivityIndicator, SafeAreaView, Share, Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { bolsasAPI, notificacionesAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';
import { useLocation } from '@/src/context/LocationContext';

const { width: SW } = Dimensions.get('window');
const CARD_IMG_H = Math.round(SW * 0.58);
const MINI_W = 160;

const CATEGORIAS = [
  { label: 'Todos',         emoji: '✨' },
  { label: 'Panadería',    emoji: '🥐' },
  { label: 'Restaurante',  emoji: '🍽️' },
  { label: 'Cafetería',    emoji: '☕' },
  { label: 'Supermercado', emoji: '🛒' },
  { label: 'Sushi',        emoji: '🍣' },
  { label: 'Pizza',        emoji: '🍕' },
  { label: 'Comida Típica',emoji: '🫕' },
];

const ZONAS_GT = ['Todas', 'Zona 1', 'Zona 2', 'Zona 4', 'Zona 9', 'Zona 10', 'Zona 11', 'Zona 12', 'Zona 13', 'Zona 14', 'Zona 15', 'Mixco', 'Villa Nueva'];

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

function getTimeTag(inicio: string, fin: string): { texto: string; urgent: boolean } | null {
  if (!inicio || !fin) return null;
  const now = new Date();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fin.split(':').map(Number);
  const ini = new Date(now); ini.setHours(ih, im, 0, 0);
  const end = new Date(now); end.setHours(fh, fm, 0, 0);
  if (now > end) return { texto: 'Vencida', urgent: false };
  if (now < ini) {
    const mins = Math.round((ini.getTime() - now.getTime()) / 60000);
    if (mins <= 60) return { texto: `Abre en ${mins}m`, urgent: false };
    return null;
  }
  const mins = Math.round((end.getTime() - now.getTime()) / 60000);
  if (mins <= 30) return { texto: `${mins}m restantes`, urgent: true };
  return null;
}

function BolsaCard({ bolsa, onPress }: { bolsa: Bolsa; onPress: () => void }) {
  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const agotada = bolsa.cantidad_disponible === 0;
  const distStr = formatDist(bolsa.distancia_km);
  const timeTag = getTimeTag(bolsa.hora_recogida_inicio, bolsa.hora_recogida_fin);
  const imgUri = bolsa.imagen_url || bolsa.negocios?.imagen_url;
  const catEmoji = CATEGORIAS.find(c => c.label === bolsa.negocios?.categoria)?.emoji || '🍱';

  async function compartir() {
    await Share.share({
      message: `Mira esta oferta en Bocara!\n${bolsa.negocios?.nombre} — ${bolsa.nombre}\nSolo Q${bolsa.precio_descuento} (antes Q${bolsa.precio_original})\nhttps://bocarafood.com`,
    });
  }

  return (
    <TouchableOpacity style={[s.card, agotada && s.cardAgotada]} onPress={onPress} disabled={agotada} activeOpacity={0.92}>
      {/* Image */}
      <View style={s.cardImgWrap}>
        {imgUri ? (
          <Image source={{ uri: imgUri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={300} />
        ) : (
          <View style={s.cardImgPlaceholder}>
            <Text style={{ fontSize: 64 }}>{catEmoji}</Text>
          </View>
        )}

        {/* Gradient overlay */}
        <View style={s.cardGradient} />

        {/* Discount pill top-left */}
        <View style={[s.discPill, agotada && { backgroundColor: Colors.textSecondary }]}>
          <Text style={s.discPillText}>{agotada ? 'Agotado' : `-${desc}%`}</Text>
        </View>

        {/* Coupon pill */}
        {bolsa.tipo === 'cupon' && (
          <View style={s.cuponPill}><Text style={s.cuponPillText}>Cupón</Text></View>
        )}

        {/* Time badge */}
        {timeTag && (
          <View style={[s.timePill, timeTag.urgent && { backgroundColor: Colors.error }]}>
            <Text style={s.timePillText}>{timeTag.texto}</Text>
          </View>
        )}

        {/* Share */}
        <TouchableOpacity style={s.shareBtn} onPress={compartir} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="share-social-outline" size={15} color="#fff" />
        </TouchableOpacity>

        {/* Name + price overlaid */}
        <View style={s.imgFooter}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.imgNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
            <Text style={s.imgNombre} numberOfLines={1}>{bolsa.nombre}</Text>
          </View>
          <View style={s.imgPriceBox}>
            <Text style={s.imgOriginal}>Q{bolsa.precio_original}</Text>
            <Text style={s.imgPrice}>Q{bolsa.precio_descuento}</Text>
          </View>
        </View>
      </View>

      {/* Meta row */}
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
    </TouchableOpacity>
  );
}

function MiniCard({ bolsa, onPress }: { bolsa: Bolsa; onPress: () => void }) {
  const desc = bolsa.precio_original > 0 ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const imgUri = bolsa.imagen_url || bolsa.negocios?.imagen_url;
  const catEmoji = CATEGORIAS.find(c => c.label === bolsa.negocios?.categoria)?.emoji || '🍱';
  return (
    <TouchableOpacity style={s.miniCard} onPress={onPress} activeOpacity={0.9}>
      <View style={s.miniImgWrap}>
        {imgUri
          ? <Image source={{ uri: imgUri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
          : <View style={s.miniImgWrap}><Text style={{ fontSize: 32 }}>{catEmoji}</Text></View>
        }
        <View style={s.miniDisc}><Text style={s.miniDiscText}>-{desc}%</Text></View>
      </View>
      <View style={s.miniBody}>
        <Text style={s.miniNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
        <Text style={s.miniPrice}>Q{bolsa.precio_descuento}</Text>
      </View>
    </TouchableOpacity>
  );
}

function SeccionHome({ titulo, bolsas, onPress }: { titulo: string; bolsas: Bolsa[]; onPress: (b: Bolsa) => void }) {
  if (bolsas.length === 0) return null;
  return (
    <View style={s.seccion}>
      <Text style={s.seccionTitulo}>{titulo}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 20 }}>
        {bolsas.map((b) => <MiniCard key={b.id} bolsa={b} onPress={() => onPress(b)} />)}
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
          <View style={{ flex: 1 }}>
            <Text style={s.greeting}>{nombreCorto ? `Hola, ${nombreCorto}` : 'Bocara'}</Text>
            <TouchableOpacity
              onPress={!tieneUbicacion && !locDenied ? requestPermission : undefined}
              activeOpacity={tieneUbicacion ? 1 : 0.7}
              style={s.locRow}
            >
              <Ionicons name="location" size={12} color={Colors.accent} />
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
              <Ionicons name="notifications-outline" size={20} color={Colors.primary} />
              {sinLeerCount > 0 && <View style={s.notifDot} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/(tabs)/perfil')} style={s.iconBtn}>
              <Ionicons name="person-outline" size={20} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Search */}
        <View style={s.searchBar}>
          <Ionicons name="search-outline" size={17} color={Colors.textSecondary} />
          <TextInput
            style={s.searchInput}
            placeholder="Restaurantes, zonas, categorías..."
            placeholderTextColor={Colors.textLight}
            value={busqueda}
            onChangeText={setBusqueda}
          />
          {busqueda.length > 0 && (
            <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={17} color={Colors.textLight} />
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

      {/* Banners */}
      {errorNet ? (
        <View style={s.alertBanner}>
          <Ionicons name="wifi-outline" size={15} color={Colors.error} />
          <Text style={s.alertText}>{errorNet}</Text>
          <TouchableOpacity onPress={cargar}><Text style={s.alertAction}>Reintentar</Text></TouchableOpacity>
        </View>
      ) : locDenied ? (
        <View style={s.infoBanner}>
          <Ionicons name="location-outline" size={15} color={Colors.accent} />
          <Text style={s.infoText}>Activa la ubicación para ver distancias</Text>
          <TouchableOpacity onPress={requestPermission} style={s.infoBtn}>
            <Text style={s.infoBtnText}>Activar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Categories */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catRow} contentContainerStyle={s.catContent}>
        {CATEGORIAS.map(({ label, emoji }) => {
          const active = catSelected === label;
          return (
            <TouchableOpacity
              key={label}
              style={[s.catPill, active && s.catPillActive]}
              onPress={() => setCatSelected(label)}
              activeOpacity={0.8}
            >
              <Text style={s.catEmoji}>{emoji}</Text>
              <Text style={[s.catLabel, active && s.catLabelActive]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Distance filter (if location) */}
      {tieneUbicacion && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
          {DIST_OPCIONES.map(({ label, km }) => (
            <TouchableOpacity key={label} style={[s.chip, distFiltro === km && s.chipActive]} onPress={() => setDistFiltro(km)}>
              <Text style={[s.chipText, distFiltro === km && s.chipTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Zone filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterContent}>
        {ZONAS_GT.map((z) => (
          <TouchableOpacity key={z} style={[s.chip, zonaSelected === z && s.chipActive]} onPress={() => setZonaSelected(z)}>
            <Text style={[s.chipText, zonaSelected === z && s.chipTextActive]}>{z}</Text>
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
          {/* Hero banner */}
          {!hayFiltro && bolsas.length > 0 && (
            <View style={s.heroBanner}>
              <View>
                <Text style={s.heroTag}>Disponible ahora</Text>
                <Text style={s.heroTitle}>Ofertas{'\n'}del día</Text>
                <Text style={s.heroSub}>{bolsas.filter(b => b.cantidad_disponible > 0).length} bolsas disponibles</Text>
              </View>
              <View style={s.heroBadge}>
                <Text style={{ fontSize: 40 }}>🥡</Text>
              </View>
            </View>
          )}

          {/* Highlighted sections */}
          {!hayFiltro && (
            <>
              <SeccionHome titulo="Últimas horas" bolsas={ultimasHoras} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
              <SeccionHome titulo="Más populares" bolsas={populares} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
            </>
          )}

          {/* Filter results header */}
          {hayFiltro && filtradas.length > 0 && (
            <View style={s.resultRow}>
              <Text style={s.resultText}>{filtradas.length} resultado{filtradas.length !== 1 ? 's' : ''}</Text>
              <TouchableOpacity onPress={() => { setBusqueda(''); setCatSelected('Todos'); setZonaSelected('Todas'); setDistFiltro(null); }}>
                <Text style={s.resultClear}>Limpiar</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Empty state */}
          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <View style={s.emptyIcon}>
                <Ionicons name="restaurant-outline" size={38} color={Colors.textLight} />
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
          <View style={{ height: 110 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  // Header
  header: { backgroundColor: Colors.white, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 22, paddingTop: 14 },
  greeting: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, letterSpacing: -0.5 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  headerLoc: { fontSize: 12, color: Colors.accent, fontWeight: '600', maxWidth: 200 },
  headerActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.error, borderWidth: 1.5, borderColor: Colors.white },

  // Search
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 50, marginHorizontal: 20, marginTop: 16, paddingHorizontal: 16, paddingVertical: 2, gap: 10 },
  searchInput: { flex: 1, fontSize: 14, color: Colors.textPrimary, paddingVertical: 12 },

  // Tabs
  tabRow: { flexDirection: 'row', marginHorizontal: 20, marginTop: 14, gap: 10 },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 50, borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.white },
  tabBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabBtnText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  tabBtnTextActive: { color: Colors.white },

  // Banners
  alertBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.errorLight, paddingHorizontal: 18, paddingVertical: 10, gap: 8 },
  alertText: { flex: 1, fontSize: 12, color: Colors.error, fontWeight: '600' },
  alertAction: { color: Colors.error, fontWeight: '800', fontSize: 12 },
  infoBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, paddingHorizontal: 18, paddingVertical: 10, gap: 8 },
  infoText: { flex: 1, fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
  infoBtn: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 14, paddingVertical: 6 },
  infoBtnText: { color: Colors.white, fontWeight: '700', fontSize: 12 },

  // Categories (pill with emoji)
  catRow: { maxHeight: 90, backgroundColor: Colors.white },
  catContent: { paddingHorizontal: 20, paddingVertical: 12, gap: 10 },
  catPill: {
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: 50, borderWidth: 1.5, borderColor: Colors.border,
    backgroundColor: Colors.white, minWidth: 80,
  },
  catPillActive: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 5,
  },
  catEmoji: { fontSize: 20, marginBottom: 2 },
  catLabel: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  catLabelActive: { color: Colors.white },

  // Filters (distance / zone)
  filterRow: { maxHeight: 48, backgroundColor: Colors.white },
  filterContent: { paddingHorizontal: 20, paddingVertical: 8, gap: 8 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 50, paddingHorizontal: 16, paddingVertical: 6 },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  // Loading / empty
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 64, gap: 12 },
  emptyIcon: { width: 88, height: 88, borderRadius: 44, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, maxWidth: 280 },
  emptyBtn: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 32, paddingVertical: 14, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },

  // Feed
  feed: { padding: 20, paddingTop: 24 },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  resultText: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  resultClear: { fontSize: 13, color: Colors.accent, fontWeight: '700' },

  // Hero banner
  heroBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.primary, borderRadius: 24, padding: 24, marginBottom: 32,
  },
  heroTag: { fontSize: 11, color: Colors.accent, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 8 },
  heroTitle: { fontSize: 34, fontWeight: '900', color: Colors.white, lineHeight: 38, letterSpacing: -0.5 },
  heroSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 8 },
  heroBadge: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },

  // Sections (horizontal mini cards)
  seccion: { marginBottom: 32 },
  seccionTitulo: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary, marginBottom: 16, letterSpacing: -0.3 },
  miniCard: { width: MINI_W, backgroundColor: Colors.white, borderRadius: 20, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  miniImgWrap: { height: 110, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  miniDisc: { position: 'absolute', top: 8, right: 8, backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 8, paddingVertical: 3 },
  miniDiscText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  miniBody: { padding: 12 },
  miniNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  miniPrice: { fontSize: 18, fontWeight: '900', color: Colors.primary, marginTop: 3 },

  // Main card
  card: { backgroundColor: Colors.white, borderRadius: 24, marginBottom: 24, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 14, overflow: 'hidden' },
  cardAgotada: { opacity: 0.45 },
  cardImgWrap: { height: CARD_IMG_H, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  cardImgPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  cardGradient: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },

  discPill: { position: 'absolute', top: 14, left: 14, backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 12, paddingVertical: 5 },
  discPillText: { color: Colors.white, fontSize: 11, fontWeight: '900' },
  cuponPill: { position: 'absolute', top: 14, left: 14, backgroundColor: Colors.accent, borderRadius: 50, paddingHorizontal: 12, paddingVertical: 5, marginTop: 34 },
  cuponPillText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  timePill: { position: 'absolute', bottom: 64, left: 14, backgroundColor: Colors.textSecondary, borderRadius: 50, paddingHorizontal: 12, paddingVertical: 5 },
  timePillText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  shareBtn: { position: 'absolute', top: 14, right: 14, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 50, padding: 8 },

  imgFooter: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 16, backgroundColor: 'rgba(0,0,0,0.52)' },
  imgNegocio: { fontSize: 11, color: 'rgba(255,255,255,0.75)', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  imgNombre: { fontSize: 18, fontWeight: '900', color: Colors.white, maxWidth: SW * 0.5 },
  imgPriceBox: { alignItems: 'flex-end' },
  imgOriginal: { fontSize: 12, color: 'rgba(255,255,255,0.55)', textDecorationLine: 'line-through' },
  imgPrice: { fontSize: 30, fontWeight: '900', color: Colors.white },

  cardMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
});
