import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

export default function CarritoScreen() {
  const { items, total, agregar, quitar, limpiar } = useCart();
  const router = useRouter();

  if (items.length === 0) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Mi carrito</Text>
        </View>
        <View style={s.empty}>
          <View style={s.emptyIconWrap}>
            <Ionicons name="bag-outline" size={44} color={Colors.textLight} />
          </View>
          <Text style={s.emptyTitle}>Tu carrito está vacío</Text>
          <Text style={s.emptyText}>Agrega bolsas de comida rescatada para empezar</Text>
          <TouchableOpacity style={s.emptyBtn} onPress={() => router.push('/(tabs)/')}>
            <Text style={s.emptyBtnText}>Explorar bolsas</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const co2Total = items.reduce((sum, i) => sum + i.bolsa.co2_salvado_kg * i.cantidad, 0);
  const ahorrado = items.reduce((sum, i) => sum + (i.bolsa.precio_original - i.bolsa.precio_descuento) * i.cantidad, 0);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mi carrito</Text>
        <TouchableOpacity onPress={limpiar} style={s.clearBtn}>
          <Ionicons name="trash-outline" size={16} color={Colors.error} />
          <Text style={s.clearBtnText}>Vaciar</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {items.map(({ bolsa, cantidad }) => (
          <View key={bolsa.id} style={s.item}>
            <View style={s.itemThumb}>
              <Ionicons name="restaurant" size={24} color={Colors.primary} />
            </View>
            <View style={s.itemInfo}>
              <Text style={s.itemNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
              <Text style={s.itemNombre} numberOfLines={1}>{bolsa.nombre}</Text>
              <View style={s.itemHoraRow}>
                <Ionicons name="time-outline" size={12} color={Colors.textSecondary} />
                <Text style={s.itemHora}>{bolsa.hora_recogida_inicio?.slice(0, 5)} – {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
              </View>
            </View>
            <View style={s.itemRight}>
              <Text style={s.itemPrecio}>Q{(bolsa.precio_descuento * cantidad).toFixed(0)}</Text>
              <View style={s.qtyRow}>
                <TouchableOpacity style={s.qtyBtn} onPress={() => quitar(bolsa.id)}>
                  <Ionicons name="remove" size={16} color={Colors.primary} />
                </TouchableOpacity>
                <Text style={s.qtyNum}>{cantidad}</Text>
                <TouchableOpacity style={s.qtyBtn} onPress={() => agregar(bolsa)}>
                  <Ionicons name="add" size={16} color={Colors.primary} />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ))}

        {/* Impacto ambiental */}
        <View style={s.impactCard}>
          <View style={s.impactHeader}>
            <Ionicons name="leaf" size={18} color={Colors.primary} />
            <Text style={s.impactTitle}>Tu impacto con este pedido</Text>
          </View>
          <View style={s.impactRow}>
            <View style={s.impactItem}>
              <Text style={s.impactNum}>{items.reduce((s, i) => s + i.cantidad, 0)}</Text>
              <Text style={s.impactLabel}>bolsas</Text>
            </View>
            <View style={s.impactDivider} />
            <View style={s.impactItem}>
              <Text style={s.impactNum}>{co2Total.toFixed(1)}</Text>
              <Text style={s.impactLabel}>kg CO₂ evitado</Text>
            </View>
            <View style={s.impactDivider} />
            <View style={s.impactItem}>
              <Text style={s.impactNum}>Q{ahorrado.toFixed(0)}</Text>
              <Text style={s.impactLabel}>ahorrado</Text>
            </View>
          </View>
        </View>

        <View style={{ height: 140 }} />
      </ScrollView>

      <View style={s.footer}>
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Total</Text>
          <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
        </View>
        <TouchableOpacity style={s.btnPago} onPress={() => router.push('/pago')}>
          <Text style={s.btnPagoText}>Proceder al pago</Text>
          <Ionicons name="arrow-forward" size={18} color={Colors.white} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18, backgroundColor: Colors.white, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 4 },
  headerTitle: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 8 },
  clearBtnText: { color: Colors.error, fontSize: 13, fontWeight: '600' },

  scroll: { padding: 16, paddingTop: 20 },

  item: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 22, padding: 16, marginBottom: 14, alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.09, shadowRadius: 12 },
  itemThumb: { width: 58, height: 58, borderRadius: 16, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  itemInfo: { flex: 1 },
  itemNegocio: { fontSize: 10, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  itemNombre: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, marginTop: 2 },
  itemHoraRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  itemHora: { fontSize: 11, color: Colors.textSecondary },
  itemRight: { alignItems: 'flex-end', gap: 10 },
  itemPrecio: { fontSize: 20, fontWeight: '900', color: Colors.primary },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyBtn: { width: 34, height: 34, borderRadius: 50, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center' },
  qtyNum: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, minWidth: 22, textAlign: 'center' },

  impactCard: { backgroundColor: Colors.primary, borderRadius: 24, padding: 20, marginTop: 4, elevation: 4, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12 },
  impactHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 18 },
  impactTitle: { fontSize: 15, fontWeight: '700', color: Colors.white },
  impactRow: { flexDirection: 'row', alignItems: 'center' },
  impactItem: { flex: 1, alignItems: 'center' },
  impactDivider: { width: 1, height: 44, backgroundColor: 'rgba(255,255,255,0.2)' },
  impactNum: { fontSize: 24, fontWeight: '900', color: Colors.white },
  impactLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 3, textAlign: 'center' },

  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.white, padding: 20, paddingBottom: 32, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 12 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  totalLabel: { fontSize: 16, color: Colors.textSecondary, fontWeight: '500' },
  totalVal: { fontSize: 30, fontWeight: '900', color: Colors.textPrimary },
  btnPago: { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, elevation: 4, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
  btnPagoText: { color: Colors.white, fontWeight: '800', fontSize: 16 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, padding: 32 },
  emptyIconWrap: { width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 22, fontWeight: '900', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyBtn: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 32, paddingVertical: 16, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
});
