import { useState, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Alert, ActivityIndicator, SafeAreaView,
} from 'react-native';
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
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  async function iniciarPago() {
    if (tipo === 'envio' && (!direccion.calle || !direccion.zona)) {
      return Alert.alert('Error', 'Ingresa tu dirección de entrega');
    }
    if (items.length === 0) return;

    setLoading(true);
    try {
      const item = items[0];
      const res = await pagosAPI.crearIntent({
        bolsa_id: item.bolsa.id,
        tipo_entrega: tipo,
        direccion_envio: tipo === 'envio' ? direccion : undefined,
      });
      const { pedidoId, codigoRecogida, payuUrl } = res.data;

      // Abrir checkout PayU en el navegador del sistema
      await WebBrowser.openBrowserAsync(payuUrl, {
        showTitle: true,
        toolbarColor: '#F97316',
        secondaryToolbarColor: '#fff',
      });

      // Después de que el usuario cierra el browser, verificar estado
      setVerificando(true);
      let intentos = 0;
      const MAX_INTENTOS = 20; // 40 segundos máximo

      pollingRef.current = setInterval(async () => {
        intentos++;
        try {
          const estadoRes = await pagosAPI.estado(pedidoId);
          const { estado_pago, estado } = estadoRes.data;

          if (estado_pago === 'pagado' && estado === 'confirmado') {
            limpiarPolling();
            setVerificando(false);
            limpiar();
            router.replace({
              pathname: '/qr-recogida',
              params: { codigo: codigoRecogida, pedidoId, tipo },
            } as any);
          } else if (estado_pago === 'fallido' || estado === 'cancelado') {
            limpiarPolling();
            setVerificando(false);
            Alert.alert('Pago no completado', 'El pago fue rechazado o cancelado. Intenta de nuevo.');
          } else if (intentos >= MAX_INTENTOS) {
            limpiarPolling();
            setVerificando(false);
            Alert.alert(
              'Verificando pago',
              'No pudimos confirmar tu pago aún. Revisa "Mis pedidos" en unos minutos.',
              [{ text: 'Ver pedidos', onPress: () => router.replace('/(tabs)/pedidos' as any) },
               { text: 'Quedarse', style: 'cancel' }]
            );
          }
        } catch { /* ignorar errores de red al polling */ }
      }, 2000);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  if (verificando) {
    return (
      <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={Colors.orange} size="large" />
        <Text style={{ marginTop: 16, fontSize: 16, fontWeight: '700', color: Colors.brown }}>Verificando pago...</Text>
        <Text style={{ marginTop: 8, fontSize: 13, color: Colors.textSecondary, textAlign: 'center', paddingHorizontal: 32 }}>
          Espera mientras confirmamos tu transacción con PayU
        </Text>
        <TouchableOpacity
          style={{ marginTop: 24, padding: 12 }}
          onPress={() => {
            limpiarPolling();
            setVerificando(false);
            router.replace('/(tabs)/pedidos' as any);
          }}
        >
          <Text style={{ color: Colors.orange, fontWeight: '700' }}>Ver mis pedidos →</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
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
          {distStr && (
            <View style={s.distInfo}>
              <Text style={s.distInfoText}>
                {envioDisponible
                  ? `📍 El restaurante está a ${distStr} de tu ubicación`
                  : `⚠️ El restaurante está a ${distStr} — fuera del radio de envío (máx. ${ENVIO_MAX_KM} km)`}
              </Text>
            </View>
          )}
          <View style={s.tipoRow}>
            <TouchableOpacity style={[s.tipoBtn, tipo === 'recogida' && s.tipoBtnActive]} onPress={() => setTipo('recogida')}>
              <Text style={s.tipoEmoji}>🏪</Text>
              <Text style={[s.tipoLabel, tipo === 'recogida' && s.tipoLabelActive]}>Recoger</Text>
              <Text style={[s.tipoPrecio, tipo === 'recogida' && s.tipoPrecioActive]}>Gratis</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tipoBtn, tipo === 'envio' && s.tipoBtnActive, !envioDisponible && s.tipoBtnDisabled]}
              onPress={() => {
                if (!envioDisponible) {
                  Alert.alert('Envío no disponible', `Este restaurante está a ${distStr}, fuera del radio de ${ENVIO_MAX_KM} km.`);
                  return;
                }
                setTipo('envio');
              }}
            >
              <Text style={s.tipoEmoji}>🏍️</Text>
              <Text style={[s.tipoLabel, tipo === 'envio' && s.tipoLabelActive, !envioDisponible && { color: Colors.textLight }]}>Envío</Text>
              <Text style={[s.tipoPrecio, tipo === 'envio' && s.tipoPrecioActive, !envioDisponible && { color: Colors.textLight }]}>
                {envioDisponible ? 'Q25' : 'No disponible'}
              </Text>
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

        {/* Método de pago */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>💳 Método de pago</Text>
          <View style={s.payMethod}>
            <Text style={{ fontSize: 28 }}>🏦</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.payLabel}>Tarjeta de crédito/débito</Text>
              <Text style={s.paySubLabel}>Procesado de forma segura con PayU</Text>
            </View>
            <View style={s.payCheck}><Text style={{ color: Colors.white, fontSize: 12 }}>✓</Text></View>
          </View>
          <Text style={s.payuInfo}>
            Serás redirigido al portal seguro de PayU para completar el pago. Aceptamos Visa, Mastercard y más.
          </Text>
        </View>

        {/* Desglose financiero */}
        <View style={s.totalBox}>
          <View style={s.totalLine}>
            <Text style={s.totalKey}>Subtotal bolsa</Text>
            <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
          </View>
          {tipo === 'envio' && (
            <View style={s.totalLine}>
              <Text style={s.totalKey}>Costo de envío</Text>
              <Text style={s.totalVal}>Q{costoEnvio}</Text>
            </View>
          )}
          <View style={s.totalLine}>
            <Text style={s.totalKey}>Comisión plataforma (≈3.6%)</Text>
            <Text style={s.totalVal}>Q{(totalFinal * 0.036).toFixed(2)}</Text>
          </View>
          <View style={[s.totalLine, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.border }]}>
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
            : <Text style={s.btnPagarText}>Pagar Q{totalFinal.toFixed(2)} con PayU</Text>
          }
        </TouchableOpacity>
        <Text style={s.seguro}>🔒 Pago seguro · SSL · PayU Latam</Text>
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
  distInfo: { backgroundColor: Colors.brownLight, borderRadius: 10, padding: 10, marginBottom: 12 },
  distInfoText: { fontSize: 12, color: Colors.brown, fontWeight: '600' },
  tipoBtnDisabled: { opacity: 0.45, borderColor: Colors.border },
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
  payuInfo: { fontSize: 12, color: Colors.textSecondary, marginTop: 10, lineHeight: 18 },
  totalBox: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12 },
  totalLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  totalKey: { fontSize: 13, color: Colors.textSecondary },
  totalVal: { fontSize: 13, color: Colors.textPrimary, fontWeight: '600' },
  totalFinalKey: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  totalFinalVal: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  footer: { backgroundColor: Colors.white, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center' },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  seguro: { textAlign: 'center', fontSize: 12, color: Colors.textLight, marginTop: 8 },
});
