require('dotenv').config();
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
app.use(express.json());

app.use('/api/auth',           require('./routes/auth'));
app.use('/api/negocios',       require('./routes/negocios'));
app.use('/api/bolsas',         require('./routes/bolsas'));
app.use('/api/pedidos',        require('./routes/pedidos'));
app.use('/api/pagos',          require('./routes/pagos'));
app.use('/api/envios',         require('./routes/envios'));
app.use('/api/notificaciones', require('./routes/notificaciones'));
app.use('/api/resenas',        require('./routes/resenas'));
app.use('/api/admin',          require('./routes/admin'));

app.get('/', (req, res) => {
  res.json({ status: '✅ Bocara API funcionando', version: '2.0.0', ambiente: process.env.NODE_ENV });
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
  setInterval(enviarRecordatoriosRecogida, 60 * 1000);
  console.log('⏰ Cron de recordatorios de recogida activo');
});

module.exports = app;
