// ── routes/pagos.js ──────────────────────────
// Integración completa con Stripe
// Qué hace:
// 1. Crea un PaymentIntent (intención de pago) 
// 2. El móvil confirma el pago con la tarjeta
// 3. Stripe nos avisa por webhook cuando se confirmó
// 4. Generamos el código de recogida y notificamos al usuario
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const supabase = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const { enviarNotificacionPush } = require("../services/notificaciones");
const router = express.Router();

// ── POST /api/pagos/crear-intent ─────────────
// Paso 1: Crear intención de pago
// El frontend usa el clientSecret para completar el pago
router.post("/crear-intent", authMiddleware, async (req, res) => {
  const { bolsa_id, tipo_entrega, direccion_envio } = req.body;

  // Obtener bolsa
  const { data: bolsa, error: bolsaError } = await supabase
    .from("bolsas")
    .select("*, negocios(id, nombre, stripe_account_id)")
    .eq("id", bolsa_id)
    .single();

  if (bolsaError || !bolsa) return res.status(404).json({ error: "Bolsa no encontrada." });
  if (bolsa.cantidad_disponible < 1) return res.status(400).json({ error: "Bolsa agotada." });

  // Calcular costo de envío si aplica
  let costoEnvio = 0;
  if (tipo_entrega === "envio") {
    if (!bolsa.permite_envio) return res.status(400).json({ error: "Este negocio no ofrece envío." });
    costoEnvio = await calcularCostoEnvio(direccion_envio);
  }

  const comisionBocara = Math.round(bolsa.precio_descuento * (process.env.BOCARA_COMMISSION_PERCENT / 100) * 100) / 100;
  const totalCentavos = Math.round((bolsa.precio_descuento + costoEnvio) * 100);

  // Crear PaymentIntent en Stripe
  // applicationFeeAmount = comisión de Bocara (en centavos)
  const paymentIntentParams = {
    amount: totalCentavos,
    currency: "gtq",  // Quetzal guatemalteco
    metadata: {
      bolsa_id,
      usuario_id: req.usuario.id,
      negocio_id: bolsa.negocios.id,
      tipo_entrega,
      costo_envio: costoEnvio,
    },
    description: `Bocara - ${bolsa.nombre} en ${bolsa.negocios.nombre}`,
  };

  // Si el negocio tiene cuenta Stripe conectada, transferir su parte directamente
  if (bolsa.negocios.stripe_account_id) {
    paymentIntentParams.transfer_data = {
      destination: bolsa.negocios.stripe_account_id,
    };
    paymentIntentParams.application_fee_amount = Math.round(comisionBocara * 100);
  }

  const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

  // Guardar pedido en estado pendiente
  const codigoRecogida = "BOC-" + Math.floor(1000 + Math.random() * 9000);
  const { data: pedido } = await supabase.from("pedidos").insert([{
    usuario_id: req.usuario.id,
    bolsa_id,
    negocio_id: bolsa.negocios.id,
    tipo_entrega,
    direccion_envio: tipo_entrega === "envio" ? direccion_envio : null,
    precio_bolsa: bolsa.precio_descuento,
    costo_envio: costoEnvio,
    comision_bocara: comisionBocara,
    total: bolsa.precio_descuento + costoEnvio,
    stripe_payment_intent_id: paymentIntent.id,
    estado_pago: "pendiente",
    codigo_recogida: codigoRecogida,
    hora_recogida_inicio: bolsa.hora_recogida_inicio,
    hora_recogida_fin: bolsa.hora_recogida_fin,
  }]).select().single();

  res.json({
    clientSecret: paymentIntent.client_secret,  // Lo necesita el SDK de Stripe en el móvil
    pedidoId: pedido.data?.id,
    total: bolsa.precio_descuento + costoEnvio,
    costoEnvio,
    codigoRecogida,
  });
});

// ── POST /api/pagos/webhook ──────────────────
// Stripe nos avisa aquí cuando el pago se completó
// IMPORTANTE: Esta ruta debe estar en HTTPS en producción
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Pago completado exitosamente
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    const { bolsa_id, usuario_id, tipo_entrega } = paymentIntent.metadata;

    // Actualizar estado del pedido
    const { data: pedido } = await supabase
      .from("pedidos")
      .update({ estado_pago: "pagado", estado: "confirmado" })
      .eq("stripe_payment_intent_id", paymentIntent.id)
      .select("*, usuarios(nombre, expo_push_token), bolsas(nombre, co2_salvado_kg)")
      .single();

    if (pedido.data) {
      // Reducir cantidad disponible de la bolsa
      await supabase.rpc("decrementar_bolsa", { bolsa_id });

      // Actualizar estadísticas del usuario
      await supabase.from("usuarios").update({
        total_bolsas_salvadas: supabase.rpc("incrementar", { valor: 1 }),
        total_co2_salvado: supabase.rpc("sumar_co2", { valor: pedido.data.bolsas.co2_salvado_kg }),
        total_ahorrado: supabase.rpc("sumar_ahorro", { valor: paymentIntent.amount / 100 }),
      }).eq("id", usuario_id);

      // Si es envío, crear el envío con el carrier
      if (tipo_entrega === "envio") {
        await crearEnvioCarrier(pedido.data);
      }

      // Notificación push al usuario
      if (pedido.data.usuarios?.expo_push_token) {
        await enviarNotificacionPush(
          pedido.data.usuarios.expo_push_token,
          "✅ ¡Pago confirmado!",
          tipo_entrega === "recogida"
            ? `Tu código de recogida es: ${pedido.data.codigo_recogida}`
            : "Tu pedido ha sido confirmado. Te notificaremos cuando esté en camino.",
          { pedidoId: pedido.data.id, tipo: "pedido_confirmado" }
        );
      }
    }
  }

  // Pago fallido
  if (event.type === "payment_intent.payment_failed") {
    await supabase
      .from("pedidos")
      .update({ estado_pago: "fallido" })
      .eq("stripe_payment_intent_id", event.data.object.id);
  }

  res.json({ received: true });
});

// ── Función: calcular costo de envío ─────────
async function calcularCostoEnvio(direccion) {
  // Lógica simple por zonas de Guatemala City
  // En producción, esto llamaría a la API de Guatex/Forza para cotización real
  const zona = direccion?.zona || "";
  const zonasBaratas = ["Zona 1","Zona 4","Zona 9","Zona 10","Zona 11","Zona 12","Zona 13"];
  const zonasMedianas = ["Zona 2","Zona 3","Zona 5","Zona 6","Zona 7","Zona 8","Zona 14","Zona 15"];

  if (zonasBaratas.includes(zona)) return parseFloat(process.env.DELIVERY_BASE_FEE_GTM_CITY || 15);
  if (zonasMedianas.includes(zona)) return parseFloat(process.env.DELIVERY_BASE_FEE_METRO || 25);
  return parseFloat(process.env.DELIVERY_BASE_FEE_INTERIOR || 50);
}

// ── Función: crear envío con carrier ─────────
async function crearEnvioCarrier(pedido) {
  try {
    const envioService = require("../services/envios");
    const resultado = await envioService.crearEnvio(pedido);
    await supabase.from("pedidos").update({
      carrier: resultado.carrier,
      tracking_number: resultado.trackingNumber,
      tracking_url: resultado.trackingUrl,
      carrier_label_url: resultado.labelUrl,
      estado: "confirmado",
    }).eq("id", pedido.id);
  } catch (err) {
    console.error("Error creando envío:", err.message);
  }
}

module.exports = router;
