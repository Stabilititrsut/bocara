import { useState, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, SafeAreaView, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

export default function PagoScreen() {
  const { items, total, limpiar } = useCart();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const [errorPago, setErrorPago] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const bolsa = items[0]?.bolsa;
  const comisionServicio = Math.round(total * 0.035 * 100) / 100;
  const totalFinal = total + comisionServicio;

  console.log('[PAGO] subtotal:', total);
  console.log('[PAGO] comisionServicio:', comisionServicio);
  console.log('[PAGO] total:', totalFinal);

  function limpiarPolling() {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }

  async function iniciarPago() {
    setErrorPago(null);
    if (items.length === 0) return;
    setLoading(true);
    try {
      const cuboItems = items.map(i => ({ bolsa_id: i.bolsa.id, cantidad: i.cantidad }));
      console.log('[PAGO] items recibidos:', JSON.stringify(cuboItems));
      const res = await pagosAPI.cubopago({
        items: cuboItems,
        tipo_entrega: 'recogida',
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
            router.replace({ pathname: '/qr-recogida', params: { codigo: codigoRecogida, pedidoId, tipo: 'recogida' } } as any);
          } else if (estado_pago === 'fallido' || estado === 'cancelado') {
            limpiarPolling(); setVerificando(false);
            setErrorPago('El pago fue rechazado o cancelado. Revisa los datos de tu tarjeta e intenta de nuevo.');
          } else if (intentos >= 20) {
            limpiarPolling(); setVerificando(false);
            Alert.alert(
              'Verificando pago',
              'No pudimos confirmar tu pago aún. Revisa "Mis pedidos" en unos minutos.',
              [
                { text: 'Ver pedidos', onPress: () => router.replace('/(tabs)/pedidos' as any) },
                { text: 'Quedarse', style: 'cancel' },
              ]
            );
          }
        } catch {}
      }, 2000);
    } catch (e: any) {
      setErrorPago(e.message || 'No se pudo generar el link de pago. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  // ── Verificando ───────────────────────────────────────────────────────────────
  if (verificando) {
    return (
      <SafeAreaView style={[s.root, s.centerBox]}>
        <View style={s.spinnerRing}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
        <Text style={s.verificandoTitle}>Verificando tu pago...</Text>
        <Text style={s.verificandoText}>
          Estamos confirmando tu transacción con Cubo Pago.{'\n'}Esto toma unos segundos.
        </Text>
        <TouchableOpacity
          style={s.linkBtn}
          onPress={() => { limpiarPolling(); setVerificando(false); router.replace('/(tabs)/pedidos' as any); }}
        >
          <Text style={s.linkBtnText}>Ver mis pedidos</Text>
          <Ionicons name="arrow-forward" size={14} color={Colors.accent} />
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Principal ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Confirmar pedido</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Producto ── */}
        {bolsa && (
          <View style={s.productCard}>
            {bolsa.imagen_url ? (
              <Image source={{ uri: bolsa.imagen_url }} style={s.productImg} />
            ) : (
              <View style={s.productImgPlaceholder}>
                <Ionicons name="restaurant" size={36} color={Colors.accent} />
              </View>
            )}
            <View style={s.productBody}>
              <Text style={s.productNegocio}>{bolsa.negocios?.nombre}</Text>
              <Text style={s.productName}>{bolsa.nombre}</Text>
              {bolsa.descripcion ? (
                <Text style={s.productDesc} numberOfLines={2}>{bolsa.descripcion}</Text>
              ) : null}
              <View style={s.priceRow}>
                {bolsa.precio_original > bolsa.precio_descuento && (
                  <Text style={s.priceOriginal}>Q{bolsa.precio_original.toFixed(2)}</Text>
                )}
                <Text style={s.priceFinal}>Q{bolsa.precio_descuento.toFixed(2)}</Text>
              </View>
            </View>
          </View>
        )}

        {/* ── Recogida en tienda ── */}
        <View style={s.recogidaCard}>
          <View style={s.recogidaIconWrap}>
            <Ionicons name="storefront-outline" size={24} color={Colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.recogidaLabel}>Recoger en tienda</Text>
            {bolsa?.negocios && (
              <Text style={s.recogidaSub} numberOfLines={1}>
                {bolsa.negocios.nombre}
                {bolsa.negocios.zona ? ` · ${bolsa.negocios.zona}` : ''}
              </Text>
            )}
          </View>
          <View style={s.gratisTag}>
            <Text style={s.gratisText}>Gratis</Text>
          </View>
        </View>

        {/* ── Resumen de pago ── */}
        <View style={s.totalCard}>
          <Text style={s.sectionTitle}>Resumen de pago</Text>
          <View style={s.totalLines}>
            <View style={s.totalLine}>
              <Text style={s.totalKey}>Subtotal</Text>
              <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
            </View>
            <View style={s.totalLine}>
              <Text style={s.totalKey}>Comisión de servicio (≈3.5%)</Text>
              <Text style={s.totalVal}>Q{comisionServicio.toFixed(2)}</Text>
            </View>
          </View>
          <View style={s.divider} />
          <View style={s.totalFinalRow}>
            <Text style={s.totalFinalLabel}>Total a pagar</Text>
            <Text style={s.totalFinalAmt}>Q{totalFinal.toFixed(2)}</Text>
          </View>
        </View>

        {/* ── Error ── */}
        {errorPago && (
          <View style={s.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={Colors.error} />
            <Text style={s.errorText}>{errorPago}</Text>
          </View>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ── Footer ── */}
      <View style={s.footer}>
        <TouchableOpacity
          style={[s.btnPagar, loading && s.btnDisabled]}
          onPress={iniciarPago}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color={Colors.white} size="small" />
            : <Text style={s.btnPagarText}>💳  Pagar con tarjeta</Text>
          }
        </TouchableOpacity>
        <View style={s.secureRow}>
          <Ionicons name="lock-closed-outline" size={12} color={Colors.textLight} />
          <Text style={s.secureText}>Pago seguro · Cubo Pago · SSL cifrado</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Colors.white },
  centerBox: { justifyContent: 'center', alignItems: 'center', padding: 32 },

  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  backBtn:     { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.primary },

  scroll: { padding: 16, paddingBottom: 8 },

  productCard: { backgroundColor: Colors.white, borderRadius: 20, marginBottom: 14, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 4 },
  productImg:            { width: '100%', height: 170, resizeMode: 'cover' },
  productImgPlaceholder: { width: '100%', height: 170, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  productBody:    { padding: 16 },
  productNegocio: { fontSize: 12, fontWeight: '600', color: Colors.accent, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  productName:    { fontSize: 18, fontWeight: '800', color: Colors.primary, marginBottom: 4 },
  productDesc:    { fontSize: 13, color: Colors.textSecondary, lineHeight: 18, marginBottom: 10 },
  priceRow:       { flexDirection: 'row', alignItems: 'center', gap: 10 },
  priceOriginal:  { fontSize: 14, color: Colors.textLight, textDecorationLine: 'line-through' },
  priceFinal:     { fontSize: 22, fontWeight: '900', color: Colors.primary },

  recogidaCard:    { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  recogidaIconWrap:{ width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  recogidaLabel:   { fontSize: 15, fontWeight: '800', color: Colors.primary },
  recogidaSub:     { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  gratisTag:       { backgroundColor: Colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  gratisText:      { fontSize: 13, fontWeight: '800', color: Colors.primary },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.primary, marginBottom: 14 },

  totalCard:       { backgroundColor: Colors.white, borderRadius: 20, padding: 18, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  totalLines:      { gap: 8 },
  totalLine:       { flexDirection: 'row', justifyContent: 'space-between' },
  totalKey:        { fontSize: 13, color: Colors.textSecondary },
  totalVal:        { fontSize: 13, fontWeight: '600', color: Colors.primary },
  divider:         { height: 1, backgroundColor: Colors.border, marginVertical: 14 },
  totalFinalRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalFinalLabel: { fontSize: 16, fontWeight: '700', color: Colors.primary },
  totalFinalAmt:   { fontSize: 24, fontWeight: '900', color: Colors.primary },

  errorBox:  { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: Colors.errorLight, borderRadius: 14, padding: 14, marginBottom: 8 },
  errorText: { flex: 1, fontSize: 13, color: Colors.error, lineHeight: 18 },

  footer:       { backgroundColor: Colors.white, padding: 16, paddingBottom: 28, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar:     { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center', justifyContent: 'center' },
  btnDisabled:  { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 17, letterSpacing: 0.3 },
  secureRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10 },
  secureText:   { fontSize: 12, color: Colors.textLight },

  spinnerRing:      { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  verificandoTitle: { fontSize: 20, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  verificandoText:  { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  linkBtn:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkBtnText:      { color: Colors.accent, fontWeight: '700', fontSize: 14 },
});
