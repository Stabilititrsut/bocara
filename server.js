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
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const supabase = require('./config/supabase');
const { enviarNotificacionPush, guardarNotificacion } = require('./services/notificaciones');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

const ALLOWED_ORIGINS = [
  'https://bocara.vercel.app',
  'https://app.bocarafood.com',
  'https://bocarafood.com',
  'https://www.bocarafood.com',
  // desarrollo local
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
  'http://localhost:19000',
];

app.use(cors({
  origin: (origin, callback) => {
    // permitir requests sin origen (apps móviles nativas, Postman, curl)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origen no permitido → ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

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

app.get('/', (req, res) => {
  res.json({ status: '✅ Bocara API funcionando', version: '2.0.2', ambiente: process.env.NODE_ENV });
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

// ── Recordatorios de recogida (corre cada minuto) ────────────────────────────
// Busca pedidos confirmados cuyo horario de recogida empieza en ~30 minutos
const recordatoriosEnviados = new Set();

async function enviarRecordatoriosRecogida() {
  try {
    const ahora = new Date();
    const en30 = new Date(ahora.getTime() + 30 * 60 * 1000);
    const en28 = new Date(ahora.getTime() + 28 * 60 * 1000);

    const pad = (n) => String(n).padStart(2, '0');
    const timeDesde = `${pad(en28.getHours())}:${pad(en28.getMinutes())}:00`;
    const timeHasta = `${pad(en30.getHours())}:${pad(en30.getMinutes())}:59`;

    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('id,codigo_recogida,hora_recogida_inicio,usuario_id,usuarios(expo_push_token)')
      .eq('estado', 'confirmado')
      .eq('estado_pago', 'pagado')
      .eq('tipo_entrega', 'recogida')
      .gte('hora_recogida_inicio', timeDesde)
      .lte('hora_recogida_inicio', timeHasta);

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

  setInterval(async () => {
    try {
      const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('pedidos')
        .update({ estado: 'cancelado', estado_pago: 'fallido' })
        .eq('estado', 'borrador')
        .lt('created_at', hace2h)
        .select('id');
      if (data?.length) console.log('[CLEANUP] borradores expirados cancelados:', data.length);
    } catch (err) {
      console.error('[CLEANUP] error limpiando borradores:', err.message);
    }
  }, 60 * 60 * 1000);
  console.log('⏰ Cron de limpieza de borradores activo (cada hora)');
});

module.exports = app;
