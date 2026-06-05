const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { haversine } = require('../utils/geo');
const { enviarNotificacionesMultiples, guardarNotificacion } = require('../services/notificaciones');
const { getReservadoPendiente, getReservasMap } = require('../services/stock');
const router = express.Router();

// GET /api/bolsas — listar bolsas disponibles con distancia opcional
router.get('/', async (req, res) => {
  const { tipo, negocio_id, zona, categoria, mi_negocio, lat, lng, max_distancia } = req.query;

  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  const maxKm   = max_distancia ? parseFloat(max_distancia) : null;

  let query = supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud)')
    .eq('activo', true)
    .order('created_at', { ascending: false });

  if (mi_negocio !== 'true') {
    query = query.gt('cantidad_disponible', 0);
    // Solo bolsas aprobadas en el feed público; degradar si la columna no existe
    query = query.or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  }
  if (tipo) query = query.eq('tipo', tipo);
  if (negocio_id) query = query.eq('negocio_id', negocio_id);

  let { data, error } = await query;
  if (error) {
    // Fallback sin columnas opcionales (estado_aprobacion puede no existir aún)
    let q2 = supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud)')
      .gt('cantidad_disponible', 0);
    if (negocio_id) q2 = q2.eq('negocio_id', negocio_id);
    const r = await q2;
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  let resultado = data || [];

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
    resultado = resultado.map(b => {
      const nLat = b.negocios?.latitud;
      const nLng = b.negocios?.longitud;
      const distancia_km = (nLat != null && nLng != null)
        ? Math.round(haversine(userLat, userLng, nLat, nLng) * 10) / 10
        : null;
      return { ...b, distancia_km };
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
    .select('*, negocios(id,nombre,zona,ciudad,categoria,direccion,telefono,latitud,longitud)')
    .eq('id', req.params.id)
    .single();

  // Fallback: si el join extendido falla, intentar sin él
  if (error && error.code !== 'PGRST116') {
    console.warn('[BOLSAS DETAIL] join falló, reintentando sin negocios join:', error.message);
    const r2 = await supabase
      .from('bolsas')
      .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud)')
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

  const { negocio_id, nombre, descripcion, contenido, precio_original, precio_descuento,
    cantidad_disponible, tipo, categoria, hora_recogida_inicio, hora_recogida_fin,
    permite_envio, co2_salvado_kg } = req.body;

  if (!nombre || precio_original == null || precio_descuento == null)
    return res.status(400).json({ error: 'nombre, precio_original y precio_descuento son requeridos' });

  const { data: negocio } = await supabase
    .from('negocios').select('id').eq('propietario_id', req.usuario.id).single();
  const nId = negocio_id || negocio?.id;
  if (!nId) return res.status(400).json({ error: 'Negocio no encontrado' });

  const estadoAprobacion = req.usuario.rol === 'admin' ? 'aprobado' : 'pendiente';

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
      co2_salvado_kg: parseFloat(co2_salvado_kg) || 0.5,
      estado_aprobacion: estadoAprobacion,
    }])
    .select()
    .single();

  if (error) {
    // Fallback: columna estado_aprobacion puede no existir aún
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
        co2_salvado_kg: parseFloat(co2_salvado_kg) || 0.5,
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
    'permite_envio','co2_salvado_kg','activo','estado_aprobacion'];
  const updates = {};
  campos.forEach(c => { if (req.body[c] !== undefined) updates[c] = req.body[c]; });

  // Si un restaurante (no admin) edita una bolsa rechazada, reenviarla a revisión
  if (req.usuario.rol !== 'admin' && bolsa.estado_aprobacion === 'rechazado') {
    updates.estado_aprobacion = 'pendiente';
    updates.motivo_rechazo = null;
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
