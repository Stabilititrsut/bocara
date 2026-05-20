import { useState, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Alert, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { useLocation } from '@/src/context/LocationContext';
import { Colors } from '@/constants/Colors';

const ENVIO_MAX_KM = 10;
type TipoEntrega = 'recogida' | 'envio';

export default function PagoScreen() {
  const { items, total, limpiar } = useCart();
  const router = useRouter();
  const { haversine, formatDistancia } = useLocation();
  const [tipo, setTipo] = useState<TipoEntrega>('recogida');
  const [direccion, setDireccion] = useState({ calle: '', zona: '', ciudad: 'Guatemala', referencia: '' });
  const [loading, setLoading] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const costoEnvio = tipo === 'envio' ? 25 : 0;
  const totalFinal = total + costoEnvio;
  const comisionCubo = totalFinal * 0.035;

  const distanciaRestaurante = useMemo(() => {
    if (!items[0]) return null;
    const neg = items[0].bolsa.negocios;
    if (!neg?.latitud || !neg?.longitud) return null;
    return haversine(neg.latitud, neg.longitud);
  }, [items, haversine]);

  const envioDisponible = distanciaRestaurante === null || distanciaRestaurante <= ENVIO_MAX_KM;
  const distStr = formatDistancia(distanciaRestaurante);
  const set = (k: string) => (v: string) => setDireccion((d) => ({ ...d, [k]: v }));

  function limpiarPolling() {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }

  async function iniciarPago() {
    if (tipo === 'envio' && (!direccion.calle || !direccion.zona)) {
      return Alert.alert('Campos requeridos', 'Ingresa tu dirección de entrega');
    }
    if (items.length === 0) return;
    setLoading(true);
    try {
      const item = items[0];
      const res = await pagosAPI.cubopago({
        bolsa_id: item.bolsa.id,
        tipo_entrega: tipo,
        direccion_envio: tipo === 'envio' ? direccion : undefined,
      });
      const { pedidoId, codigoRecogida, visaLinkUrl } = res.data;
      await WebBrowser.openBrowserAsync(visaLinkUrl, { showTitle: true, toolbarColor: Colors.primary });
      setVerificando(true);
      let intentos = 0;
      pollingRef.current = setInterval(async () => {
        intentos++;
        try {
          const estadoRes = await pagosAPI.estado(pedidoId);
          const { estado_pago, estado } = estadoRes.data;
          if (estado_pago === 'pagado' && estado === 'confirmado') {
            limpiarPolling(); setVerificando(false); limpiar();
            router.replace({ pathname: '/qr-recogida', params: { codigo: codigoRecogida, pedidoId, tipo } } as any);
          } else if (estado_pago === 'fallido' || estado === 'cancelado') {
            limpiarPolling(); setVerificando(false);
            Alert.alert('Pago no completado', 'El pago fue rechazado o cancelado. Intenta de nuevo.');
          } else if (intentos >= 20) {
            limpiarPolling(); setVerificando(false);
            Alert.alert('Verificando pago', 'No pudimos confirmar tu pago aún. Revisa "Mis pedidos" en unos minutos.',
              [{ text: 'Ver pedidos', onPress: () => router.replace('/(tabs)/pedidos' as any) }, { text: 'Quedarse', style: 'cancel' }]);
          }
        } catch {}
      }, 2000);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  if (verificando) {
    return (
      <SafeAreaView style={[s.root, s.centerBox]}>
        <View style={s.verificandoIcon}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
        <Text style={s.verificandoTitle}>Verificando pago...</Text>
        <Text style={s.verificandoText}>Espera mientras confirmamos tu transacción con PayU</Text>
        <TouchableOpacity style={s.verificandoLink} onPress={() => { limpiarPolling(); setVerificando(false); router.replace('/(tabs)/pedidos' as any); }}>
          <Text style={s.verificandoLinkText}>Ver mis pedidos</Text>
          <Ionicons name="arrow-forward" size={14} color={Colors.primary} />
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Confirmar pedido</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Resumen */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="receipt-outline" size={18} color={Colors.primary} />
            <Text style={s.sectionTitle}>Resumen del pedido</Text>
          </View>
          {items.map(({ bolsa, cantidad }) => (
            <View key={bolsa.id} style={s.orderItem}>
              <View style={s.orderThumb}>
                <Ionicons name="restaurant-outline" size={16} color={Colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.orderName} numberOfLines={1}>{bolsa.nombre}</Text>
                <Text style={s.orderNegocio}>{bolsa.negocios?.nombre} × {cantidad}</Text>
              </View>
              <Text style={s.orderPrice}>Q{(bolsa.precio_descuento * cantidad).toFixed(0)}</Text>
            </View>
          ))}
        </View>

        {/* Tipo entrega */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="car-outline" size={18} color={Colors.primary} />
            <Text style={s.sectionTitle}>Tipo de entrega</Text>
          </View>
          {distStr && (
            <View style={[s.distInfo, !envioDisponible && s.distInfoWarn]}>
              <Ionicons name={envioDisponible ? 'location-outline' : 'warning-outline'} size={14} color={envioDisponible ? Colors.primary : Colors.error} />
              <Text style={[s.distInfoText, !envioDisponible && { color: Colors.error }]}>
                {envioDisponible ? `Restaurante a ${distStr}` : `Fuera del radio de envío (${distStr} — máx. ${ENVIO_MAX_KM} km)`}
              </Text>
            </View>
          )}
          <View style={s.tipoRow}>
            {[
              { key: 'recogida', icon: 'storefront-outline', label: 'Recoger en tienda', precio: 'Gratis', available: true },
              { key: 'envio', icon: 'bicycle-outline', label: 'Envío a domicilio', precio: envioDisponible ? 'Q25' : 'No disponible', available: envioDisponible },
            ].map(({ key, icon, label, precio, available }) => (
              <TouchableOpacity
                key={key}
                style={[s.tipoBtn, tipo === key && s.tipoBtnActive, !available && s.tipoBtnDisabled]}
                onPress={() => {
                  if (!available) { Alert.alert('Envío no disponible', `El restaurante está a ${distStr}, fuera del radio de ${ENVIO_MAX_KM} km.`); return; }
                  setTipo(key as TipoEntrega);
                }}
              >
                <Ionicons name={icon as any} size={24} color={tipo === key ? Colors.primary : Colors.textSecondary} />
                <Text style={[s.tipoLabel, tipo === key && s.tipoLabelActive]}>{label}</Text>
                <Text style={[s.tipoPrecio, tipo === key && s.tipoPrecioActive]}>{precio}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Dirección */}
        {tipo === 'envio' && (
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Ionicons name="location-outline" size={18} color={Colors.primary} />
              <Text style={s.sectionTitle}>Dirección de entrega</Text>
            </View>
            {[
              { key: 'calle', label: 'Calle y número *', placeholder: '5a Calle 10-35' },
              { key: 'zona', label: 'Zona *', placeholder: 'Zona 10' },
              { key: 'ciudad', label: 'Ciudad', placeholder: 'Guatemala' },
              { key: 'referencia', label: 'Referencia', placeholder: 'Frente al banco...' },
            ].map(({ key, label, placeholder }) => (
              <View key={key}>
                <Text style={s.inputLabel}>{label}</Text>
                <TextInput
                  style={s.input}
                  placeholder={placeholder}
                  placeholderTextColor={Colors.textLight}
                  value={(direccion as any)[key]}
                  onChangeText={set(key)}
                />
              </View>
            ))}
          </View>
        )}

        {/* Pago */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="card-outline" size={18} color={Colors.primary} />
            <Text style={s.sectionTitle}>Método de pago</Text>
          </View>
          <View style={s.payMethodRow}>
            <View style={s.payIconBox}>
              <Ionicons name="card" size={22} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.payLabel}>Tarjeta de crédito / débito</Text>
              <Text style={s.paySubLabel}>Procesado con PayU · Pago seguro</Text>
            </View>
            <View style={s.payCheck}>
              <Ionicons name="checkmark" size={14} color={Colors.white} />
            </View>
          </View>
          <Text style={s.payuNote}>Serás redirigido al portal seguro de PayU. Aceptamos Visa, Mastercard y más.</Text>
        </View>

        {/* Total */}
        <View style={s.totalBox}>
          {[
            { key: 'Subtotal bolsa', val: `Q${total.toFixed(2)}` },
            ...(tipo === 'envio' ? [{ key: 'Envío a domicilio', val: `Q${costoEnvio}` }] : []),
            { key: 'Comisión plataforma (≈3.5%)', val: `Q${comisionCubo.toFixed(2)}` },
          ].map(({ key, val }) => (
            <View key={key} style={s.totalLine}>
              <Text style={s.totalKey}>{key}</Text>
              <Text style={s.totalLineVal}>{val}</Text>
            </View>
          ))}
          <View style={s.totalDivider} />
          <View style={s.totalLine}>
            <Text style={s.totalFinalKey}>Total a pagar</Text>
            <Text style={s.totalFinalVal}>Q{totalFinal.toFixed(2)}</Text>
          </View>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity style={[s.btnPagar, loading && s.btnDisabled]} onPress={iniciarPago} disabled={loading}>
          {loading
            ? <ActivityIndicator color={Colors.white} />
            : <>
                <Ionicons name="lock-closed" size={16} color={Colors.white} />
                <Text style={s.btnPagarText}>Pagar Q{totalFinal.toFixed(2)} con PayU</Text>
              </>
          }
        </TouchableOpacity>
        <View style={s.securoRow}>
          <Ionicons name="shield-checkmark-outline" size={13} color={Colors.textLight} />
          <Text style={s.seguroText}>Pago seguro · SSL · PayU Latam</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.surface },
  centerBox: { justifyContent: 'center', alignItems: 'center', padding: 32 },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },

  scroll: { padding: 16 },
  section: { backgroundColor: Colors.white, borderRadius: 20, padding: 18, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },

  orderItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  orderThumb: { width: 38, height: 38, borderRadius: 10, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center' },
  orderName: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  orderNegocio: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  orderPrice: { fontSize: 15, fontWeight: '800', color: Colors.primary },

  distInfo: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.accentLight, borderRadius: 12, padding: 10, marginBottom: 14 },
  distInfoWarn: { backgroundColor: Colors.errorLight },
  distInfoText: { fontSize: 12, color: Colors.primary, fontWeight: '600', flex: 1 },

  tipoRow: { flexDirection: 'row', gap: 10 },
  tipoBtn: { flex: 1, borderWidth: 2, borderColor: Colors.border, borderRadius: 16, padding: 14, alignItems: 'center', gap: 6 },
  tipoBtnActive: { borderColor: Colors.primary, backgroundColor: Colors.accentLight },
  tipoBtnDisabled: { opacity: 0.45 },
  tipoLabel: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, textAlign: 'center' },
  tipoLabelActive: { color: Colors.primary },
  tipoPrecio: { fontSize: 13, color: Colors.textLight, fontWeight: '500' },
  tipoPrecioActive: { color: Colors.primary, fontWeight: '700' },

  inputLabel: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.surface, borderRadius: 12, padding: 13, fontSize: 14, color: Colors.textPrimary, marginBottom: 12 },

  payMethodRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 14, padding: 14, gap: 12 },
  payIconBox: { width: 42, height: 42, borderRadius: 12, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center' },
  payLabel: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  paySubLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  payCheck: { backgroundColor: Colors.primary, borderRadius: 12, width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  payuNote: { fontSize: 12, color: Colors.textSecondary, marginTop: 12, lineHeight: 18 },

  totalBox: { backgroundColor: Colors.white, borderRadius: 20, padding: 18, marginBottom: 12 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  totalKey: { fontSize: 13, color: Colors.textSecondary },
  totalLineVal: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600' },
  totalDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 10 },
  totalFinalKey: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
  totalFinalVal: { fontSize: 24, fontWeight: '900', color: Colors.primary },

  footer: { backgroundColor: Colors.white, padding: 16, paddingBottom: 24, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar: { backgroundColor: Colors.primary, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  securoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 },
  seguroText: { textAlign: 'center', fontSize: 12, color: Colors.textLight },

  verificandoIcon: { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.accentLight, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  verificandoTitle: { fontSize: 20, fontWeight: '800', color: Colors.textPrimary, marginBottom: 8 },
  verificandoText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  verificandoLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verificandoLinkText: { color: Colors.primary, fontWeight: '700', fontSize: 14 },
});
