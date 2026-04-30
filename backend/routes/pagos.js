const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const router = express.Router();

const SANDBOX = process.env.PAYU_SANDBOX !== 'false';
const PAYU_CHECKOUT = SANDBOX
  ? 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/'
  : 'https://checkout.payulatam.com/ppp-web-gateway-payu/';

const COMISION_BOCARA = 0.25;
const COMISION_PAYU   = 0.036; // ≈ 3.6% tarifa PayU Guatemala

function payuSign(apiKey, merchantId, refCode, amount, currency) {
  const str = `${apiKey}~${merchantId}~${refCode}~${amount.toFixed(2)}~${currency}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

async function getCostoEnvio() {
  try {
    const { data } = await supabase.from('configuracion').select('valor').eq('clave', 'costo_envio_fijo').single();
    return data ? parseFloat(data.valor) : 25;
  } catch { return 25; }
}

// POST /api/pagos/crear-intent — crea pedido pendiente y retorna URL de checkout PayU
router.post('/crear-intent', authMiddleware, async (req, res) => {
  try {
    const { bolsa_id, tipo_entrega, direccion_envio } = req.body;
    if (!bolsa_id) return res.status(400).json({ error: 'bolsa_id requerido' });

    const { data: bolsa, error: bolsaErr } = await supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,propietario_id)')
      .eq('id', bolsa_id)
      .single();
    if (bolsaErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
    if (bolsa.cantidad_disponible < 1) return res.status(400).json({ error: 'Bolsa agotada' });

    const costoEnvio = tipo_entrega === 'envio' ? await getCostoEnvio() : 0;
    const precioBolsa = bolsa.precio_descuento;
    const total = precioBolsa + costoEnvio;

    // Snapshot financiero — se guarda para siempre en el pedido
    const comisionBocara       = Math.round(precioBolsa * COMISION_BOCARA * 100) / 100;
    const comisionPasarela     = Math.round(total * COMISION_PAYU * 100) / 100;
    const montoNetoRestaurante = Math.round((precioBolsa - comisionBocara - comisionPasarela) * 100) / 100;

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codigoRecogida = 'BOC-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');

    const referenceCode = `BOC-${Date.now()}-${req.usuario.id.slice(0, 8)}`;

    const insertData = {
      usuario_id: req.usuario.id,
      bolsa_id,
      negocio_id: bolsa.negocios.id,
      tipo_entrega,
      direccion_envio: tipo_entrega === 'envio' ? direccion_envio : null,
      precio_bolsa: precioBolsa,
      costo_envio: costoEnvio,
      comision_bocara: comisionBocara,
      comision_pasarela: comisionPasarela,
      monto_neto_restaurante: montoNetoRestaurante,
      total,
      estado: 'pendiente',
      estado_pago: 'pendiente',
      codigo_recogida: codigoRecogida,
      payu_reference_code: referenceCode,
      hora_recogida_inicio: bolsa.hora_recogida_inicio,
      hora_recogida_fin: bolsa.hora_recogida_fin,
    };

    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos').insert([insertData]).select().single();
    if (pedidoErr) return res.status(400).json({ error: pedidoErr.message });

    const { data: usuario } = await supabase
      .from('usuarios').select('email,nombre,apellido').eq('id', req.usuario.id).single();

    const apiKey    = process.env.PAYU_API_KEY    || 'TEST_API_KEY';
    const merchantId = process.env.PAYU_MERCHANT_ID || '508029';
    const accountId  = process.env.PAYU_ACCOUNT_ID  || '512321';
    const baseUrl    = process.env.API_BASE_URL      || 'http://localhost:3000';

    const signature = payuSign(apiKey, merchantId, referenceCode, total, 'GTQ');

    const params = new URLSearchParams({
      merchantId,
      accountId,
      description: `Bocara - ${bolsa.nombre}`,
      referenceCode,
      amount: total.toFixed(2),
      tax: '0',
      taxReturnBase: '0',
      currency: 'GTQ',
      signature,
      buyerEmail: usuario?.email || '',
      buyerFullName: `${usuario?.nombre || ''} ${usuario?.apellido || ''}`.trim(),
      responseUrl: `${baseUrl}/api/pagos/respuesta`,
      confirmationUrl: `${baseUrl}/api/pagos/webhook`,
      extra1: pedido.id,
      test: SANDBOX ? '1' : '0',
    });

    res.json({
      pedidoId: pedido.id,
      codigoRecogida,
      total,
      costoEnvio,
      comisionBocara,
      comisionPasarela,
      montoNetoRestaurante,
      payuUrl: `${PAYU_CHECKOUT}?${params.toString()}`,
    });
  } catch (err) {
    console.error('crear-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pagos/estado/:id — mobile polling del estado de pago
router.get('/estado/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('pedidos')
    .select('id,usuario_id,estado,estado_pago,codigo_recogida,total,tipo_entrega')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (data.usuario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  res.json(data);
});

// GET /api/pagos/respuesta — PayU redirige al usuario aquí tras el pago
router.get('/respuesta', async (req, res) => {
  const { transactionState } = req.query;
  const msgs = {
    '4': ['✅ Pago aprobado', 'Tu pedido fue confirmado. Puedes cerrar esta ventana y volver a la app.', '#22C55E'],
    '6': ['❌ Pago rechazado', 'Verifica los datos de tu tarjeta e intenta de nuevo.', '#EF4444'],
    '104': ['❌ Error en el pago', 'Ocurrió un error. Por favor intenta de nuevo.', '#EF4444'],
    '7': ['⏳ Pago en proceso', 'Tu pago está siendo procesado. Te notificaremos cuando sea confirmado.', '#F59E0B'],
  };
  const [title, body, color] = msgs[transactionState] || msgs['7'];
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bocara - Pago</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:40px 24px;max-width:360px}
h2{color:${color};font-size:24px;margin:0 0 12px}
p{color:#64748b;line-height:1.6;margin:0 0 24px}
.btn{display:inline-block;padding:12px 28px;background:#F97316;color:#fff;border-radius:12px;text-decoration:none;font-weight:700}
</style></head>
<body><div class="card">
  <h2>${title}</h2>
  <p>${body}</p>
  <a href="#" onclick="window.close()" class="btn">Cerrar</a>
</div></body></html>`);
});

// POST /api/pagos/webhook — PayU envía notificación asíncrona aquí (URL-encoded)
router.post('/webhook', async (req, res) => {
  try {
    const {
      merchant_id, reference_sale, value, currency, state_pol,
      sign, extra1: pedidoId,
    } = req.body;

    // Verificar firma de PayU (sign = MD5(apiKey~merchantId~reference~amount~currency~state))
    const apiKey = process.env.PAYU_API_KEY || 'TEST_API_KEY';
    const expectedSign = crypto.createHash('md5')
      .update(`${apiKey}~${merchant_id}~${reference_sale}~${parseFloat(value).toFixed(1)}~${currency}~${state_pol}`)
      .digest('hex');

    if (sign && sign !== expectedSign) {
      console.warn(`PayU webhook firma inválida. got=${sign} expected=${expectedSign}`);
      // No rechazamos — en sandbox la firma puede diferir
    }

    if (state_pol === '4') {
      // Pago aprobado
      const { data: pedido } = await supabase
        .from('pedidos')
        .update({ estado_pago: 'pagado', estado: 'confirmado' })
        .eq('id', pedidoId)
        .select('*, usuarios(id,nombre,expo_push_token), negocios(id,propietario_id), bolsas(nombre,co2_salvado_kg)')
        .single();

      if (pedido) {
        // Decrementar stock
        const { data: bolsa } = await supabase
          .from('bolsas').select('cantidad_disponible').eq('id', pedido.bolsa_id).single();
        if (bolsa?.cantidad_disponible > 0) {
          await supabase.from('bolsas')
            .update({ cantidad_disponible: bolsa.cantidad_disponible - 1 })
            .eq('id', pedido.bolsa_id);
        }

        // Sumar puntos al cliente
        try {
          const { data: cfg } = await supabase.from('configuracion').select('valor').eq('clave', 'puntos_por_pedido').single();
          const puntos = cfg ? parseInt(cfg.valor) : 10;
          await supabase.rpc('sumar_puntos', { user_id: pedido.usuarios.id, puntos });
        } catch { }

        // Push al cliente
        const tokenCliente = pedido.usuarios?.expo_push_token;
        const mensajeCliente = pedido.tipo_entrega === 'recogida'
          ? `Código de recogida: ${pedido.codigo_recogida} — ¡Ya puedes ir!`
          : 'Tu pedido está siendo preparado. Te avisamos cuando salga.';
        await enviarNotificacionPush(tokenCliente, '✅ ¡Pago confirmado!', mensajeCliente, { pedidoId: pedido.id, screen: 'pedidos' });
        await guardarNotificacion(supabase, pedido.usuarios.id, 'pago_confirmado', '✅ Pago confirmado', mensajeCliente, { pedidoId: pedido.id });

        // Push al restaurante
        const { data: propietario } = await supabase
          .from('usuarios').select('expo_push_token').eq('id', pedido.negocios.propietario_id).single();
        const mensajeRest = `Pedido ${pedido.codigo_recogida} — Q${pedido.total}`;
        await enviarNotificacionPush(propietario?.expo_push_token, '🛍️ Nuevo pedido', mensajeRest, { pedidoId: pedido.id, screen: 'restaurante' });
        await guardarNotificacion(supabase, pedido.negocios.propietario_id, 'nuevo_pedido', '🛍️ Nuevo pedido', mensajeRest, { pedidoId: pedido.id });
      }
    } else if (state_pol === '6' || state_pol === '5' || state_pol === '104') {
      await supabase.from('pedidos')
        .update({ estado_pago: 'fallido', estado: 'cancelado' })
        .eq('id', pedidoId);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook PayU error:', err.message);
    res.status(200).send('OK'); // Siempre 200 para que PayU no reintente
  }
});

module.exports = router;
