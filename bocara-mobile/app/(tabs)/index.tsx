import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, RefreshControl, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { bolsasAPI, notificacionesAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';
import { useLocation } from '@/src/context/LocationContext';

const CATEGORIAS = ['Todos', 'Panadería', 'Restaurante', 'Cafetería', 'Supermercado'];
const EMOJI_MAP: Record<string, string> = {
  Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒',
  Sushi: '🍣', Pizza: '🍕', 'Comida Típica': '🫕', Otro: '🍱',
};

type DistFiltro = 1 | 3 | 5 | 10 | null;
const DIST_OPCIONES: Array<{ label: string; km: DistFiltro }> = [
  { label: '1 km', km: 1 },
  { label: '3 km', km: 3 },
  { label: '5 km', km: 5 },
  { label: '10 km', km: 10 },
  { label: 'Todos', km: null },
];

function formatDist(km: number | null | undefined): string | null {
  if (km === null || km === undefined) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function BolsaCard({ bolsa, onPress }: { bolsa: Bolsa & { distancia_km?: number | null }; onPress: () => void }) {
  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100)
    : 0;
  const emoji = EMOJI_MAP[bolsa.negocios?.categoria || ''] || '🍱';
  const agotada = bolsa.cantidad_disponible === 0;
  const distStr = formatDist(bolsa.distancia_km);

  return (
    <TouchableOpacity style={[s.card, agotada && s.cardAgotada]} onPress={onPress} disabled={agotada} activeOpacity={0.85}>
      <View style={s.cardImg}>
        <Text style={{ fontSize: 44 }}>{emoji}</Text>
        <View style={[s.badge, agotada && { backgroundColor: Colors.textLight }]}>
          <Text style={s.badgeText}>{agotada ? 'Agotada' : `-${desc}%`}</Text>
        </View>
        {bolsa.tipo === 'cupon' && (
          <View style={s.cuponBadge}><Text style={s.cuponText}>🎫 Cupón</Text></View>
        )}
        {distStr && (
          <View style={s.distBadge}>
            <Text style={s.distText}>📍 {distStr}</Text>
          </View>
        )}
      </View>
      <View style={s.cardBody}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.cardNombre} numberOfLines={1}>{bolsa.nombre}</Text>
          <View style={s.cardMetaRow}>
            <Text style={s.cardZona}>📍 {bolsa.negocios?.zona}</Text>
            {distStr && <Text style={s.cardDist}> · {distStr}</Text>}
          </View>
          <Text style={s.cardHora}>⏰ {bolsa.hora_recogida_inicio?.slice(0, 5)} - {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
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

export default function HomeScreen() {
  const [bolsas, setBolsas] = useState<Bolsa[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'bolsa' | 'cupon'>('bolsa');
  const [catSelected, setCatSelected] = useState('Todos');
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
    try {
      const params: Record<string, any> = { tipo: tab, activo: true };
      if (coords) {
        params.lat = coords.lat;
        params.lng = coords.lng;
      }
      const res = await bolsasAPI.listar(params);
      setBolsas(res.data || []);
    } catch {
      setBolsas([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab, coords]);

  useEffect(() => { setLoading(true); cargar(); }, [cargar]);

  // Client-side filtering (instant on chip change — no new API call)
  const filtradas = bolsas.filter((b) => {
    const matchCat = catSelected === 'Todos' || b.negocios?.categoria === catSelected;
    const matchBusq = !busqueda ||
      b.negocios?.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
      b.nombre.toLowerCase().includes(busqueda.toLowerCase());
    const matchDist = distFiltro === null ||
      (b as any).distancia_km === null ||
      (b as any).distancia_km === undefined ||
      (b as any).distancia_km <= distFiltro;
    return matchCat && matchBusq && matchDist;
  });

  const tieneUbicacion = coords !== null;
  const locDenied = permissionStatus === 'denied';

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerTop}>
          <TouchableOpacity onPress={!tieneUbicacion && !locDenied ? requestPermission : undefined} activeOpacity={tieneUbicacion ? 1 : 0.7}>
            <View style={s.locRow}>
              <Text style={s.headerLoc}>
                {locLoading ? '📍 Buscando...' : tieneUbicacion ? `📍 ${locationName}` : locDenied ? '📍 Sin ubicación' : '📍 Activar ubicación'}
              </Text>
              {!tieneUbicacion && !locLoading && (
                <View style={s.locBadge}>
                  <Text style={s.locBadgeText}>{locDenied ? 'Denegado' : 'Tocar para activar'}</Text>
                </View>
              )}
            </View>
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

        {/* Search */}
        <View style={s.searchRow}>
          <Text style={s.searchIcon}>🔍</Text>
          <TextInput
            style={s.search}
            placeholder="Busca restaurantes o productos..."
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={busqueda}
            onChangeText={setBusqueda}
          />
        </View>

        {/* Tabs */}
        <View style={s.tabs}>
          <TouchableOpacity style={[s.tabBtn, tab === 'bolsa' && s.tabActive]} onPress={() => setTab('bolsa')}>
            <Text style={[s.tabText, tab === 'bolsa' && s.tabTextActive]}>🥡 Sabores Rescatados</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tabBtn, tab === 'cupon' && s.tabActive]} onPress={() => setTab('cupon')}>
            <Text style={[s.tabText, tab === 'cupon' && s.tabTextActive]}>🎫 Cupones</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Banner permiso denegado */}
      {locDenied && (
        <View style={s.permBanner}>
          <Text style={s.permBannerText}>📍 Activa la ubicación para ver restaurantes cercanos y distancias</Text>
          <TouchableOpacity onPress={requestPermission} style={s.permBannerBtn}>
            <Text style={s.permBannerBtnText}>Activar</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Filtros de distancia — solo si hay ubicación */}
      {tieneUbicacion && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.distRow} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
          {DIST_OPCIONES.map(({ label, km }) => (
            <TouchableOpacity
              key={label}
              style={[s.distChip, distFiltro === km && s.distChipActive]}
              onPress={() => setDistFiltro(km)}
            >
              <Text style={[s.distChipText, distFiltro === km && s.distChipTextActive]}>
                {km ? `📍 ${label}` : '🌎 Todos'}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Categorías */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.cats} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}>
        {CATEGORIAS.map((cat) => (
          <TouchableOpacity key={cat} style={[s.catChip, catSelected === cat && s.catChipActive]} onPress={() => setCatSelected(cat)}>
            <Text style={[s.catText, catSelected === cat && s.catTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Feed */}
      {loading ? (
        <View style={s.loadingBox}>
          <ActivityIndicator color={Colors.orange} size="large" />
          <Text style={s.loadingText}>
            {locLoading ? 'Obteniendo tu ubicación...' : 'Buscando bolsas disponibles...'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.feed}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {tieneUbicacion && distFiltro && (
            <View style={s.filtroActivoBanner}>
              <Text style={s.filtroActivoText}>
                📍 Mostrando restaurantes a menos de {distFiltro} km de ti · {filtradas.length} resultado{filtradas.length !== 1 ? 's' : ''}
              </Text>
            </View>
          )}

          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🍽️</Text>
              <Text style={s.emptyTitle}>
                {distFiltro && tieneUbicacion ? `Sin resultados en ${distFiltro} km` : 'Sin resultados'}
              </Text>
              <Text style={s.emptyText}>
                {distFiltro && tieneUbicacion
                  ? 'Prueba aumentando el radio de búsqueda'
                  : `No hay ${tab === 'cupon' ? 'cupones' : 'bolsas'} disponibles en este momento`}
              </Text>
              {distFiltro && tieneUbicacion && (
                <TouchableOpacity style={s.emptyBtn} onPress={() => setDistFiltro(null)}>
                  <Text style={s.emptyBtnText}>Ver todos los restaurantes</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            filtradas.map((b) => (
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
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerLoc: { color: Colors.orangeLight, fontSize: 12 },
  locBadge: { backgroundColor: 'rgba(255,165,0,0.25)', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  locBadgeText: { color: Colors.orangeLight, fontSize: 10, fontWeight: '700' },
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
  permBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.orangeLight, padding: 10, paddingHorizontal: 16, gap: 8 },
  permBannerText: { flex: 1, fontSize: 12, color: Colors.brown, fontWeight: '600' },
  permBannerBtn: { backgroundColor: Colors.orange, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  permBannerBtnText: { color: Colors.white, fontWeight: '800', fontSize: 12 },
  distRow: { backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, maxHeight: 52 },
  distChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: Colors.background },
  distChipActive: { backgroundColor: Colors.brown, borderColor: Colors.brown },
  distChipText: { fontSize: 13, color: Colors.textPrimary, fontWeight: '700' },
  distChipTextActive: { color: Colors.white },
  cats: { backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  catChip: { borderWidth: 1.5, borderColor: '#C9B8AC', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8, marginRight: 8, backgroundColor: Colors.background },
  catChipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  catText: { fontSize: 13, color: Colors.textPrimary, fontWeight: '700' },
  catTextActive: { color: Colors.white },
  filtroActivoBanner: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 10, marginBottom: 12 },
  filtroActivoText: { fontSize: 12, color: Colors.brown, fontWeight: '600' },
  feed: { padding: 16 },
  card: { backgroundColor: Colors.white, borderRadius: 20, marginBottom: 14, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, overflow: 'hidden' },
  cardAgotada: { opacity: 0.55 },
  cardImg: { backgroundColor: Colors.brownLight, height: 110, justifyContent: 'center', alignItems: 'center' },
  badge: { position: 'absolute', top: 10, right: 10, backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  cuponText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  distBadge: { position: 'absolute', bottom: 8, left: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, paddingHorizontal: 8, paddingVertical: 3 },
  distText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  cardBody: { padding: 14, flexDirection: 'row' },
  cardNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardNombre: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginTop: 2 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  cardZona: { fontSize: 12, color: Colors.textSecondary },
  cardDist: { fontSize: 12, color: Colors.orange, fontWeight: '700' },
  cardHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  cardPrices: { alignItems: 'flex-end', justifyContent: 'center' },
  cardOriginal: { fontSize: 12, color: Colors.textLight, textDecorationLine: 'line-through' },
  cardDescuento: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  cardDisp: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  emptyBtn: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 10, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
