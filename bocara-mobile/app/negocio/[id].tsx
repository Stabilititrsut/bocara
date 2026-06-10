import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { negociosAPI } from '@/src/services/api';

const GOLD = '#C8A97E';
const { width: SW } = Dimensions.get('window');
const CARD_W = Math.floor((SW - 48) / 2);
const CARD_H = 250;
const CARD_IMG_H = 145;

function BolsaCard({ bolsa, onPress }: { bolsa: any; onPress: () => void }) {
  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const agotada = bolsa.cantidad_disponible === 0;

  return (
    <TouchableOpacity
      style={[s.bolsaCard, { width: CARD_W, height: CARD_H }, agotada && { opacity: 0.45 }]}
      onPress={onPress}
      activeOpacity={0.88}
      disabled={agotada}
    >
      <View style={[s.bolsaImgWrap, { height: CARD_IMG_H }]}>
        {bolsa.imagen_url ? (
          <Image source={{ uri: bolsa.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#F5F0EB', justifyContent: 'center', alignItems: 'center' }]}>
            <Text style={{ fontSize: 38 }}>🥐</Text>
          </View>
        )}
        <View style={[s.discBadge, agotada && { backgroundColor: '#8A8A8A' }]}>
          <Text style={s.discText}>{agotada ? 'Agotado' : `-${desc}%`}</Text>
        </View>
      </View>
      <View style={s.bolsaInfo}>
        <Text style={s.bolsaNombre} numberOfLines={2}>{bolsa.nombre}</Text>
        <View style={s.precioRow}>
          <View>
            <Text style={s.precioOriginal}>Q{bolsa.precio_original?.toFixed(2)}</Text>
            <Text style={s.precioDescuento}>Q{bolsa.precio_descuento?.toFixed(2)}</Text>
          </View>
          {!agotada && (
            <TouchableOpacity style={s.addBtn} onPress={onPress}>
              <Ionicons name="add" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function NegocioDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [negocio, setNegocio] = useState<any>(null);
  const [tiempoLimitado, setTiempoLimitado] = useState<any[]>([]);
  const [promociones, setPromociones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      negociosAPI.detalle(id),
      negociosAPI.bolsas(id),
    ]).then(([negRes, bolsasRes]) => {
      setNegocio(negRes.data);
      const grouped = bolsasRes.data || {};
      setTiempoLimitado(grouped.tiempo_limitado || []);
      setPromociones(grouped.promociones || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [id]);

  function renderGrid(items: any[]) {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push(
        <View key={i} style={s.gridRow}>
          <BolsaCard bolsa={items[i]} onPress={() => router.push(`/producto/${items[i].id}` as any)} />
          {items[i + 1]
            ? <BolsaCard bolsa={items[i + 1]} onPress={() => router.push(`/producto/${items[i + 1].id}` as any)} />
            : <View style={{ width: CARD_W }} />
          }
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
    <SafeAreaView style={s.root}>
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* COVER */}
        <View style={s.cover}>
          {negocio?.imagen_url ? (
            <Image source={{ uri: negocio.imagen_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: GOLD }]} />
          )}
          <View style={s.coverOverlay} />
          <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* INFO CARD */}
        <View style={s.infoCard}>
          <Text style={s.negocioNombre}>{negocio?.nombre}</Text>
          {negocio?.zona ? (
            <View style={s.metaRow}>
              <Ionicons name="location" size={13} color={GOLD} />
              <Text style={s.metaText}>Zona {negocio.zona}</Text>
              {negocio.ciudad ? <Text style={s.metaText}>· {negocio.ciudad}</Text> : null}
            </View>
          ) : null}
          {negocio?.descripcion ? (
            <Text style={s.descripcion}>{negocio.descripcion}</Text>
          ) : null}
        </View>

        {/* TIEMPO LIMITADO */}
        {tiempoLimitado.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>⏱️  Disponibles por Tiempo Limitado</Text>
            {renderGrid(tiempoLimitado)}
          </View>
        )}

        {/* PROMOCIONES */}
        {promociones.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>🏷️  Promociones</Text>
            {renderGrid(promociones)}
          </View>
        )}

        {tiempoLimitado.length === 0 && promociones.length === 0 && (
          <View style={s.emptyState}>
            <Text style={{ fontSize: 48 }}>🕐</Text>
            <Text style={s.emptyTitle}>Sin productos activos</Text>
            <Text style={s.emptySub}>Este negocio no tiene productos disponibles en este momento.</Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF' },

  cover: { height: 220, backgroundColor: GOLD },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.22)' },
  backBtn: {
    position: 'absolute', top: 16, left: 16,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.40)', alignItems: 'center', justifyContent: 'center',
  },

  infoCard: {
    backgroundColor: '#FFFFFF', borderRadius: 24, padding: 20,
    marginHorizontal: 16, marginTop: -28, elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.10, shadowRadius: 12,
    marginBottom: 8,
  },
  negocioNombre: { fontSize: 22, fontWeight: '900', color: '#1A1A1A', marginBottom: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  metaText: { fontSize: 13, color: '#8A8A8A', fontWeight: '500' },
  descripcion: { fontSize: 13, color: '#8A8A8A', lineHeight: 20, marginTop: 4 },

  section: { paddingHorizontal: 16, paddingTop: 20, marginBottom: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '900', color: '#1A1A1A', marginBottom: 16 },

  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },

  bolsaCard: { backgroundColor: '#FFFFFF', borderRadius: 20, overflow: 'hidden', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10 },
  bolsaImgWrap: { backgroundColor: '#F5F0EB', justifyContent: 'center', alignItems: 'center' },
  discBadge: { position: 'absolute', top: 10, left: 10, backgroundColor: '#1A1A1A', borderRadius: 50, paddingHorizontal: 9, paddingVertical: 4 },
  discText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  bolsaInfo: { padding: 12 },
  bolsaNombre: { fontSize: 13, fontWeight: '800', color: '#1A1A1A', lineHeight: 18, marginBottom: 8 },
  precioRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  precioOriginal: { fontSize: 10, color: '#C4C4C4', textDecorationLine: 'line-through' },
  precioDescuento: { fontSize: 18, fontWeight: '900', color: '#1A1A1A' },
  addBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#1A1A1A', alignItems: 'center', justifyContent: 'center' },

  emptyState: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: '#1A1A1A', marginTop: 12 },
  emptySub: { fontSize: 13, color: '#8A8A8A', textAlign: 'center', marginTop: 6, lineHeight: 20 },
});
