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

    if (cupon.usos_actuales >= cupon.uso_maximo)
      return res.status(400).json({ error: 'Este cupón ya alcanzó su límite de usos' });

    const { data: usoExistente } = await supabase
      .from('cupones_usuarios')
      .select('id')
      .eq('cupon_id', cupon.id)
      .eq('usuario_id', req.usuario.id)
      .maybeSingle();

    if (usoExistente) return res.status(400).json({ error: 'Ya usaste este cupón anteriormente' });

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
    const { data: usados } = await supabase
      .from('cupones_usuarios')
      .select('cupon_id')
      .eq('usuario_id', req.usuario.id);

    const idsUsados = (usados || []).map(u => u.cupon_id);

    let query = supabase.from('cupones').select('*').eq('activo', true);
    if (idsUsados.length > 0) {
      query = query.not('id', 'in', `(${idsUsados.join(',')})`);
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
