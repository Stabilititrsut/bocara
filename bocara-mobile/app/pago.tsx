import { useState, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, SafeAreaView, Image, Modal, TextInput,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { pagosAPI, pedidosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { Colors } from '@/constants/Colors';

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface TarjetaGuardada {
  id: string;
  ultimos4: string;
  tipo: string;   // VISA | Mastercard | AmEx | Otro
  banco: string;
  token?: string; // CuboPago paymentIntentToken para pagos futuros
  guardadaEn: string;
}

type TipoTarjeta = 'VISA' | 'Mastercard' | 'AmEx' | 'Otro';

const TIPOS_TARJETA: TipoTarjeta[] = ['VISA', 'Mastercard', 'AmEx', 'Otro'];
const PROPINAS = [0, 3, 5, 10, 15] as const;
const STORAGE_TARJETAS = 'bocara_tarjetas_guardadas';
const MAX_TARJETAS = 3;

const TIPO_COLORS: Record<string, string> = {
  VISA: '#1A1F71',
  Mastercard: '#EB001B',
  AmEx: '#007BC1',
  Otro: '#444',
};

// ── Componente ────────────────────────────────────────────────────────────────

export default function PagoScreen() {
  const { items, total, limpiar } = useCart();
  const router = useRouter();

  // Core payment
  const [loading, setLoading] = useState(false);
  const [verificando, setVerificando] = useState(false);
  const [errorPago, setErrorPago] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pedidoDataRef = useRef<{ pedidoId: string; codigoRecogida: string; token?: string } | null>(null);

  // Propina
  const [propinaMode, setPropinaMode] = useState<number | 'otro'>(0);
  const [propinaCustom, setPropinaCustom] = useState('');

  // Tarjetas guardadas
  const [tarjetas, setTarjetas] = useState<TarjetaGuardada[]>([]);
  const [tarjetaSelId, setTarjetaSelId] = useState<string | null>(null);

  // Factura modal
  const [facturaVisible, setFacturaVisible] = useState(false);
  const [facturaType, setFacturaType] = useState<'cf' | 'nit'>('cf');
  const [facturaNIT, setFacturaNIT] = useState('');
  const [facturaNombre, setFacturaNombre] = useState('');
  const [facturaLoading, setFacturaLoading] = useState(false);

  // Guardar tarjeta modal
  const [guardarModal, setGuardarModal] = useState(false);
  const [nuevaTarjeta, setNuevaTarjeta] = useState<{ ultimos4: string; tipo: TipoTarjeta; banco: string }>({
    ultimos4: '', tipo: 'VISA', banco: '',
  });

  // Carga tarjetas guardadas al montar
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_TARJETAS)
      .then(v => { if (v) setTarjetas(JSON.parse(v)); })
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

  // ── Flujo post-pago: factura → guardar tarjeta → QR ──────────────────────
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
    } catch { } finally {
      setFacturaLoading(false);
      setFacturaVisible(false);
      // Si hay menos de MAX_TARJETAS, ofrecer guardar
      if (tarjetas.length < MAX_TARJETAS) {
        setNuevaTarjeta({ ultimos4: '', tipo: 'VISA', banco: '' });
        setGuardarModal(true);
      } else {
        limpiar(); irAQR();
      }
    }
  }

  function omitirFactura() {
    setFacturaVisible(false);
    if (tarjetas.length < MAX_TARJETAS) {
      setNuevaTarjeta({ ultimos4: '', tipo: 'VISA', banco: '' });
      setGuardarModal(true);
    } else {
      limpiar(); irAQR();
    }
  }

  async function guardarNuevaTarjeta() {
    const t: TarjetaGuardada = {
      id: Date.now().toString(),
      ultimos4: nuevaTarjeta.ultimos4,
      tipo: nuevaTarjeta.tipo,
      banco: nuevaTarjeta.banco,
      token: pedidoDataRef.current?.token,
      guardadaEn: new Date().toISOString(),
    };
    const updated = [t, ...tarjetas].slice(0, MAX_TARJETAS);
    await AsyncStorage.setItem(STORAGE_TARJETAS, JSON.stringify(updated));
    setTarjetas(updated);
    setTarjetaSelId(t.id);
    setGuardarModal(false);
    limpiar(); irAQR();
  }

  function omitirGuardar() {
    setGuardarModal(false);
    limpiar(); irAQR();
  }

  async function eliminarTarjeta(id: string) {
    const updated = tarjetas.filter(t => t.id !== id);
    await AsyncStorage.setItem(STORAGE_TARJETAS, JSON.stringify(updated));
    setTarjetas(updated);
    if (tarjetaSelId === id) setTarjetaSelId(null);
  }

  // ── Iniciar pago ─────────────────────────────────────────────────────────
  async function iniciarPago() {
    setErrorPago(null);
    setPendiente(false);
    if (items.length === 0) return;
    setLoading(true);

    console.log('A. iniciarPago llamado');

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLoading(false);
      setErrorPago('El servidor tardó demasiado en responder. Intenta de nuevo.');
    }, 15000);

    try {
      const cuboItems = items.map(i => ({ bolsa_id: i.bolsa.id, cantidad: i.cantidad }));
      const res = await pagosAPI.cubopago({
        items: cuboItems,
        tipo_entrega: 'recogida',
        propina: propina > 0 ? propina : undefined,
      });

      clearTimeout(timeoutId);
      if (timedOut) return;

      console.log('B. Respuesta del backend:', res.data);

      const { pedidoId, codigoRecogida, visaLinkUrl } = res.data;
      pedidoDataRef.current = { pedidoId, codigoRecogida };

      if (!visaLinkUrl) {
        setErrorPago('No se recibió el link de pago. Intenta de nuevo.');
        return;
      }

      console.log('C. URL de redirección:', visaLinkUrl);
      console.log('D. Abriendo URL de pago... (platform:', Platform.OS, ')');

      if (Platform.OS === 'web') {
        // En web móvil, window.open() después de un await es bloqueado como popup.
        // window.location.href navega en la misma pestaña — nunca bloqueado.
        window.location.href = visaLinkUrl;
        // La página navega fuera — pago-retorno.tsx maneja el retorno de CuboPago.
      } else {
        // En nativo: in-app browser (SFSafariViewController / Chrome Custom Tab)
        await WebBrowser.openBrowserAsync(visaLinkUrl, { showTitle: true, toolbarColor: Colors.primary });

        console.log('E. Browser cerrado — iniciando verificación de pago');

        setVerificando(true);
        let intentos = 0;
        pollingRef.current = setInterval(async () => {
          intentos++;
          try {
            const estadoRes = await pagosAPI.estado(pedidoId);
            const { estado_pago, estado } = estadoRes.data;
            if (estado_pago === 'pagado' && estado === 'confirmado') {
              limpiarPolling(); setVerificando(false);
              setFacturaVisible(true);
            } else if (estado_pago === 'fallido' || estado === 'cancelado') {
              limpiarPolling(); setVerificando(false);
              setErrorPago('El pago fue rechazado o cancelado. Revisa los datos de tu tarjeta e intenta de nuevo.');
            } else if (intentos >= 10) {
              limpiarPolling(); setVerificando(false);
              setPendiente(true);
            }
          } catch {}
        }, 3000);
      }
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (!timedOut) {
        console.error('Error en pago:', e);
        setErrorPago(e.message || 'Error al conectar con el servidor de pagos.');
      }
    } finally {
      if (!timedOut) setLoading(false);
    }
  }

  function reintentar() {
    setErrorPago(null);
    iniciarPago();
  }

  // ── Error de pago ─────────────────────────────────────────────────────────
  if (errorPago) return (
    <SafeAreaView style={[s.root, s.centerBox]}>
      <Text style={s.errorIcon}>⚠️</Text>
      <Text style={s.errorTitulo}>No se pudo procesar el pago</Text>
      <Text style={s.errorMsg}>{errorPago}</Text>
      <TouchableOpacity onPress={reintentar} style={s.btnReintentar}>
        <Text style={s.btnReintentarText}>Reintentar</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => router.back()}>
        <Text style={s.linkVolver}>Volver al carrito</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  // ── Pago pendiente (no confirmado tras polling) ────────────────────────────
  if (pendiente) return (
    <SafeAreaView style={[s.root, s.centerBox]}>
      <Text style={{ fontSize: 48 }}>⏳</Text>
      <Text style={s.verificandoTitle}>Pago en proceso</Text>
      <Text style={s.verificandoText}>
        Si el cobro se realizó, tu pedido aparecerá en "Mis pedidos" en los próximos minutos.
      </Text>
      <TouchableOpacity
        onPress={() => router.replace('/(tabs)/pedidos' as any)}
        style={[s.btnReintentar, { marginTop: 8 }]}
      >
        <Text style={s.btnReintentarText}>Ver mis pedidos →</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );

  // ── Skeleton ──────────────────────────────────────────────────────────────
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
          {[220, 76, 80, 110, 80, 160].map((h, i) => (
            <View key={i} style={[s.skeletonCard, { height: h }]} />
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Verificando ───────────────────────────────────────────────────────────
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

  // ── Principal ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>

      {/* ── Modal factura ── */}
      <Modal visible={facturaVisible} transparent animationType="slide" onRequestClose={omitirFactura}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <View style={s.modalIconRow}>
              <View style={s.modalIconBg}><Ionicons name="receipt-outline" size={28} color={Colors.primary} /></View>
            </View>
            <Text style={s.modalTitle}>¿Necesitas factura?</Text>
            <Text style={s.modalSub}>Selecciona el tipo de facturación para este pedido.</Text>
            <View style={s.toggleRow}>
              {(['cf', 'nit'] as const).map(t => (
                <TouchableOpacity key={t} style={[s.toggleBtn, facturaType === t && s.toggleBtnActive]} onPress={() => setFacturaType(t)}>
                  <Text style={[s.toggleText, facturaType === t && s.toggleTextActive]}>
                    {t === 'cf' ? 'CF — Consumidor Final' : 'Ingresar NIT'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {facturaType === 'nit' && (
              <View style={s.inputGroup}>
                <TextInput style={s.modalInput} placeholder="NIT (ej. 1234567-8)" placeholderTextColor={Colors.textLight} value={facturaNIT} onChangeText={setFacturaNIT} autoCapitalize="characters" />
                <TextInput style={s.modalInput} placeholder="Nombre o razón social" placeholderTextColor={Colors.textLight} value={facturaNombre} onChangeText={setFacturaNombre} autoCapitalize="words" />
              </View>
            )}
            <View style={s.modalBtns}>
              <TouchableOpacity
                style={[s.modalBtnPrimary, (facturaLoading || (facturaType === 'nit' && !facturaNIT)) && s.btnOff]}
                onPress={generarFactura}
                disabled={facturaLoading || (facturaType === 'nit' && !facturaNIT)}
              >
                {facturaLoading ? <ActivityIndicator color={Colors.white} size="small" /> : <Text style={s.modalBtnPrimaryText}>Guardar factura</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={s.modalBtnSecondary} onPress={omitirFactura}>
                <Text style={s.modalBtnSecondaryText}>Omitir por ahora</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Modal guardar tarjeta ── */}
      <Modal visible={guardarModal} transparent animationType="slide" onRequestClose={omitirGuardar}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <View style={s.modalIconRow}>
              <View style={s.modalIconBg}><Ionicons name="card-outline" size={28} color={Colors.primary} /></View>
            </View>
            <Text style={s.modalTitle}>¿Guardar esta tarjeta?</Text>
            <Text style={s.modalSub}>Paga más rápido la próxima vez sin volver a ingresarla.</Text>
            <View style={s.toggleRow}>
              {TIPOS_TARJETA.map(t => (
                <TouchableOpacity
                  key={t}
                  style={[s.toggleBtn, nuevaTarjeta.tipo === t && { backgroundColor: TIPO_COLORS[t], borderColor: TIPO_COLORS[t] }]}
                  onPress={() => setNuevaTarjeta(p => ({ ...p, tipo: t }))}
                >
                  <Text style={[s.toggleText, nuevaTarjeta.tipo === t && { color: Colors.white }]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.inputGroup}>
              <TextInput
                style={s.modalInput}
                placeholder="Últimos 4 dígitos (ej. 1234)"
                placeholderTextColor={Colors.textLight}
                value={nuevaTarjeta.ultimos4}
                onChangeText={v => setNuevaTarjeta(p => ({ ...p, ultimos4: v.replace(/\D/g, '').slice(0, 4) }))}
                keyboardType="number-pad"
                maxLength={4}
              />
              <TextInput
                style={s.modalInput}
                placeholder="Banco (opcional, ej. Promerica)"
                placeholderTextColor={Colors.textLight}
                value={nuevaTarjeta.banco}
                onChangeText={v => setNuevaTarjeta(p => ({ ...p, banco: v }))}
                autoCapitalize="words"
              />
            </View>
            <View style={s.modalBtns}>
              <TouchableOpacity
                style={[s.modalBtnPrimary, nuevaTarjeta.ultimos4.length < 4 && s.btnOff]}
                onPress={guardarNuevaTarjeta}
                disabled={nuevaTarjeta.ultimos4.length < 4}
              >
                <Text style={s.modalBtnPrimaryText}>Guardar tarjeta</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalBtnSecondary} onPress={omitirGuardar}>
                <Text style={s.modalBtnSecondaryText}>No por ahora</Text>
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

        {/* ── Mis tarjetas guardadas ── */}
        {tarjetas.length > 0 && (
          <View style={s.sectionCard}>
            <Text style={s.sectionCardTitle}>Mis tarjetas guardadas</Text>
            <View style={s.tarjetasList}>
              {tarjetas.map(t => (
                <TouchableOpacity
                  key={t.id}
                  style={[s.tarjetaItem, tarjetaSelId === t.id && s.tarjetaItemActive]}
                  onPress={() => setTarjetaSelId(prev => prev === t.id ? null : t.id)}
                  activeOpacity={0.85}
                >
                  <View style={[s.tarjetaChip, { backgroundColor: TIPO_COLORS[t.tipo] || '#444' }]}>
                    <Text style={s.tarjetaChipText}>{t.tipo}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.tarjetaNumero}>•••• •••• •••• {t.ultimos4}</Text>
                    {t.banco ? <Text style={s.tarjetaBanco}>{t.banco}</Text> : null}
                  </View>
                  {tarjetaSelId === t.id
                    ? <Ionicons name="checkmark-circle" size={22} color={Colors.primary} />
                    : <View style={s.tarjetaRadio} />
                  }
                  <TouchableOpacity onPress={() => eliminarTarjeta(t.id)} hitSlop={{ top: 8, bottom: 8, left: 10, right: 4 }}>
                    <Ionicons name="trash-outline" size={17} color={Colors.textLight} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
              {tarjetas.length < MAX_TARJETAS && (
                <TouchableOpacity
                  style={s.tarjetaAddBtn}
                  onPress={() => { setNuevaTarjeta({ ultimos4: '', tipo: 'VISA', banco: '' }); setGuardarModal(true); }}
                >
                  <Ionicons name="add-circle-outline" size={18} color={Colors.accent} />
                  <Text style={s.tarjetaAddText}>Agregar tarjeta</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

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
            {bolsa.descripcion ? <Text style={s.productDesc} numberOfLines={2}>{bolsa.descripcion}</Text> : null}
            <View style={s.priceRow}>
              {bolsa.precio_original > bolsa.precio_descuento && (
                <Text style={s.priceOriginal}>Q{bolsa.precio_original.toFixed(2)}</Text>
              )}
              <Text style={s.priceFinal}>Q{bolsa.precio_descuento.toFixed(2)}</Text>
            </View>
          </View>
        </View>

        {/* ── Recogida ── */}
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
          <View style={s.gratisTag}><Text style={s.gratisText}>Gratis</Text></View>
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

        {/* ── Resumen ── */}
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

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ── Footer ── */}
      <View style={s.footer}>
        <TouchableOpacity
          style={[s.btnPagar, loading && s.btnOff]}
          onPress={iniciarPago}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color={Colors.white} size="small" />
            : <Text style={s.btnPagarText}>
                {tarjetaSelId
                  ? `💳  Pagar con •••• ${tarjetas.find(t => t.id === tarjetaSelId)?.ultimos4} · Q${totalFinal.toFixed(2)}`
                  : `💳  Pagar Q${totalFinal.toFixed(2)}`
                }
              </Text>
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

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Colors.surface },
  centerBox: { justifyContent: 'center', alignItems: 'center', padding: 32 },

  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  backBtn:     { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.primary },

  scroll:       { padding: 16, paddingBottom: 8 },
  skeletonCard: { backgroundColor: Colors.border, borderRadius: 20, marginBottom: 12, opacity: 0.35 },

  // Tarjetas guardadas
  sectionCard:     { backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  sectionCardTitle:{ fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 2 },
  sectionCardSub:  { fontSize: 12, color: Colors.textSecondary, marginBottom: 14 },
  tarjetasList:  { gap: 8 },
  tarjetaItem:   { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: Colors.surface, borderRadius: 14, padding: 12, borderWidth: 1.5, borderColor: 'transparent' },
  tarjetaItemActive: { borderColor: Colors.primary, backgroundColor: Colors.white },
  tarjetaChip:   { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, minWidth: 56, alignItems: 'center' },
  tarjetaChipText:{ color: Colors.white, fontSize: 11, fontWeight: '800' },
  tarjetaNumero: { fontSize: 14, fontWeight: '700', color: Colors.primary, letterSpacing: 1 },
  tarjetaBanco:  { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  tarjetaRadio:  { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: Colors.border },
  tarjetaAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 4 },
  tarjetaAddText:{ fontSize: 13, fontWeight: '700', color: Colors.accent },

  // Producto
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

  // Recogida
  recogidaCard:    { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  recogidaIconWrap:{ width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  recogidaLabel:   { fontSize: 15, fontWeight: '800', color: Colors.primary },
  recogidaSub:     { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  gratisTag:       { backgroundColor: Colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  gratisText:      { fontSize: 13, fontWeight: '800', color: Colors.primary },

  // Propina
  propinaPills:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  propinaPill:       { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  propinaPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  propinaPillText:   { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  propinaPillTextActive: { color: Colors.white },
  propinaInputWrap:  { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 14, marginTop: 12, gap: 4 },
  propinaInputPrefix:{ fontSize: 18, fontWeight: '800', color: Colors.primary },
  propinaInputField: { flex: 1, fontSize: 18, fontWeight: '700', color: Colors.primary, paddingVertical: 12 },

  // Totals
  sectionTitle:  { fontSize: 15, fontWeight: '800', color: Colors.primary, marginBottom: 14 },
  totalCard:     { backgroundColor: Colors.white, borderRadius: 20, padding: 18, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  totalLines:    { gap: 8 },
  totalLine:     { flexDirection: 'row', justifyContent: 'space-between' },
  totalKey:      { fontSize: 13, color: Colors.textSecondary },
  totalVal:      { fontSize: 13, fontWeight: '600', color: Colors.primary },
  divider:       { height: 1, backgroundColor: Colors.border, marginVertical: 14 },
  totalFinalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalFinalLabel:{ fontSize: 16, fontWeight: '700', color: Colors.primary },
  totalFinalAmt:  { fontSize: 24, fontWeight: '900', color: Colors.primary },
  // Error pantalla completa
  errorIcon:   { fontSize: 48, marginBottom: 16 },
  errorTitulo: { fontSize: 20, fontWeight: '800', color: Colors.primary, marginBottom: 8, textAlign: 'center' },
  errorMsg:    { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 28, paddingHorizontal: 8 },
  btnReintentar:     { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center' as const, marginBottom: 12 },
  btnReintentarText: { color: Colors.white, fontWeight: '900', fontSize: 15 },
  linkVolver:        { fontSize: 14, color: Colors.textSecondary, fontWeight: '700', paddingVertical: 8 },

  // Footer
  footer:       { backgroundColor: Colors.white, padding: 16, paddingBottom: 28, borderTopWidth: 1, borderTopColor: Colors.border },
  btnPagar:     { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center', justifyContent: 'center' },
  btnOff:       { backgroundColor: Colors.textLight },
  btnPagarText: { color: Colors.white, fontWeight: '900', fontSize: 15, letterSpacing: 0.2 },
  secureRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 10 },
  secureText:   { fontSize: 12, color: Colors.textLight },

  // Verificando
  spinnerRing:      { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  verificandoTitle: { fontSize: 20, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  verificandoText:  { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  linkBtn:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkBtnText:      { color: Colors.accent, fontWeight: '700', fontSize: 14 },

  // Modales compartidos
  modalOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard:     { backgroundColor: Colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 40 },
  modalIconRow:  { alignItems: 'center', marginBottom: 16 },
  modalIconBg:   { width: 60, height: 60, borderRadius: 30, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  modalTitle:    { fontSize: 22, fontWeight: '900', color: Colors.primary, marginBottom: 6, textAlign: 'center' },
  modalSub:      { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  toggleRow:     { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  toggleBtn:     { flex: 1, minWidth: 80, paddingVertical: 12, borderRadius: 14, alignItems: 'center', backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  toggleBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  toggleText:    { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  toggleTextActive: { color: Colors.white },
  inputGroup:    { gap: 10, marginBottom: 16 },
  modalInput:    { backgroundColor: Colors.surface, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, color: Colors.primary, fontWeight: '600' },
  modalBtns:     { gap: 10, marginTop: 4 },
  modalBtnPrimary:    { backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17, alignItems: 'center' },
  modalBtnPrimaryText:{ color: Colors.white, fontWeight: '900', fontSize: 16 },
  modalBtnSecondary:  { alignItems: 'center', paddingVertical: 14 },
  modalBtnSecondaryText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 14 },
});
