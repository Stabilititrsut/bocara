const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const router = express.Router();

// GET /api/negocios — listar negocios activos
router.get('/', async (req, res) => {
  const { zona, categoria, verificado } = req.query;
  let query = supabase
    .from('negocios')
    .select('*')
    .eq('activo', true)
    .order('calificacion_promedio', { ascending: false });
  if (zona) query = query.eq('zona', zona);
  if (categoria) query = query.eq('categoria', categoria);
  if (verificado !== undefined) query = query.eq('verificado', verificado === 'true');
  let { data, error } = await query;
  if (error) {
    let q2 = supabase.from('negocios').select('id,nombre,direccion,zona,ciudad,telefono,categoria,latitud,longitud').order('nombre');
    if (zona) q2 = q2.eq('zona', zona);
    if (categoria) q2 = q2.eq('categoria', categoria);
    const r = await q2;
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/negocios/mi-negocio
router.get('/mi-negocio', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('negocios')
    .select('*')
    .eq('propietario_id', req.usuario.id)
    .single();
  if (error) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(data);
});

// GET /api/negocios/:id — detalle con bolsas
router.get('/:id', async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error || !negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { data: bolsas } = await supabase
    .from('bolsas')
    .select('*')
    .eq('negocio_id', req.params.id)
    .eq('activo', true)
    .gt('cantidad_disponible', 0);
  res.json({ ...negocio, bolsas: bolsas || [] });
});

// POST /api/negocios — crear negocio con geocodificación
router.post('/', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const { nombre, descripcion, direccion, zona, ciudad, telefono, categoria, email,
    latitud: latManual, longitud: lngManual } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

  // Geocodificar dirección (no bloquea la respuesta si falla)
  let latitud = latManual ? parseFloat(latManual) : null;
  let longitud = lngManual ? parseFloat(lngManual) : null;
  if (!latitud && direccion) {
    const coords = await geocodeAddress(direccion, zona, ciudad || 'Guatemala');
    if (coords) { latitud = coords.lat; longitud = coords.lng; }
  }

  const { data, error } = await supabase
    .from('negocios')
    .insert([{
      propietario_id: req.usuario.id, nombre, descripcion, direccion,
      zona, ciudad: ciudad || 'Guatemala', telefono, categoria,
      email: email || req.usuario.email,
      latitud, longitud,
    }])
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/negocios/:id — actualizar negocio con re-geocodificación si cambia dirección
router.put('/:id', authMiddleware, async (req, res) => {
  const { data: negocio } = await supabase.from('negocios').select('propietario_id,direccion,zona,ciudad,latitud,longitud').eq('id', req.params.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (negocio.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const { nombre, descripcion, direccion, zona, ciudad, telefono, categoria, activo,
    latitud: latManual, longitud: lngManual } = req.body;
  const updates = {};
  if (nombre !== undefined)      updates.nombre = nombre;
  if (descripcion !== undefined) updates.descripcion = descripcion;
  if (direccion !== undefined)   updates.direccion = direccion;
  if (zona !== undefined)        updates.zona = zona;
  if (ciudad !== undefined)      updates.ciudad = ciudad;
  if (telefono !== undefined)    updates.telefono = telefono;
  if (categoria !== undefined)   updates.categoria = categoria;
  if (activo !== undefined)      updates.activo = activo;

  // Coordenadas manuales tienen prioridad
  if (latManual != null) updates.latitud  = parseFloat(latManual);
  if (lngManual != null) updates.longitud = parseFloat(lngManual);

  // Re-geocodificar si cambió la dirección y no hay coords manuales
  const dirCambiada = direccion !== undefined && direccion !== negocio.direccion;
  const sinCoordsManuales = latManual == null && lngManual == null;
  const sinCoordsExistentes = !negocio.latitud && !negocio.longitud;
  if ((dirCambiada || sinCoordsExistentes) && sinCoordsManuales) {
    const newDir = direccion || negocio.direccion;
    const newZona = zona || negocio.zona;
    const newCiudad = ciudad || negocio.ciudad;
    const coords = await geocodeAddress(newDir, newZona, newCiudad);
    if (coords) { updates.latitud = coords.lat; updates.longitud = coords.lng; }
  }

  const { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/negocios/:id/estadisticas
router.get('/:id/estadisticas', authMiddleware, async (req, res) => {
  let { data: pedidos } = await supabase
    .from('pedidos')
    .select('total, estado, created_at')
    .eq('negocio_id', req.params.id)
    .eq('estado_pago', 'pagado');
  if (!pedidos) {
    const r = await supabase.from('pedidos').select('total, estado, created_at').eq('negocio_id', req.params.id);
    pedidos = r.data;
  }
  const totalVentas = (pedidos || []).reduce((s, p) => s + (p.total || 0), 0);
  res.json({
    total_pedidos: (pedidos || []).length,
    total_ventas: totalVentas,
    pedidos_hoy: (pedidos || []).filter(p => {
      const d = p.created_at || p.creado_en;
      return d && new Date(d).toDateString() === new Date().toDateString();
    }).length,
  });
});

module.exports = router;
