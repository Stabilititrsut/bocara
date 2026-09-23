import { publicacionVencida } from '@/src/utils/horarioRecogida';
import { useRelojPublicaciones } from '@/src/utils/usePublicacionesVigentes';
import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCart } from '@/src/context/CartContext';
import { mostrarErrorCarrito } from '@/src/utils/cartFeedback';
import { bolsasAPI } from '@/src/services/api';
import { disponibilidadReal, textoDisponibilidad } from '@/src/utils/stock';
import { Colors } from '@/constants/Colors';

const MSG_REVALIDACION = 'No pudimos verificar la disponibilidad. Revisa tu conexión e intenta de nuevo.';

export default function CarritoScreen() {
  const { items, total, agregar, quitar, limpiar, loaded, storageError, sincronizarDisponibilidad } = useCart();
  const router = useRouter();
  const ahora = useRelojPublicaciones();
  const hayVencidos = items.some(i => publicacionVencida(i.bolsa, ahora));
  const hayAgotados = items.some(i => disponibilidadReal(i.bolsa) <= 0);
  const checkoutPending = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const revalidandoRef = useRef(false);
  const [revalidando, setRevalidando] = useState(false);
  const [errorRevalidacion, setErrorRevalidacion] = useState<string | null>(null);

  // Reconsulta backend la disponibilidad real de cada item del carrito. Nunca
  // borra el carrito ante un fallo de red — solo avisa y deja reintentar.
  const revalidarStock = useCallback(async () => {
    const actuales = itemsRef.current;
    if (revalidandoRef.current || actuales.length === 0) return;
    revalidandoRef.current = true;
    setRevalidando(true);
    setErrorRevalidacion(null);
    try {
      const resultados = await Promise.allSettled(actuales.map(i => bolsasAPI.detalle(i.bolsa.id)));
      const actualizaciones: Record<string, number> = {};
      let fallos = 0;
      resultados.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value?.data) {
          const data = r.value.data;
          actualizaciones[actuales[idx].bolsa.id] = typeof data.cantidad_disponible_real === 'number'
            ? data.cantidad_disponible_real
            : data.cantidad_disponible;
        } else {
          fallos++;
        }
      });
      if (Object.keys(actualizaciones).length > 0) sincronizarDisponibilidad(actualizaciones);
      if (fallos === resultados.length) setErrorRevalidacion(MSG_REVALIDACION);
    } catch {
      setErrorRevalidacion(MSG_REVALIDACION);
    } finally {
      revalidandoRef.current = false;
      setRevalidando(false);
    }
  }, [sincronizarDisponibilidad]);

  useFocusEffect(useCallback(() => {
    checkoutPending.current = false;
    revalidarStock();
  }, [revalidarStock]));

  function iniciarCheckout() {
    if (!loaded || items.length === 0 || checkoutPending.current || revalidando) return;
    if (items.some(i => publicacionVencida(i.bolsa))) {
      mostrarErrorCarrito({ ok: false, motivo: 'vencido' }); return;
    }
    if (hayAgotados) {
      mostrarErrorCarrito({ ok: false, motivo: 'agotado' }); return;
    }
    checkoutPending.current = true;
    router.push('/pago');
  }

  function quitarAgotado(bolsaId: string, cantidad: number) {
    for (let i = 0; i < cantidad; i++) quitar(bolsaId);
  }

  if (!loaded) return (
    <SafeAreaView style={s.root}>
      <View style={s.empty}>
        <ActivityIndicator color={Colors.primary} />
        <Text style={s.emptyText}>Cargando carrito...</Text>
      </View>
    </SafeAreaView>
  );

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
          <Text style={s.emptyTitle}>{storageError === 'lectura' ? 'No se pudo recuperar tu carrito' : 'Tu carrito está vacío'}</Text>
          <Text style={s.emptyText}>{storageError === 'lectura' ? 'Puedes seguir explorando y agregar productos. Tu carrito guardado no se reemplaza hasta que hagas un cambio.' : 'Agrega bolsas de comida rescatada para empezar'}</Text>
          {storageError === 'escritura' && <Text style={s.emptyText}>No se pudo guardar el carrito local. Los cambios actuales podrían no conservarse al reiniciar.</Text>}
          <TouchableOpacity style={s.emptyBtn} onPress={() => router.push('/(tabs)/' as any)}>
            <Text style={s.emptyBtnText}>Explorar bolsas</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const kgTotal = items.reduce((sum, i) => sum + (((i.bolsa as any).peso_estimado_kg ?? 0) * i.cantidad), 0);
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
        {storageError && <Text style={s.emptyText}>No se pudo guardar o recuperar el carrito local. Los cambios actuales podrían no conservarse al reiniciar.</Text>}
        {hayVencidos && <Text style={s.emptyText}>Hay publicaciones cuyo horario ya venció. Retíralas con el botón menos o vacía el carrito para continuar. No hemos borrado tus productos guardados.</Text>}
        {errorRevalidacion && (
          <View style={s.avisoStock}>
            <Text style={s.emptyText}>{errorRevalidacion}</Text>
            <TouchableOpacity style={s.retryStockBtn} onPress={revalidarStock} disabled={revalidando}>
              <Ionicons name="refresh" size={14} color={Colors.white} />
              <Text style={s.retryStockText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}
        {items.map(({ bolsa, cantidad }) => {
          const stockReal = disponibilidadReal(bolsa);
          const agotado = stockReal <= 0;
          const excedeStock = !agotado && cantidad > stockReal;
          const vencido = publicacionVencida(bolsa, ahora);
          return (
            <View key={bolsa.id} style={s.item}>
              <View style={s.itemThumb}>
                <Ionicons name="restaurant" size={24} color={Colors.primary} />
              </View>
              <View style={s.itemInfo}>
                <Text style={s.itemNegocio} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
                <Text style={s.itemNombre} numberOfLines={1}>{bolsa.nombre}</Text>
                {vencido && <Text style={s.emptyText}>No disponible para compra</Text>}
                {!vencido && (agotado || stockReal <= 3) && (
                  <Text style={[s.stockAviso, agotado && s.stockAvisoAgotado]}>{textoDisponibilidad(stockReal)}</Text>
                )}
                <View style={s.itemHoraRow}>
                  <Ionicons name="time-outline" size={12} color={Colors.textSecondary} />
                  <Text style={s.itemHora}>{bolsa.hora_recogida_inicio?.slice(0, 5)} – {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
                </View>
                {agotado && (
                  <TouchableOpacity onPress={() => quitarAgotado(bolsa.id, cantidad)}>
                    <Text style={s.quitarAgotadoText}>Quitar del carrito</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={s.itemRight}>
                <Text style={s.itemPrecio}>Q{(bolsa.precio_descuento * cantidad).toFixed(0)}</Text>
                <View style={s.qtyRow}>
                  <TouchableOpacity style={s.qtyBtn} onPress={() => quitar(bolsa.id)}>
                    <Ionicons name="remove" size={16} color={Colors.primary} />
                  </TouchableOpacity>
                  <Text style={[s.qtyNum, excedeStock && { color: Colors.error }]}>{cantidad}</Text>
                  <TouchableOpacity
                    style={s.qtyBtn}
                    disabled={vencido || agotado || cantidad >= stockReal}
                    onPress={() => mostrarErrorCarrito(agregar(bolsa))}
                  >
                    <Ionicons name="add" size={16} color={Colors.primary} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        })}

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
              <Text style={s.impactNum}>{kgTotal > 0 ? kgTotal.toFixed(1) : 'N/D'}</Text>
              <Text style={s.impactLabel}>kg aprox.{'\n'}en el carrito</Text>
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
        {hayAgotados && !errorRevalidacion && (
          <TouchableOpacity style={s.revisarBtn} onPress={revalidarStock} disabled={revalidando}>
            <Ionicons name="refresh" size={14} color={Colors.accent} />
            <Text style={s.revisarBtnText}>{revalidando ? 'Revisando disponibilidad...' : 'Revisar disponibilidad'}</Text>
          </TouchableOpacity>
        )}
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Total</Text>
          <Text style={s.totalVal}>Q{total.toFixed(2)}</Text>
        </View>
        <TouchableOpacity style={s.btnPago} onPress={iniciarCheckout} disabled={!loaded || items.length === 0 || hayVencidos || hayAgotados || revalidando}>
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

  stockAviso: { fontSize: 12, fontWeight: '700', color: Colors.accent, marginTop: 4 },
  stockAvisoAgotado: { color: Colors.error },
  quitarAgotadoText: { fontSize: 12, fontWeight: '700', color: Colors.error, marginTop: 6, textDecorationLine: 'underline' },

  avisoStock: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 14, gap: 10 },
  retryStockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 10, alignSelf: 'flex-start', paddingHorizontal: 16 },
  retryStockText: { color: Colors.white, fontWeight: '800', fontSize: 13 },

  revisarBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, marginBottom: 8 },
  revisarBtnText: { color: Colors.accent, fontWeight: '700', fontSize: 13 },

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
