import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Alert, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { pedidosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

type TipoEntrega = 'recogida' | 'envio';

export default function PagoScreen() {
  const { items, total, limpiar } = useCart();
  const router = useRouter();
  const [tipo, setTipo] = useState<TipoEntrega>('recogida');
  const [direccion, setDireccion] = useState({ calle: '', zona: '', ciudad: 'Guatemala', referencia: '' });
  const [loading, setLoading] = useState(false);
  const costoEnvio = tipo === 'envio' ? 25 : 0;
  const totalFinal = total + costoEnvio;

  const set = (k: string) => (v: string) => setDireccion((d) => ({ ...d, [k]: v }));

  async function handlePagar() {
    if (tipo === 'envio' && (!direccion.calle || !direccion.zona)) {
      return Alert.alert('Error', 'Ingresa tu dirección de entrega');
    }
    if (items.length === 0) return;

    setLoading(true);
    try {
      const item = items[0];
      const res = await pedidosAPI.crear({
        bolsa_id: item.bolsa.id,
        tipo_entrega: tipo,
        direccion_envio: tipo === 'envio' ? direccion : undefined,
      });
      const { codigoRecogida, pedidoId } = res.data;
      limpiar();
      router.replace({
        pathname: '/qr-recogida',
        params: { codigo: codigoRecogida, pedidoId, tipo },
      } as any);
    } catch (e: any) {
      Alert.alert('Error al confirmar pedido', e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Resumen */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>📋 Resumen del pedido</Text>
          {items.map(({ bolsa, cantidad }) => (
            <View key={bolsa.id} style={s.orderItem}>
              <Text style={s.orderName}>{bolsa.nombre}</Text>
              <Text style={s.orderNegocio}>{bolsa.negocios?.nombre} × {cantidad}</Text>
              <Text style={s.orderPrice}>Q{(bolsa.precio_descuento * cantidad).toFixed(0)}</Text>
            </View>
          ))}
        </View>

        {/* Tipo entrega */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>🚗 Tipo de entrega</Text>
          <View style={s.tipoRow}>
            <TouchableOpacity style={[s.tipoBtn, tipo === 'recogida' && s.tipoBtnActive]} onPress={() => setTipo('recogida')}>
              <Text style={s.tipoEmoji}>🏪</Text>
              <Text style={[s.tipoLabel, tipo === 'recogida' && s.tipoLabelActive]}>Recoger</Text>
              <Text style={[s.tipoPrecio, tipo === 'recogida' && s.tipoPrecioActive]}>Gratis</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.tipoBtn, tipo === 'envio' && s.tipoBtnActive]} onPress={() => setTipo('envio')}>
              <Text style={s.tipoEmoji}>🏍️</Text>
              <Text style={[s.tipoLabel, tipo === 'envio' && s.tipoLabelActive]}>Envío</Text>
              <Text style={[s.tipoPrecio, tipo === 'envio' && s.tipoPrecioActive]}>Q25</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Dirección si es envío */}
        {tipo === 'envio' && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>📍 Dirección de entrega</Text>
            {[
              { key: 'calle', label: 'Calle y número *', placeholder: '5a Calle 10-35' },
              { key: 'zona', label: 'Zona *', placeholder: 'Zona 10' },
              { key: 'ciudad', label: 'Ciudad', placeholder: 'Guatemala' },
              { key: 'referencia', label: 'Referencia', placeholder: 'Frente al banco...' },
            ].map(({ key, label, placeholder }) => (
              <View key={key}>
                <Text style={s.label}>{label}</Text>
                <TextInput
                  style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
                  value={(direccion as any)[key]} onChangeText={set(key)}
                />
              </View>
            ))}
          </View>
        )}

        {/* Pago */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>💳 Método de pago</Text>
          <View style={s.payMethod}>
            <Text style={{ fontSize: 24 }}>💳</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.payLabel}>Tarjeta de crédito/débito</Text>
              <Text style={s.paySubLabel}>Procesado de forma segura con Stripe</Text>
            </View>
            <View style={s.payCheck}><Text style={{ color: Colors.white, fontSize: 12 }}>✓</Text></View>
          </View>
        </View>

        {/* Total */}
        <View style={s.totalBox}>
          <View style={s.totalLine}>
            <Text style={s.totalKey}>Subtotal</Text>
            <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
          </View>
          {tipo === 'envio' && (
            <View style={s.totalLine}>
              <Text style={s.totalKey}>Envío</Text>
              <Text style={s.totalVal}>Q{costoEnvio}</Text>
            </View>
          )}
          <View style={[s.totalLine, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.border }]}>
            <Text style={s.totalFinalKey}>Total</Text>
            <Text style={s.totalFinalVal}>Q{totalFinal.toFixed(2)}</Text>
          </View>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity style={[s.btnPagar, loading && s.btnDisabled]} onPress={handlePagar} disabled={loading}>
          {loading ? <ActivityIndicator color={Colors.white} /> : <Text style={s.btnPagarText}>Pagar Q{totalFinal.toFixed(2)}</Text>}
        </TouchableOpacity>
        <Text style={s.seguro}>🔒 Pago seguro con SSL</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 16 },
  section: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  orderItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  orderName: { flex: 1, fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  orderNegocio: { fontSize: 12, color: Colors.textSecondary, marginRight: 8 },
  orderPrice: { fontSize: 14, fontWeight: '800', color: Colors.orange },
  tipoRow: { flexDirection: 'row', gap: 10 },
  tipoBtn: { flex: 1, borderWidth: 2, borderColor: Colors.border, borderRadius: 14, padding: 14, alignItems: 'center', gap: 4 },
  tipoBtnActive: { borderColor: Colors.orange, backgroundColor: Colors.orangeLight },
  tipoEmoji: { fontSize: 24 },
  tipoLabel: { fontSize: 14, fontWeight: '700', color: Colors.textSecondary },
  tipoLabelActive: { color: Colors.brown },
  tipoPrecio: { fontSize: 13, color: Colors.textLight },
  tipoPrecioActive: { color: Colors.orange, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.inputBg, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 12 },
  payMethod: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.inputBg, borderRadius: 12, padding: 14 },
  payLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  paySubLabel: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  payCheck: { backgroundColor: Colors.green, borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  totalBox: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  totalKey: { fontSize: 14, color: Colors.textSecondary },
  totalVal: { fontSize: 14, color: Colors.textPrimary, fontWeight: '600' },
  totalFinalKey: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  totalFinalVal: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  footer: { backgroundColor: Colors.white, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center' },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 17 },
  seguro: { textAlign: 'center', fontSize: 12, color: Colors.textLight, marginTop: 8 },
});
