const express = require('express');
const axios = require('axios');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const soloCliente = require('../middleware/soloCliente');
const { generarLinkPago } = require('../services/visaLink');
const { getReservadoPendiente } = require('../services/stock');
const { ESTADOS_SIN_COBRO, puedeTransicionar, validarTransicion } = require('../services/orderStateMachine');
const { procesarWebhookCubo } = require('./webhooks');
const { obtenerComisionFraccion, obtenerConfigNumerica, COMISION_PLATAFORMA_FRACCION } = require('../services/configuracion');
const { normalizeCartItems, validateCheckoutBags } = require('../services/checkoutValidation');
const router = express.Router();

// Números de Guatemala tienen 8 dígitos locales. Algunos registros en `usuarios.telefono`
// ya incluyen el prefijo "502" y otros no — tomar los últimos 8 dígitos normaliza ambos
// casos y evita duplicar el código de país (causaba 422 "invalid phone number" en Cubo).
function formatearTelefonoCubo(telefono) {
  if (!telefono) return undefined;
  const local = telefono.replace(/\D/g, '').slice(-8);
  return local ? `+502${local}` : undefined;
}

// Revierte un pedido recién creado que no llegó a tener link de pago utilizable.
//
// No usa services/stock.liberarInventarioPedido a propósito: ese liberador es
// para cancelaciones de pedidos que pueden tener stock descontado. Aquí el
// pedido nunca pasó de 'borrador'/'pendiente', así que jamás se tocó
// `bolsas.cantidad_disponible` — devolver unidades duplicaría el stock. Basta
// con sacarlo del conjunto que services/stock.js cuenta como reservado.
//
// Las dos cláusulas de guarda son el punto importante: `.in('estado', …)` y
// `.neq('estado_pago', 'pagado')` impiden que un rollback tardío pise un pedido
// que el webhook de Cubo confirmó mientras tanto. Sin ellas, una carrera entre
// este rollback y confirmar_pago_cubo dejaba cancelado un pedido ya cobrado.
async function revertirPedidoSinPago(pedidoId, motivo) {
  // Todos los estados de origen posibles aquí son cancelables; se comprueba
  // contra la máquina para que un cambio futuro en la matriz se note.
  const origenes = ESTADOS_SIN_COBRO.filter((e) => puedeTransicionar(e, 'cancelado'));
  try {
    const { error } = await supabase.from('pedidos')
      .update({ estado: 'cancelado', estado_pago: 'fallido' })
      .eq('id', pedidoId)
      .in('estado', origenes)
      .neq('estado_pago', 'pagado');
    if (error) console.error('[PAGO] rollback de pedido falló —', motivo, ':', error.message);
  } catch (err) {
    console.error('[PAGO] rollback de pedido no disponible —', motivo, ':', err.message);
  }
}

// Comisión y costo de envío se leen de `configuracion` (services/configuracion.js)
// en vez de estar escritos a mano — así coinciden con lo que ve el admin en el
// panel de Configuración y con el resto de endpoints que calculan liquidaciones.
async function getCostoEnvio() {
  return obtenerConfigNumerica('costo_envio_fijo');
}

// PayU fue reemplazado por Cubo. La ruta se conserva únicamente para que una
// versión antigua de la app reciba un error claro; nunca crea pedidos ni pagos.
router.post('/crear-intent', authMiddleware, soloCliente, (_req, res) => {
  res.status(410).json({ error: 'Este método de pago fue retirado. Actualiza la aplicación para pagar con Cubo.' });
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

router.get('/respuesta', (_req, res) => res.status(410).send('Método de pago retirado'));
router.post('/webhook', (_req, res) => res.status(410).json({ received: false, error: 'Webhook retirado' }));

// POST /api/pagos/cubopago — genera link de pago Cubo Pago (Guatemala) y lo devuelve al frontend
router.post('/cubopago', authMiddleware, soloCliente, async (req, res) => {
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

    const normalized = normalizeCartItems(itemsReq, bolsa_id, cantidadReq);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const cartItems = normalized.items;

    // Buscar todas las bolsas en paralelo
    const bolsasResults = await Promise.all(
      cartItems.map(item =>
        supabase.from('bolsas')
          .select('*, negocios(id,nombre,propietario_id,activo,estado_verificacion)')
          .eq('id', item.bolsa_id).single()
      )
    );

    // Verificar que todas las bolsas existan
    const bolsas = [];
    for (let i = 0; i < cartItems.length; i++) {
      const { data: bolsa, error } = bolsasResults[i];
      if (error || !bolsa) return res.status(404).json({ error: `Bolsa ${cartItems[i].bolsa_id} no encontrada` });
      bolsas.push(bolsa);
    }

    const checkoutError = validateCheckoutBags(cartItems, bolsas, tipo_entrega);
    if (checkoutError) return res.status(400).json({ error: checkoutError });
    if (tipo_entrega === 'envio' && !direccion_envio) {
      return res.status(400).json({ error: 'La dirección de envío es requerida' });
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

    // Precio del producto = suma de (precio_unitario × cantidad), SIN propina.
    const subtotalProductos = Math.round(
      cartItems.reduce((sum, item, i) => sum + bolsas[i].precio_descuento * item.cantidad, 0) * 100
    ) / 100;
    // Base de la transacción para el cargo de plataforma: producto + envío + propina.
    // El 3.5% se calcula sobre este monto completo — CON propina incluida — nunca solo
    // sobre el producto. (Nombrar esta variable "subtotal" a secas escondía que ya
    // incluye la propina; de ahí el nombre explícito.)
    const baseTransaccion = subtotalProductos + costoEnvio + propina;

    // Modelo de comisiones de Bocara:
    //   · comisionBocara: 25% del producto (sin propina) → ingreso de Bocara.
    //   · comisionPasarela ("cargo de plataforma"): 3.5% de baseTransaccion (producto +
    //     envío + propina) → 100% ingreso de Bocara, cobrado aparte al cliente (se suma
    //     a `total` abajo). NUNCA debe restarse de montoNetoRestaurante: el cliente ya
    //     lo pagó aparte, así que descontárselo también al restaurante sería cobrarlo
    //     dos veces y ese quetzal no quedaría asignado a nadie.
    //   · El restaurante recibe 75% del producto + el 100% de la propina + el 100% del
    //     costo de envío (no existe un tercer actor — repartidor — en el sistema; si se
    //     agrega uno más adelante, este es el punto a ajustar).
    const comisionFraccion     = await obtenerComisionFraccion();
    const comisionBocara       = Math.round(subtotalProductos * comisionFraccion * 100) / 100;
    const comisionPasarela     = Math.round(baseTransaccion * COMISION_PLATAFORMA_FRACCION * 100) / 100;
    const total                = Math.round((baseTransaccion + comisionPasarela) * 100) / 100;
    const montoNetoRestaurante = Math.round((subtotalProductos - comisionBocara + propina + costoEnvio) * 100) / 100;

    console.log('[PAGO] items recibidos:', JSON.stringify(cartItems));
    console.log('[PAGO] subtotalProductos:', subtotalProductos);
    console.log('[PAGO] comisionPasarela (cargo de plataforma 3.5%, ingreso Bocara):', comisionPasarela);
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
      await revertirPedidoSinPago(pedido.id, 'items del pedido no se pudieron insertar');
      console.error('[PAGO] Error insertando pedido_items — pedido cancelado. Ejecutar migración SQL si la tabla o columnas no existen:', itemsInsertErr.message);
      return res.status(500).json({ error: 'Error al registrar los items del pedido. Intenta de nuevo.' });
    }

    const { data: usuario } = await supabase
      .from('usuarios').select('nombre,apellido,email,telefono').eq('id', req.usuario.id).single();

    const frontendUrl = process.env.FRONTEND_URL || 'https://bocarafood.com';
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
        telefono: formatearTelefonoCubo(usuario?.telefono),
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
      await revertirPedidoSinPago(pedido.id, 'token de Cubo no se pudo guardar');
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
    redirectUri: 'https://bocarafood.com/pago-retorno',
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
    // Antes esta ruta respondía 200 SIEMPRE, descartando el statusCode. Dos
    // consecuencias graves: un payload corrupto se confirmaba como recibido en
    // vez de devolver 400, y —peor— un fallo transitorio (502 con Cubo caído,
    // 503 con la RPC sin desplegar) también salía como 200, así que Cubo daba
    // el webhook por entregado y NO lo reintentaba: el pago quedaba cobrado y
    // el pedido sin confirmar, en silencio. El statusCode se propaga igual que
    // en la ruta canónica.
    const { statusCode = 200, ...data } = result;
    res.status(statusCode).json({ received: true, ...data });
  } catch (err) {
    console.error('[CUBO WEBHOOK LEGACY] Error interno:', err.message);
    res.status(500).json({ received: true, error: 'Error interno' });
  }
});

// POST /api/pagos/preparar — crea pedido en estado 'borrador' sin generar link de pago
router.post('/preparar', authMiddleware, soloCliente, async (req, res) => {
  try {
    const { items: itemsReq, bolsa_id, tipo_entrega, direccion_envio, cantidad: cantidadReq, propina: propinaReq, cupon_id } = req.body;
    const propina = Math.max(0, Math.round((parseFloat(propinaReq) || 0) * 100) / 100);

    if (process.env.CUBO_PAYMENTS_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Pagos temporalmente deshabilitados' });
    }

    const normalized = normalizeCartItems(itemsReq, bolsa_id, cantidadReq);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const cartItems = normalized.items;

    const bolsasResults = await Promise.all(
      cartItems.map(item =>
        supabase.from('bolsas')
          .select('*, negocios(id,nombre,propietario_id,activo,estado_verificacion)')
          .eq('id', item.bolsa_id).single()
      )
    );

    const bolsas = [];
    for (let i = 0; i < cartItems.length; i++) {
      const { data: bolsa, error } = bolsasResults[i];
      if (error || !bolsa) return res.status(404).json({ error: `Bolsa ${cartItems[i].bolsa_id} no encontrada` });
      bolsas.push(bolsa);
    }

    const checkoutError = validateCheckoutBags(cartItems, bolsas, tipo_entrega);
    if (checkoutError) return res.status(400).json({ error: checkoutError });
    if (tipo_entrega === 'envio' && !direccion_envio) {
      return res.status(400).json({ error: 'La dirección de envío es requerida' });
    }

    const { data: viejos } = await supabase
      .from('pedidos')
      .update({ estado: 'cancelado', estado_pago: 'fallido' })
      .eq('usuario_id', req.usuario.id)
      .in('estado', ['borrador', 'pendiente'])
      .eq('estado_pago', 'pendiente')
      .select('id');
    console.log('[PREPARAR] pedidos anteriores cancelados:', viejos?.length ?? 0);
    // Liberar reservas de cupón de borradores cancelados
    // NOTA: .rpc(...) no expone .catch() directamente (solo .then()) — encadenarlo
    // así lanza "‥.catch is not a function" de forma síncrona y tumbaba TODO /preparar
    // (incluso sin cupón de por medio, porque este bloque corre para cualquier usuario
    // con un carrito previo sin terminar). Usar try/catch alrededor del await en su lugar.
    for (const v of (viejos || [])) {
      try {
        await supabase.rpc('liberar_reserva_cupon', { p_pedido_id: v.id });
      } catch (err) {
        console.error('[PREPARAR] liberar_reserva_cupon error:', err.message);
      }
    }

    for (let i = 0; i < cartItems.length; i++) {
      const bolsa = bolsas[i];
      const cantidadSolicitada = cartItems[i].cantidad;
      const reservado = await getReservadoPendiente(bolsa.id);
      const disponibleReal = Math.max(0, bolsa.cantidad_disponible - reservado);
      if (cantidadSolicitada > disponibleReal) {
        return res.status(400).json({
          error: disponibleReal === 0
            ? `"${bolsa.nombre}": Esta bolsa ya no tiene unidades disponibles.`
            : `"${bolsa.nombre}": Solo quedan ${disponibleReal} unidad(es) disponibles.`,
        });
      }
    }

    const costoEnvio = tipo_entrega === 'envio' ? await getCostoEnvio() : 0;
    // Precio del producto, SIN propina.
    const subtotalProductos = Math.round(
      cartItems.reduce((sum, item, i) => sum + bolsas[i].precio_descuento * item.cantidad, 0) * 100
    ) / 100;
    // Base de la transacción para el cargo de plataforma: producto + envío + propina
    // (el 3.5% incluye la propina en su base, nunca solo el producto).
    const baseTransaccion = subtotalProductos + costoEnvio + propina;
    const comisionFraccion = await obtenerComisionFraccion();
    const comisionBocara = Math.round(subtotalProductos * comisionFraccion * 100) / 100;
    const comisionPasarela = Math.round(baseTransaccion * COMISION_PLATAFORMA_FRACCION * 100) / 100;
    // Total sin descuento — se actualiza después de la reserva atómica del cupón
    let total = Math.round((baseTransaccion + comisionPasarela) * 100) / 100;
    // No restar comisionPasarela: es 100% ingreso de Bocara y el cliente ya la paga
    // aparte (incluida en `total`) — restarla aquí también sería cobrarla dos veces.
    // El descuento de cupón (si se aplica después) tampoco se resta aquí: lo absorbe
    // Bocara de su propia comisión, nunca el restaurante — ver aplicar_cupon_borrador.
    // + costoEnvio: 100% al restaurante, igual que la propina (no hay repartidor en
    // el sistema; ajustar este punto si se agrega un tercer actor de reparto).
    const montoNetoRestaurante = Math.round((subtotalProductos - comisionBocara + propina + costoEnvio) * 100) / 100;

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const codigoRecogida = 'BOC-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    const referenceCode = `BOC-${Date.now()}-${req.usuario.id.slice(0, 8)}`;

    const bolsaPrincipal = bolsas[0];
    const itemPrincipal = cartItems[0];

    const insertBase = {
      usuario_id: req.usuario.id,
      bolsa_id: bolsaPrincipal.id,
      negocio_id: bolsaPrincipal.negocios.id,
      tipo_entrega,
      direccion_envio: tipo_entrega === 'envio' ? direccion_envio : null,
      precio_bolsa: bolsaPrincipal.precio_descuento,
      costo_envio: costoEnvio,
      comision_bocara: comisionBocara,
      comision_pasarela: comisionPasarela,
      monto_neto_restaurante: montoNetoRestaurante,
      total,
      estado: 'borrador',
      estado_pago: 'pendiente',
      codigo_recogida: codigoRecogida,
      payu_reference_code: referenceCode,
      hora_recogida_inicio: bolsaPrincipal.hora_recogida_inicio,
      hora_recogida_fin: bolsaPrincipal.hora_recogida_fin,
    };

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

    const pedidoItemsData = cartItems.map((item, i) => ({
      pedido_id: pedido.id,
      bolsa_id: item.bolsa_id,
      cantidad: item.cantidad,
      precio_unitario: bolsas[i].precio_descuento,
      subtotal: Math.round(bolsas[i].precio_descuento * item.cantidad * 100) / 100,
    }));
    const { error: itemsInsertErr } = await supabase.from('pedido_items').insert(pedidoItemsData);
    if (itemsInsertErr) {
      await revertirPedidoSinPago(pedido.id, 'items del pedido no se pudieron insertar');
      return res.status(500).json({ error: 'Error al registrar los items del pedido.' });
    }

    // Reserva atómica del cupón — SOLO aquí, NUNCA antes del pedido, NUNCA desde Node.js directamente
    let descuentoCupon = 0;
    if (cupon_id) {
      const ERRORES_CUPON = {
        cupon_no_encontrado:     'Cupón no válido o expirado',
        cupon_inactivo:          'Este cupón no está disponible',
        cupon_vencido:           'Este cupón ha vencido',
        cupon_exclusivo:         'Este cupón no está disponible para tu cuenta',
        limite_global_alcanzado: 'Este cupón ya alcanzó su límite de usos',
        limite_usuario_alcanzado:'Ya usaste este cupón anteriormente',
      };
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('reservar_cupon', {
        p_cupon_id:     cupon_id,
        p_usuario_id:   req.usuario.id,
        p_pedido_id:    pedido.id,
        p_monto_pedido: total, // total antes de descuento
      });
      if (rpcErr || !rpcRes?.ok) {
        await revertirPedidoSinPago(pedido.id, 'reserva de cupón falló');
        const msg = ERRORES_CUPON[rpcRes?.resultado] || rpcErr?.message || 'Error al aplicar el cupón';
        console.error('[PREPARAR] reservar_cupon fallo:', rpcRes?.resultado || rpcErr?.message);
        return res.status(400).json({ error: msg });
      }
      descuentoCupon = Math.round((parseFloat(String(rpcRes.descuento)) || 0) * 100) / 100;
      const totalConDescuento = Math.round(Math.max(0, total - descuentoCupon) * 100) / 100;
      const { error: updErr } = await supabase.from('pedidos').update({
        total: totalConDescuento,
        descuento_cupon: descuentoCupon,
      }).eq('id', pedido.id);
      if (updErr) {
        await revertirPedidoSinPago(pedido.id, 'descuento de cupón no se pudo aplicar');
        return res.status(500).json({ error: 'Error al aplicar el descuento al pedido' });
      }
      total = totalConDescuento;
      console.log('[PREPARAR] cupón reservado:', cupon_id, '| descuento: Q' + descuentoCupon);
    }

    console.log('[PREPARAR] borrador creado:', pedido.id, '| total:', total, cupon_id ? `| cupón: Q${descuentoCupon}` : '');
    res.json({ pedidoId: pedido.id, codigoRecogida, total, costoEnvio, comisionPasarela, montoNetoRestaurante, descuentoCupon });
  } catch (err) {
    console.error('preparar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pagos/generar-link — genera link CuboPago para un borrador existente (se llama al presionar Pagar)
router.post('/generar-link', authMiddleware, soloCliente, async (req, res) => {
  try {
    const { pedidoId } = req.body;
    if (!pedidoId) return res.status(400).json({ error: 'pedidoId requerido' });

    if (process.env.CUBO_PAYMENTS_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Pagos temporalmente deshabilitados' });
    }

    const apiKeyDisponible = process.env.CUBO_API_KEY
      || (process.env.CUBO_ENVIRONMENT !== 'production' ? process.env.CUBOPAGO_API_KEY : null);
    if (!apiKeyDisponible) {
      return res.status(500).json({ error: 'CUBO_API_KEY no configurada en el servidor' });
    }

    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos')
      .select('*, bolsas(nombre), negocios(nombre)')
      .eq('id', pedidoId)
      .single();

    if (pedidoErr || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'No autorizado' });
    if (pedido.estado !== 'borrador') return res.status(400).json({ error: 'El pedido ya no está en borrador' });

    const { data: usuario } = await supabase
      .from('usuarios').select('nombre,apellido,email,telefono').eq('id', req.usuario.id).single();

    const { data: pedidoItems, error: itemsErr } = await supabase
      .from('pedido_items')
      .select('*, bolsas(id,negocio_id,nombre,activo,estado_aprobacion,precio_descuento,cantidad_disponible,fecha_caducidad,permite_envio,negocios(id,activo,estado_verificacion))')
      .eq('pedido_id', pedidoId);
    if (itemsErr || !pedidoItems?.length) {
      return res.status(400).json({ error: 'El pedido no contiene productos válidos' });
    }

    const items = pedidoItems;
    const checkoutError = validateCheckoutBags(
      items.map(pi => ({ bolsa_id: pi.bolsa_id, cantidad: pi.cantidad })),
      items.map(pi => pi.bolsas),
      pedido.tipo_entrega
    );
    if (checkoutError) return res.status(400).json({ error: checkoutError });

    // Volver a validar reservas justo antes de abrir Cubo. El borrador propio aún
    // no cuenta como reserva, así que `reservado` representa únicamente pedidos
    // de otros clientes que ya llegaron a la pasarela.
    for (const item of items) {
      const reservado = await getReservadoPendiente(item.bolsa_id);
      const disponible = Math.max(0, Number(item.bolsas.cantidad_disponible) - reservado);
      if (Number(item.cantidad) > disponible) {
        return res.status(409).json({
          error: disponible === 0
            ? `"${item.bolsas.nombre}": ya no tiene unidades disponibles.`
            : `"${item.bolsas.nombre}": solo quedan ${disponible} unidad(es) disponibles.`,
        });
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://bocarafood.com';
    const redirectUri = `${frontendUrl}/pago-retorno?pedidoId=${pedido.id}`;

    const tituloStr = items.length === 1
      ? `Bocara - ${items[0].bolsas?.nombre || pedido.bolsas?.nombre || 'pedido'}`
      : `Bocara - ${items.length} productos`;

    const descuentoCupon   = Math.round((parseFloat(pedido.descuento_cupon)   || 0) * 100) / 100;
    const comisionPasarela = Math.round((parseFloat(pedido.comision_pasarela) || 0) * 100) / 100;
    const costoEnvio       = Math.round((parseFloat(pedido.costo_envio)       || 0) * 100) / 100;
    const propina          = Math.round((parseFloat(pedido.propina)           || 0) * 100) / 100;
    const subtotalItems    = Math.round(
      items.reduce((s, pi) => s + parseFloat(pi.precio_unitario) * pi.cantidad, 0) * 100
    ) / 100;

    console.log('[GENERAR LINK] ─── Diagnóstico financiero ───');
    console.log('[GENERAR LINK] pedidoId:', pedido.id);
    console.log('[GENERAR LINK] subtotal items:', subtotalItems);
    console.log('[GENERAR LINK] costo_envio:', costoEnvio);
    console.log('[GENERAR LINK] propina:', propina);
    console.log('[GENERAR LINK] comision_pasarela:', comisionPasarela);
    console.log('[GENERAR LINK] descuento_cupon:', descuentoCupon);
    console.log('[GENERAR LINK] total en DB (GTQ):', pedido.total);
    console.log('[GENERAR LINK] monto a Cubo (centavos):', Math.round(pedido.total * 100));
    console.log('[GENERAR LINK] moneda: GTQ');

    // ── Items para Cubo ──────────────────────────────────────────────────────
    // Cuando hay descuento de cupón, los items a precio original superan el amount final
    // (descuento > comisión → amount < suma_items). Cubo rechazaría la solicitud con 422
    // si valida amount >= sum(items). En ese caso no enviamos items para evitar el error.
    let cuboItems;
    if (descuentoCupon > 0) {
      cuboItems = undefined; // Cubo recibe solo amount; items no son obligatorios
      console.log('[GENERAR LINK] cupón activo: items omitidos para evitar mismatch con amount descontado');
    } else {
      cuboItems = items.map(pi => ({
        name:     pi.bolsas?.nombre || 'Producto',
        price:    parseFloat(pi.precio_unitario).toFixed(2),
        quantity: pi.cantidad,
      }));
      if (costoEnvio > 0) {
        cuboItems.push({ name: 'Costo de envío', price: costoEnvio.toFixed(2), quantity: 1 });
      }
      if (propina > 0) {
        cuboItems.push({ name: `Propina para ${pedido.negocios?.nombre || 'restaurante'}`, price: propina.toFixed(2), quantity: 1 });
      }
    }
    console.log('[GENERAR LINK] items enviados a Cubo:', cuboItems ? JSON.stringify(cuboItems) : 'ninguno (cupón aplicado)');

    const { url: visaLinkUrl, token: paymentIntentToken } = await generarLinkPago({
      referencia: pedido.payu_reference_code,
      pedidoId: pedido.id,
      titulo: tituloStr,
      monto: pedido.total,
      urlRedireccion: redirectUri,
      cliente: {
        nombre: `${usuario?.nombre || ''} ${usuario?.apellido || ''}`.trim() || undefined,
        email: usuario?.email || undefined,
        telefono: formatearTelefonoCubo(usuario?.telefono),
      },
      items: cuboItems,
    });

    // El pedido se leyó como 'borrador' antes de llamar a Cubo, y generarLinkPago
    // es una llamada de red: el barrido de borradores expirados (server.js) pudo
    // cancelarlo en esa ventana. Sin el `.eq('estado', 'borrador')` de abajo,
    // este UPDATE resucitaría a 'pendiente' un pedido ya cancelado.
    const transicion = validarTransicion(pedido.estado, 'pendiente');
    if (!transicion.ok) {
      return res.status(transicion.status).json({
        ok: false, error: transicion.error, codigo: transicion.codigo, detalle: transicion.detalle,
      });
    }

    const montoCentavos = Math.round(pedido.total * 100);
    const { data: persistido, error: tokenPersistErr } = await supabase.from('pedidos').update({
      estado: 'pendiente',
      cubo_payment_intent_token: paymentIntentToken || null,
      monto_esperado_centavos: montoCentavos,
    }).eq('id', pedido.id).eq('estado', 'borrador').select('id').maybeSingle();
    if (tokenPersistErr) {
      console.error('[GENERAR LINK] No se pudo persistir el token de Cubo:', tokenPersistErr.message);
      return res.status(503).json({ error: 'No se pudo asegurar la referencia del pago. Intenta nuevamente.' });
    }
    if (!persistido) {
      // El link quedó creado en Cubo pero el pedido ya no lo admite. No se
      // devuelve la URL: cobrar contra un pedido cancelado es peor que pedir al
      // cliente que reinicie el checkout.
      console.warn('[GENERAR LINK] el pedido dejó de ser borrador mientras se generaba el link:', pedido.id);
      return res.status(409).json({
        ok: false,
        error: 'CONFLICTO_DE_ESTADO',
        detalle: 'El pedido dejó de estar disponible para pago mientras se generaba el link. Vuelve a iniciar el checkout.',
      });
    }

    console.log('[GENERAR LINK] pedido:', pedido.id, '| link generado');
    res.json({ visaLinkUrl, paymentIntentToken });
  } catch (err) {
    console.error('generar-link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pagos/borrador/:id/cupon — aplica o retira cupón en el borrador (atómico)
// Toda la operación ocurre en una única transacción DB vía RPC aplicar_cupon_borrador:
//   1. bloquea el pedido (FOR UPDATE) — serializa concurrentes
//   2. libera reservas activas anteriores
//   3. reserva el nuevo cupón (o solo libera si cupon_id = null)
//   4. recalcula comisionPasarela, total y montoNeto desde pedido_items
//   5. actualiza el mismo registro de pedidos (pedidoId invariante)
router.patch('/borrador/:id/cupon', authMiddleware, async (req, res) => {
  try {
    const { cupon_id } = req.body;

    if (process.env.CUBO_PAYMENTS_ENABLED !== 'true') {
      return res.status(503).json({ error: 'Pagos temporalmente deshabilitados' });
    }

    const { data: rpcRes, error: rpcErr } = await supabase.rpc('aplicar_cupon_borrador', {
      p_pedido_id:  req.params.id,
      p_cupon_id:   cupon_id || null,
      p_usuario_id: req.usuario.id,
    });

    if (rpcErr) {
      console.error('[CUPON PATCH] RPC error:', rpcErr.message);
      return res.status(500).json({ error: rpcErr.message });
    }

    if (!rpcRes?.ok) {
      const ERRORES = {
        pedido_no_encontrado:     { status: 404, msg: 'Pedido no encontrado' },
        no_autorizado:            { status: 403, msg: 'No autorizado' },
        pedido_no_borrador:       { status: 400, msg: 'El pedido ya no está en borrador' },
        cupon_no_encontrado:      { status: 400, msg: 'Cupón no válido o expirado' },
        cupon_inactivo:           { status: 400, msg: 'Este cupón no está disponible' },
        cupon_vencido:            { status: 400, msg: 'Este cupón ha vencido' },
        cupon_exclusivo:          { status: 400, msg: 'Este cupón no está disponible para tu cuenta' },
        limite_global_alcanzado:  { status: 400, msg: 'Este cupón ya alcanzó su límite de usos' },
        limite_usuario_alcanzado: { status: 400, msg: 'Ya usaste este cupón anteriormente' },
        reserva_duplicada:        { status: 409, msg: 'Intento de reserva simultánea — intenta de nuevo' },
      };
      const e = ERRORES[rpcRes?.resultado] || { status: 400, msg: 'Error al procesar el cupón' };
      return res.status(e.status).json({ error: e.msg });
    }

    const { descuentoCupon, comisionPasarela, total, mensaje } = rpcRes;
    console.log('[CUPON PATCH] pedido:', req.params.id, '| descuento: Q' + descuentoCupon, '| total:', total);
    res.json({ pedidoId: req.params.id, descuentoCupon, comisionPasarela, total, mensaje: mensaje || '' });
  } catch (err) {
    console.error('borrador cupon patch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pagos/borrador/:id — actualiza propina en borrador y recalcula totales
router.patch('/borrador/:id', authMiddleware, async (req, res) => {
  try {
    const { propina: propinaReq } = req.body;
    const propina = Math.max(0, Math.round((parseFloat(propinaReq) || 0) * 100) / 100);

    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos').select('*').eq('id', req.params.id).single();

    if (pedidoErr || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedido.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'No autorizado' });
    if (pedido.estado !== 'borrador') return res.status(400).json({ error: 'El pedido ya no está en borrador' });

    const { data: pedidoItems } = await supabase
      .from('pedido_items').select('precio_unitario, cantidad').eq('pedido_id', req.params.id);

    const subtotalProductos = Math.round(
      (pedidoItems || []).reduce((sum, pi) => sum + pi.precio_unitario * pi.cantidad, 0) * 100
    ) / 100;
    // Base del cargo de plataforma: producto + envío + propina (incluye propina, nunca solo el producto).
    const baseTransaccion = subtotalProductos + pedido.costo_envio + propina;
    const comisionPasarela = Math.round(baseTransaccion * COMISION_PLATAFORMA_FRACCION * 100) / 100;
    const descuentoCupon = Math.round((parseFloat(pedido.descuento_cupon) || 0) * 100) / 100;
    const total = Math.round(Math.max(0, baseTransaccion + comisionPasarela - descuentoCupon) * 100) / 100;
    // No restar comisionPasarela ni descuentoCupon: comisionPasarela es 100% ingreso de
    // Bocara ya pagado aparte por el cliente, y el descuento de cupón lo absorbe Bocara
    // de su propia comisión — nunca el restaurante. + costo_envio: 100% al restaurante,
    // igual que la propina.
    const montoNetoRestaurante = Math.round((subtotalProductos - pedido.comision_bocara + propina + pedido.costo_envio) * 100) / 100;

    const { error: updateErr } = await supabase.from('pedidos').update({
      propina, total, comision_pasarela: comisionPasarela, monto_neto_restaurante: montoNetoRestaurante,
    }).eq('id', req.params.id);

    if (updateErr) return res.status(400).json({ error: updateErr.message });

    res.json({ pedidoId: req.params.id, propina, total, comisionPasarela, montoNetoRestaurante });
  } catch (err) {
    console.error('borrador patch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
