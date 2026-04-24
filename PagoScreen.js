// ── src/screens/PagoScreen.js ────────────────
// Esta es la pantalla más importante:
// 1. El usuario elige recogida o envío
// 2. Si elige envío, cotiza el costo en tiempo real con Guatex/Forza
// 3. Paga con Stripe (tarjeta, Google Pay, Apple Pay)
// 4. Recibe confirmación y código o tracking
import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, StyleSheet
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStripe } from "@stripe/stripe-react-native";
import { pagosAPI, bolsasAPI } from "../services/api";

export default function PagoScreen({ route, navigation }) {
  const { bolsa, negocio } = route.params;
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [tipoEntrega, setTipoEntrega] = useState("recogida");
  const [opcionesEnvio, setOpcionesEnvio] = useState([]);
  const [carrieroSeleccionado, setCarrierSeleccionado] = useState(null);
  const [costoEnvio, setCostoEnvio] = useState(0);
  const [direccion, setDireccion] = useState({ calle: "", zona: "", ciudad: "Guatemala City", referencia: "" });
  const [cotizando, setCotizando] = useState(false);
  const [pagando, setPagando] = useState(false);
  const [paso, setPaso] = useState(1); // 1=elegir entrega, 2=pagar, 3=éxito
  const [resultadoPago, setResultadoPago] = useState(null);

  const descuento = Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100);
  const total = bolsa.precio_descuento + costoEnvio;

  // Cotizar envío cuando cambia la dirección
  useEffect(() => {
    if (tipoEntrega === "envio" && direccion.zona) {
      cotizarEnvio();
    }
  }, [direccion.zona, tipoEntrega]);

  const cotizarEnvio = async () => {
    setCotizando(true);
    try {
      const opciones = await bolsasAPI.cotizarEnvio(bolsa.id, direccion);
      setOpcionesEnvio(opciones);
      if (opciones.length > 0) {
        setCarrierSeleccionado(opciones[0]);
        setCostoEnvio(opciones[0].precio);
      }
    } catch (e) {
      console.error("Error cotizando envío:", e);
    }
    setCotizando(false);
  };

  const iniciarPago = async () => {
    if (tipoEntrega === "envio" && (!direccion.calle || !direccion.zona)) {
      Alert.alert("Dirección incompleta", "Por favor ingresa tu calle y zona.");
      return;
    }

    setPagando(true);
    try {
      // Paso 1: Crear PaymentIntent en el backend
      const { clientSecret, codigoRecogida, pedidoId } = await pagosAPI.crearIntent(
        bolsa.id,
        tipoEntrega,
        tipoEntrega === "envio" ? { ...direccion, carrier: carrieroSeleccionado?.carrier } : null
      );

      // Paso 2: Inicializar el sheet de pago de Stripe
      const { error: initError } = await initPaymentSheet({
        paymentIntentClientSecret: clientSecret,
        merchantDisplayName: "Bocara Guatemala",
        defaultBillingDetails: { address: { country: "GT" } },
        googlePay: { merchantCountryCode: "GT", currencyCode: "GTQ", testEnv: true },
        applePay: { merchantCountryCode: "GT" },
      });

      if (initError) throw new Error(initError.message);

      // Paso 3: Mostrar la pantalla de pago de Stripe
      const { error: payError } = await presentPaymentSheet();

      if (payError) {
        if (payError.code !== "Canceled") {
          Alert.alert("Error en el pago", payError.message);
        }
      } else {
        // ¡Pago exitoso!
        setResultadoPago({ codigoRecogida, pedidoId, tipoEntrega });
        setPaso(3);
      }
    } catch (e) {
      Alert.alert("Error", e.message || "Hubo un problema con el pago.");
    }
    setPagando(false);
  };

  // ── Pantalla de éxito ─────────────────────
  if (paso === 3 && resultadoPago) {
    return (
      <SafeAreaView style={[s.container, { justifyContent: "center", alignItems: "center", padding: 24 }]}>
        <View style={s.successIcon}>
          <Text style={{ fontSize: 40 }}>✅</Text>
        </View>
        <Text style={s.successTitle}>¡Reserva confirmada!</Text>
        <Text style={s.successSub}>{negocio.nombre}</Text>

        {resultadoPago.tipoEntrega === "recogida" ? (
          <View style={s.codigoBox}>
            <Text style={{ color: "#64748b", fontSize: 13, marginBottom: 8 }}>Tu código de recogida</Text>
            <Text style={s.codigo}>{resultadoPago.codigoRecogida}</Text>
            <Text style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>
              Muéstralo al llegar · {bolsa.hora_recogida_inicio?.slice(0,5)} – {bolsa.hora_recogida_fin?.slice(0,5)}
            </Text>
          </View>
        ) : (
          <View style={s.codigoBox}>
            <Text style={{ color: "#64748b", fontSize: 13, marginBottom: 8 }}>Tu pedido está en proceso</Text>
            <Text style={{ fontSize: 32 }}>🏍️</Text>
            <Text style={{ color: "#1a1a2e", fontWeight: "700", marginTop: 8 }}>Envío con {carrieroSeleccionado?.nombre}</Text>
            <Text style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Te notificaremos cuando vaya en camino</Text>
          </View>
        )}

        <View style={s.impactoBox}>
          <Text style={{ fontSize: 16, marginRight: 8 }}>🌱</Text>
          <Text style={{ color: "#166534", fontSize: 13 }}>
            ¡Salvaste <Text style={{ fontWeight: "800" }}>{bolsa.co2_salvado_kg} kg CO₂</Text>!
          </Text>
        </View>

        <TouchableOpacity style={s.btnPrimario} onPress={() => navigation.navigate("Pedidos")}>
          <Text style={s.btnPrimarioText}>Ver mis pedidos</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnSecundario} onPress={() => navigation.navigate("ExplorarHome")}>
          <Text style={s.btnSecundarioText}>Seguir explorando</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Pantalla principal de pago ────────────
  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>

        {/* Header */}
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginBottom: 20 }}>
          <Text style={{ fontSize: 16, color: "#64748b" }}>← Volver</Text>
        </TouchableOpacity>
        <Text style={s.titulo}>Completa tu reserva</Text>
        <Text style={s.negocioNombre}>{negocio.nombre} · {bolsa.nombre}</Text>

        {/* Resumen de precios */}
        <View style={s.resumenBox}>
          <View style={s.fila}><Text style={s.filaLabel}>Precio original</Text><Text style={[s.filaValor, { textDecorationLine: "line-through", color: "#94a3b8" }]}>Q{bolsa.precio_original}</Text></View>
          <View style={s.fila}><Text style={s.filaLabel}>Descuento Bocara</Text><Text style={[s.filaValor, { color: "#16a34a" }]}>-Q{bolsa.precio_original - bolsa.precio_descuento}</Text></View>
          {costoEnvio > 0 && <View style={s.fila}><Text style={s.filaLabel}>Costo de envío</Text><Text style={s.filaValor}>Q{costoEnvio}</Text></View>}
          <View style={[s.fila, { borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 12, marginTop: 4 }]}>
            <Text style={{ fontWeight: "700", fontSize: 17 }}>Total</Text>
            <Text style={{ fontWeight: "800", fontSize: 24, color: "#16a34a" }}>Q{total}</Text>
          </View>
        </View>

        {/* Elegir tipo de entrega */}
        <Text style={s.seccionTitulo}>¿Cómo quieres recibirlo?</Text>
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 20 }}>
          <TouchableOpacity
            style={[s.opcionEntrega, tipoEntrega === "recogida" && s.opcionEntregaActiva]}
            onPress={() => { setTipoEntrega("recogida"); setCostoEnvio(0); }}
          >
            <Text style={{ fontSize: 28 }}>🏪</Text>
            <Text style={[s.opcionEntregaLabel, tipoEntrega === "recogida" && { color: "#16a34a" }]}>Recogida</Text>
            <Text style={s.opcionEntregaSub}>Gratis</Text>
          </TouchableOpacity>

          {bolsa.permite_envio && (
            <TouchableOpacity
              style={[s.opcionEntrega, tipoEntrega === "envio" && s.opcionEntregaActiva]}
              onPress={() => setTipoEntrega("envio")}
            >
              <Text style={{ fontSize: 28 }}>🏍️</Text>
              <Text style={[s.opcionEntregaLabel, tipoEntrega === "envio" && { color: "#16a34a" }]}>Envío</Text>
              <Text style={s.opcionEntregaSub}>+costo</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Formulario de dirección si elige envío */}
        {tipoEntrega === "envio" && (
          <View style={s.seccionEnvio}>
            <Text style={s.seccionTitulo}>Dirección de envío</Text>
            <TextInput style={s.input} placeholder="Calle y número (ej: 10 Calle 5-50)" value={direccion.calle} onChangeText={(v) => setDireccion({ ...direccion, calle: v })} />
            <TextInput style={s.input} placeholder="Zona (ej: Zona 10)" value={direccion.zona} onChangeText={(v) => setDireccion({ ...direccion, zona: v })} onEndEditing={cotizarEnvio} />
            <TextInput style={s.input} placeholder="Ciudad" value={direccion.ciudad} onChangeText={(v) => setDireccion({ ...direccion, ciudad: v })} />
            <TextInput style={s.input} placeholder="Referencia (opcional, ej: Frente al parque)" value={direccion.referencia} onChangeText={(v) => setDireccion({ ...direccion, referencia: v })} />

            {/* Opciones de carrier */}
            {cotizando ? (
              <ActivityIndicator color="#16a34a" style={{ margin: 16 }} />
            ) : opcionesEnvio.length > 0 ? (
              <View>
                <Text style={[s.seccionTitulo, { fontSize: 14 }]}>Elige tu servicio de envío</Text>
                {opcionesEnvio.map((op) => (
                  <TouchableOpacity
                    key={op.carrier}
                    style={[s.opcionCarrier, carrieroSeleccionado?.carrier === op.carrier && s.opcionCarrierActiva]}
                    onPress={() => { setCarrierSeleccionado(op); setCostoEnvio(op.precio); }}
                  >
                    <Text style={{ fontSize: 24 }}>{op.logo}</Text>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ fontWeight: "700", color: "#1a1a2e" }}>{op.nombre}</Text>
                      <Text style={{ fontSize: 12, color: "#64748b" }}>{op.descripcion}</Text>
                    </View>
                    <Text style={{ fontWeight: "800", color: "#16a34a", fontSize: 16 }}>Q{op.precio}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        )}

        {/* Botón de pago */}
        <TouchableOpacity style={[s.btnPagar, pagando && { opacity: 0.6 }]} onPress={iniciarPago} disabled={pagando}>
          {pagando ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.btnPagarText}>
              {tipoEntrega === "recogida" ? "🔒 Pagar Q" + total : "🏍️ Pagar Q" + total + " (con envío)"}
            </Text>
          )}
        </TouchableOpacity>
        <Text style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
          🔒 Pago seguro con Stripe · Acepta tarjeta, Apple Pay y Google Pay
        </Text>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  titulo: { fontSize: 26, fontWeight: "800", color: "#1a1a2e", marginBottom: 4 },
  negocioNombre: { fontSize: 14, color: "#64748b", marginBottom: 20 },
  resumenBox: { backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 24, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8 },
  fila: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  filaLabel: { color: "#64748b", fontSize: 14 },
  filaValor: { color: "#1a1a2e", fontWeight: "600", fontSize: 14 },
  seccionTitulo: { fontWeight: "700", fontSize: 16, color: "#1a1a2e", marginBottom: 12 },
  opcionEntrega: { flex: 1, backgroundColor: "#fff", borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 2, borderColor: "#e2e8f0", elevation: 1 },
  opcionEntregaActiva: { borderColor: "#16a34a", backgroundColor: "#f0fdf4" },
  opcionEntregaLabel: { fontWeight: "700", fontSize: 14, color: "#64748b", marginTop: 8 },
  opcionEntregaSub: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  seccionEnvio: { marginBottom: 20 },
  input: { backgroundColor: "#fff", borderRadius: 12, padding: 14, fontSize: 14, marginBottom: 10, borderWidth: 1.5, borderColor: "#e2e8f0" },
  opcionCarrier: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 2, borderColor: "#e2e8f0" },
  opcionCarrierActiva: { borderColor: "#16a34a", backgroundColor: "#f0fdf4" },
  btnPagar: { backgroundColor: "#16a34a", borderRadius: 16, padding: 18, alignItems: "center", marginTop: 8 },
  btnPagarText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  successIcon: { width: 90, height: 90, backgroundColor: "#dcfce7", borderRadius: 45, justifyContent: "center", alignItems: "center", marginBottom: 20 },
  successTitle: { fontSize: 26, fontWeight: "800", color: "#1a1a2e", marginBottom: 4 },
  successSub: { fontSize: 14, color: "#64748b", marginBottom: 24 },
  codigoBox: { backgroundColor: "#f8fafc", borderRadius: 16, padding: 24, alignItems: "center", width: "100%", marginBottom: 16 },
  codigo: { fontFamily: "monospace", fontSize: 32, fontWeight: "900", color: "#16a34a", letterSpacing: 4 },
  impactoBox: { flexDirection: "row", alignItems: "center", backgroundColor: "#f0fdf4", borderRadius: 12, padding: 14, width: "100%", marginBottom: 24 },
  btnPrimario: { backgroundColor: "#1a1a2e", borderRadius: 14, padding: 16, alignItems: "center", width: "100%", marginBottom: 10 },
  btnPrimarioText: { color: "#4ade80", fontWeight: "800", fontSize: 16 },
  btnSecundario: { borderRadius: 14, padding: 16, alignItems: "center", width: "100%" },
  btnSecundarioText: { color: "#64748b", fontWeight: "600", fontSize: 15 },
});
