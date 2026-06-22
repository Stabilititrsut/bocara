const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const { guardarNotificacion } = require('../services/notificaciones');
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

// GET /api/negocios/feed — negocios activos con ≥1 bolsa aprobada + stats de descuento
router.get('/feed', async (req, res) => {
  const { zona, categoria } = req.query;
  let { data: bolsas, error } = await supabase
    .from('bolsas')
    .select('negocio_id, precio_original, precio_descuento, negocios(id,nombre,zona,descripcion,categoria,imagen_url,calificacion_promedio)')
    .eq('activo', true)
    .gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  if (error) {
    const r = await supabase
      .from('bolsas')
      .select('negocio_id, precio_original, precio_descuento, negocios(id,nombre,zona,descripcion,categoria,imagen_url,calificacion_promedio)')
      .eq('activo', true)
      .gt('cantidad_disponible', 0);
    bolsas = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  const map = new Map();
  for (const b of (bolsas || [])) {
    const n = b.negocios;
    if (!n) continue;
    if (zona && String(n.zona) !== String(zona)) continue;
    if (categoria && n.categoria !== categoria) continue;
    const disc = b.precio_original > 0
      ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;
    if (!map.has(n.id)) map.set(n.id, { ...n, cantidad_bolsas: 0, max_descuento: 0 });
    const e = map.get(n.id);
    e.cantidad_bolsas++;
    if (disc > e.max_descuento) e.max_descuento = disc;
  }

  res.json(Array.from(map.values()).sort((a, b) => (b.calificacion_promedio || 0) - (a.calificacion_promedio || 0)));
});

// GET /api/negocios/:id/detalle — detalle con bolsas agrupadas + veces_pedido
router.get('/:id/detalle', async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios').select('*').eq('id', req.params.id).single();
  if (error || !negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

  let { data, error: bErr } = await supabase
    .from('bolsas').select('*')
    .eq('negocio_id', req.params.id).eq('activo', true).gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null')
    .order('created_at', { ascending: false });
  if (bErr) {
    const r = await supabase.from('bolsas').select('*')
      .eq('negocio_id', req.params.id).eq('activo', true).gt('cantidad_disponible', 0);
    data = r.data;
  }
  const bolsas = data || [];

  // Contar cuántas veces fue pedida cada bolsa (pedidos recogidos)
  const vecesPedidoMap = {};
  if (bolsas.length > 0) {
    const ids = bolsas.map((b) => b.id);
    const { data: peds } = await supabase
      .from('pedidos').select('bolsa_id').in('bolsa_id', ids).eq('estado', 'recogido');
    for (const p of (peds || [])) {
      vecesPedidoMap[p.bolsa_id] = (vecesPedidoMap[p.bolsa_id] || 0) + 1;
    }
  }

  const enrich = (b) => ({ ...b, veces_pedido: vecesPedidoMap[b.id] || 0 });
  res.json({
    negocio,
    bolsas: {
      tiempo_limitado: bolsas.filter((b) => b.tipo !== 'cupon').map(enrich),
      promocion:       bolsas.filter((b) => b.tipo === 'cupon').map(enrich),
    },
  });
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
  console.log('[NEGOCIO UBICACION] latitud:', latitud, 'longitud:', longitud);

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
  const totalPropinas = ventas.reduce((s, p) => s + (p.propina || 0), 0);
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
      total_propinas: parseFloat(totalPropinas.toFixed(2)),
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
    imagen_url, dpi_foto_url, nit, dpi, datos_bancarios, horario_atencion,
    punto_referencia, google_maps_url, waze_url,
    latitud: latManual, longitud: lngManual } = req.body;
  const updates = {};
  if (nombre !== undefined)             updates.nombre = nombre;
  if (descripcion !== undefined)        updates.descripcion = descripcion;
  if (direccion !== undefined)          updates.direccion = direccion;
  if (zona !== undefined)               updates.zona = zona;
  if (ciudad !== undefined)             updates.ciudad = ciudad;
  if (telefono !== undefined)           updates.telefono = telefono;
  if (categoria !== undefined)          updates.categoria = categoria;
  if (activo !== undefined)             updates.activo = activo;
  if (imagen_url !== undefined)         updates.imagen_url = imagen_url;
  if (dpi_foto_url !== undefined)       updates.dpi_foto_url = dpi_foto_url;
  if (nit !== undefined)                updates.nit = nit;
  if (dpi !== undefined)                updates.dpi = dpi;
  if (datos_bancarios !== undefined)    updates.datos_bancarios = datos_bancarios;
  if (horario_atencion !== undefined)   updates.horario_atencion = horario_atencion;
  if (punto_referencia !== undefined)   updates.punto_referencia = punto_referencia;
  if (google_maps_url !== undefined)    updates.google_maps_url = google_maps_url;
  if (waze_url !== undefined)           updates.waze_url = waze_url;

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

  let { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();

  // If dpi_foto_url column doesn't exist yet, store it inside datos_bancarios JSONB
  if (error && updates.dpi_foto_url && error.message.includes('dpi_foto_url')) {
    const dpiUrl = updates.dpi_foto_url;
    delete updates.dpi_foto_url;
    const { data: cur } = await supabase.from('negocios').select('datos_bancarios').eq('id', req.params.id).single();
    updates.datos_bancarios = { ...(cur?.datos_bancarios || {}), dpi_foto_url: dpiUrl };
    const retry = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
    if (retry.error) return res.status(400).json({ error: retry.error.message });
    data = { ...retry.data, dpi_foto_url: dpiUrl };
    error = null;
  }

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/negocios/:id/impacto — kg rescatados y CO2 evitado acumulado del negocio
router.get('/:id/impacto', async (req, res) => {
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('bolsa_id, bolsas!bolsa_id(peso_kg)')
      .eq('negocio_id', req.params.id)
      .eq('estado', 'recogido');

    if (error) return res.status(500).json({ error: error.message });

    const kg_rescatados = Math.round(
      (pedidos || []).reduce((sum, p) => sum + (parseFloat(p.bolsas?.peso_kg) || 0), 0) * 10
    ) / 10;
    const co2_evitado = Math.round(kg_rescatados * 2.5 * 10) / 10;

    res.json({ kg_rescatados, co2_evitado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// GET /api/negocios/:id/bolsas — bolsas aprobadas vigentes agrupadas por tipo
router.get('/:id/bolsas', async (req, res) => {
  let { data, error } = await supabase
    .from('bolsas')
    .select('*')
    .eq('negocio_id', req.params.id)
    .eq('activo', true)
    .gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null')
    .order('created_at', { ascending: false });
  if (error) {
    const r = await supabase.from('bolsas').select('*')
      .eq('negocio_id', req.params.id).eq('activo', true).gt('cantidad_disponible', 0)
      .order('created_at', { ascending: false });
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  const bolsas = data || [];
  res.json({
    tiempo_limitado: bolsas.filter(b => b.tipo !== 'cupon'),
    promociones: bolsas.filter(b => b.tipo === 'cupon'),
  });
});

// POST /api/negocios/mi-negocio/solicitar-cambios
// El restaurante envía { cambios: { campo: valor } } para revisión del admin
router.post('/mi-negocio/solicitar-cambios', authMiddleware, async (req, res) => {
  console.log('[CAMBIOS PERFIL] usuario_id:', req.usuario.id, 'rol:', req.usuario.rol);

  // BUG 6: buscar el negocio por propietario_id (NO por usuario.id directamente)
  const { data: negocio, error: negocioErr } = await supabase
    .from('negocios').select('id,propietario_id').eq('propietario_id', req.usuario.id).maybeSingle();
  console.log('[CAMBIOS PERFIL] negocio encontrado:', negocio, 'error:', negocioErr?.message);
  if (negocioErr) return res.status(500).json({ error: 'Error al buscar el negocio: ' + negocioErr.message });
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado. Verifica que tu cuenta esté asociada a un negocio registrado.' });
  console.log('[CAMBIOS PERFIL] negocio:', negocio.id);

  // Frontend envía { cambios: { campo: valor, ... } }
  const bodyChanges = req.body.cambios;
  if (!bodyChanges || typeof bodyChanges !== 'object' || Array.isArray(bodyChanges)) {
    return res.status(400).json({ error: 'Se esperaba { cambios: { ... } } en el body' });
  }

  const campos_permitidos = ['nombre','descripcion','direccion','zona','ciudad','telefono',
    'categoria','latitud','longitud','punto_referencia','google_maps_url','waze_url'];
  const cambios = {};
  for (const k of campos_permitidos) {
    if (bodyChanges[k] !== undefined) cambios[k] = bodyChanges[k];
  }
  console.log('[CAMBIOS PERFIL] cambios:', cambios);

  if (Object.keys(cambios).length === 0)
    return res.status(400).json({ error: 'No se enviaron campos para cambiar' });

  // Si ya hay solicitud pendiente → actualizar en lugar de rechazar con 409
  const { data: pendiente } = await supabase
    .from('negocio_cambios_pendientes')
    .select('id')
    .eq('negocio_id', negocio.id)
    .eq('estado', 'pendiente')
    .maybeSingle();

  let data, error;

  if (pendiente) {
    ({ data, error } = await supabase
      .from('negocio_cambios_pendientes')
      .update({ cambios, updated_at: new Date().toISOString() })
      .eq('id', pendiente.id)
      .select()
      .single());
  } else {
    ({ data, error } = await supabase
      .from('negocio_cambios_pendientes')
      .insert([{ negocio_id: negocio.id, usuario_id: req.usuario.id, cambios, estado: 'pendiente' }])
      .select()
      .single());
  }

  if (error) {
    console.error('[CAMBIOS PERFIL] error Supabase:', error.message, error.code, error.details);
    return res.status(400).json({
      error: 'No se pudo guardar la solicitud: ' + error.message,
      code: error.code,
      details: error.details,
    });
  }

  console.log('[CAMBIOS PERFIL] solicitud creada/actualizada:', data.id);
  res.status(pendiente ? 200 : 201).json({ ok: true, solicitud: data, actualizado: !!pendiente });
});

// GET /api/negocios/mi-negocio/cambios-pendientes
router.get('/mi-negocio/cambios-pendientes', authMiddleware, async (req, res) => {
  const { data: negocio } = await supabase
    .from('negocios').select('id').eq('propietario_id', req.usuario.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });

  let { data, error } = await supabase
    .from('negocio_cambios_pendientes')
    .select('*')
    .eq('negocio_id', negocio.id)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) return res.json([]); // tabla puede no existir aún
  res.json(data || []);
});

module.exports = router;
