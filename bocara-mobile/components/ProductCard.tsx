import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCart } from '@/src/context/CartContext';

const { width: SW } = Dimensions.get('window');
export const CARD_W = Math.floor((SW - 44) / 2);

const GOLD  = '#C8A97E';
const DARK  = '#1A1A1A';
const SURF  = '#F5F0EB';
const BADGE = '#FFD600';

interface Props {
  item: any;
  fallbackImg?: string;
  width?: number;
}

export default function ProductCard({ item, fallbackImg, width }: Props) {
  const router = useRouter();
  const { items, agregar } = useCart();
  const cartCount = items.find(i => i.bolsa.id === item.id)?.cantidad || 0;

  const pct = item.precio_original > 0
    ? Math.round((1 - item.precio_descuento / item.precio_original) * 100) : 0;
  const agotado = item.cantidad_disponible === 0;
  const imgSrc  = item.imagen_url || fallbackImg;
  const w       = width ?? CARD_W;

  return (
    <View style={[s.card, { width: w }, agotado && s.agotado]}>
      {/* Image area */}
      <TouchableOpacity
        style={[s.imgWrap]}
        onPress={() => router.push(`/producto/${item.id}` as any)}
        activeOpacity={0.92}
        disabled={agotado}
      >
        {imgSrc ? (
          <Image
            source={{ uri: imgSrc }}
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

        {/* Discount badge */}
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
      </TouchableOpacity>

      {/* Info area */}
      <View style={s.body}>
        <Text style={s.nombre} numberOfLines={2}>{item.nombre}</Text>

        <View style={s.bottomRow}>
          <View>
            <Text style={s.precio}>Q{item.precio_descuento?.toFixed(2)}</Text>
            {item.precio_original > item.precio_descuento && (
              <Text style={s.orig}>Q{item.precio_original?.toFixed(2)}</Text>
            )}
          </View>

          {!agotado && (
            <TouchableOpacity
              style={[s.addBtn, cartCount > 0 && s.addBtnActive]}
              onPress={() => agregar(item)}
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
