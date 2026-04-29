import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

export default function CarritoScreen() {
  const { items, total, agregar, quitar, limpiar } = useCart();
  const router = useRouter();

  if (items.length === 0) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={s.headerTitle}>Mi carrito</Text></View>
        <View style={s.empty}>
          <Text style={{ fontSize: 56 }}>🛒</Text>
          <Text style={s.emptyTitle}>Tu carrito está vacío</Text>
          <Text style={s.emptyText}>Agrega bolsas de comida rescatada para empezar</Text>
          <TouchableOpacity style={s.btnEmpty} onPress={() => router.push('/(tabs)/')}>
            <Text style={s.btnEmptyText}>Explorar bolsas</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mi carrito</Text>
        <TouchableOpacity onPress={limpiar}><Text style={s.clearBtn}>Vaciar</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {items.map(({ bolsa, cantidad }) => (
          <View key={bolsa.id} style={s.item}>
            <View style={s.itemEmoji}><Text style={{ fontSize: 32 }}>🍱</Text></View>
            <View style={s.itemInfo}>
              <Text style={s.itemNegocio}>{bolsa.negocios?.nombre}</Text>
              <Text style={s.itemNombre}>{bolsa.nombre}</Text>
              <Text style={s.itemHora}>⏰ {bolsa.hora_recogida_inicio?.slice(0,5)} - {bolsa.hora_recogida_fin?.slice(0,5)}</Text>
            </View>
            <View style={s.itemRight}>
              <Text style={s.itemPrecio}>Q{(bolsa.precio_descuento * cantidad).toFixed(0)}</Text>
              <View style={s.qty}>
                <TouchableOpacity style={s.qtyBtn} onPress={() => quitar(bolsa.id)}>
                  <Text style={s.qtyBtnText}>−</Text>
                </TouchableOpacity>
                <Text style={s.qtyNum}>{cantidad}</Text>
                <TouchableOpacity style={s.qtyBtn} onPress={() => agregar(bolsa)}>
                  <Text style={s.qtyBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ))}

        {/* Impacto */}
        <View style={s.impact}>
          <Text style={s.impactTitle}>🌱 Tu impacto con este pedido</Text>
          <View style={s.impactRow}>
            <View style={s.impactItem}>
              <Text style={s.impactNum}>{items.length}</Text>
              <Text style={s.impactLabel}>bolsas</Text>
            </View>
            <View style={s.impactItem}>
              <Text style={s.impactNum}>{(items.reduce((s, i) => s + i.bolsa.co2_salvado_kg * i.cantidad, 0)).toFixed(1)}</Text>
              <Text style={s.impactLabel}>kg CO₂</Text>
            </View>
            <View style={s.impactItem}>
              <Text style={s.impactNum}>Q{(items.reduce((s, i) => s + (i.bolsa.precio_original - i.bolsa.precio_descuento) * i.cantidad, 0)).toFixed(0)}</Text>
              <Text style={s.impactLabel}>ahorrado</Text>
            </View>
          </View>
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Footer */}
      <View style={s.footer}>
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Total</Text>
          <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
        </View>
        <TouchableOpacity style={s.btnPago} onPress={() => router.push('/pago')}>
          <Text style={s.btnPagoText}>Proceder al pago →</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  clearBtn: { color: Colors.error, fontSize: 14, fontWeight: '600' },
  scroll: { padding: 16 },
  item: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, alignItems: 'center', elevation: 2 },
  itemEmoji: { backgroundColor: Colors.brownLight, borderRadius: 12, width: 56, height: 56, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  itemInfo: { flex: 1 },
  itemNegocio: { fontSize: 10, color: Colors.textLight, fontWeight: '600', textTransform: 'uppercase' },
  itemNombre: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginTop: 2 },
  itemHora: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  itemRight: { alignItems: 'flex-end', gap: 8 },
  itemPrecio: { fontSize: 18, fontWeight: '900', color: Colors.orange },
  qty: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { backgroundColor: Colors.brownLight, borderRadius: 8, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: 18, color: Colors.brown, fontWeight: '700', lineHeight: 22 },
  qtyNum: { fontSize: 16, fontWeight: '800', color: Colors.brown, minWidth: 24, textAlign: 'center' },
  impact: { backgroundColor: Colors.greenLight, borderRadius: 16, padding: 16, marginTop: 8 },
  impactTitle: { fontSize: 14, fontWeight: '800', color: Colors.green, marginBottom: 12 },
  impactRow: { flexDirection: 'row', justifyContent: 'space-around' },
  impactItem: { alignItems: 'center' },
  impactNum: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  impactLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.white, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  totalLabel: { fontSize: 16, color: Colors.textSecondary },
  totalVal: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  btnPago: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center' },
  btnPagoText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  btnEmpty: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 14, marginTop: 8 },
  btnEmptyText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
});
