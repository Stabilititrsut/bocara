import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, ActivityIndicator, SafeAreaView, Share,
} from 'react-native';
import { Image } from 'expo-image';
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

// Tiempo restante hasta el horario de recogida
function getTimeTag(inicio: string, fin: string): { texto: string; color: string } | null {
  if (!inicio || !fin) return null;
  const now = new Date();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fin.split(':').map(Number);
  const ini = new Date(now); ini.setHours(ih, im, 0, 0);
  const end = new Date(now); end.setHours(fh, fm, 0, 0);
  if (now > end) return { texto: 'Vencido', color: Colors.textLight };
  if (now < ini) {
    const mins = Math.round((ini.getTime() - now.getTime()) / 60000);
    if (mins <= 60) return { texto: `Abre en ${mins}m`, color: Colors.orange };
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
      message: `🛍️ ¡Mira esta bolsa de comida rescatada en Bocara!\n${bolsa.negocios?.nombre} — ${bolsa.nombre}\nSolo Q${bolsa.precio_descuento} (antes Q${bolsa.precio_original})\nhttps://bocarafood.com`,
    });
  }

  return (
    <TouchableOpacity style={[s.card, agotada && s.cardAgotada]} onPress={onPress} disabled={agotada} activeOpacity={0.85}>
      <View style={s.cardImg}>
        {bolsa.imagen_url || bolsa.negocios?.imagen_url ? (
          <Image
            source={{ uri: bolsa.imagen_url || bolsa.negocios?.imagen_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <Text style={{ fontSize: 44 }}>{emoji}</Text>
        )}
        <View style={[s.badge, agotada && { backgroundColor: Colors.textLight }]}>
          <Text style={s.badgeText}>{agotada ? 'Agotada' : `-${desc}%`}</Text>
        </View>
        {bolsa.tipo === 'cupon' && (
          <View style={s.cuponBadge}><Text style={s.cuponText}>🎫 Cupón</Text></View>
        )}
        {distStr && !agotada && (
          <View style={s.distBadge}><Text style={s.distText}>📍 {distStr}</Text></View>
        )}
        {timeTag && (
          <View style={[s.timeBadge, { backgroundColor: timeTag.color }]}>
            <Text style={s.timeText}>{timeTag.texto}</Text>
          </View>
        )}
        <TouchableOpacity style={s.shareBtn} onPress={compartir} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ fontSize: 14 }}>↗️</Text>
        </TouchableOpacity>
      </View>
      <View style={s.cardBody}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.cardNombre} numberOfLines={1}>{bolsa.nombre}</Text>
          <Text style={s.cardZona}>📍 {bolsa.negocios?.zona}</Text>
          <Text style={s.cardHora}>⏰ {bolsa.hora_recogida_inicio?.slice(0, 5)} – {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
        </View>
        <View style={s.cardPrices}>
          <Text style={s.cardOriginal}>Q{bolsa.precio_original}</Text>
          <Text style={s.cardDescuento}>Q{bolsa.precio_descuento}</Text>
          <Text style={s.cardDisp}>{bolsa.cantidad_disponible} disp.</Text>
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
        {bolsas.map((b) => (
          <TouchableOpacity key={b.id} style={s.miniCard} onPress={() => onPress(b)} activeOpacity={0.85}>
            <View style={s.miniImg}>
              {b.imagen_url || b.negocios?.imagen_url ? (
                <Image source={{ uri: b.imagen_url || b.negocios?.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
              ) : (
                <Text style={{ fontSize: 28 }}>{EMOJI_MAP[b.negocios?.categoria || ''] || '🍱'}</Text>
              )}
              <View style={s.miniBadge}><Text style={s.miniBadgeText}>-{Math.round((1 - b.precio_descuento / b.precio_original) * 100)}%</Text></View>
            </View>
            <View style={s.miniBody}>
              <Text style={s.miniNegocio} numberOfLines={1}>{b.negocios?.nombre}</Text>
              <Text style={s.miniPrecio}>Q{b.precio_descuento}</Text>
            </View>
          </TouchableOpacity>
        ))}
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

  // Secciones de home (sin filtros activos)
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

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerTop}>
          <TouchableOpacity onPress={!tieneUbicacion && !locDenied ? requestPermission : undefined} activeOpacity={tieneUbicacion ? 1 : 0.7}>
            <Text style={s.headerLoc}>
              {locLoading ? '📍 Buscando...' : tieneUbicacion ? `📍 ${locationName}` : locDenied ? '📍 Sin ubicación' : '📍 Activar ubicación'}
            </Text>
            <Text style={s.logo}>Boca<Text style={s.logoAccent}>ra</Text></Text>
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => router.push('/(tabs)/explore' as any)} style={s.avatar}>
              <Text style={{ fontSize: 20 }}>🔔</Text>
              {sinLeerCount > 0 && (
                <View style={s.notifDot}>
                  <Text style={s.notifDotText}>{sinLeerCount > 9 ? '9+' : sinLeerCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/(tabs)/perfil')} style={s.avatar}>
              <Text style={{ fontSize: 22 }}>👤</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={s.searchRow}>
          <Text style={s.searchIcon}>🔍</Text>
          <TextInput
            style={s.search}
            placeholder="Busca por nombre, zona o categoría..."
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={busqueda}
            onChangeText={setBusqueda}
          />
          {busqueda.length > 0 && (
            <TouchableOpacity onPress={() => setBusqueda('')}>
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 18, paddingLeft: 8 }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={s.tabs}>
          <TouchableOpacity style={[s.tabBtn, tab === 'bolsa' && s.tabActive]} onPress={() => setTab('bolsa')}>
            <Text style={[s.tabText, tab === 'bolsa' && s.tabTextActive]}>🥡 Sabores Rescatados</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tabBtn, tab === 'cupon' && s.tabActive]} onPress={() => setTab('cupon')}>
            <Text style={[s.tabText, tab === 'cupon' && s.tabTextActive]}>🎫 Cupones</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Banners de estado */}
      {errorNet ? (
        <View style={s.errorBanner}>
          <Text style={s.errorBannerText}>📶 {errorNet}</Text>
          <TouchableOpacity onPress={cargar}><Text style={s.errorBannerBtn}>Reintentar</Text></TouchableOpacity>
        </View>
      ) : locDenied ? (
        <View style={s.permBanner}>
          <Text style={s.permBannerText}>📍 Activa la ubicación para ver distancias</Text>
          <TouchableOpacity onPress={requestPermission} style={s.permBannerBtn}>
            <Text style={s.permBannerBtnText}>Activar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Filtro de distancia */}
      {tieneUbicacion && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
          {DIST_OPCIONES.map(({ label, km }) => (
            <TouchableOpacity key={label} style={[s.chip, distFiltro === km && s.chipActive]} onPress={() => setDistFiltro(km)}>
              <Text style={[s.chipText, distFiltro === km && s.chipTextActive]}>{km ? `📍 ${label}` : '🌎 Todos'}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Zonas de Guatemala */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
        {ZONAS_GT.map((z) => (
          <TouchableOpacity key={z} style={[s.chip, zonaSelected === z && s.chipActive]} onPress={() => setZonaSelected(z)}>
            <Text style={[s.chipText, zonaSelected === z && s.chipTextActive]}>🏘️ {z}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Categorías */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
        {CATEGORIAS.map((cat) => (
          <TouchableOpacity key={cat} style={[s.chip, catSelected === cat && s.chipOrange]} onPress={() => setCatSelected(cat)}>
            <Text style={[s.chipText, catSelected === cat && s.chipTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Feed */}
      {loading ? (
        <View style={s.loadingBox}>
          <ActivityIndicator color={Colors.orange} size="large" />
          <Text style={s.loadingText}>{locLoading ? 'Obteniendo tu ubicación...' : 'Buscando bolsas disponibles...'}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.feed}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {/* Secciones cuando no hay filtro activo */}
          {!hayFiltro && (
            <>
              <SeccionHome titulo="⚡ Últimas horas" bolsas={ultimasHoras} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
              <SeccionHome titulo="⭐ Los más populares" bolsas={populares} onPress={(b) => router.push(`/producto/${b.id}` as any)} />
            </>
          )}

          {hayFiltro && filtradas.length > 0 && (
            <View style={s.resultBanner}>
              <Text style={s.resultText}>{filtradas.length} resultado{filtradas.length !== 1 ? 's' : ''}</Text>
            </View>
          )}

          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🍽️</Text>
              <Text style={s.emptyTitle}>
                {distFiltro && tieneUbicacion ? `Sin resultados en ${distFiltro} km` : 'Sin resultados'}
              </Text>
              <Text style={s.emptyText}>
                {busqueda ? `No encontramos "${busqueda}"` :
                  distFiltro && tieneUbicacion ? 'Prueba aumentando el radio' :
                  `No hay ${tab === 'cupon' ? 'cupones' : 'bolsas'} disponibles ahora`}
              </Text>
              {(hayFiltro) && (
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
          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { backgroundColor: Colors.brown, paddingBottom: 16 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12 },
  headerLoc: { color: Colors.orangeLight, fontSize: 12 },
  logo: { color: Colors.white, fontSize: 32, fontWeight: '900', letterSpacing: -0.5 },
  logoAccent: { color: Colors.orange },
  avatar: { backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: -2, right: -2, backgroundColor: Colors.orange, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 1.5, borderColor: Colors.brown },
  notifDotText: { color: Colors.white, fontSize: 8, fontWeight: '900' },
  searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 12 },
  searchIcon: { fontSize: 16, marginRight: 8 },
  search: { flex: 1, color: Colors.white, fontSize: 14, paddingVertical: 10 },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, padding: 3 },
  tabBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: Colors.orange },
  tabText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: Colors.white },
  errorBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEE2E2', padding: 10, paddingHorizontal: 16, gap: 8 },
  errorBannerText: { flex: 1, fontSize: 12, color: Colors.error, fontWeight: '600' },
  errorBannerBtn: { color: Colors.error, fontWeight: '800', fontSize: 12 },
  permBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.orangeLight, padding: 10, paddingHorizontal: 16, gap: 8 },
  permBannerText: { flex: 1, fontSize: 12, color: Colors.brown, fontWeight: '600' },
  permBannerBtn: { backgroundColor: Colors.orange, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  permBannerBtnText: { color: Colors.white, fontWeight: '800', fontSize: 12 },
  filterRow: { backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, maxHeight: 52 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: Colors.background },
  chipActive: { backgroundColor: Colors.brown, borderColor: Colors.brown },
  chipOrange: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  chipText: { fontSize: 12, color: Colors.textPrimary, fontWeight: '700' },
  chipTextActive: { color: Colors.white },
  resultBanner: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 10, marginBottom: 12 },
  resultText: { fontSize: 12, color: Colors.brown, fontWeight: '600' },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },
  feed: { padding: 16 },
  // Secciones
  seccion: { marginBottom: 20 },
  seccionTitulo: { fontSize: 17, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  miniCard: { width: 140, backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden', elevation: 2 },
  miniImg: { backgroundColor: Colors.brownLight, height: 90, justifyContent: 'center', alignItems: 'center' },
  miniBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: Colors.orange, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  miniBadgeText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  miniBody: { padding: 10 },
  miniNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  miniPrecio: { fontSize: 16, fontWeight: '900', color: Colors.orange, marginTop: 2 },
  // Cards
  card: { backgroundColor: Colors.white, borderRadius: 20, marginBottom: 14, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, overflow: 'hidden' },
  cardAgotada: { opacity: 0.55 },
  cardImg: { backgroundColor: Colors.brownLight, height: 120, justifyContent: 'center', alignItems: 'center' },
  badge: { position: 'absolute', top: 10, right: 10, backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  cuponText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  distBadge: { position: 'absolute', bottom: 8, left: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  distText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  timeBadge: { position: 'absolute', bottom: 8, right: 10, borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  timeText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  shareBtn: { position: 'absolute', top: 10, right: 50, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  cardBody: { padding: 14, flexDirection: 'row' },
  cardNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardNombre: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginTop: 2 },
  cardZona: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  cardHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  cardPrices: { alignItems: 'flex-end', justifyContent: 'center' },
  cardOriginal: { fontSize: 12, color: Colors.textLight, textDecorationLine: 'line-through' },
  cardDescuento: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  cardDisp: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  emptyBtn: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 10, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
