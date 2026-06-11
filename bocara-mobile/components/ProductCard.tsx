import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCart } from '@/src/context/CartContext';
import { favoritosAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';

const { width: SW } = Dimensions.get('window');
export const CARD_W = Math.floor((SW - 44) / 2);

const GOLD  = '#C8A97E';
const DARK  = '#1A1A1A';
const SURF  = '#F5F0EB';
const BADGE = '#FFD600';
const RED   = '#E53935';

export interface ProductCardProps {
  bolsa: Bolsa;
  onAgregar: (bolsa: Bolsa) => void;
  width?: number;
  showFavorite?: boolean;
  isFavorited?: boolean;
}

export default function ProductCard({ bolsa, onAgregar, width, showFavorite, isFavorited }: ProductCardProps) {
  const router = useRouter();
  const { items } = useCart();
  const cartCount = items.find(i => i.bolsa.id === bolsa.id)?.cantidad || 0;
  const [isFav, setIsFav] = useState(!!isFavorited);

  useEffect(() => { setIsFav(!!isFavorited); }, [isFavorited]);

  const pct = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const agotado = bolsa.cantidad_disponible === 0;
  const w       = width ?? CARD_W;

  async function toggleFav() {
    const prev = isFav;
    setIsFav(!prev);
    try {
      if (prev) await favoritosAPI.quitarBolsa(bolsa.id);
      else      await favoritosAPI.agregarBolsa(bolsa.id);
    } catch {
      setIsFav(prev);
    }
  }

  return (
    <View style={[s.card, { width: w }, agotado && s.agotado]}>
      <TouchableOpacity
        style={s.imgWrap}
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
            onError={() => {}}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, s.placeholder]}>
            <Text style={s.placeholderEmoji}>🥐</Text>
          </View>
        )}

        {pct > 0 && !agotado && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{pct}% DTO</Text>
          </View>
        )}
        {agotado && (
          <View style={[s.badge, { backgroundColor: '#9CA3AF' }]}>
            <Text style={s.badgeText}>Agotado</Text>
          </View>
        )}

        {showFavorite && (
          <TouchableOpacity
            style={s.favBtn}
            onPress={toggleFav}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.8}
          >
            <Ionicons
              name={isFav ? 'heart' : 'heart-outline'}
              size={14}
              color={isFav ? RED : '#fff'}
            />
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      <View style={s.body}>
        <Text style={s.nombre} numberOfLines={2}>{bolsa.nombre}</Text>

        <View style={s.bottomRow}>
          <View>
            <Text style={s.precio}>Q{bolsa.precio_descuento?.toFixed(2)}</Text>
            {bolsa.precio_original > bolsa.precio_descuento && (
              <Text style={s.orig}>Q{bolsa.precio_original?.toFixed(2)}</Text>
            )}
          </View>

          {!agotado && (
            <TouchableOpacity
              style={[s.addBtn, cartCount > 0 && s.addBtnActive]}
              onPress={() => onAgregar(bolsa)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.85}
            >
              {cartCount > 0
                ? <Text style={s.addBtnCount}>{cartCount}</Text>
                : <Ionicons name="add" size={18} color="#fff" />
              }
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  agotado: { opacity: 0.45 },
  imgWrap: {
    height: 140,
    backgroundColor: SURF,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    backgroundColor: SURF,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderEmoji: { fontSize: 40 },
  badge: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: BADGE,
    borderRadius: 50,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { fontSize: 10, fontWeight: '900', color: DARK },
  favBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: 10 },
  nombre: { fontSize: 13, fontWeight: '700', color: DARK, lineHeight: 18, marginBottom: 8 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  precio: { fontSize: 16, fontWeight: '900', color: GOLD },
  orig: { fontSize: 10, color: '#C4C4C4', textDecorationLine: 'line-through', marginTop: 1 },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: DARK,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },
  addBtnActive: { backgroundColor: GOLD },
  addBtnCount: { fontSize: 12, fontWeight: '900', color: '#fff' },
});
