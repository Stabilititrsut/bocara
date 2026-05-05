const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const router = express.Router();

// GET /api/negocios — listar negocios activos y aprobados
router.get('/', async (req, res) => {
  const { zona, categoria, verificado } = req.query;
  let query = supabase
    .from('negocios')
    .select('*')
    .eq('activo', true)
    // Mostrar solo aprobados (o los que no tienen el campo aún para backwards compat)
    .or('estado_verificacion.eq.aprobado,estado_verificacion.is.null')
    .order('calificacion_promedio', { ascending: false });
  if (zona) query = query.eq('zona', zona);
  if (categoria) query = query.eq('categoria', categoria);
  if (verificado !== undefined) query = query.eq('verificado', verificado === 'true');
  let { data, error } = await query;
  if (error) {
    // Fallback sin estado_verificacion (tabla vieja)
    let q2 = supabase.from('negocios').select('id,nombre,direccion,zona,ciudad,telefono,categoria,latitud,longitud,imagen_url,calificacion_promedio,total_resenas').eq('activo', true).order('nombre');
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
    nit, dpi, datos_bancarios, horario_atencion,
    latitud: latManual, longitud: lngManual } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

  let latitud = latManual ? parseFloat(latManual) : null;
  let longitud = lngManual ? parseFloat(lngManual) : null;
  if (!latitud && direccion) {
    const coords = await geocodeAddress(direccion, zona, ciudad || 'Guatemala');
    if (coords) { latitud = coords.lat; longitud = coords.lng; }
  }

  const insertData = {
    propietario_id: req.usuario.id, nombre, descripcion, direccion,
    zona, ciudad: ciudad || 'Guatemala', telefono, categoria,
    email: email || req.usuario.email,
    latitud, longitud,
    estado_verificacion: req.usuario.rol === 'admin' ? 'aprobado' : 'pendiente',
    activo: req.usuario.rol === 'admin',
  };
  if (nit) insertData.nit = nit;
  if (dpi) insertData.dpi = dpi;
  if (datos_bancarios) insertData.datos_bancarios = datos_bancarios;
  if (horario_atencion) insertData.horario_atencion = horario_atencion;

  const { data, error } = await supabase
    .from('negocios')
    .insert([insertData])
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/negocios/mi-negocio/ganancias
router.get('/mi-negocio/ganancias', authMiddleware, async (req, res) => {
  const { data: negocio } = await supabase
    .from('negocios').select('id,nombre,datos_bancarios').eq('propietario_id', req.usuario.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

  const { periodo = 'mes' } = req.query;
  let desde = new Date();
  if (periodo === 'dia')    desde = new Date(Date.now() - 86400000);
  else if (periodo === 'semana') desde = new Date(Date.now() - 7 * 86400000);
  else                     desde = new Date(Date.now() - 30 * 86400000);

  const { data: pedidos } = await supabase
    .from('pedidos')
    .select('id,total,precio_bolsa,comision_bocara,monto_neto_restaurante,estado,created_at')
    .eq('negocio_id', negocio.id)
    .eq('estado', 'recogido')
    .gte('created_at', desde.toISOString());

  const ventas = pedidos || [];
  const bruto = ventas.reduce((s, p) => s + (p.precio_bolsa || p.total || 0), 0);
  const comision = bruto * 0.25;
  const neto = bruto * 0.75;

  // Liquidaciones históricas
  const { data: liquidaciones } = await supabase
    .from('liquidaciones')
    .select('*')
    .eq('negocio_id', negocio.id)
    .order('created_at', { ascending: false })
    .limit(20);

  res.json({
    periodo,
    negocio: { id: negocio.id, nombre: negocio.nombre, datos_bancarios: negocio.datos_bancarios },
    resumen: {
      total_pedidos: ventas.length,
      ventas_brutas: parseFloat(bruto.toFixed(2)),
      comision_bocara: parseFloat(comision.toFixed(2)),
      neto_restaurante: parseFloat(neto.toFixed(2)),
    },
    liquidaciones: liquidaciones || [],
  });
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
