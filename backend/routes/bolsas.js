const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { haversine } = require('../utils/geo');
const { enviarNotificacionesMultiples, guardarNotificacion } = require('../services/notificaciones');
const { getReservadoPendiente, getReservasMap } = require('../services/stock');
const { obtenerConfigNumerica } = require('../services/configuracion');
const router = express.Router();

function validarDatosBolsa(datos, { permiteCantidadCero = false } = {}) {
  if (datos.nombre !== undefined && (typeof datos.nombre !== 'string' || datos.nombre.trim().length < 2 || datos.nombre.trim().length > 120))
    return 'El nombre debe tener entre 2 y 120 caracteres';

  for (const campo of ['precio_original', 'precio_descuento']) {
    if (datos[campo] !== undefined && (!Number.isFinite(Number(datos[campo])) || Number(datos[campo]) <= 0))
      return `${campo} debe ser mayor que cero`;
  }
  if (datos.precio_original !== undefined && datos.precio_descuento !== undefined &&
      Number(datos.precio_descuento) > Number(datos.precio_original))
    return 'El precio con descuento no puede ser mayor que el precio original';

  if (datos.cantidad_disponible !== undefined) {
    const cantidad = Number(datos.cantidad_disponible);
    const minimo = permiteCantidadCero ? 0 : 1;
    if (!Number.isInteger(cantidad) || cantidad < minimo || cantidad > 999)
      return `La cantidad debe ser un entero entre ${minimo} y 999`;
  }
  if (datos.peso_estimado_kg !== undefined && datos.peso_estimado_kg !== '' &&
      (!Number.isFinite(Number(datos.peso_estimado_kg)) || Number(datos.peso_estimado_kg) <= 0 || Number(datos.peso_estimado_kg) > 100))
    return 'El peso estimado debe ser mayor que 0 y menor o igual a 100 kg';

  const timeRe = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
  if (datos.hora_recogida_inicio && !timeRe.test(datos.hora_recogida_inicio)) return 'Hora de inicio inválida';
  if (datos.hora_recogida_fin && !timeRe.test(datos.hora_recogida_fin)) return 'Hora de finalización inválida';
  if (datos.hora_recogida_inicio && datos.hora_recogida_fin && datos.hora_recogida_inicio >= datos.hora_recogida_fin)
    return 'La hora de finalización debe ser posterior a la hora de inicio';
  if (datos.fecha_caducidad && !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha_caducidad))
    return 'La fecha de caducidad debe usar el formato AAAA-MM-DD';
  return null;
}

async function getNegocioIdParaUsuario(usuarioId) {
  const { data } = await supabase.from('negocios').select('id').eq('propietario_id', usuarioId).single();
  return data?.id || null;
}

// Detecta si un error de Supabase/PostgREST es por una columna que no existe en la
// tabla real, para poder dejar de enviarla y reintentar SIN inventar el campo.
function extraerColumnaFaltante(error) {
  if (!error) return null;
  // PostgREST: "Could not find the 'peso_kg' column of 'bolsas' in the schema cache"
  let m = /Could not find the '([a-zA-Z0-9_]+)' column/.exec(error.message || '');
  if (m) return m[1];
  // Postgres: column "peso_kg" of relation "bolsas" does not exist (42703)
  m = /column "([a-zA-Z0-9_]+)" of relation/.exec(error.message || '');
  if (m) return m[1];
  return null;
}

// Campos públicos de una bolsa — estos endpoints no llevan auth. motivo_rechazo
// queda fuera a propósito (defensa en profundidad): hoy nunca debería llegar
// con valor porque solo se muestran bolsas aprobadas, pero un select('*') sin
// whitelist lo expondría igual si algún filtro fallara.
const CAMPOS_BOLSA_PUBLICOS = 'id,negocio_id,nombre,descripcion,contenido,precio_original,precio_descuento,' +
  'cantidad_disponible,tipo,categoria,categoria_alimento,categoria_menu,' +
  'hora_recogida_inicio,hora_recogida_fin,permite_envio,imagen_url,' +
  'peso_estimado_kg,co2_salvado_kg,fecha,fecha_disponible,fecha_caducidad,' +
  'activo,activa,estado_aprobacion,creado_en,created_at,' +
  'es_tiempo_limitado,es_promocion,es_descuento,es_destacado,es_mas_vendido,es_precio_bajo';

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
    if (await authMiddleware.estaSuspendido(jwtUser.id)) {
      return res.status(401).json({ error: authMiddleware.MENSAJE_SUSPENDIDO });
    }
    nIdOwner = await getNegocioIdParaUsuario(jwtUser.id);
    if (!nIdOwner) return res.status(404).json({ error: 'Negocio no encontrado' });
  }

  const userLat = lat ? parseFloat(lat) : null;
  const userLng = lng ? parseFloat(lng) : null;
  const maxKm   = max_distancia ? parseFloat(max_distancia) : null;

  // mi_negocio=true (autenticado, el restaurante viendo sus propias publicaciones)
  // sí necesita ver motivo_rechazo — select('*') solo para ese camino privado.
  // El feed público usa la whitelist para no exponer motivo_rechazo de más.
  const selectBolsas = mi_negocio === 'true' ? '*' : CAMPOS_BOLSA_PUBLICOS;

  let query = supabase
    .from('bolsas')
    .select(`${selectBolsas}, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url,activo,estado_verificacion)`)
    .order('created_at', { ascending: false });

  if (mi_negocio !== 'true') {
    // El feed público solo debe mostrar lo que un cliente puede comprar ahora mismo.
    query = query.eq('activo', true);
    query = query.gt('cantidad_disponible', 0);
    // Solo bolsas aprobadas en el feed público; degradar si la columna no existe
    query = query.or('estado_aprobacion.eq.aprobado,estado_aprobacion.is.null');
  }
  // mi_negocio=true no filtra por activo/cantidad/aprobación: el restaurante debe
  // ver TODAS sus publicaciones en su panel de gestión (ocultas, rechazadas,
  // pendientes, agotadas), no solo las que un cliente vería.
  if (tipo) query = query.eq('tipo', tipo);
  // Para mi_negocio=true se usa siempre el negocio del usuario autenticado (ignora query param)
  if (nIdOwner) query = query.eq('negocio_id', nIdOwner);
  else if (negocio_id) query = query.eq('negocio_id', negocio_id);

  let { data, error } = await query;
  if (error) {
    // Fallback sin columnas opcionales (estado_aprobacion puede no existir aún)
    let q2 = supabase
      .from('bolsas')
      .select(`${selectBolsas}, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url,activo,estado_verificacion)`);
    if (mi_negocio !== 'true') q2 = q2.eq('activo', true).gt('cantidad_disponible', 0);
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
    resultado = resultado.filter(b => b.negocios?.activo === true &&
      (b.negocios?.estado_verificacion === 'aprobado' || b.negocios?.estado_verificacion == null));
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
    .select(`${CAMPOS_BOLSA_PUBLICOS}, negocios(id,nombre,zona,ciudad,categoria,direccion,telefono,latitud,longitud,imagen_url,calificacion_promedio,total_resenas,google_maps_url,waze_url,activo,estado_verificacion)`)
    .eq('id', req.params.id)
    .single();

  // Fallback: si el join extendido falla, intentar sin él
  if (error && error.code !== 'PGRST116') {
    console.warn('[BOLSAS DETAIL] join falló, reintentando sin negocios join:', error.message);
    const r2 = await supabase
      .from('bolsas')
      .select(`${CAMPOS_BOLSA_PUBLICOS}, negocios(id,nombre,zona,ciudad,categoria,latitud,longitud,imagen_url,calificacion_promedio,total_resenas,google_maps_url,waze_url,activo,estado_verificacion)`)
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

  // Una bolsa oculta, pendiente/rechazada, o de un negocio suspendido/no aprobado
  // no debe ser consultable directamente aunque el cliente conozca el id.
  const negocioOk = data.negocios && data.negocios.activo !== false &&
    (data.negocios.estado_verificacion === 'aprobado' || data.negocios.estado_verificacion == null);
  const bolsaOk = data.activo !== false &&
    (data.estado_aprobacion === 'aprobado' || data.estado_aprobacion == null);
  if (!negocioOk || !bolsaOk) {
    return res.status(404).json({ error: 'Bolsa no encontrada' });
  }
  if (data.negocios) {
    delete data.negocios.activo;
    delete data.negocios.estado_verificacion;
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

  // SQL para agregar columnas si no existen aún (idempotente)
  console.log('[BOLSAS] SQL necesario si las columnas no existen:\n' +
    'ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS fecha_caducidad date;\n' +
    'ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS categoria_alimento text;');

  const { negocio_id, nombre, descripcion, contenido, precio_original, precio_descuento,
    cantidad_disponible, tipo, categoria, hora_recogida_inicio, hora_recogida_fin,
    permite_envio, imagen_url, peso_estimado_kg, fecha_caducidad, categoria_alimento,
    categoria_menu, es_tiempo_limitado, es_promocion, es_descuento,
    es_destacado, es_mas_vendido, es_precio_bajo } = req.body;

  if (!nombre || precio_original == null || precio_descuento == null)
    return res.status(400).json({ error: 'nombre, precio_original y precio_descuento son requeridos' });

  const errorValidacion = validarDatosBolsa({
    nombre, precio_original, precio_descuento,
    cantidad_disponible: cantidad_disponible ?? 1,
    peso_estimado_kg: peso_estimado_kg ?? 0.5,
    hora_recogida_inicio: hora_recogida_inicio || '18:00',
    hora_recogida_fin: hora_recogida_fin || '20:00',
    fecha_caducidad,
  });
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });

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
    });
  }

  // Límite de bolsas activas por restaurante (configuracion.max_bolsas_por_restaurante)
  if (req.usuario.rol !== 'admin') {
    const { count: activasCount } = await supabase
      .from('bolsas').select('id', { count: 'exact', head: true })
      .eq('negocio_id', nId).eq('activo', true);
    const maxBolsas = await obtenerConfigNumerica('max_bolsas_por_restaurante');
    if ((activasCount || 0) >= maxBolsas) {
      return res.status(409).json({
        error: `Alcanzaste el máximo de ${maxBolsas} publicaciones activas. Desactiva alguna antes de crear una nueva.`,
      });
    }
  }

  const estadoAprobacion = req.usuario.rol === 'admin' ? 'aprobado' : 'pendiente';
  const pesoKg = parseFloat(peso_estimado_kg) || 0.5;

  let { data, error } = await supabase
    .from('bolsas')
    .insert([{
      negocio_id: nId, nombre: nombre.trim(), descripcion, contenido,
      precio_original: parseFloat(precio_original),
      precio_descuento: parseFloat(precio_descuento),
      cantidad_disponible: cantidad_disponible == null ? 1 : Number(cantidad_disponible),
      tipo: tipo || 'bolsa', categoria,
      hora_recogida_inicio: hora_recogida_inicio || '18:00',
      hora_recogida_fin: hora_recogida_fin || '20:00',
      permite_envio: permite_envio || false,
      peso_estimado_kg: pesoKg,
      categoria_alimento: categoria_alimento || null,
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
    // Fallback: solo omite las columnas de metadata más recientes (fecha_caducidad,
    // categoria_menu) que pueden faltar en despliegues antiguos. peso_estimado_kg y los
    // flags es_tiempo_limitado/es_promocion/es_descuento se preservan siempre:
    // son los que definen el tipo real de la publicación y no deben perderse.
    const r = await supabase
      .from('bolsas')
      .insert([{
        negocio_id: nId, nombre: nombre.trim(), descripcion, contenido,
        precio_original: parseFloat(precio_original),
        precio_descuento: parseFloat(precio_descuento),
        cantidad_disponible: cantidad_disponible == null ? 1 : Number(cantidad_disponible),
        tipo: tipo || 'bolsa', categoria,
        hora_recogida_inicio: hora_recogida_inicio || '18:00',
        hora_recogida_fin: hora_recogida_fin || '20:00',
        permite_envio: permite_envio || false,
        peso_estimado_kg: pesoKg,
        imagen_url: imagen_url || null,
        estado_aprobacion: estadoAprobacion,
        es_tiempo_limitado: es_tiempo_limitado ?? false,
        es_promocion: es_promocion ?? false,
        es_descuento: es_descuento ?? false,
        es_destacado: es_destacado ?? false,
        es_mas_vendido: es_mas_vendido ?? false,
        es_precio_bajo: es_precio_bajo ?? false,
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
  const { data: bolsa, error: bolsaErr } = await supabase
    .from('bolsas')
    .select('negocio_id, estado_aprobacion, motivo_rechazo, peso_estimado_kg, categoria_alimento, nombre, precio_original, precio_descuento, cantidad_disponible, hora_recogida_inicio, hora_recogida_fin, fecha_caducidad')
    .eq('id', req.params.id)
    .single();
  console.log('[PUT /bolsas/:id] id=%s usuario=%s error=%s', req.params.id, req.usuario?.id, bolsaErr?.message);
  if (!bolsa) return res.status(404).json({ error: bolsaErr?.message || 'Bolsa no encontrada' });

  if (req.usuario.rol !== 'admin') {
    const { data: negocio } = await supabase
      .from('negocios')
      .select('id')
      .eq('id', bolsa.negocio_id)
      .eq('propietario_id', req.usuario.id)
      .single();
    if (!negocio) return res.status(403).json({ error: 'No autorizado' });

    // En revisión inicial (pendiente, nunca aprobada/rechazada, sin "pedir cambios"
    // de por medio) el admin puede estar mirando esta publicación en este momento —
    // permitir editarla o activarla podría hacer que apruebe una versión que el
    // restaurante ya cambió. Bloqueado solo mientras dure esa primera revisión;
    // en cuanto hay una decisión (aprobado/rechazado/pedir-cambios) se libera.
    if (bolsa.estado_aprobacion === 'pendiente' && !bolsa.motivo_rechazo) {
      return res.status(409).json({
        error: 'Esta publicación está en revisión inicial. Espera a que el administrador la revise antes de editarla o activarla.',
      });
    }
  }

  const campos = ['nombre','descripcion','contenido','precio_original','precio_descuento',
    'cantidad_disponible','tipo','categoria','hora_recogida_inicio','hora_recogida_fin',
    'permite_envio','activo','imagen_url','fecha_caducidad','categoria_alimento',
    'categoria_menu','es_tiempo_limitado','es_promocion','es_descuento',
    'es_destacado','es_mas_vendido','es_precio_bajo','peso_estimado_kg'];
  const updates = {};
  campos.forEach(c => { if (req.body[c] !== undefined) updates[c] = req.body[c]; });

  const datosResultantes = { ...bolsa, ...updates };
  const errorValidacion = validarDatosBolsa(datosResultantes, { permiteCantidadCero: true });
  if (errorValidacion) return res.status(400).json({ error: errorValidacion });
  if (updates.nombre !== undefined) updates.nombre = updates.nombre.trim();
  for (const campo of ['precio_original', 'precio_descuento', 'cantidad_disponible', 'peso_estimado_kg']) {
    if (updates[campo] !== undefined && updates[campo] !== '') updates[campo] = Number(updates[campo]);
  }

  // inactivo_desde marca desde cuándo cuenta el plazo de 5 días hábiles del cron
  // de limpieza (server.js) — se setea al apagar el switch de visibilidad y se
  // limpia al reactivarlo, para que el contador se reinicie si el restaurante
  // vuelve a publicarla. Columna faltante (migración pendiente) la resuelve el
  // mismo retry loop de abajo, igual que cualquier otro campo.
  if (updates.activo !== undefined) {
    updates.inactivo_desde = updates.activo ? null : new Date().toISOString();
  }

  // Un cambio que solo toca "activo" (+ inactivo_desde, que viaja siempre junto)
  // es un toggle de visibilidad del restaurante, no una edición de contenido —
  // no debe mandar la publicación de vuelta a revisión.
  const soloVisibilidad = Object.keys(updates).length > 0 &&
    Object.keys(updates).every(k => k === 'activo' || k === 'inactivo_desde');

  // BUG 2: Restaurantes nunca pueden aprobar directamente — strip any estado_aprobacion del body
  if (req.usuario.rol !== 'admin') {
    delete updates.estado_aprobacion;
    // Si editó el contenido de una bolsa aprobada o rechazada, vuelve a revisión del admin
    if (!soloVisibilidad && (bolsa.estado_aprobacion === 'aprobado' || bolsa.estado_aprobacion === 'rechazado')) {
      updates.estado_aprobacion = 'pendiente';
      updates.motivo_rechazo = null;
    } else if (!soloVisibilidad && bolsa.estado_aprobacion === 'pendiente' && bolsa.motivo_rechazo) {
      // Estaba en "pedir cambios" (pendiente + motivo). Al reenviar, limpiar el
      // motivo para que el admin vea que el restaurante ya corrigió y quede
      // claro en la cola que espera una revisión nueva, no la misma de antes.
      updates.motivo_rechazo = null;
    }
  } else if (req.body.estado_aprobacion !== undefined) {
    updates.estado_aprobacion = req.body.estado_aprobacion;
  }

  // Reintenta quitando, una por una, las columnas que el propio error de la BD
  // reporte como inexistentes — nunca se inventa/crea el campo, solo se deja de
  // enviar el que realmente falta y se sigue trabajando con los campos reales.
  let data, error;
  const columnasOmitidas = [];
  for (let intento = 0; intento <= campos.length; intento++) {
    const r = await supabase.from('bolsas').update(updates).eq('id', req.params.id).select().single();
    data = r.data; error = r.error;
    if (!error) break;
    const columnaFaltante = extraerColumnaFaltante(error);
    if (!columnaFaltante || !(columnaFaltante in updates)) break;
    delete updates[columnaFaltante];
    columnasOmitidas.push(columnaFaltante);
  }
  if (error) return res.status(400).json({ error: error.message });
  if (columnasOmitidas.length) {
    console.warn('[PUT /bolsas/:id] columnas omitidas por no existir en la BD:', columnasOmitidas.join(', '));
  }
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
  // inactivo_desde marca desde cuándo cuenta el plazo de 5 días hábiles del cron
  // de limpieza (server.js). Si la columna aún no existe, reintentar sin ella.
  const { error } = await supabase.from('bolsas')
    .update({ activo: false, inactivo_desde: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) await supabase.from('bolsas').update({ activo: false }).eq('id', req.params.id);
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
