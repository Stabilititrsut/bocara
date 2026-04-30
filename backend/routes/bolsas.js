const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { haversine } = require('../utils/geo');
const { enviarNotificacionesMultiples, guardarNotificacion } = require('../services/notificaciones');
const router = express.Router();

// GET /api/bolsas — listar bolsas disponibles con distancia opcional
router.get('/', async (req, res) => {
  const { tipo, negocio_id, zona, categoria, mi_negocio, lat, lng, max_distancia } = req.query;

  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  const maxKm   = max_distancia ? parseFloat(max_distancia) : null;

  let query = supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,permite_envio)')
    .eq('activo', true)
    .order('created_at', { ascending: false });

  if (mi_negocio !== 'true') query = query.gt('cantidad_disponible', 0);
  if (tipo) query = query.eq('tipo', tipo);
  if (negocio_id) query = query.eq('negocio_id', negocio_id);

  let { data, error } = await query;
  if (error) {
    // Fallback sin columnas opcionales
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
  const { data, error } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,categoria,direccion,telefono,latitud,longitud,permite_envio)')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Bolsa no encontrada' });
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

  const { data, error } = await supabase
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

  if (error) return res.status(400).json({ error: error.message });

  // Notificar a usuarios que tienen este negocio en favoritos
  notificarFavoritos(nId, data.nombre, data.id).catch(() => {});

  res.status(201).json(data);
});

// PUT /api/bolsas/:id — actualizar bolsa
router.put('/:id', authMiddleware, async (req, res) => {
  const { data: bolsa } = await supabase
    .from('bolsas')
    .select('negocio_id, negocios(propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (!bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });
  if (bolsa.negocios?.propietario_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const campos = ['nombre','descripcion','contenido','precio_original','precio_descuento',
    'cantidad_disponible','tipo','categoria','hora_recogida_inicio','hora_recogida_fin',
    'permite_envio','co2_salvado_kg','activo'];
  const updates = {};
  campos.forEach(c => { if (req.body[c] !== undefined) updates[c] = req.body[c]; });

  const { data, error } = await supabase.from('bolsas').update(updates).eq('id', req.params.id).select().single();
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
