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

const CATEGORIAS = ['Todos', 'Panadería', 'Restaurante', 'Cafetería', 'Supermercado'];
const EMOJI_MAP: Record<string, string> = {
  Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒',
  Sushi: '🍣', Pizza: '🍕', 'Comida Típica': '🫕', Otro: '🍱',
};

function BolsaCard({ bolsa, onPress }: { bolsa: Bolsa; onPress: () => void }) {
  const desc = Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100);
  const emoji = EMOJI_MAP[bolsa.negocios?.categoria || ''] || '🍱';
  const agotada = bolsa.cantidad_disponible === 0;

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
      </View>
      <View style={s.cardBody}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.cardNombre} numberOfLines={1}>{bolsa.nombre}</Text>
          <Text style={s.cardZona}>📍 {bolsa.negocios?.zona}</Text>
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
  const [sinLeerCount, setSinLeerCount] = useState(0);
  const router = useRouter();
  const { usuario } = useAuth();

  useEffect(() => {
    notificacionesAPI.listar().then((r) => {
      const sinLeer = (r.data || []).filter((n: any) => !n.leida).length;
      setSinLeerCount(sinLeer);
    }).catch(() => {});
  }, []);

  const cargar = useCallback(async () => {
    try {
      const res = await bolsasAPI.listar({ tipo: tab, activo: true });
      setBolsas(res.data || []);
    } catch {
      // usar datos de muestra si no hay conexión
      setBolsas([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab]);

  useEffect(() => { setLoading(true); cargar(); }, [cargar]);

  const filtradas = bolsas.filter((b) => {
    const matchCat = catSelected === 'Todos' || b.negocios?.categoria === catSelected;
    const matchBusq = !busqueda || b.negocios?.nombre.toLowerCase().includes(busqueda.toLowerCase()) || b.nombre.toLowerCase().includes(busqueda.toLowerCase());
    return matchCat && matchBusq;
  });

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerTop}>
          <View>
            <Text style={s.headerLoc}>📍 Guatemala City</Text>
            <Text style={s.logo}>Boca<Text style={s.logoAccent}>ra</Text></Text>
          </View>
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
            placeholderTextColor={Colors.textLight}
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

      {/* Categorías */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.cats} contentContainerStyle={{ paddingHorizontal: 16 }}>
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
          <Text style={s.loadingText}>Buscando bolsas disponibles...</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.feed}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {filtradas.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 48 }}>🍽️</Text>
              <Text style={s.emptyTitle}>Sin resultados</Text>
              <Text style={s.emptyText}>No hay {tab === 'cupon' ? 'cupones' : 'bolsas'} disponibles en este momento</Text>
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
  cats: { maxHeight: 48, marginTop: 12 },
  catChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginRight: 8, backgroundColor: Colors.white },
  catChipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  catText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  catTextActive: { color: Colors.white },
  feed: { padding: 16 },
  card: { backgroundColor: Colors.white, borderRadius: 20, marginBottom: 14, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, overflow: 'hidden' },
  cardAgotada: { opacity: 0.55 },
  cardImg: { backgroundColor: Colors.brownLight, height: 110, justifyContent: 'center', alignItems: 'center' },
  badge: { position: 'absolute', top: 10, right: 10, backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: Colors.white, fontSize: 12, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  cuponText: { color: Colors.white, fontSize: 11, fontWeight: '700' },
  cardBody: { padding: 14, flexDirection: 'row' },
  cardNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardNombre: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginTop: 2 },
  cardZona: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
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
});
