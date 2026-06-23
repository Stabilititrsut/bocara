import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { favoritosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { useAuth } from '@/src/context/AuthContext';
import ProductCard, { CARD_W } from '@/components/ProductCard';
import { Colors } from '@/constants/Colors';

const GOLD = '#E8820C';
const DARK = '#2C4A2E';
const RED  = '#E53935';

type TabKey = 'negocios' | 'bolsas';

// ─── 2-col grid ──────────────────────────────────────────────────────────────
function BolsasGrid({ bolsas, onAgregar }: { bolsas: any[]; onAgregar: (b: any) => void }) {
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < bolsas.length; i += 2) {
    rows.push(
      <View key={i} style={gs.row}>
        <ProductCard bolsa={bolsas[i]} onAgregar={onAgregar} />
        {bolsas[i + 1]
          ? <ProductCard bolsa={bolsas[i + 1]} onAgregar={onAgregar} />
          : <View style={{ width: CARD_W }} />}
      </View>
    );
  }
  return <>{rows}</>;
}

const gs = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
});

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function FavoritosScreen() {
  const router = useRouter();
  const { agregar } = useCart();
  const { usuario } = useAuth();

  const [activeTab,  setActiveTab]  = useState<TabKey>('negocios');
  const [negocios,   setNegocios]   = useState<any[]>([]);
  const [bolsas,     setBolsas]     = useState<any[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cargar = useCallback(async () => {
    if (!usuario) { setLoading(false); setRefreshing(false); return; }
    try {
      const [negRes, bolsasRes] = await Promise.all([
        favoritosAPI.listar(),
        favoritosAPI.listarBolsas().catch(() => ({ data: [] })),
      ]);
      console.log('[favoritos] negocios cargados:', negRes.data?.length ?? 0);
      console.log('[favoritos] bolsas cargadas:', bolsasRes.data?.length ?? 0);
      // GET /favoritos/negocios devuelve negocios planos [{id,nombre,categoria,...}]
      setNegocios(negRes.data || []);
      setBolsas(bolsasRes.data || []);
    } catch (err: any) {
      console.log('[favoritos] error cargando:', err?.message);
    } finally { setLoading(false); setRefreshing(false); }
  }, [usuario]);

  // Recargar cada vez que el usuario vuelve a esta pantalla
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      cargar();
    }, [cargar])
  );

  async function quitarNegocio(negocioId: string) {
    // Optimistic: quitar de la lista inmediatamente
    setNegocios(prev => prev.filter(n => n.id !== negocioId));
    try { await favoritosAPI.quitar(negocioId); }
    catch { cargar(); } // si falla, recargar
  }

  if (!usuario) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={s.headerTitle}>Favoritos</Text></View>
        <View style={s.empty}>
          <Ionicons name="person-outline" size={56} color={Colors.textLight} />
          <Text style={s.emptyTitle}>Inicia sesión para ver tus favoritos</Text>
          <TouchableOpacity style={s.emptyBtn} onPress={() => router.push('/login' as any)}>
            <Text style={s.emptyBtnText}>Iniciar sesión</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={s.headerTitle}>Favoritos</Text></View>
        <View style={s.loadingBox}><ActivityIndicator color={GOLD} size="large" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Favoritos</Text>
      </View>

      {/* Tab switcher */}
      <View style={s.tabRow}>
        <TouchableOpacity
          style={[s.tabBtn, activeTab === 'negocios' && s.tabBtnActive]}
          onPress={() => setActiveTab('negocios')}
          activeOpacity={0.8}
        >
          <Ionicons
            name={activeTab === 'negocios' ? 'storefront' : 'storefront-outline'}
            size={16}
            color={activeTab === 'negocios' ? '#fff' : Colors.textSecondary}
          />
          <Text style={[s.tabText, activeTab === 'negocios' && s.tabTextActive]}>
            Negocios{negocios.length > 0 ? ` (${negocios.length})` : ''}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.tabBtn, activeTab === 'bolsas' && s.tabBtnActive]}
          onPress={() => setActiveTab('bolsas')}
          activeOpacity={0.8}
        >
          <Ionicons
            name={activeTab === 'bolsas' ? 'bag' : 'bag-outline'}
            size={16}
            color={activeTab === 'bolsas' ? '#fff' : Colors.textSecondary}
          />
          <Text style={[s.tabText, activeTab === 'bolsas' && s.tabTextActive]}>
            Productos{bolsas.length > 0 ? ` (${bolsas.length})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); cargar(); }}
            tintColor={GOLD}
          />
        }
      >
        {/* ── Tab Negocios ── */}
        {activeTab === 'negocios' && (
          negocios.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="heart-outline" size={56} color={Colors.textLight} />
              <Text style={s.emptyTitle}>Aún no tienes negocios favoritos</Text>
              <Text style={s.emptyText}>Guarda tus restaurantes favoritos para encontrarlos rápido</Text>
              <TouchableOpacity
                style={s.emptyBtn}
                onPress={() => router.push('/(tabs)/tiendas' as any)}
              >
                <Text style={s.emptyBtnText}>Explorar negocios</Text>
              </TouchableOpacity>
            </View>
          ) : (
            // GET /favoritos/negocios devuelve [{id, nombre, categoria, zona, imagen_url, calificacion_promedio}]
            negocios.map(negocio => {
              const rating = negocio.calificacion_promedio || 0;
              return (
                <TouchableOpacity
                  key={negocio.id}
                  style={s.card}
                  onPress={() => router.push(`/negocio/${negocio.id}` as any)}
                  activeOpacity={0.88}
                >
                  <View style={s.cardImgWrap}>
                    {negocio.imagen_url ? (
                      <Image
                        source={{ uri: negocio.imagen_url }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={200}
                      />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, s.imgPlaceholder]}>
                        <Text style={{ fontSize: 30 }}>🏪</Text>
                      </View>
                    )}
                  </View>

                  <View style={s.cardInfo}>
                    <Text style={s.cardNombre} numberOfLines={1}>{negocio.nombre}</Text>
                    {negocio.categoria ? <Text style={s.cardCat}>{negocio.categoria}</Text> : null}
                    <View style={s.cardMeta}>
                      <Ionicons name="star" size={11} color={GOLD} />
                      <Text style={s.metaText}>{rating > 0 ? rating.toFixed(1) : 'Nuevo'}</Text>
                      {negocio.zona ? (
                        <>
                          <View style={s.metaDot} />
                          <Text style={s.metaText}>Zona {negocio.zona}</Text>
                        </>
                      ) : null}
                    </View>
                  </View>

                  {/* Botón quitar favorito — corazón rojo lleno */}
                  <TouchableOpacity
                    style={s.heartBtn}
                    onPress={() => quitarNegocio(negocio.id)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="heart" size={20} color={RED} />
                  </TouchableOpacity>

                  <Ionicons name="chevron-forward" size={16} color={Colors.textLight} style={{ marginRight: 12 }} />
                </TouchableOpacity>
              );
            })
          )
        )}

        {/* ── Tab Productos ── */}
        {activeTab === 'bolsas' && (
          bolsas.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="bag-outline" size={56} color={Colors.textLight} />
              <Text style={s.emptyTitle}>Aún no tienes productos favoritos</Text>
              <Text style={s.emptyText}>Guarda tus bolsas favoritas para pedirlas rápido</Text>
              <TouchableOpacity
                style={s.emptyBtn}
                onPress={() => router.push('/(tabs)/tiendas' as any)}
              >
                <Text style={s.emptyBtnText}>Explorar tiendas</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.gridWrap}>
              <BolsasGrid bolsas={bolsas} onAgregar={agregar} />
            </View>
          )
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    paddingHorizontal: 20, paddingVertical: 18,
    backgroundColor: Colors.white,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.5 },

  tabRow: {
    flexDirection: 'row',
    backgroundColor: Colors.white,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    paddingHorizontal: 16, paddingVertical: 8, gap: 8,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 12,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  tabBtnActive: { backgroundColor: DARK, borderColor: DARK },
  tabText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  tabTextActive: { color: '#fff' },

  scroll: { padding: 16 },

  // Negocio card
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.white, borderRadius: 20,
    marginBottom: 14, overflow: 'hidden',
    elevation: 3, shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10,
  },
  cardImgWrap: { width: 80, height: 80, backgroundColor: Colors.surface },
  imgPlaceholder: { justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface },
  cardInfo: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginBottom: 2 },
  cardCat: {
    fontSize: 10, color: Colors.textSecondary, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
  },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  metaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: Colors.textLight },
  heartBtn: { padding: 8, marginLeft: 4 },

  // Grid
  gridWrap: { paddingTop: 4 },

  // Empty / not logged
  empty: { paddingTop: 80, alignItems: 'center', gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  emptyText: {
    fontSize: 14, color: Colors.textSecondary,
    textAlign: 'center', lineHeight: 22, paddingHorizontal: 20,
  },
  emptyBtn: {
    backgroundColor: DARK, borderRadius: 50,
    paddingHorizontal: 28, paddingVertical: 12, marginTop: 4,
  },
  emptyBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
