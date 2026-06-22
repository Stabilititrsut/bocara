const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { haversine } = require('../utils/geo');
const { enviarNotificacionesMultiples, guardarNotificacion } = require('../services/notificaciones');
const { getReservadoPendiente, getReservasMap } = require('../services/stock');
const { calcularImpactoProducto } = require('../services/impactoAmbiental');
const router = express.Router();

async function getNegocioIdParaUsuario(usuarioId) {
  const { data } = await supabase.from('negocios').select('id').eq('propietario_id', usuarioId).single();
  return data?.id || null;
}

// GET /api/bolsas — listar bolsas disponibles con distancia opcional
router.get('/', async (req, res) => {
  const { tipo, negocio_id, zona, categoria, mi_negocio, lat, lng, max_distancia } = req.query;

  // mi_negocio=true requiere autenticación y filtra solo al negocio del usuario
  let nIdOwner = null;
  if (mi_negocio === 'true') {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'No autenticado' });
    let jwtUser;
    try { jwtUser = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token inválido' }); }
    nIdOwner = await getNegocioIdParaUsuario(jwtUser.id);
    if (!nIdOwner) return res.status(404).json({ error: 'Negocio no encontrado' });
  }

  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  const maxKm   = max_distancia ? parseFloat(max_distancia) : null;

  let query = supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url)')
    .eq('activo', true)
    .order('created_at', { ascending: false });

  if (mi_negocio !== 'true') {
    query = query.gt('cantidad_disponible', 0);
    // Solo bolsas aprobadas en el feed público; degradar si la columna no existe
    query = query.or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  }
  if (tipo) query = query.eq('tipo', tipo);
  // Para mi_negocio=true se usa siempre el negocio del usuario autenticado (ignora query param)
  if (nIdOwner) query = query.eq('negocio_id', nIdOwner);
  else if (negocio_id) query = query.eq('negocio_id', negocio_id);

  let { data, error } = await query;
  if (error) {
    // Fallback sin columnas opcionales (estado_aprobacion puede no existir aún)
    let q2 = supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url)')
      .gt('cantidad_disponible', 0);
    if (nIdOwner) q2 = q2.eq('negocio_id', nIdOwner);
    else if (negocio_id) q2 = q2.eq('negocio_id', negocio_id);
    const r = await q2;
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  let resultado = data || [];
  if (resultado.length > 0) console.log('[BOLSAS] total:', resultado.length, '| sample imagen_url:', resultado[0]?.imagen_url || '(sin imagen)');


  // Solo bolsas de negocios activos/aprobados (excepto cuando el restaurante consulta sus propias bolsas)
  if (mi_negocio !== 'true') {
    resultado = resultado.filter(b => b.negocios?.activo !== false);
  }

  // Inyectar cantidad_disponible_real = cantidad_disponible DB − reservas de pedidos pendientes
  try {
    const reservaMap = await getReservasMap();
    resultado = resultado.map(b => ({
      ...b,
      cantidad_disponible_real: Math.max(0, b.cantidad_disponible - (reservaMap[b.id] || 0)),
    }));
    // Para el feed público, filtrar también por disponibilidad real (no solo DB)
    if (mi_negocio !== 'true') {
      resultado = resultado.filter(b => b.cantidad_disponible_real > 0);
    }
  } catch {
    // Si falla el cálculo de reservas, seguir con datos DB sin bloquear el feed
    resultado = resultado.map(b => ({ ...b, cantidad_disponible_real: b.cantidad_disponible }));
  }

  // Filtros de texto
  if (zona) resultado = resultado.filter(b => b.negocios?.zona === zona);
  if (categoria) resultado = resultado.filter(b => b.negocios?.categoria === categoria);

  // Calcular distancia si el cliente envió coordenadas
  if (userLat !== null && userLng !== null) {
    console.log('[LOCATION] userLat:', userLat, 'userLng:', userLng);
    resultado = resultado.map(b => {
      const nLat = b.negocios?.latitud;
      const nLng = b.negocios?.longitud;
      const distancia_km = (nLat != null && nLng != null)
        ? Math.round(haversine(userLat, userLng, nLat, nLng) * 10) / 10
        : null;
      console.log('[BOLSAS] calculando distancia para negocio:', b.negocios?.nombre, '→', distancia_km, 'km');
      const distancia_texto = distancia_km !== null
        ? distancia_km < 1
          ? `A ${Math.round(distancia_km * 1000)} m`
          : `A ${distancia_km.toFixed(1)} km`
        : null;
      return { ...b, distancia_km, distancia_texto };
    });

    // Filtrar por distancia máxima (solo si el negocio tiene coords)
    if (maxKm !== null) {
      resultado = resultado.filter(b =>
        b.distancia_km === null || b.distancia_km <= maxKm
      );
    }

    // Ordenar: primero los que tienen distancia conocida (ascendente), luego los sin coords
    resultado.sort((a, b) => {
      if (a.distancia_km === null && b.distancia_km === null) return 0;
      if (a.distancia_km === null) return 1;
      if (b.distancia_km === null) return -1;
      return a.distancia_km - b.distancia_km;
    });
  }

  res.json(resultado);
});

// GET /api/bolsas/:id — detalle de bolsa con coords del negocio
router.get('/:id', async (req, res) => {
  console.log('[BOLSAS DETAIL] id recibido:', req.params.id);

  let { data, error } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,categoria,direccion,telefono,latitud,longitud,imagen_url)')
    .eq('id', req.params.id)
    .single();

  // Fallback: si el join extendido falla, intentar sin él
  if (error && error.code !== 'PGRST116') {
    console.warn('[BOLSAS DETAIL] join falló, reintentando sin negocios join:', error.message);
    const r2 = await supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url)')
      .eq('id', req.params.id)
      .single();
    data = r2.data;
    error = r2.error;
  }

  console.log('[BOLSAS DETAIL] error:', error?.code, error?.message);
  console.log('[BOLSAS DETAIL] data id:', data?.id);

  if (error?.code === 'PGRST116' || (!error && !data)) {
    return res.status(404).json({ error: 'Bolsa no encontrada' });
  }
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Añadir disponibilidad real descontando reservas pendientes
  try {
    const reservado = await getReservadoPendiente(data.id);
    data.cantidad_disponible_real = Math.max(0, data.cantidad_disponible - reservado);
  } catch {
    data.cantidad_disponible_real = data.cantidad_disponible;
  }

  res.json(data);
});

// POST /api/bolsas — crear bolsa (restaurante)
router.post('/', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'Solo los restaurantes pueden crear bolsas' });

  // BUG 1: SQL para agregar columna si no existe aún
  console.log('[BOLSAS] SQL necesario si la columna no existe:\nALTER TABLE bolsas ADD COLUMN IF NOT EXISTS fecha_caducidad date;');

  const { negocio_id, nombre, descripcion, contenido, precio_original, precio_descuento,
    cantidad_disponible, tipo, categoria, hora_recogida_inicio, hora_recogida_fin,
    permite_envio, imagen_url, peso_kg, fecha_caducidad,
    categoria_menu, es_tiempo_limitado, es_promocion, es_descuento,
    es_destacado, es_mas_vendido, es_precio_bajo } = req.body;

  if (!nombre || precio_original == null || precio_descuento == null)
    return res.status(400).json({ error: 'nombre, precio_original y precio_descuento son requeridos' });

  const { data: negocio } = await supabase
    .from('negocios').select('id,categoria').eq('propietario_id', req.usuario.id).single();
  // Admins pueden especificar negocio_id; restaurantes solo pueden usar su propio negocio
  const nId = req.usuario.rol === 'admin' ? (negocio_id || negocio?.id) : negocio?.id;
  if (!nId) return res.status(400).json({ error: 'Negocio no encontrado' });

  // Verificar que no exista una bolsa activa con el mismo nombre en este negocio
  const { data: existentes } = await supabase
    .from('bolsas')
    .select('id,nombre,estado_aprobacion')
    .eq('negocio_id', nId)
    .ilike('nombre', nombre.trim())
    .eq('activo', true);
  if (existentes && existentes.length > 0) {
    return res.status(409).json({
      error: `Ya existe una publicación activa con el nombre "${nombre.trim()}". Si necesitas editarla, usa la opción de editar.`,
      duplicado: true,
      existente: existentes[0],
    });
  }

  const estadoAprobacion = req.usuario.rol === 'admin' ? 'aprobado' : 'pendiente';
  const pesoKg = parseFloat(peso_kg) || 0.5;
  // CO₂ calculado automáticamente — no se acepta del cliente
  const categoriaParaCO2 = categoria || negocio?.categoria || '';
  const impacto = await calcularImpactoProducto(supabase, pesoKg, categoriaParaCO2);
  const co2Calculado = impacto.co2e_kg;
  if (impacto.sin_datos) {
    console.warn(`[BOLSAS] Sin factor CO₂ para categoría "${categoriaParaCO2}" — co2_salvado_kg quedará en 0`);
  }

  let { data, error } = await supabase
    .from('bolsas')
    .insert([{
      negocio_id: nId, nombre, descripcion, contenido,
      precio_original: parseFloat(precio_original),
      precio_descuento: parseFloat(precio_descuento),
      cantidad_disponible: parseInt(cantidad_disponible) || 1,
      tipo: tipo || 'bolsa', categoria,
      hora_recogida_inicio: hora_recogida_inicio || '18:00',
      hora_recogida_fin: hora_recogida_fin || '20:00',
      permite_envio: permite_envio || false,
      peso_kg: pesoKg,
      co2_salvado_kg: co2Calculado,
      imagen_url: imagen_url || null,
      estado_aprobacion: estadoAprobacion,
      fecha_caducidad: fecha_caducidad || null,
      categoria_menu: categoria_menu || null,
      es_tiempo_limitado: es_tiempo_limitado ?? false,
      es_promocion: es_promocion ?? false,
      es_descuento: es_descuento ?? false,
      es_destacado: es_destacado ?? false,
      es_mas_vendido: es_mas_vendido ?? false,
      es_precio_bajo: es_precio_bajo ?? false,
    }])
    .select()
    .single();

  if (error) {
    // Fallback: columnas nuevas pueden no existir aún
    const r = await supabase
      .from('bolsas')
      .insert([{
        negocio_id: nId, nombre, descripcion, contenido,
        precio_original: parseFloat(precio_original),
        precio_descuento: parseFloat(precio_descuento),
        cantidad_disponible: parseInt(cantidad_disponible) || 1,
        tipo: tipo || 'bolsa', categoria,
        hora_recogida_inicio: hora_recogida_inicio || '18:00',
        hora_recogida_fin: hora_recogida_fin || '20:00',
        permite_envio: permite_envio || false,
        co2_salvado_kg: co2Calculado,
        imagen_url: imagen_url || null,
      }])
      .select()
      .single();
    data = r.data; error = r.error;
  }

  if (error) return res.status(400).json({ error: error.message });

  // Notificar favoritos solo si la bolsa está aprobada (no pendiente)
  if (!data.estado_aprobacion || data.estado_aprobacion === 'aprobado') {
    notificarFavoritos(nId, data.nombre, data.id).catch(() => {});
  }

  res.status(201).json(data);
});

// PUT /api/bolsas/:id — actualizar bolsa
router.put('/:id', authMiddleware, async (req, res) => {
  const { data: bolsa } = await supabase
    .from('bolsas')
    .select('negocio_id, estado_aprobacion, negocios(propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (!bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
  if (bolsa.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const campos = ['nombre','descripcion','contenido','precio_original','precio_descuento',
    'cantidad_disponible','tipo','categoria','hora_recogida_inicio','hora_recogida_fin',
    'permite_envio','activo','imagen_url','fecha_caducidad',
    'categoria_menu','es_tiempo_limitado','es_promocion','es_descuento',
    'es_destacado','es_mas_vendido','es_precio_bajo'];
  const updates = {};
  campos.forEach(c => { if (req.body[c] !== undefined) updates[c] = req.body[c]; });

  // BUG 2: Restaurantes nunca pueden aprobar directamente — strip any estado_aprobacion del body
  if (req.usuario.rol !== 'admin') {
    delete updates.estado_aprobacion;
    // Si editó una bolsa aprobada o rechazada, vuelve a revisión del admin
    if (bolsa.estado_aprobacion === 'aprobado' || bolsa.estado_aprobacion === 'rechazado') {
      updates.estado_aprobacion = 'pendiente';
      updates.motivo_rechazo = null;
    }
  } else if (req.body.estado_aprobacion !== undefined) {
    updates.estado_aprobacion = req.body.estado_aprobacion;
  }

  // Recalcular CO₂ si se envía peso_kg
  if (req.body.peso_kg !== undefined) {
    const pesoKg = parseFloat(req.body.peso_kg) || 0.5;
    updates.peso_kg = pesoKg;
    const { data: neg } = await supabase.from('negocios').select('categoria').eq('id', bolsa.negocio_id).single();
    const categoriaParaCO2 = updates.categoria || neg?.categoria || '';
    const impactoEdit = await calcularImpactoProducto(supabase, pesoKg, categoriaParaCO2);
    updates.co2_salvado_kg = impactoEdit.co2e_kg;
    if (impactoEdit.sin_datos) {
      console.warn(`[BOLSAS] Sin factor CO₂ al editar para categoría "${categoriaParaCO2}"`);
    }
  }

  let { data, error } = await supabase.from('bolsas').update(updates).eq('id', req.params.id).select().single();
  if (error) {
    // Fallback: columna estado_aprobacion puede no existir aún — reintentar sin ella
    delete updates.estado_aprobacion;
    delete updates.motivo_rechazo;
    const r = await supabase.from('bolsas').update(updates).eq('id', req.params.id).select().single();
    data = r.data; error = r.error;
  }
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/bolsas/:id — desactivar bolsa
router.delete('/:id', authMiddleware, async (req, res) => {
  const { data: bolsa } = await supabase
    .from('bolsas')
    .select('negocio_id, negocios(propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (!bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
  if (bolsa.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });
  await supabase.from('bolsas').update({ activo: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

async function notificarFavoritos(negocioId, bolsaNombre, bolsaId) {
  try {
    const { data: negocio } = await supabase.from('negocios').select('nombre').eq('id', negocioId).single();
    const nombreNegocio = negocio?.nombre || 'Tu restaurante favorito';

    const { data: favs } = await supabase
      .from('favoritos')
      .select('usuario_id, usuarios(expo_push_token)')
      .eq('negocio_id', negocioId);

    if (!favs?.length) return;

    const tokens = favs.map(f => f.usuarios?.expo_push_token).filter(Boolean);
    if (tokens.length) {
      await enviarNotificacionesMultiples(
        tokens,
        '🛍️ ¡Nueva bolsa disponible!',
        `${nombreNegocio} publicó: ${bolsaNombre}`,
        { negocioId, bolsaId, screen: 'home' }
      );
    }

    for (const fav of favs) {
      await guardarNotificacion(
        supabase, fav.usuario_id, 'nueva_bolsa',
        '🛍️ Nueva bolsa disponible',
        `${nombreNegocio} publicó: ${bolsaNombre}`,
        { negocioId, bolsaId }
      );
    }
  } catch {
    // tabla favoritos puede no existir aún — fallo silencioso
  }
}

module.exports = router;
