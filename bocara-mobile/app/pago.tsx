import { useState, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, SafeAreaView, Image, Modal, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { pagosAPI, pedidosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

const PROPINAS = [0, 3, 5, 10, 15] as const;

export default function PagoScreen() {
  const { items, total, limpiar } = useCart();
  const router = useRouter();

  // Core payment
  const [loading, setLoading] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const [errorPago, setErrorPago] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pedidoDataRef = useRef<{ pedidoId: string; codigoRecogida: string } | null>(null);

  // Propina
  const [propinaMode, setPropinaMode] = useState<number | 'otro'>(0);
  const [propinaCustom, setPropinaCustom] = useState('');

  // Guardar tarjeta
  const [recordarTarjeta, setRecordarTarjeta] = useState(false);
  const [tarjetaGuardada, setTarjetaGuardada] = useState(false);

  // Factura modal
  const [facturaVisible, setFacturaVisible] = useState(false);
  const [facturaType, setFacturaType] = useState<'cf' | 'nit'>('cf');
  const [facturaNIT, setFacturaNIT] = useState('');
  const [facturaNombre, setFacturaNombre] = useState('');
  const [facturaLoading, setFacturaLoading] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('bocara_tarjeta_guardada')
      .then(v => { if (v === 'true') setTarjetaGuardada(true); })
      .catch(() => {});
  }, []);

  const bolsa = items[0]?.bolsa;
  const propina = propinaMode === 'otro'
    ? Math.max(0, parseFloat(propinaCustom) || 0)
    : (propinaMode as number);
  const comisionServicio = Math.round(total * 0.035 * 100) / 100;
  const totalFinal = total + comisionServicio + propina;

  function limpiarPolling() {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }

  function irAQR() {
    const d = pedidoDataRef.current;
    if (!d) return;
    router.replace({ pathname: '/qr-recogida', params: { codigo: d.codigoRecogida, pedidoId: d.pedidoId, tipo: 'recogida' } } as any);
  }

  async function generarFactura() {
    const d = pedidoDataRef.current;
    if (!d) return;
    setFacturaLoading(true);
    try {
      await pedidosAPI.factura(d.pedidoId, {
        tipo: facturaType,
        nit: facturaType === 'nit' ? facturaNIT : undefined,
        nombre_fiscal: facturaType === 'nit' ? facturaNombre : undefined,
      });
    } catch { /* non-critical — navigate anyway */ } finally {
      setFacturaLoading(false);
      setFacturaVisible(false);
      limpiar();
      irAQR();
    }
  }

  function omitirFactura() {
    setFacturaVisible(false);
    limpiar();
    irAQR();
  }

  async function iniciarPago() {
    setErrorPago(null);
    if (items.length === 0) return;
    setLoading(true);
    try {
      const cuboItems = items.map(i => ({ bolsa_id: i.bolsa.id, cantidad: i.cantidad }));
      const res = await pagosAPI.cubopago({
        items: cuboItems,
        tipo_entrega: 'recogida',
        propina: propina > 0 ? propina : undefined,
      });
      const { pedidoId, codigoRecogida, visaLinkUrl } = res.data;
      pedidoDataRef.current = { pedidoId, codigoRecogida };

      if (recordarTarjeta) {
        AsyncStorage.setItem('bocara_tarjeta_guardada', 'true').catch(() => {});
        setTarjetaGuardada(true);
      }

      await WebBrowser.openBrowserAsync(visaLinkUrl, { showTitle: true, toolbarColor: Colors.primary });
      setVerificando(true);
      let intentos = 0;
      pollingRef.current = setInterval(async () => {
        intentos++;
        try {
          const estadoRes = await pagosAPI.estado(pedidoId);
          const { estado_pago, estado } = estadoRes.data;
          if (estado_pago === 'pagado' && estado === 'confirmado') {
            limpiarPolling(); setVerificando(false);
            setFacturaVisible(true); // show invoice modal before navigating
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

  // ── Skeleton (navegación antes de que el carrito hidrate) ─────────────────────
  if (!bolsa) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.primary} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Confirmar pedido</Text>
        </View>
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={[s.skeletonCard, { height: 220 }]} />
          <View style={[s.skeletonCard, { height: 76 }]} />
          <View style={[s.skeletonCard, { height: 110 }]} />
          <View style={[s.skeletonCard, { height: 80 }]} />
          <View style={[s.skeletonCard, { height: 160 }]} />
        </ScrollView>
      </SafeAreaView>
    );
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

      {/* ── Modal de factura ── */}
      <Modal visible={facturaVisible} transparent animationType="slide" onRequestClose={omitirFactura}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <View style={s.modalIconRow}>
              <View style={s.modalIconBg}>
                <Ionicons name="receipt-outline" size={28} color={Colors.primary} />
              </View>
            </View>
            <Text style={s.modalTitle}>¿Necesitas factura?</Text>
            <Text style={s.modalSub}>Selecciona el tipo de facturación para este pedido.</Text>

            <View style={s.facturaToggleRow}>
              <TouchableOpacity
                style={[s.facturaToggleBtn, facturaType === 'cf' && s.facturaToggleBtnActive]}
                onPress={() => setFacturaType('cf')}
              >
                <Text style={[s.facturaToggleText, facturaType === 'cf' && s.facturaToggleTextActive]}>
                  CF — Consumidor Final
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.facturaToggleBtn, facturaType === 'nit' && s.facturaToggleBtnActive]}
                onPress={() => setFacturaType('nit')}
              >
                <Text style={[s.facturaToggleText, facturaType === 'nit' && s.facturaToggleTextActive]}>
                  Ingresar NIT
                </Text>
              </TouchableOpacity>
            </View>

            {facturaType === 'nit' && (
              <View style={s.facturaInputs}>
                <TextInput
                  style={s.facturaInput}
                  placeholder="NIT (ej. 1234567-8)"
                  placeholderTextColor={Colors.textLight}
                  value={facturaNIT}
                  onChangeText={setFacturaNIT}
                  autoCapitalize="characters"
                />
                <TextInput
                  style={s.facturaInput}
                  placeholder="Nombre o razón social"
                  placeholderTextColor={Colors.textLight}
                  value={facturaNombre}
                  onChangeText={setFacturaNombre}
                  autoCapitalize="words"
                />
              </View>
            )}

            <View style={s.modalBtns}>
              <TouchableOpacity
                style={[s.modalBtnPrimary, (facturaLoading || (facturaType === 'nit' && !facturaNIT)) && s.btnDisabled]}
                onPress={generarFactura}
                disabled={facturaLoading || (facturaType === 'nit' && !facturaNIT)}
              >
                {facturaLoading
                  ? <ActivityIndicator color={Colors.white} size="small" />
                  : <Text style={s.modalBtnPrimaryText}>Guardar factura</Text>
                }
              </TouchableOpacity>
              <TouchableOpacity style={s.modalBtnSecondary} onPress={omitirFactura}>
                <Text style={s.modalBtnSecondaryText}>Omitir por ahora</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Confirmar pedido</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* ── Producto ── */}
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

        {/* ── Recogida en tienda ── */}
        <View style={s.recogidaCard}>
          <View style={s.recogidaIconWrap}>
            <Ionicons name="storefront-outline" size={24} color={Colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.recogidaLabel}>Recoger en tienda</Text>
            {bolsa?.negocios && (
              <Text style={s.recogidaSub} numberOfLines={1}>
                {bolsa.negocios.nombre}{bolsa.negocios.zona ? ` · ${bolsa.negocios.zona}` : ''}
              </Text>
            )}
          </View>
          <View style={s.gratisTag}>
            <Text style={s.gratisText}>Gratis</Text>
          </View>
        </View>

        {/* ── Propina ── */}
        <View style={s.sectionCard}>
          <Text style={s.sectionCardTitle}>¿Quieres dejar propina?</Text>
          <Text style={s.sectionCardSub}>100% va directo al restaurante</Text>
          <View style={s.propinaPills}>
            {PROPINAS.map(monto => (
              <TouchableOpacity
                key={monto}
                style={[s.propinaPill, propinaMode === monto && s.propinaPillActive]}
                onPress={() => setPropinaMode(monto)}
              >
                <Text style={[s.propinaPillText, propinaMode === monto && s.propinaPillTextActive]}>
                  {monto === 0 ? 'Sin propina' : `Q${monto}`}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[s.propinaPill, propinaMode === 'otro' && s.propinaPillActive]}
              onPress={() => setPropinaMode('otro')}
            >
              <Text style={[s.propinaPillText, propinaMode === 'otro' && s.propinaPillTextActive]}>Otro</Text>
            </TouchableOpacity>
          </View>
          {propinaMode === 'otro' && (
            <View style={s.propinaInputWrap}>
              <Text style={s.propinaInputPrefix}>Q</Text>
              <TextInput
                style={s.propinaInputField}
                placeholder="0.00"
                placeholderTextColor={Colors.textLight}
                keyboardType="decimal-pad"
                value={propinaCustom}
                onChangeText={setPropinaCustom}
              />
            </View>
          )}
        </View>

        {/* ── Guardar tarjeta ── */}
        <View style={s.sectionCard}>
          {tarjetaGuardada ? (
            <View style={s.tarjetaGuardadaRow}>
              <View style={s.tarjetaIconWrap}>
                <Ionicons name="card" size={20} color={Colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.tarjetaGuardadaLabel}>Tarjeta preferida guardada</Text>
                <Text style={s.tarjetaGuardadaSub}>Se usará en el pago rápido cuando esté disponible</Text>
              </View>
              <TouchableOpacity
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => {
                  AsyncStorage.removeItem('bocara_tarjeta_guardada').catch(() => {});
                  setTarjetaGuardada(false);
                  setRecordarTarjeta(false);
                }}
              >
                <Ionicons name="close-circle-outline" size={22} color={Colors.textLight} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={s.recordarRow} onPress={() => setRecordarTarjeta(!recordarTarjeta)} activeOpacity={0.7}>
              <View style={[s.recordarCheck, recordarTarjeta && s.recordarCheckActive]}>
                {recordarTarjeta && <Ionicons name="checkmark" size={14} color={Colors.white} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.recordarLabel}>Recordar tarjeta para próximos pagos</Text>
                <Text style={s.recordarSub}>Solo guardamos tu preferencia de forma segura</Text>
              </View>
            </TouchableOpacity>
          )}
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
            {propina > 0 && (
              <View style={s.totalLine}>
                <Text style={s.totalKey}>Propina al restaurante</Text>
                <Text style={[s.totalVal, { color: Colors.accent }]}>+Q{propina.toFixed(2)}</Text>
              </View>
            )}
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
            : <Text style={s.btnPagarText}>💳  Pagar Q{totalFinal.toFixed(2)}</Text>
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
  root:      { flex: 1, backgroundColor: Colors.surface },
  centerBox: { justifyContent: 'center', alignItems: 'center', padding: 32 },

  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  backBtn:     { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.primary },

  scroll: { padding: 16, paddingBottom: 8 },

  // Skeleton
  skeletonCard: { backgroundColor: Colors.border, borderRadius: 20, marginBottom: 12, opacity: 0.4 },

  // Product card
  productCard: { backgroundColor: Colors.white, borderRadius: 20, marginBottom: 12, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 4 },
  productImg:            { width: '100%', height: 170, resizeMode: 'cover' },
  productImgPlaceholder: { width: '100%', height: 170, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  productBody:    { padding: 16 },
  productNegocio: { fontSize: 12, fontWeight: '600', color: Colors.accent, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  productName:    { fontSize: 18, fontWeight: '800', color: Colors.primary, marginBottom: 4 },
  productDesc:    { fontSize: 13, color: Colors.textSecondary, lineHeight: 18, marginBottom: 10 },
  priceRow:       { flexDirection: 'row', alignItems: 'center', gap: 10 },
  priceOriginal:  { fontSize: 14, color: Colors.textLight, textDecorationLine: 'line-through' },
  priceFinal:     { fontSize: 22, fontWeight: '900', color: Colors.primary },

  // Recogida card
  recogidaCard:    { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  recogidaIconWrap:{ width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  recogidaLabel:   { fontSize: 15, fontWeight: '800', color: Colors.primary },
  recogidaSub:     { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  gratisTag:       { backgroundColor: Colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  gratisText:      { fontSize: 13, fontWeight: '800', color: Colors.primary },

  // Generic section card
  sectionCard: { backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  sectionCardTitle: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 2 },
  sectionCardSub:   { fontSize: 12, color: Colors.textSecondary, marginBottom: 14 },

  // Propina
  propinaPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  propinaPill:  { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  propinaPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  propinaPillText:   { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  propinaPillTextActive: { color: Colors.white },
  propinaInputWrap:  { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 14, marginTop: 12, gap: 4 },
  propinaInputPrefix:{ fontSize: 18, fontWeight: '800', color: Colors.primary },
  propinaInputField: { flex: 1, fontSize: 18, fontWeight: '700', color: Colors.primary, paddingVertical: 12 },

  // Guardar tarjeta
  tarjetaGuardadaRow:  { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tarjetaIconWrap:     { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  tarjetaGuardadaLabel:{ fontSize: 14, fontWeight: '800', color: Colors.primary },
  tarjetaGuardadaSub:  { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  recordarRow:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  recordarCheck:  { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: Colors.border, alignItems: 'center', justifyContent: 'center' },
  recordarCheckActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  recordarLabel:  { fontSize: 14, fontWeight: '700', color: Colors.primary },
  recordarSub:    { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },

  // Totals
  sectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.primary, marginBottom: 14 },
  totalCard:       { backgroundColor: Colors.white, borderRadius: 20, padding: 18, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
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

  // Footer
  footer:       { backgroundColor: Colors.white, padding: 16, paddingBottom: 28, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar:     { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center', justifyContent: 'center' },
  btnDisabled:  { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 17, letterSpacing: 0.3 },
  secureRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10 },
  secureText:   { fontSize: 12, color: Colors.textLight },

  // Spinner / verificando
  spinnerRing:      { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  verificandoTitle: { fontSize: 20, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  verificandoText:  { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  linkBtn:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkBtnText:      { color: Colors.accent, fontWeight: '700', fontSize: 14 },

  // Factura modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard:    { backgroundColor: Colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 40 },
  modalIconRow: { alignItems: 'center', marginBottom: 16 },
  modalIconBg:  { width: 60, height: 60, borderRadius: 30, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  modalTitle:   { fontSize: 22, fontWeight: '900', color: Colors.primary, marginBottom: 6, textAlign: 'center' },
  modalSub:     { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  facturaToggleRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  facturaToggleBtn: { flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: 'center', backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  facturaToggleBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  facturaToggleText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  facturaToggleTextActive: { color: Colors.white },
  facturaInputs: { gap: 10, marginBottom: 16 },
  facturaInput:  { backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, color: Colors.primary, fontWeight: '600' },
  modalBtns:          { gap: 10, marginTop: 4 },
  modalBtnPrimary:    { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center' },
  modalBtnPrimaryText:{ color: Colors.white, fontWeight: '900', fontSize: 16 },
  modalBtnSecondary:  { alignItems: 'center', paddingVertical: 14 },
  modalBtnSecondaryText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 14 },
});
