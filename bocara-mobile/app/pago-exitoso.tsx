import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/Colors';
import { pagosAPI } from '@/src/services/api';
import { useCart } from '@/src/context/CartContext';
import { volver } from '@/src/utils/backNavigation';

export type ResultType = 'success' | 'rejected' | 'cancelled' | 'verifying';
export type EstadoBackendPago = 'verificando' | 'confirmado' | 'fallido' | 'cancelado' | 'pendiente' | 'error';

export function detectarResultado(status?: string, transactionState?: string): ResultType {
  if (status === 'SUCCEEDED' || transactionState === '4') return 'success';
  if (status === 'REJECTED' || status === 'FAILED')       return 'rejected';
  if (status === 'CANCELLED')                             return 'cancelled';
  return 'verifying';
}

// La URL solo puede AFIRMAR 'success'; la vista real que se muestra siempre
// pasa por esta función, que exige que el backend lo haya confirmado. Para
// cualquier otro resultado reclamado por la URL (rejected/cancelled/verifying)
// se muestra tal cual — esos no aseguran un pago exitoso falso.
export function vistaEfectivaDesde(resultado: ResultType, estadoBackend: EstadoBackendPago): ResultType | 'pendiente' {
  if (resultado !== 'success') return resultado;
  switch (estadoBackend) {
    case 'confirmado': return 'success';
    case 'fallido':
    case 'error':      return 'rejected';
    case 'cancelado':  return 'cancelled';
    case 'pendiente':  return 'pendiente';
    default:           return 'verifying';
  }
}

const MAX_INTENTOS = 20;

export default function PagoExitosoScreen() {
  const router = useRouter();
  const { limpiar } = useCart();
  const params = useLocalSearchParams<{
    pedidoId?: string;
    status?: string;
    transactionState?: string;
    auth_number?: string;
    card_last_four?: string;
  }>();


  const { pedidoId, status, transactionState, auth_number, card_last_four } = params;
  // `resultado` es lo que la URL de retorno de Cubo AFIRMA. Nunca es fuente de
  // verdad por sí solo: `vista` (abajo) es lo que realmente se muestra, y para
  // el caso "success" exige que el backend lo confirme primero.
  const resultado = detectarResultado(status, transactionState);

  const pollingRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const limpiadoRef   = useRef(false);
  const [confirmado, setConfirmado] = useState(false);
  // Solo se usa cuando `resultado === 'success'`: hasta que el backend confirme,
  // la vista real se degrada a 'verifying'/'rejected'/'cancelled'/'pendiente'
  // según lo que diga pagosAPI.estado — nunca a "pago exitoso" por el query param.
  const [estadoBackend, setEstadoBackend] = useState<'verificando' | 'confirmado' | 'fallido' | 'cancelado' | 'pendiente' | 'error'>('verificando');

  // Para SUCCEEDED: poll hasta que el webhook confirme en DB, luego ir a qr-recogida.
  // Mientras no haya confirmación del backend, NUNCA se marca como pagado.
  useEffect(() => {
    if (resultado !== 'success') return;
    if (!pedidoId) { setEstadoBackend('error'); return; }

    let intentos = 0;
    let activo = true;
    const verificar = async () => {
      intentos++;
      try {
        const res = await pagosAPI.estado(pedidoId);
        const { estado_pago, estado, codigo_recogida, tipo_entrega } = res.data;

        if (estado_pago === 'pagado' && estado === 'confirmado') {
          clearInterval(pollingRef.current!);
          if (!activo) return;
          if (!limpiadoRef.current) { limpiadoRef.current = true; limpiar(); }
          setEstadoBackend('confirmado');
          setConfirmado(true);
          router.replace({
            pathname: '/qr-recogida',
            params: { codigo: codigo_recogida, pedidoId, tipo: tipo_entrega || 'recogida' },
          } as any);
          return;
        }
        if (estado_pago === 'fallido' || estado === 'cancelado') {
          clearInterval(pollingRef.current!);
          if (activo) setEstadoBackend(estado === 'cancelado' ? 'cancelado' : 'fallido');
          return;
        }
      } catch {
        // El webhook puede tardar unos segundos en confirmar — un error de red
        // puntual no debe tumbar el polling, solo se refleja tras agotar intentos.
      }

      if (intentos >= MAX_INTENTOS) {
        clearInterval(pollingRef.current!);
        if (activo) setEstadoBackend('pendiente');
      }
    };

    void verificar();
    pollingRef.current = setInterval(verificar, 3000);

    return () => { activo = false; if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [resultado, pedidoId, limpiar, router]);

  function irAPedidos()  { stopPolling(); router.replace('/(tabs)/pedidos' as any); }
  function irAlInicio()  { stopPolling(); router.replace('/' as any);               }
  function irAlCarrito() { stopPolling(); router.replace('/(tabs)/carrito' as any); }
  function irAPago()     { stopPolling(); volver(router, '/pago');                   }
  function stopPolling() { if (pollingRef.current) clearInterval(pollingRef.current); }

  // La URL dijo "success", pero el backend todavía no lo confirmó (o nunca lo
  // hizo): degradar a rechazado/cancelado/pendiente en vez de mostrar éxito.
  const vistaEfectiva = vistaEfectivaDesde(resultado, estadoBackend);

  // ── PENDIENTE (URL decía éxito, backend aún no confirma tras agotar reintentos) ──
  if (vistaEfectiva === 'pendiente') {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.card}>
          <View style={[s.iconCircle, { backgroundColor: '#FFF7ED' }]}>
            <Ionicons name="time-outline" size={64} color={Colors.orange} />
          </View>
          <Text style={s.title}>Confirmación pendiente</Text>
          <Text style={s.sub}>
            Cubo todavía no nos confirma este pago.{'\n'}Tu pedido no se marcará como pagado hasta que el backend lo confirme.
          </Text>
        </View>

        <TouchableOpacity style={s.btnPrimary} onPress={irAPedidos}>
          <Ionicons name="receipt-outline" size={18} color={Colors.white} />
          <Text style={s.btnPrimaryText}>Ver mis pedidos</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecondary} onPress={irAlInicio}>
          <Text style={s.btnSecondaryText}>Volver al inicio</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── ÉXITO (solo alcanzable una vez el backend confirmó estado_pago=pagado) ──
  if (vistaEfectiva === 'success') {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.card}>
          <View style={[s.iconCircle, { backgroundColor: '#F0FDF4' }]}>
            <Ionicons name="checkmark-circle" size={64} color="#22C55E" />
          </View>
          <Text style={s.title}>¡Pago exitoso!</Text>
          <Text style={s.sub}>
            Tu pago fue procesado correctamente.{'\n'}Estamos confirmando tu pedido.
          </Text>

          {(auth_number || card_last_four) && (
            <View style={s.detailBox}>
              {auth_number    && <Text style={s.detail}>Autorización: <Text style={s.detailVal}>{auth_number}</Text></Text>}
              {card_last_four && <Text style={s.detail}>Tarjeta terminada en: <Text style={s.detailVal}>{card_last_four}</Text></Text>}
            </View>
          )}

          {!confirmado && (
            <View style={s.verifyRow}>
              <ActivityIndicator color={Colors.orange} size="small" />
              <Text style={s.verifyText}>Verificando confirmación del pedido...</Text>
            </View>
          )}
        </View>

        <TouchableOpacity style={s.btnPrimary} onPress={irAPedidos}>
          <Ionicons name="receipt-outline" size={18} color={Colors.white} />
          <Text style={s.btnPrimaryText}>Ver mis pedidos</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecondary} onPress={irAlInicio}>
          <Text style={s.btnSecondaryText}>Volver al inicio</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── RECHAZADO / FALLIDO ────────────────────────────────────────────────────
  if (vistaEfectiva === 'rejected') {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.card}>
          <View style={[s.iconCircle, { backgroundColor: '#FEF2F2' }]}>
            <Ionicons name="close-circle" size={64} color="#EF4444" />
          </View>
          <Text style={s.title}>Pago denegado</Text>
          <Text style={s.sub}>
            No pudimos procesar tu pago.{'\n'}Puedes intentarlo de nuevo o usar otra tarjeta.
          </Text>
        </View>

        <TouchableOpacity style={s.btnPrimary} onPress={irAPago}>
          <Ionicons name="refresh-outline" size={18} color={Colors.white} />
          <Text style={s.btnPrimaryText}>Intentar de nuevo</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecondary} onPress={irAlCarrito}>
          <Text style={s.btnSecondaryText}>Volver al carrito</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── CANCELADO ──────────────────────────────────────────────────────────────
  if (vistaEfectiva === 'cancelled') {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.card}>
          <View style={[s.iconCircle, { backgroundColor: '#FFFBEB' }]}>
            <Ionicons name="ban-outline" size={64} color="#F59E0B" />
          </View>
          <Text style={s.title}>Pago cancelado</Text>
          <Text style={s.sub}>
            Cancelaste el proceso de pago.{'\n'}Tu pedido aún no ha sido confirmado.
          </Text>
        </View>

        <TouchableOpacity style={s.btnPrimary} onPress={irAlCarrito}>
          <Ionicons name="cart-outline" size={18} color={Colors.white} />
          <Text style={s.btnPrimaryText}>Volver al carrito</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecondary} onPress={irAlInicio}>
          <Text style={s.btnSecondaryText}>Volver al inicio</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── VERIFICANDO (status desconocido o sin params) ──────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <View style={s.card}>
        <View style={[s.iconCircle, { backgroundColor: '#FFF7ED' }]}>
          <ActivityIndicator color={Colors.orange} size="large" />
        </View>
        <Text style={s.title}>Verificando tu pago</Text>
        <Text style={s.sub}>
          Esto puede tardar unos segundos.{'\n'}Puedes revisar el estado en Mis pedidos.
        </Text>
      </View>

      <TouchableOpacity style={s.btnPrimary} onPress={irAPedidos}>
        <Ionicons name="receipt-outline" size={18} color={Colors.white} />
        <Text style={s.btnPrimaryText}>Ver mis pedidos</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.btnSecondary} onPress={irAlInicio}>
        <Text style={s.btnSecondaryText}>Volver al inicio</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#F8F5F0', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card:           { backgroundColor: Colors.white, borderRadius: 24, padding: 28, width: '100%', alignItems: 'center', marginBottom: 20,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 4 },
  iconCircle:     { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  title:          { fontSize: 24, fontWeight: '900', color: Colors.brown, marginBottom: 10, textAlign: 'center' },
  sub:            { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  detailBox:      { backgroundColor: '#F8F5F0', borderRadius: 12, padding: 14, marginTop: 16, width: '100%', gap: 4 },
  detail:         { fontSize: 13, color: Colors.textSecondary, textAlign: 'center' },
  detailVal:      { fontWeight: '700', color: Colors.brown },
  verifyRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  verifyText:     { fontSize: 12, color: Colors.textLight },
  btnPrimary:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.primary,
                    borderRadius: 16, paddingVertical: 15, paddingHorizontal: 32, width: '100%', justifyContent: 'center' },
  btnPrimaryText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  btnSecondary:   { marginTop: 12, paddingVertical: 10 },
  btnSecondaryText:{ fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
});
