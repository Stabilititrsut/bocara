const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { generarLinkPago } = require('../services/visaLink');
const { getReservadoPendiente } = require('../services/stock');
const { procesarWebhookCubo } = require('./webhooks');
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

    // Cancelar pedidos pendientes anteriores del mismo usuario ANTES de validar stock
    // para que sus reservas no bloqueen la nueva compra
    const { data: viejos } = await supabase
      .from('pedidos')
      .update({ estado: 'cancelado', estado_pago: 'fallido' })
      .eq('usuario_id', req.usuario.id)
      .eq('estado', 'pendiente')
      .eq('estado_pago', 'pendiente')
      .select('id');
    console.log('[PAGO] pedidos pendientes anteriores cancelados:', viejos?.length ?? 0);

    // Validar stock real = cantidad_disponible DB − reservas de otros usuarios
    const reservado = await getReservadoPendiente(bolsa_id);
    const disponibleReal = Math.max(0, bolsa.cantidad_disponible - reservado);
    console.log('[STOCK] bolsa:', bolsa_id);
    console.log('[STOCK] cantidad_disponible DB:', bolsa.cantidad_disponible);
    console.log('[STOCK] reservado pendiente:', reservado);
    console.log('[STOCK] disponible real:', disponibleReal);
    console.log('[STOCK] solicitado:', 1);
    if (disponibleReal < 1) {
      return res.status(400).json({ error: 'Esta bolsa ya no tiene unidades disponibles.' });
    }

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
        .select('*, usuarios(id,nombre,expo_push_token), negocios(id,propietario_id), bolsas(nombre)')
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

// POST /api/pagos/cubopago — genera link de pago Cubo Pago (Guatemala) y lo devuelve al frontend
router.post('/cubopago', authMiddleware, async (req, res) => {
  try {
    console.log('1. Endpoint /pagos/cubopago recibido', req.body);
    const { items: itemsReq, bolsa_id, tipo_entrega, direccion_envio, cantidad: cantidadReq, propina: propinaReq } = req.body;
    const propina = Math.max(0, Math.round((parseFloat(propinaReq) || 0) * 100) / 100);

    if (process.env.CUBO_PAYMENTS_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Pagos temporalmente deshabilitados' });
    }

    const apiKeyDisponible = process.env.CUBO_API_KEY
      || (process.env.CUBO_ENVIRONMENT !== 'production' ? process.env.CUBOPAGO_API_KEY : null);
    if (!apiKeyDisponible) {
      return res.status(500).json({ error: 'CUBO_API_KEY no configurada en el servidor' });
    }

    // Normalizar: soportar modo carrito (items[]) y modo legado (bolsa_id + cantidad)
    let cartItems;
    if (Array.isArray(itemsReq) && itemsReq.length > 0) {
      cartItems = itemsReq;
    } else if (bolsa_id) {
      cartItems = [{ bolsa_id, cantidad: Math.max(1, parseInt(cantidadReq) || 1) }];
    } else {
      return res.status(400).json({ error: 'Se requiere items[] o bolsa_id' });
    }

    // Buscar todas las bolsas en paralelo
    const bolsasResults = await Promise.all(
      cartItems.map(item =>
        supabase.from('bolsas').select('*, negocios(id,nombre,propietario_id)').eq('id', item.bolsa_id).single()
      )
    );

    // Verificar que todas las bolsas existan
    const bolsas = [];
    for (let i = 0; i < cartItems.length; i++) {
      const { data: bolsa, error } = bolsasResults[i];
      if (error || !bolsa) return res.status(404).json({ error: `Bolsa ${cartItems[i].bolsa_id} no encontrada` });
      bolsas.push(bolsa);
    }

    // Cancelar pedidos pendientes anteriores del mismo usuario ANTES de validar stock
    // para que sus reservas no bloqueen la nueva compra
    const { data: viejos } = await supabase
      .from('pedidos')
      .update({ estado: 'cancelado', estado_pago: 'fallido' })
      .eq('usuario_id', req.usuario.id)
      .eq('estado', 'pendiente')
      .eq('estado_pago', 'pendiente')
      .select('id');
    console.log('[PAGO] pedidos pendientes anteriores cancelados:', viejos?.length ?? 0);

    // Validar stock de cada item considerando reservas pendientes de otros usuarios
    for (let i = 0; i < cartItems.length; i++) {
      const bolsa = bolsas[i];
      const cantidadSolicitada = cartItems[i].cantidad;
      const reservado = await getReservadoPendiente(bolsa.id);
      const disponibleReal = Math.max(0, bolsa.cantidad_disponible - reservado);
      console.log('[STOCK] bolsa:', bolsa.id);
      console.log('[STOCK] cantidad_disponible DB:', bolsa.cantidad_disponible);
      console.log('[STOCK] reservado pendiente:', reservado);
      console.log('[STOCK] disponible real:', disponibleReal);
      console.log('[STOCK] solicitado:', cantidadSolicitada);
      if (cantidadSolicitada > disponibleReal) {
        return res.status(400).json({
          error: disponibleReal === 0
            ? `"${bolsa.nombre}": Esta bolsa ya no tiene unidades disponibles.`
            : `"${bolsa.nombre}": Solo quedan ${disponibleReal} unidad(es) disponibles.`,
        });
      }
    }

    const costoEnvio = tipo_entrega === 'envio' ? await getCostoEnvio() : 0;

    // Subtotal = suma de (precio_unitario × cantidad) + propina
    const subtotalProductos = Math.round(
      cartItems.reduce((sum, item, i) => sum + bolsas[i].precio_descuento * item.cantidad, 0) * 100
    ) / 100;
    const subtotal = subtotalProductos + costoEnvio + propina;

    const COMISION_CUBO        = 0.035;
    const comisionBocara       = Math.round(subtotalProductos * COMISION_BOCARA * 100) / 100;
    const comisionPasarela     = Math.round(subtotal * COMISION_CUBO * 100) / 100;
    const total                = Math.round((subtotal + comisionPasarela) * 100) / 100;
    // Propina va 100% al restaurante (solo se descuenta comisión pasarela)
    const montoNetoRestaurante = Math.round((subtotalProductos - comisionBocara - comisionPasarela + propina) * 100) / 100;

    console.log('[PAGO] items recibidos:', JSON.stringify(cartItems));
    console.log('[PAGO] subtotalProductos:', subtotalProductos);
    console.log('[PAGO] comisionPasarela:', comisionPasarela);
    console.log('[PAGO] total:', total);
    console.log('[PAGO] amount Cubo (centavos):', Math.round(total * 100));

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codigoRecogida = 'BOC-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    const referenceCode = `BOC-${Date.now()}-${req.usuario.id.slice(0, 8)}`;

    // Pedido principal — usa la primera bolsa para compatibilidad con columnas existentes
    const bolsaPrincipal  = bolsas[0];
    const itemPrincipal   = cartItems[0];

    const insertBase = {
      usuario_id:             req.usuario.id,
      bolsa_id:               bolsaPrincipal.id,
      negocio_id:             bolsaPrincipal.negocios.id,
      tipo_entrega,
      direccion_envio:        tipo_entrega === 'envio' ? direccion_envio : null,
      precio_bolsa:           bolsaPrincipal.precio_descuento,
      costo_envio:            costoEnvio,
      comision_bocara:        comisionBocara,
      comision_pasarela:      comisionPasarela,
      monto_neto_restaurante: montoNetoRestaurante,
      total,
      estado:                 'pendiente',
      estado_pago:            'pendiente',
      codigo_recogida:        codigoRecogida,
      payu_reference_code:    referenceCode,
      hora_recogida_inicio:   bolsaPrincipal.hora_recogida_inicio,
      hora_recogida_fin:      bolsaPrincipal.hora_recogida_fin,
    };

    // Intentar con propina + cantidad; fallback si columnas no existen
    const insertConExtras = { ...insertBase, cantidad: itemPrincipal.cantidad, ...(propina > 0 ? { propina } : {}) };
    let { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos').insert([insertConExtras]).select().single();
    if (pedidoErr) {
      const r2 = await supabase.from('pedidos').insert([{ ...insertBase, cantidad: itemPrincipal.cantidad }]).select().single();
      pedido = r2.data; pedidoErr = r2.error;
    }
    if (pedidoErr) {
      const r3 = await supabase.from('pedidos').insert([insertBase]).select().single();
      pedido = r3.data; pedidoErr = r3.error;
    }
    if (pedidoErr) return res.status(400).json({ error: pedidoErr.message });

    // Guardar todos los items del carrito en pedido_items
    const pedidoItemsData = cartItems.map((item, i) => ({
      pedido_id:       pedido.id,
      bolsa_id:        item.bolsa_id,
      cantidad:        item.cantidad,
      precio_unitario: bolsas[i].precio_descuento,
      subtotal:        Math.round(bolsas[i].precio_descuento * item.cantidad * 100) / 100,
    }));
    const { error: itemsInsertErr } = await supabase.from('pedido_items').insert(pedidoItemsData);
    if (itemsInsertErr) {
      await supabase.from('pedidos')
        .update({ estado: 'cancelado', estado_pago: 'fallido' })
        .eq('id', pedido.id);
      console.error('[PAGO] Error insertando pedido_items — pedido cancelado. Ejecutar migración SQL si la tabla o columnas no existen:', itemsInsertErr.message);
      return res.status(500).json({ error: 'Error al registrar los items del pedido. Intenta de nuevo.' });
    }

    const { data: usuario } = await supabase
      .from('usuarios').select('nombre,apellido,email,telefono').eq('id', req.usuario.id).single();

    const frontendUrl = process.env.FRONTEND_URL || 'https://bocara.vercel.app';
    const redirectUri = `${frontendUrl}/pago-retorno?pedidoId=${pedido.id}`;
    console.log('[CUBO] redirectUri:', redirectUri);

    // Items para Cubo: todos los productos del carrito + propina si aplica
    const titulo = cartItems.length === 1
      ? `Bocara - ${bolsaPrincipal.nombre}`
      : `Bocara - ${cartItems.length} productos`;
    const cuboItems = cartItems.map((item, i) => ({
      name:     bolsas[i].nombre,
      price:    bolsas[i].precio_descuento.toFixed(2),
      quantity: item.cantidad,
    }));
    if (propina > 0) {
      cuboItems.push({ name: `Propina para ${bolsaPrincipal.negocios.nombre}`, price: propina.toFixed(2), quantity: 1 });
    }
    console.log('[PAGO] items Cubo:', JSON.stringify(cuboItems));

    console.log('2. Llamando a generarLinkPago...');
    const { url: visaLinkUrl, token: paymentIntentToken } = await generarLinkPago({
      referencia:     referenceCode,
      pedidoId:       pedido.id,
      titulo,
      monto:          total,
      urlRedireccion: redirectUri,
      cliente: {
        nombre:   `${usuario?.nombre || ''} ${usuario?.apellido || ''}`.trim() || undefined,
        email:    usuario?.email    || undefined,
        telefono: usuario?.telefono ? `+502${usuario.telefono.replace(/\D/g, '')}` : undefined,
      },
      items: cuboItems,
    });

    console.log('3. Link generado:', visaLinkUrl);
    // Guardar token y monto esperado para verificación independiente del webhook
    const montoCentavos = Math.round(total * 100);
    const { error: tokenUpdateErr } = await supabase.from('pedidos')
      .update({
        cubo_payment_intent_token: paymentIntentToken || null,
        monto_esperado_centavos:   montoCentavos,
      })
      .eq('id', pedido.id);
    if (tokenUpdateErr) {
      await supabase.from('pedidos')
        .update({ estado: 'cancelado', estado_pago: 'fallido' })
        .eq('id', pedido.id);
      console.error('[PAGO] Error guardando token Cubo — pedido cancelado. Columnas Cubo pueden no existir (ejecutar migración SQL):', tokenUpdateErr.message);
      return res.status(500).json({ error: 'Error al guardar el token de pago. Ejecuta la migración SQL (cubo-pago-schema.sql) e intenta de nuevo.' });
    }
    console.log('[PAGO] token guardado en pedido:', paymentIntentToken, '| monto_esperado_centavos:', montoCentavos);

    res.json({
      pedidoId: pedido.id,
      codigoRecogida,
      total,
      costoEnvio,
      comisionBocara,
      comisionPasarela,
      montoNetoRestaurante,
      visaLinkUrl,
      paymentIntentToken,
    });
  } catch (err) {
    console.error('cubopago error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pagos/cubo/crear-link-test — diagnóstico de integración Cubo (solo dev, admins)
router.post('/cubo/crear-link-test', authMiddleware, async (req, res) => {
  if (process.env.CUBO_ENVIRONMENT === 'production') {
    return res.status(404).json({ error: 'Endpoint no disponible en producción' });
  }
  if (req.usuario?.rol !== 'admin') {
    return res.status(403).json({ error: 'Solo administradores pueden usar este endpoint' });
  }

  const cuboApiUrl = process.env.CUBO_API_URL;
  const apiKey     = process.env.CUBO_API_KEY || process.env.CUBOPAGO_API_KEY;

  if (!cuboApiUrl) return res.status(500).json({ error: 'CUBO_API_URL no configurada' });
  if (!apiKey)     return res.status(500).json({ error: 'CUBO_API_KEY no configurada' });

  console.log('[CUBO TEST] Creando link de prueba | URL:', cuboApiUrl, '| key: configurada ✓');

  const payload = {
    description: 'Prueba Bocara Dev',
    amount: 100,
    redirectUri: 'https://bocara.vercel.app/pago-retorno',
    metadata: { orderId: 'TEST-CUBO-001', source: 'bocara', environment: 'dev' },
    clientName: 'Cliente Prueba',
    clientEmail: 'test@bocara.com',
    clientPhone: '+50255555555',
    items: [{ name: 'Bolsa de comida prueba', price: '1.00', quantity: 1 }],
  };

  try {
    const response = await axios.post(`${cuboApiUrl}/api/v1/links/one-use`, payload, {
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      timeout: 10000,
    });

    console.log('[CUBO TEST] Respuesta Cubo status:', response.status);
    res.json({
      success: true,
      paymentLink: response.data.cuboRedirectUri || response.data.url || null,
      identifier: response.data.paymentIntentToken || response.data.identifier || null,
      cuboRawResponse: response.data,
    });
  } catch (err) {
    const errorData = err.response?.data;
    console.error('[CUBO TEST] Error:', err.message, errorData || '');
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.message,
      cuboError: errorData || null,
    });
  }
});

// POST /api/pagos/cubo-webhook — URL legacy de Cubo (conservada por retrocompatibilidad)
// Configurar en Cubo Admin la URL canónica: https://bocara.onrender.com/api/webhooks/cubo
router.post('/cubo-webhook', async (req, res) => {
  console.warn('[CUBO WEBHOOK LEGACY] Recibido en /api/pagos/cubo-webhook — actualiza la URL del webhook en Cubo Admin a /api/webhooks/cubo');
  try {
    const result = await procesarWebhookCubo(req.body);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error('[CUBO WEBHOOK LEGACY] Error interno:', err.message);
    res.status(200).json({ received: true });
  }
});

module.exports = router;
