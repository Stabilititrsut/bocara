const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const { guardarNotificacion } = require('../services/notificaciones');
const { aNumero, obtenerSubtotalProductos } = require('../services/finanzas');
const router = express.Router();

// Campos públicos de un negocio — estos endpoints no llevan auth, así que nunca
// deben incluir datos sensibles (dpi, dpi_foto_url, datos_bancarios, nit, motivo_rechazo, etc.).
// foto_portada/foto_negocio NO son columnas reales de la tabla (nunca se creó
// la migración); ningún flujo de escritura las usa — la foto del negocio vive
// en imagen_url. Incluirlas aquí rompía estos endpoints con un 42703.
const CAMPOS_NEGOCIO_PUBLICOS = 'id,nombre,categoria,zona,ciudad,direccion,' +
  'punto_referencia,latitud,longitud,google_maps_url,waze_url,' +
  'imagen_url,logo_url,' +
  'calificacion_promedio,total_resenas';

// Campos públicos de una bolsa (misma whitelist que routes/bolsas.js) — motivo_rechazo
// queda fuera a propósito, defensa en profundidad para estos endpoints sin auth.
const CAMPOS_BOLSA_PUBLICOS = 'id,negocio_id,nombre,descripcion,contenido,precio_original,precio_descuento,' +
  'cantidad_disponible,tipo,categoria,categoria_alimento,categoria_menu,' +
  'hora_recogida_inicio,hora_recogida_fin,permite_envio,imagen_url,' +
  'peso_estimado_kg,co2_salvado_kg,fecha,fecha_disponible,fecha_caducidad,' +
  'activo,activa,estado_aprobacion,creado_en,created_at,' +
  'es_tiempo_limitado,es_promocion,es_descuento,es_destacado,es_mas_vendido,es_precio_bajo';

// Un negocio solo debe ser visible/navegable para clientes si está activo y,
// cuando el campo existe, aprobado (compat con despliegues sin estado_verificacion aún).
function negocioDisponiblePublico(n) {
  return !!n && n.activo !== false &&
    (n.estado_verificacion === 'aprobado' || n.estado_verificacion == null);
}

// GET /api/negocios — listar negocios activos y aprobados
router.get('/', async (req, res) => {
  const { zona, categoria, verificado } = req.query;
  // select('*') aquí exponía dpi, datos_bancarios, nit, password_hash y
  // motivo_rechazo sin autenticación — misma lista blanca que ya usan
  // /:id y /:id/detalle.
  let query = supabase
    .from('negocios')
    .select(CAMPOS_NEGOCIO_PUBLICOS)
    .eq('activo', true)
    // Mostrar solo aprobados (o los que no tienen el campo aún para backwards compat)
    .or('estado_verificacion.eq.aprobado,estado_verificacion.is.null')
    .order('calificacion_promedio', { ascending: false });
  if (zona) query = query.eq('zona', zona);
  if (categoria) query = query.eq('categoria', categoria);
  if (verificado !== undefined) query = query.eq('verificado', verificado === 'true');
  let { data, error } = await query;
  if (error) {
    // Fallback sin estado_verificacion (tabla vieja) — misma lista blanca, sin datos sensibles
    let q2 = supabase.from('negocios').select(CAMPOS_NEGOCIO_PUBLICOS).eq('activo', true).order('nombre');
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
    .select('negocio_id, precio_original, precio_descuento, negocios(id,nombre,zona,descripcion,categoria,imagen_url,calificacion_promedio,activo,estado_verificacion)')
    .eq('activo', true)
    .gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  if (error) {
    const r = await supabase
      .from('bolsas')
      .select('negocio_id, precio_original, precio_descuento, negocios(id,nombre,zona,descripcion,categoria,imagen_url,calificacion_promedio,activo,estado_verificacion)')
      .eq('activo', true)
      .gt('cantidad_disponible', 0);
    bolsas = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  const map = new Map();
  for (const b of (bolsas || [])) {
    const n = b.negocios;
    if (!n) continue;
    // Restaurantes suspendidos o aún no aprobados no deben aportar al feed del cliente.
    if (!negocioDisponiblePublico(n)) continue;
    if (zona && String(n.zona) !== String(zona)) continue;
    if (categoria && n.categoria !== categoria) continue;
    const disc = b.precio_original > 0
      ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;
    if (!map.has(n.id)) map.set(n.id, { ...n, cantidad_bolsas: 0, max_descuento: 0 });
    const e = map.get(n.id);
    e.cantidad_bolsas++;
    if (disc > e.max_descuento) e.max_descuento = disc;
  }

  const resultado = Array.from(map.values()).map(({ activo, estado_verificacion, ...pub }) => pub);
  res.json(resultado.sort((a, b) => (b.calificacion_promedio || 0) - (a.calificacion_promedio || 0)));
});

// GET /api/negocios/:id/detalle — detalle con bolsas agrupadas + veces_pedido
router.get('/:id/detalle', async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios').select(CAMPOS_NEGOCIO_PUBLICOS + ',activo,estado_verificacion').eq('id', req.params.id).single();
  if (error || !negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  // Un restaurante suspendido o pendiente de aprobación no debe ser navegable por clientes.
  if (!negocioDisponiblePublico(negocio)) return res.status(404).json({ error: 'Negocio no encontrado' });
  delete negocio.activo;
  delete negocio.estado_verificacion;

  let { data, error: bErr } = await supabase
    .from('bolsas').select(CAMPOS_BOLSA_PUBLICOS)
    .eq('negocio_id', req.params.id).eq('activo', true).gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null')
    .order('created_at', { ascending: false });
  if (bErr) {
    const r = await supabase.from('bolsas').select(CAMPOS_BOLSA_PUBLICOS)
      .eq('negocio_id', req.params.id).eq('activo', true).gt('cantidad_disponible', 0);
    data = r.data;
  }
  const bolsas = data || [];

  // Contar cuántas veces fue pedida cada bolsa (pedidos recogidos)
  const vecesPedidoMap = {};
  if (bolsas.length > 0) {
    const ids = bolsas.map((b) => b.id);
    const { data: peds } = await supabase
      .from('pedidos').select('bolsa_id').in('bolsa_id', ids).in('estado', ['completado', 'recogido']);
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

// GET /api/negocios/:id/impacto — contribución real al aprovechamiento del negocio
router.get('/:id/impacto', async (req, res) => {
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('precio_bolsa, bolsas!bolsa_id(peso_estimado_kg)')
      .eq('negocio_id', req.params.id)
      .in('estado', ['completado', 'recogido']);
    if (error) return res.status(500).json({ error: error.message });
    const rows = pedidos || [];
    const pedidos_completados = rows.length;
    const unidades_rescatadas = rows.length; // sin columna cantidad; cada pedido = 1 unidad
    const kg_rescatados = Math.round(
      rows.reduce((sum, p) => sum + (parseFloat(p.bolsas?.peso_estimado_kg) || 0), 0) * 10
    ) / 10;
    const ventas_recuperadas = Math.round(
      rows.reduce((sum, p) => sum + (parseFloat(p.precio_bolsa) || 0), 0) * 100
    ) / 100;
    res.json({ kg_rescatados, unidades_rescatadas, pedidos_completados, ventas_recuperadas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/negocios/:id — detalle con bolsas
router.get('/:id', async (req, res) => {
  const { data: negocio, error } = await supabase
    .from('negocios')
    .select(CAMPOS_NEGOCIO_PUBLICOS + ',activo,estado_verificacion')
    .eq('id', req.params.id)
    .single();
  if (error || !negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!negocioDisponiblePublico(negocio)) return res.status(404).json({ error: 'Negocio no encontrado' });
  delete negocio.activo;
  delete negocio.estado_verificacion;
  let { data: bolsas, error: bErr } = await supabase
    .from('bolsas')
    .select(CAMPOS_BOLSA_PUBLICOS)
    .eq('negocio_id', req.params.id)
    .eq('activo', true)
    .gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  if (bErr) {
    const r = await supabase
      .from('bolsas')
      .select(CAMPOS_BOLSA_PUBLICOS)
      .eq('negocio_id', req.params.id)
      .eq('activo', true)
      .gt('cantidad_disponible', 0);
    bolsas = r.data;
  }
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
  let desde = null;
  if (periodo === 'dia')         desde = new Date(Date.now() - 86400000);
  else if (periodo === 'semana') desde = new Date(Date.now() - 7 * 86400000);
  else if (periodo === 'mes')    desde = new Date(Date.now() - 30 * 86400000);
  // periodo === 'todo' → desde queda null, sin límite de fecha (histórico completo)

  // Mismo criterio de "venta real" que el resto del sistema: dinero confirmado
  // por Cubo (estado_pago='pagado', no cancelado, con token+identifier de Cubo),
  // sin exigir que ya esté completado/recogido — el dinero ya entró aunque el
  // cliente no haya pasado a recoger. Antes este endpoint solo filtraba por
  // estado IN (completado,recogido) sin verificar pago real ni excluir cancelados.
  let query = supabase
    .from('pedidos')
    .select('id,total,precio_bolsa,cantidad,costo_envio,descuento_cupon,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,estado,estado_pago,cubo_payment_intent_token,cubo_identifier,created_at')
    .eq('negocio_id', negocio.id)
    .eq('estado_pago', 'pagado')
    .neq('estado', 'cancelado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null);
  if (desde) query = query.gte('created_at', desde.toISOString());
  const { data: pedidos } = await query;

  const ventas = pedidos || [];
  // Todo se suma desde el snapshot financiero guardado en cada pedido (comision_bocara,
  // monto_neto_restaurante, propina) — nunca recalculado con el % de configuración
  // actual, para que las cifras no cambien retroactivamente si la comisión cambia
  // después de una venta. Antes esta ruta ni siquiera seleccionaba la columna
  // `propina`, así que total_propinas siempre daba 0 aunque hubiera propinas reales,
  // y usaba fracciones fijas 0.25/0.75 en vez de la comisión configurada.
  const bruto           = ventas.reduce((s, p) => s + obtenerSubtotalProductos(p), 0); // producto, sin propina
  const comisionBocara  = ventas.reduce((s, p) => s + (p.comision_bocara   || 0), 0);
  const cargoPlataforma = ventas.reduce((s, p) => s + (p.comision_pasarela || 0), 0); // informativo — nunca sale del restaurante
  const totalPropinas   = ventas.reduce((s, p) => s + (p.propina || 0), 0);
  const totalEnvios     = ventas.reduce((s, p) => s + aNumero(p.costo_envio), 0);
  const netoVentas       = bruto - comisionBocara; // 75% del producto, sin propina
  // "Lo que recibirás" se lee tal cual quedó guardado al confirmar el pago — nunca
  // recalculado. Un pedido Cubo-verificado sin monto_neto_restaurante sería un dato
  // faltante real (no debería ocurrir) y se excluye en vez de estimarlo.
  const ventasSinDesglose = ventas.filter(p => p.monto_neto_restaurante == null);
  if (ventasSinDesglose.length > 0) {
    console.warn('[GANANCIAS] pedidos sin monto_neto_restaurante — excluidos de total_a_recibir:',
      ventasSinDesglose.map(p => p.id));
  }
  const totalARecibir = ventas.reduce((s, p) => s + (p.monto_neto_restaurante || 0), 0);

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
      ventas_brutas: parseFloat(bruto.toFixed(2)),          // producto, sin propina
      comision_bocara: parseFloat(comisionBocara.toFixed(2)),
      cargo_plataforma: parseFloat(cargoPlataforma.toFixed(2)), // no afecta el pago al restaurante — informativo
      neto_restaurante: parseFloat(netoVentas.toFixed(2)),   // 75% del producto, sin propina
      total_propinas: parseFloat(totalPropinas.toFixed(2)),
      total_envios: parseFloat(totalEnvios.toFixed(2)),
      total_a_recibir: parseFloat(totalARecibir.toFixed(2)), // 75% + propina — lo que realmente se le paga
      pedidos_sin_desglose: ventasSinDesglose.length, // pedidos excluidos de total_a_recibir por falta de dato — debería ser 0
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

// GET /api/negocios/:id/bolsas — bolsas aprobadas vigentes agrupadas por tipo
router.get('/:id/bolsas', async (req, res) => {
  const { data: negocioCheck } = await supabase
    .from('negocios').select('activo,estado_verificacion').eq('id', req.params.id).single();
  if (!negocioDisponiblePublico(negocioCheck)) return res.status(404).json({ error: 'Negocio no encontrado' });

  let { data, error } = await supabase
    .from('bolsas')
    .select(CAMPOS_BOLSA_PUBLICOS)
    .eq('negocio_id', req.params.id)
    .eq('activo', true)
    .gt('cantidad_disponible', 0)
    .or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null')
    .order('created_at', { ascending: false });
  if (error) {
    const r = await supabase.from('bolsas').select(CAMPOS_BOLSA_PUBLICOS)
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
    // Limpiar motivo_rechazo: si el admin había pedido cambios, esta es la versión
    // corregida — el motivo viejo ya no aplica y no debe seguir mostrándose como
    // si la nueva versión todavía tuviera ese pendiente (mismo criterio que
    // PUT /bolsas/:id al reenviar tras un "pedir cambios").
    ({ data, error } = await supabase
      .from('negocio_cambios_pendientes')
      .update({ cambios, motivo_rechazo: null })
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
