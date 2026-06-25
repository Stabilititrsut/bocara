const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// POST /api/cupones/validar
router.post('/validar', authMiddleware, async (req, res) => {
  try {
    const { codigo, monto_total } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Código requerido' });

    const { data: cupon } = await supabase
      .from('cupones')
      .select('*')
      .eq('codigo', codigo.toUpperCase().trim())
      .eq('activo', true)
      .maybeSingle();

    if (!cupon) return res.status(404).json({ error: 'Cupón no válido o expirado' });

    if (cupon.fecha_vencimiento && new Date(cupon.fecha_vencimiento) < new Date())
      return res.status(400).json({ error: 'Este cupón ha vencido' });

    // Límite global: usos_actuales refleja consumos confirmados (webhook). Es una pre-verificación
    // aproximada; la reserva atómica en reservar_cupon hace el chequeo definitivo.
    if (cupon.usos_actuales >= cupon.uso_maximo)
      return res.status(400).json({ error: 'Este cupón ya alcanzó su límite de usos' });

    // Cupón exclusivo para otro usuario
    if (cupon.usuario_id_exclusivo && cupon.usuario_id_exclusivo !== req.usuario.id)
      return res.status(400).json({ error: 'Este cupón no está disponible para tu cuenta' });

    // Límite por usuario: contar usos confirmados
    const { count: usosConfirmados } = await supabase
      .from('cupon_usos')
      .select('*', { count: 'exact', head: true })
      .eq('cupon_id', cupon.id)
      .eq('usuario_id', req.usuario.id);

    if ((usosConfirmados || 0) >= cupon.uso_por_usuario)
      return res.status(400).json({ error: 'Ya usaste este cupón anteriormente' });

    const montoBase = Math.max(0, parseFloat(monto_total) || 0);
    let descuento = cupon.tipo === 'porcentaje'
      ? (montoBase * cupon.valor) / 100
      : cupon.valor;
    descuento = Math.min(descuento, montoBase);
    descuento = Math.round(descuento * 100) / 100;

    res.json({
      valido: true,
      cupon_id: cupon.id,
      codigo: cupon.codigo,
      tipo: cupon.tipo,
      valor: cupon.valor,
      descuento_aplicado: descuento,
      mensaje: cupon.tipo === 'porcentaje'
        ? `${cupon.valor}% de descuento — ahorras Q${descuento.toFixed(2)}`
        : `Descuento de Q${cupon.valor.toFixed(2)} aplicado`,
    });
  } catch (err) {
    console.error('validar cupon error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cupones/mis-cupones
router.get('/mis-cupones', authMiddleware, async (req, res) => {
  try {
    // Cupones ya consumidos (pago confirmado) y activamente reservados por el usuario
    const [{ data: consumidos }, { data: reservados }] = await Promise.all([
      supabase.from('cupon_usos').select('cupon_id').eq('usuario_id', req.usuario.id),
      supabase.from('cupon_reservas').select('cupon_id')
        .eq('usuario_id', req.usuario.id)
        .eq('estado', 'activa')
        .gt('expires_at', new Date().toISOString()),
    ]);

    const idsNoDisponibles = [
      ...new Set([
        ...(consumidos || []).map(u => u.cupon_id),
        ...(reservados || []).map(r => r.cupon_id),
      ]),
    ];

    let query = supabase.from('cupones').select('*').eq('activo', true)
      .or(`usuario_id_exclusivo.is.null,usuario_id_exclusivo.eq.${req.usuario.id}`);
    if (idsNoDisponibles.length > 0) {
      query = query.not('id', 'in', `(${idsNoDisponibles.join(',')})`);
    }

    const { data: cupones } = await query;
    res.json(cupones || []);
  } catch (err) {
    console.error('mis-cupones error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cupones/mi-referido
router.get('/mi-referido', authMiddleware, async (req, res) => {
  try {
    const { data: usuario } = await supabase
      .from('usuarios')
      .select('codigo_referido, credito_referido')
      .eq('id', req.usuario.id)
      .single();

    const frontendUrl = process.env.FRONTEND_URL || 'https://bocara.vercel.app';
    const codigo = usuario?.codigo_referido || null;
    res.json({
      codigo,
      credito: parseFloat((usuario?.credito_referido || 0).toFixed(2)),
      link_compartir: codigo ? `${frontendUrl}/registro?ref=${codigo}` : null,
    });
  } catch (err) {
    console.error('mi-referido error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
