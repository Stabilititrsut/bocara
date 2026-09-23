import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView, Linking, Alert, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { Colors } from '@/constants/Colors';
import { pedidosAPI } from '@/src/services/api';

// Estados en los que el backend respalda que el pedido fue pagado y confirmado —
// ver services/orderStateMachine.js en el backend. La URL (codigo/pedidoId) nunca
// es suficiente por sí sola: alguien podría pegar esta ruta a mano con cualquier
// parámetro y no debe ver una confirmación que el backend no respalda.
export const ESTADOS_CONFIRMADOS = ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido'];

type Verificacion = 'cargando' | 'ok' | 'cancelado' | 'no_confirmado' | 'error';

// Pura y exportada para poder probar la regla sin montar el componente:
// dado el `estado` que devuelve el backend, decide si se puede mostrar el QR.
export function resolverVerificacion(estadoPedido: string | undefined): 'ok' | 'cancelado' | 'no_confirmado' {
  if (estadoPedido === 'cancelado') return 'cancelado';
  if (ESTADOS_CONFIRMADOS.includes(estadoPedido as string)) return 'ok';
  return 'no_confirmado';
}

export default function QrRecogidaScreen() {
  const { codigo, tipo, pedidoId } = useLocalSearchParams<{ codigo: string; tipo: string; pedidoId: string }>();
  const router = useRouter();
  const esEnvio = tipo === 'envio';

  const [negocioNav, setNegocioNav] = useState<{
    nombre?: string;
    direccion?: string;
    zona?: string;
    punto_referencia?: string;
    google_maps_url?: string;
    waze_url?: string;
    latitud?: number | null;
    longitud?: number | null;
  } | null>(null);
  const [verificacion, setVerificacion] = useState<Verificacion>('cargando');
  const [codigoVerificado, setCodigoVerificado] = useState<string | undefined>(undefined);
  const [errorMsg, setErrorMsg] = useState('');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!pedidoId) { setVerificacion('no_confirmado'); return; }
    let activo = true;
    setVerificacion('cargando');
    pedidosAPI.detalle(pedidoId).then((res) => {
      if (!activo) return;
      const d = res.data || {};
      const n = d.negocios || d.negocio;
      if (n) setNegocioNav(n);
      setCodigoVerificado(d.codigo_recogida);
      setVerificacion(resolverVerificacion(d.estado));
    }).catch((err: any) => {
      if (!activo) return;
      setErrorMsg(err?.status === 404 ? 'No encontramos este pedido.' : (err?.message || 'No pudimos verificar tu pedido.'));
      setVerificacion('error');
    });
    return () => { activo = false; };
  }, [pedidoId, intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);
  const codigoMostrado = codigoVerificado || codigo;

  function abrirGoogleMaps() {
    const url = negocioNav?.google_maps_url
      || (negocioNav?.latitud != null && negocioNav?.longitud != null
        ? `https://www.google.com/maps/dir/?api=1&destination=${negocioNav.latitud},${negocioNav.longitud}`
        : null);
    if (url) Linking.openURL(url);
    else Alert.alert('Sin ubicación', 'El negocio aún no tiene ubicación registrada.');
  }

  function abrirWaze() {
    const url = negocioNav?.waze_url
      || (negocioNav?.latitud != null && negocioNav?.longitud != null
        ? `https://waze.com/ul?ll=${negocioNav.latitud},${negocioNav.longitud}&navigate=yes`
        : null);
    if (url) Linking.openURL(url);
    else Alert.alert('Sin ubicación', 'El negocio aún no tiene ubicación registrada.');
  }

  const tieneNavegacion = !!(
    negocioNav?.google_maps_url ||
    negocioNav?.waze_url ||
    (negocioNav?.latitud != null && negocioNav?.longitud != null)
  );

  if (verificacion === 'cargando') {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.verificando}>
          <ActivityIndicator size="large" color={Colors.orange} />
          <Text style={s.verificandoText}>Confirmando tu pedido con Bocara...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (verificacion === 'error' || verificacion === 'no_confirmado' || verificacion === 'cancelado') {
    const titulo = verificacion === 'cancelado' ? 'Pedido cancelado' : 'No pudimos confirmar tu pedido';
    const detalle = verificacion === 'cancelado'
      ? 'Este pedido fue cancelado y ya no tiene una bolsa asociada para recoger.'
      : verificacion === 'no_confirmado'
        ? 'Todavía no tenemos confirmación de pago para este pedido. Revisa Mis pedidos para ver su estado actual.'
        : errorMsg;
    return (
      <SafeAreaView style={s.root}>
        <View style={s.verificando}>
          <Text style={{ fontSize: 40 }}>{verificacion === 'cancelado' ? '🚫' : '⚠️'}</Text>
          <Text style={s.title}>{titulo}</Text>
          <Text style={s.subtitle}>{detalle}</Text>
          {verificacion === 'error' && (
            <TouchableOpacity style={s.btnPedidos} onPress={reintentar}>
              <Text style={s.btnPedidosText}>Reintentar</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.btnHome} onPress={() => router.replace('/(tabs)/pedidos' as any)}>
            <Text style={s.btnHomeText}>Ver mis pedidos</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.container} showsVerticalScrollIndicator={false}>

        <View style={s.successIcon}>
          <Text style={{ fontSize: 48 }}>✅</Text>
        </View>
        <Text style={s.title}>¡Pedido confirmado!</Text>
        <Text style={s.subtitle}>
          {esEnvio
            ? 'Tu pedido está en camino. Te notificaremos cuando salga.'
            : 'Muestra este código QR al recoger tu bolsa'}
        </Text>

        {!esEnvio && (
          <>
            <View style={s.qrCard}>
              <View style={s.qrWrapper}>
                <QRCode
                  value={codigoMostrado || 'BOC-000000'}
                  size={200}
                  color={Colors.brown}
                  backgroundColor={Colors.white}
                />
              </View>
              <View style={s.codigoRow}>
                <Text style={s.codigoLabel}>Código</Text>
                <Text style={s.codigo}>{codigoMostrado}</Text>
              </View>
            </View>

            <View style={s.instrucciones}>
              <Text style={s.instruccionTitle}>¿Cómo recoger?</Text>
              <Text style={s.instruccionItem}>1. Ve al restaurante en el horario indicado</Text>
              <Text style={s.instruccionItem}>2. Muestra el QR o el código al personal</Text>
              <Text style={s.instruccionItem}>3. ¡Disfruta tu bolsa rescatada! 🌱</Text>
            </View>

            {/* Cómo llegar — se muestra si hay datos de navegación */}
            {(negocioNav || tieneNavegacion) && (
              <View style={s.navCard}>
                <Text style={s.navTitle}>📍 Cómo llegar</Text>
                {negocioNav?.nombre ? (
                  <Text style={s.navNombre}>{negocioNav.nombre}</Text>
                ) : null}
                {(negocioNav?.direccion || negocioNav?.zona) ? (
                  <Text style={s.navDireccion}>
                    {[negocioNav.direccion, negocioNav.zona].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {negocioNav?.punto_referencia ? (
                  <Text style={s.navReferencia}>🔖 {negocioNav.punto_referencia}</Text>
                ) : null}
                <View style={s.navBtns}>
                  <TouchableOpacity style={s.navBtnGoogle} onPress={abrirGoogleMaps}>
                    <Text style={{ fontSize: 16 }}>🗺️</Text>
                    <Text style={s.navBtnText}>Google Maps</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.navBtnWaze} onPress={abrirWaze}>
                    <Text style={{ fontSize: 16 }}>🚗</Text>
                    <Text style={s.navBtnText}>Waze</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </>
        )}

        {esEnvio && (
          <View style={s.envioCard}>
            <Text style={{ fontSize: 40 }}>🏍️</Text>
            <Text style={s.envioTitle}>Tu pedido está siendo preparado</Text>
            <Text style={s.envioText}>
              Recibirás notificaciones sobre el estado de tu entrega.{'\n'}
              Tiempo estimado: 30–60 minutos.
            </Text>
          </View>
        )}

        <View style={s.impact}>
          <Text style={s.impactTitle}>🌿 ¡Gracias por rescatar comida!</Text>
          <Text style={s.impactText}>Contribuiste a reducir el desperdicio de alimentos en Guatemala</Text>
        </View>

        <TouchableOpacity style={s.btnPedidos} onPress={() => router.replace('/(tabs)/pedidos')}>
          <Text style={s.btnPedidosText}>Ver mis pedidos</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btnHome} onPress={() => router.replace('/(tabs)/' as any)}>
          <Text style={s.btnHomeText}>Seguir explorando</Text>
        </TouchableOpacity>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  container: { padding: 24, alignItems: 'center' },
  verificando: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  verificandoText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  successIcon: {
    backgroundColor: Colors.greenLight,
    borderRadius: 50, width: 96, height: 96,
    alignItems: 'center', justifyContent: 'center', marginTop: 16,
  },
  title: { fontSize: 26, fontWeight: '900', color: Colors.brown, marginTop: 16, textAlign: 'center' },
  subtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
  qrCard: {
    backgroundColor: Colors.white, borderRadius: 20, padding: 24,
    alignItems: 'center', marginTop: 24, width: '100%',
    elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10, shadowRadius: 12,
  },
  qrWrapper: {
    padding: 12, backgroundColor: Colors.white,
    borderRadius: 12, borderWidth: 2, borderColor: Colors.border,
  },
  codigoRow: { marginTop: 16, alignItems: 'center' },
  codigoLabel: { fontSize: 11, fontWeight: '600', color: Colors.textLight, textTransform: 'uppercase', letterSpacing: 1 },
  codigo: { fontSize: 28, fontWeight: '900', color: Colors.brown, letterSpacing: 4, marginTop: 4 },
  instrucciones: {
    backgroundColor: Colors.white, borderRadius: 16, padding: 16,
    width: '100%', marginTop: 16,
  },
  instruccionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 10 },
  instruccionItem: { fontSize: 13, color: Colors.textSecondary, marginBottom: 6, lineHeight: 20 },

  navCard: {
    backgroundColor: Colors.white, borderRadius: 16, padding: 16,
    width: '100%', marginTop: 12,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  navTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginBottom: 6 },
  navNombre: { fontSize: 14, fontWeight: '700', color: Colors.brown, marginBottom: 2 },
  navDireccion: { fontSize: 13, color: Colors.textSecondary, marginBottom: 4 },
  navReferencia: { fontSize: 12, color: Colors.textSecondary, marginBottom: 12, fontStyle: 'italic' },
  navBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  navBtnGoogle: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: Colors.brown, borderRadius: 12, paddingVertical: 12,
  },
  navBtnWaze: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: '#00B4D8', borderRadius: 12, paddingVertical: 12,
  },
  navBtnText: { color: Colors.white, fontSize: 13, fontWeight: '700' },

  envioCard: {
    backgroundColor: Colors.white, borderRadius: 20, padding: 24,
    alignItems: 'center', marginTop: 20, width: '100%', gap: 8,
  },
  envioTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown, textAlign: 'center' },
  envioText: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  impact: {
    backgroundColor: Colors.greenLight, borderRadius: 16, padding: 16,
    width: '100%', marginTop: 16, alignItems: 'center',
  },
  impactTitle: { fontSize: 14, fontWeight: '800', color: Colors.green, marginBottom: 4 },
  impactText: { fontSize: 13, color: Colors.brown, textAlign: 'center' },
  btnPedidos: {
    backgroundColor: Colors.orange, borderRadius: 14, padding: 14,
    width: '100%', alignItems: 'center', marginTop: 20,
  },
  btnPedidosText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnHome: {
    borderWidth: 2, borderColor: Colors.brown, borderRadius: 14, padding: 14,
    width: '100%', alignItems: 'center', marginTop: 10,
  },
  btnHomeText: { color: Colors.brown, fontWeight: '700', fontSize: 15 },
});
