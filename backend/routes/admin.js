const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso solo para administradores' });
  next();
}

// GET /api/admin/stats
router.get('/stats', authMiddleware, adminOnly, async (req, res) => {
  const [usersRes, negociosRes, pedidosRes, bolsasRes] = await Promise.all([
    supabase.from('usuarios').select('id', { count: 'exact', head: true }),
    supabase.from('negocios').select('id,verificado,activo'),
    supabase.from('pedidos').select('total,estado,estado_pago'),
    supabase.from('bolsas').select('co2_salvado_kg'),
  ]);
  const pedidos = pedidosRes.data || [];
  const pagados = pedidos.filter(p => p.estado_pago === 'pagado');
  const ingresos = pagados.reduce((s, p) => s + (p.total || 0), 0);
  const negocios = negociosRes.data || [];
  const comision = ingresos * 0.25;
  res.json({
    total_usuarios: usersRes.count || 0,
    total_negocios: negocios.length,
    negocios_activos: negocios.filter(n => n.activo !== false).length,
    negocios_sin_verificar: negocios.filter(n => !n.verificado).length,
    total_pedidos: pedidos.length,
    pedidos_completados: pedidos.filter(p => p.estado === 'recogido').length,
    ingresos_totales: ingresos,
    comision_generada: comision,
    co2_total: (bolsasRes.data || []).reduce((s, b) => s + (b.co2_salvado_kg || 0), 0),
  });
});

// GET /api/admin/usuarios
router.get('/usuarios', authMiddleware, adminOnly, async (req, res) => {
  const { rol } = req.query;
  let query = supabase
    .from('usuarios')
    .select('id,email,nombre,apellido,rol,telefono,puntos,total_bolsas_salvadas,total_ahorrado,created_at,creado_en')
    .order('created_at', { ascending: false });
  if (rol && rol !== 'todos') query = query.eq('rol', rol);
  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('usuarios').select('id,email,nombre,apellido,rol,telefono,puntos');
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /api/admin/usuarios/:id
router.put('/usuarios/:id', authMiddleware, adminOnly, async (req, res) => {
  const { rol } = req.body;
  if (!rol) return res.status(400).json({ error: 'rol requerido' });
  const { data, error } = await supabase.from('usuarios').update({ rol }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/usuarios/:id/suspender
router.put('/usuarios/:id/suspender', authMiddleware, adminOnly, async (req, res) => {
  const { data: u } = await supabase.from('usuarios').select('rol').eq('id', req.params.id).single();
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.rol === 'admin') return res.status(403).json({ error: 'No se puede suspender a un administrador' });
  const { data, error } = await supabase.from('usuarios').update({ rol: 'suspendido' }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/usuarios/:id/rehabilitar
router.put('/usuarios/:id/rehabilitar', authMiddleware, adminOnly, async (req, res) => {
  const { rol_restaurar } = req.body;
  const rolFinal = rol_restaurar || 'cliente';
  const { data, error } = await supabase.from('usuarios').update({ rol: rolFinal }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/negocios
router.get('/negocios', authMiddleware, adminOnly, async (req, res) => {
  let { data, error } = await supabase
    .from('negocios')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    const r = await supabase.from('negocios').select('id,nombre,categoria,zona,ciudad,telefono,verificado,activo,propietario_id,total_bolsas_vendidas');
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /api/admin/negocios/:id/verificar
router.put('/negocios/:id/verificar', authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('negocios').update({ verificado: true, activo: true }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/negocios/:id/rechazar
router.put('/negocios/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body;
  const updates = { verificado: false, activo: false };
  if (motivo) updates.descripcion_rechazo = motivo;
  const { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /api/admin/negocios/:id/toggle
router.put('/negocios/:id/toggle', authMiddleware, adminOnly, async (req, res) => {
  const { data: negocio } = await supabase.from('negocios').select('activo').eq('id', req.params.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { data, error } = await supabase
    .from('negocios').update({ activo: !negocio.activo }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/financiero — resumen por restaurante
router.get('/financiero', authMiddleware, adminOnly, async (req, res) => {
  const { periodo } = req.query; // '7d' | '30d' | 'todo'
  let query = supabase
    .from('pedidos')
    .select('id,total,estado,estado_pago,negocio_id,created_at,creado_en,negocios(id,nombre,zona)')
    .eq('estado', 'recogido');

  if (periodo === '7d') {
    const desde = new Date(Date.now() - 7 * 86400000).toISOString();
    query = query.gte('created_at', desde);
  } else if (periodo === '30d') {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    query = query.gte('created_at', desde);
  }

  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('pedidos').select('id,total,estado,negocio_id').eq('estado', 'recogido');
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  // Agrupar por negocio
  const map = {};
  for (const p of (data || [])) {
    const nid = p.negocio_id;
    if (!map[nid]) {
      map[nid] = {
        negocio_id: nid,
        nombre: p.negocios?.nombre || 'Sin nombre',
        zona: p.negocios?.zona || '',
        pedidos: 0,
        bruto: 0,
        comision: 0,
        neto: 0,
      };
    }
    map[nid].pedidos += 1;
    map[nid].bruto += p.total || 0;
  }
  const resumen = Object.values(map).map(r => ({
    ...r,
    comision: r.bruto * 0.25,
    neto: r.bruto * 0.75,
  })).sort((a, b) => b.bruto - a.bruto);

  const totalBruto = resumen.reduce((s, r) => s + r.bruto, 0);
  res.json({
    resumen,
    totales: {
      bruto: totalBruto,
      comision: totalBruto * 0.25,
      neto: totalBruto * 0.75,
      pedidos: resumen.reduce((s, r) => s + r.pedidos, 0),
    },
  });
});

// GET /api/admin/pedidos-todos — lista completa de pedidos
router.get('/pedidos-todos', authMiddleware, adminOnly, async (req, res) => {
  const { negocio_id, limite } = req.query;
  let query = supabase
    .from('pedidos')
    .select('id,total,estado,estado_pago,codigo_recogida,created_at,creado_en,negocio_id,usuario_id,negocios(nombre),usuarios(nombre,email)')
    .order('created_at', { ascending: false })
    .limit(parseInt(limite) || 100);
  if (negocio_id) query = query.eq('negocio_id', negocio_id);
  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('pedidos').select('id,total,estado,negocio_id').limit(100);
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/geocodificar-negocios — geocodifica todos los negocios sin coordenadas
router.post('/geocodificar-negocios', authMiddleware, adminOnly, async (req, res) => {
  const { data: negocios, error } = await supabase
    .from('negocios')
    .select('id,nombre,direccion,zona,ciudad')
    .or('latitud.is.null,longitud.is.null');
  if (error) return res.status(500).json({ error: error.message });

  const resultados = { ok: 0, sin_resultado: 0, errores: 0 };
  // Nominatim pide máximo 1 req/seg — procesamos secuencialmente con delay
  for (const n of (negocios || [])) {
    try {
      const coords = await geocodeAddress(n.direccion, n.zona, n.ciudad);
      if (coords) {
        await supabase.from('negocios').update({ latitud: coords.lat, longitud: coords.lng }).eq('id', n.id);
        resultados.ok++;
      } else {
        resultados.sin_resultado++;
      }
      await new Promise(r => setTimeout(r, 1100)); // respetar rate limit de Nominatim
    } catch {
      resultados.errores++;
    }
  }
  res.json({ total: negocios?.length || 0, ...resultados });
});

// GET /api/admin/config
router.get('/config', authMiddleware, adminOnly, async (req, res) => {
  const defaults = {
    comision_porcentaje: 25,
    puntos_por_pedido: 10,
    min_puntos_canje: 100,
    puntos_a_quetzales: 0.10,
    costo_envio_fijo: 25,
    max_bolsas_por_restaurante: 10,
  };
  try {
    const { data, error } = await supabase.from('configuracion').select('clave,valor');
    if (error || !data) return res.json(defaults);
    const config = { ...defaults };
    for (const row of data) {
      const num = parseFloat(row.valor);
      config[row.clave] = isNaN(num) ? row.valor : num;
    }
    res.json(config);
  } catch {
    res.json(defaults);
  }
});

// PUT /api/admin/config
router.put('/config', authMiddleware, adminOnly, async (req, res) => {
  const entradas = Object.entries(req.body).map(([clave, valor]) => ({
    clave, valor: String(valor),
  }));
  try {
    const { error } = await supabase
      .from('configuracion')
      .upsert(entradas, { onConflict: 'clave' });
    if (error) return res.status(400).json({ error: error.message, hint: 'Crea la tabla configuracion: CREATE TABLE configuracion (clave TEXT PRIMARY KEY, valor TEXT);' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
