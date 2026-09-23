require('dotenv').config();

// Diagnóstico seguro: presencia de variables, nunca valores
console.log('[CUBO ENV CHECK]', {
  commit:            process.env.RENDER_GIT_COMMIT || 'local',
  cuboApiKeyPresent: Boolean(process.env.CUBO_API_KEY),
  cuboApiUrlPresent: Boolean(process.env.CUBO_API_URL),
  cuboEnvironment:   process.env.CUBO_ENVIRONMENT || null,
  cuboCurrency:      process.env.CUBO_CURRENCY    || '⚠ NO CONFIGURADA',
  cuboVariableNames: Object.keys(process.env).filter(k => k.includes('CUBO')).sort(),
});

// Validación de arranque para Cubo Pago en producción
if (process.env.CUBO_ENVIRONMENT === 'production') {
  if (!process.env.CUBO_API_URL) {
    console.error('❌ CUBO_API_URL no configurada en producción. Configúrala en Render Dashboard.');
    process.exit(1);
  }
  if (!process.env.CUBO_API_KEY) {
    console.error('❌ CUBO_API_KEY no configurada en producción. Configúrala en Render Dashboard.');
    process.exit(1);
  }
  if (!process.env.CUBO_CURRENCY) {
    console.error('❌ CUBO_CURRENCY no configurada en producción. Configurar como GTQ en Render Dashboard.');
    process.exit(1);
  }
  if (process.env.CUBO_CURRENCY !== 'GTQ') {
    console.error(`❌ CUBO_CURRENCY="${process.env.CUBO_CURRENCY}" — debe ser "GTQ" (quetzales, confirmado por Cubo). Verificar en Render Dashboard.`);
    process.exit(1);
  }
  if (/sandbox/i.test(process.env.CUBO_API_URL)) {
    console.error('❌ CUBO_API_URL apunta a sandbox en producción:', process.env.CUBO_API_URL);
    process.exit(1);
  }
  // Verificación de webhook implementada en routes/webhooks.js:
  //   1. GET /api/v1/transactions/:token  (consulta independiente a Cubo antes de cualquier escritura)
  //   2. Valida: status=SUCCEEDED, token, currency=GTQ, monto en centavos vs monto_esperado_centavos
  //   3. RPC confirmar_pago_cubo: bloqueo FOR UPDATE + revalidación atómica de token, monto e inventario
  console.log('[CUBO PROD] Verificación de webhook activa: consulta independiente GET /api/v1/transactions/:token + validación de token, moneda GTQ y monto server-side.');
}

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const supabase = require('./config/supabase');
const { corsMiddleware } = require('./middleware/cors');
const { enviarNotificacionPush, guardarNotificacion } = require('./services/notificaciones');
const { procesarEventosFallidos } = require('./services/pagoEventos');
const { RESERVA_TTL_MINUTOS } = require('./services/stock');
const { enqueueEventBestEffort } = require('./services/eventosDominio');
const { resolverRequestId } = require('./utils/requestId');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

// Orígenes permitidos y reglas de preflight: middleware/cors.js
app.use(corsMiddleware());

// Se expone en el header de respuesta y se agrega a los logs y al error 500
// genérico de abajo — nunca a las respuestas 2xx/4xx explícitas de cada ruta,
// para no tocar un contrato que el frontend ya consume. Validación en
// utils/requestId.js (ver test/requestId.test.js).
app.use((req, res, next) => {
  req.requestId = resolverRequestId(req.headers['x-request-id']);
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

morgan.token('request_id', (req) => req.requestId);
app.use(morgan(
  process.env.NODE_ENV === 'production'
    ? ':remote-addr - [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] request_id=:request_id'
    : ':method :url :status :response-time ms request_id=:request_id',
));

// PayU webhook envía application/x-www-form-urlencoded
app.use('/api/pagos/webhook', express.urlencoded({ extended: false }));
app.use(express.json({ limit: '15mb' }));
app.use('/api/webhooks',      require('./routes/webhooks'));

app.use('/api/auth',           require('./routes/auth'));
app.use('/api/negocios',       require('./routes/negocios'));
app.use('/api/bolsas',         require('./routes/bolsas'));
app.use('/api/pedidos',        require('./routes/pedidos'));
app.use('/api/pagos',          require('./routes/pagos'));
app.use('/api/envios',         require('./routes/envios'));
app.use('/api/notificaciones', require('./routes/notificaciones'));
app.use('/api/resenas',        require('./routes/resenas'));
app.use('/api/admin',          require('./routes/admin'));
app.use('/api/favoritos',      require('./routes/favoritos'));
app.use('/api/uploads',        require('./routes/uploads'));
app.use('/api/cupones',        require('./routes/cupones'));

app.get('/', (req, res) => {
  res.json({ status: '✅ Bocara API funcionando', version: '2.0.2', ambiente: process.env.NODE_ENV });
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message, '| request_id:', req.requestId, '| ruta:', req.method, req.originalUrl);
  // Aditivo: agrega code/request_id sin quitar `error`, que es lo único que
  // las rutas explícitas garantizan hoy. Este handler solo corre para
  // excepciones no capturadas por una ruta — nunca para un res.status(...)
  // ya enviado desde dentro de un router.
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
    code: err.code || 'ERROR_INTERNO',
    request_id: req.requestId,
  });
});

// ── Recordatorios de recogida (corre cada minuto) ────────────────────────────
// Busca pedidos confirmados cuyo horario de recogida empieza en ~30 minutos
const recordatoriosEnviados = new Set();

async function enviarRecordatoriosRecogida() {
  try {
    const ahora = new Date();
    const en30 = new Date(ahora.getTime() + 30 * 60 * 1000);
    const en28 = new Date(ahora.getTime() + 28 * 60 * 1000);

    const horaGuatemala = (fecha, segundos) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(fecha);
      const get = type => parts.find(p => p.type === type)?.value || '00';
      return `${get('hour')}:${get('minute')}:${segundos}`;
    };
    const timeDesde = horaGuatemala(en28, '00');
    const timeHasta = horaGuatemala(en30, '59');

    let query = supabase
      .from('pedidos')
      .select('id,codigo_recogida,hora_recogida_inicio,hora_recogida_fin,usuario_id,usuarios(expo_push_token)')
      .eq('estado', 'confirmado')
      .eq('estado_pago', 'pagado')
      .eq('tipo_entrega', 'recogida');
    query = timeDesde <= timeHasta
      ? query.gte('hora_recogida_inicio', timeDesde).lte('hora_recogida_inicio', timeHasta)
      : query.or(`hora_recogida_inicio.gte.${timeDesde},hora_recogida_inicio.lte.${timeHasta}`);
    const { data: pedidos } = await query;

    for (const p of (pedidos || [])) {
      if (recordatoriosEnviados.has(p.id)) continue;
      recordatoriosEnviados.add(p.id);

      const token = p.usuarios?.expo_push_token;
      const msg = `Pasa a recoger tu bolsa de ${p.hora_recogida_inicio} a ${p.hora_recogida_fin || '...'}. Código: ${p.codigo_recogida}`;
      await enviarNotificacionPush(token, '⏰ ¡Tu bolsa te espera!', msg, { pedidoId: p.id, screen: 'pedidos' });
      await guardarNotificacion(supabase, p.usuario_id, 'recordatorio_recogida', '⏰ ¡Tu bolsa te espera!', msg, { pedidoId: p.id });
    }
  } catch (err) {
    console.error('Cron recordatorio error:', err.message);
  }
}

if (!process.env.CUPONES_MIGRADO) {
  console.warn(`
[BOCARA — MIGRACIÓN CUPONES PENDIENTE]
Ejecutar el archivo de migración en Supabase Dashboard → SQL Editor:
  supabase/migrations/202406241200_cupones_referidos.sql

Luego agregar CUPONES_MIGRADO=true en las variables de entorno para silenciar este aviso.
NO habilitar pagos con cupones hasta ejecutar la migración.
`);
}

app.listen(PORT, () => {
  console.log(`🚀 Bocara API corriendo en puerto ${PORT}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV}`);

  const _cuboUrl     = process.env.CUBO_API_URL || '';
  const _cuboKey     = process.env.CUBO_API_KEY || process.env.CUBOPAGO_API_KEY || '';
  console.log('[CUBO STATUS]');
  console.log(`ambiente=${process.env.CUBO_ENVIRONMENT || 'no_configurado'}`);
  console.log(`pagos_habilitados=${process.env.CUBO_PAYMENTS_ENABLED === 'true'}`);
  console.log(`api_url_produccion=${_cuboUrl === 'https://api-payment-a.cubopago.com'}`);
  console.log(`api_key_configurada=${_cuboKey.length > 0}`);

  console.log('[ADMIN] Ruta disponible: GET /api/admin/cubo-status');
  setInterval(enviarRecordatoriosRecogida, 60 * 1000);
  console.log('⏰ Cron de recordatorios de recogida activo');

  // Los eventos viven en PostgreSQL; este proceso reintenta notificaciones y
  // puntos que hayan fallado tras confirmar un pago. La operación es idempotente.
  setInterval(() => procesarEventosFallidos(20), 60 * 1000);
  setTimeout(() => procesarEventosFallidos(20), 5 * 1000);
  console.log('🔁 Reintentos post-pago activos (cada minuto)');

  setInterval(async () => {
    try {
      const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('pedidos')
        .update({ estado: 'cancelado', estado_pago: 'fallido' })
        .eq('estado', 'borrador')
        .lt('created_at', hace2h)
        .select('id');
      if (data?.length) {
        console.log('[CLEANUP] borradores expirados cancelados:', data.length);
        // Liberar reservas de cupón de borradores expirados
        // NOTA: .rpc(...) no expone .catch() directamente (solo .then()) — encadenarlo
        // así lanzaba sincrónicamente en el primer pedido del lote y abortaba el resto
        // del for (capturado por el catch de afuera), dejando sin liberar la reserva de
        // cupón de todos los pedidos siguientes del batch. try/catch por iteración evita eso.
        for (const d of data) {
          try {
            await supabase.rpc('liberar_reserva_cupon', { p_pedido_id: d.id });
          } catch (err) {
            console.error('[CLEANUP] liberar_reserva_cupon error:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('[CLEANUP] error limpiando borradores:', err.message);
    }
  }, 60 * 60 * 1000);
  console.log('⏰ Cron de limpieza de borradores activo (cada hora)');

  // Reservas zombis: pedidos que se quedaron en 'pendiente' porque el cliente
  // abrió el link de Cubo y nunca volvió.
  //
  // El stock YA está liberado sin necesidad de este barrido: la disponibilidad
  // real ignora toda reserva de más de RESERVA_TTL_MINUTOS (services/stock.js),
  // así que la unidad vuelve al feed en el minuto 15 aunque el cron no corra.
  // Lo que este barrido cierra es el ESTADO del pedido.
  //
  // ── Por qué el margen ya no es de 2 horas (AC-03) ──────────────────────────
  //
  // Antes se esperaban 120 minutos para no romper al cliente que pagaba tarde:
  // con la fila en 'cancelado' su webhook devolvía 409 con el dinero cobrado.
  // El efecto secundario era peor que el problema que evitaba — el pedido
  // quedaba pagable durante dos horas sobre un stock que ya se había devuelto
  // al catálogo a los 15 minutos, así que pagarlo tarde era exactamente la
  // sobreventa que AC-03 prohíbe.
  //
  // Ahora el plazo es el mismo TTL de la reserva, y el pago tardío se ataja
  // antes de cobrarse: el link de Cubo caduca a los 15 minutos
  // (services/visaLink.js) y, si aun así llega un SUCCEEDED tarde, el webhook
  // lo rechaza sin confirmar nada y lo registra para reembolso manual
  // (services/cuboWebhook.js + confirmar_pago_cubo v6). Cerrar la fila al
  // vencer deja de ser un riesgo y pasa a ser parte de la garantía: ningún
  // pedido se queda en un limbo pagable.
  //
  // Cada 5 minutos en vez de cada 30: el cierre tiene que ir pegado al TTL para
  // que la ventana de limbo sea de minutos, no de media hora.
  const cerrarReservasVencidas = async () => {
    try {
      const { data, error } = await supabase.rpc('expirar_reservas_vencidas', {
        p_ttl_minutos: RESERVA_TTL_MINUTOS,
        p_limite: 500,
      });
      if (error) {
        console.error('[CLEANUP] expirar_reservas_vencidas — ejecutar migración 202609121200:', error.message);
        return;
      }
      if (!data?.expirados) return;
      console.log('[CLEANUP] reservas vencidas cerradas:', data.expirados, `(TTL ${RESERVA_TTL_MINUTOS} min)`);

      // Un pedido cancelado no debe seguir reteniendo la reserva de su cupón.
      // try/catch por iteración: .rpc(...) lanza de forma síncrona si algo va
      // mal y un fallo no puede abortar el resto del lote.
      for (const id of (data.pedido_ids || [])) {
        try {
          await supabase.rpc('liberar_reserva_cupon', { p_pedido_id: id });
        } catch (err) {
          console.error('[CLEANUP] liberar_reserva_cupon error:', err.message);
        }
        enqueueEventBestEffort({
          eventType: 'reserva.expirada', aggregateType: 'pedido', aggregateId: id,
          payload: { ttl_minutos: RESERVA_TTL_MINUTOS },
        });
      }
    } catch (err) {
      console.error('[CLEANUP] error cerrando reservas vencidas:', err.message);
    }
  };
  setInterval(cerrarReservasVencidas, 5 * 60 * 1000);
  setTimeout(cerrarReservasVencidas, 10 * 1000);
  console.log(`⏰ Cron de cierre de reservas vencidas activo (cada 5 min, TTL ${RESERVA_TTL_MINUTOS} min)`);

  // Las publicaciones se conservan aunque estén ocultas o rechazadas. Nunca se
  // borran automáticamente: `activo=false` funciona como archivo recuperable.
  console.log('🗃️ Conservación de publicaciones activa (sin borrado automático)');
});

module.exports = app;
