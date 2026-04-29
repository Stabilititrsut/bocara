const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso solo para administradores' });
  next();
}

// GET /api/admin/stats — estadísticas generales
router.get('/stats', authMiddleware, adminOnly, async (req, res) => {
  const [usersRes, negociosRes, pedidosRes, bolsasRes] = await Promise.all([
    supabase.from('usuarios').select('id', { count: 'exact', head: true }),
    supabase.from('negocios').select('id,verificado', { count: 'exact' }),
    supabase.from('pedidos').select('total,estado_pago').eq('estado_pago', 'pagado'),
    supabase.from('bolsas').select('co2_salvado_kg').eq('activo', true),
  ]);
  const ingresos = (pedidosRes.data || []).reduce((s, p) => s + (p.total || 0), 0);
  const negociosSinVerificar = (negociosRes.data || []).filter(n => !n.verificado).length;
  const co2Total = (bolsasRes.data || []).reduce((s, b) => s + (b.co2_salvado_kg || 0), 0);
  res.json({
    total_usuarios: usersRes.count || 0,
    total_negocios: negociosRes.count || 0,
    negocios_sin_verificar: negociosSinVerificar,
    total_pedidos: (pedidosRes.data || []).length,
    ingresos_totales: ingresos,
    total_bolsas_vendidas: (pedidosRes.data || []).length,
    co2_total: co2Total,
  });
});

// GET /api/admin/usuarios
router.get('/usuarios', authMiddleware, adminOnly, async (req, res) => {
  const { rol } = req.query;
  let query = supabase
    .from('usuarios')
    .select('id,email,nombre,apellido,rol,telefono,puntos,total_bolsas_salvadas,total_ahorrado,created_at')
    .order('created_at', { ascending: false });
  if (rol) query = query.eq('rol', rol);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /api/admin/usuarios/:id
router.put('/usuarios/:id', authMiddleware, adminOnly, async (req, res) => {
  const { rol } = req.body;
  const updates = {};
  if (rol) updates.rol = rol;
  const { data, error } = await supabase.from('usuarios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/negocios
router.get('/negocios', authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('negocios')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /api/admin/negocios/:id/verificar
router.put('/negocios/:id/verificar', authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('negocios').update({ verificado: true }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/negocios/:id/toggle — activar/desactivar
router.put('/negocios/:id/toggle', authMiddleware, adminOnly, async (req, res) => {
  const { data: negocio } = await supabase.from('negocios').select('activo').eq('id', req.params.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { data, error } = await supabase
    .from('negocios').update({ activo: !negocio.activo }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
