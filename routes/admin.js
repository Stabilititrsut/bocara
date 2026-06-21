const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { enviarEmail, templateAprobado, templateRechazado, templateSuspendido, templateSuspendidoUsuario, templateRehabilitadoUsuario } = require('../services/email');
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Acceso solo para administradores' });
  next();
}

// GET /api/admin/stats
router.get('/stats', authMiddleware, adminOnly, async (req, res) => {
  const [usersRes, negociosRes, pedidosRes, bolsasRes] = await Promise.all([
    supabase.from('usuarios').select('id', { count: 'exact', head: true }),
    supabase.from('negocios').select('id,verificado,activo,estado_verificacion'),
    supabase.from('pedidos').select('total,estado,estado_pago'),
    supabase.from('bolsas').select('co2_salvado_kg'),
  ]);
  const pedidos = pedidosRes.data || [];
  const pagados = pedidos.filter(p => p.estado_pago === 'pagado');
  const ingresos = pagados.reduce((s, p) => s + (p.total || 0), 0);
  const negocios = negociosRes.data || [];
  const comision = ingresos * 0.25;
  // Contar pendientes: estado_verificacion='pendiente' o activo=false y no verificado (legacy)
  const negocios_pendientes = negocios.filter(n =>
    n.estado_verificacion === 'pendiente' || (!n.verificado && n.activo === false && n.estado_verificacion !== 'rechazado')
  ).length;
  res.json({
    total_usuarios: usersRes.count || 0,
    total_negocios: negocios.length,
    negocios_activos: negocios.filter(n => n.activo !== false).length,
    negocios_sin_verificar: negocios_pendientes,
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
    .select('id,email,nombre,apellido,rol,telefono,puntos,total_bolsas_salvadas,total_ahorrado,created_at,creado_en,negocios(activo)')
    .order('created_at', { ascending: false });
  if (rol && rol !== 'todos') query = query.eq('rol', rol);
  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('usuarios').select('id,email,nombre,apellido,rol,telefono,puntos');
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  const usuarios = (data || []).map(({ negocios, ...u }) => ({
    ...u,
    negocio_activo: Array.isArray(negocios) && negocios.length > 0 ? negocios[0].activo : null,
  }));
  res.json(usuarios);
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
  const { motivo } = req.body || {};
  const { data: u } = await supabase.from('usuarios').select('rol,email,nombre,apellido').eq('id', req.params.id).single();
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.rol === 'admin') return res.status(403).json({ error: 'No se puede suspender a un administrador' });
  const { data, error } = await supabase.from('usuarios').update({ rol: 'suspendido' }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Enviar email de notificación
  if (u.email && motivo) {
    const nombreDisplay = [u.nombre, u.apellido].filter(Boolean).join(' ') || 'Usuario';
    console.log(`[suspender-usuario] Enviando email a ${u.email} — motivo: "${motivo}"`);
    enviarEmail({
      to: u.email,
      subject: 'Cuenta suspendida — Bocara Food',
      html: templateSuspendidoUsuario(nombreDisplay, u.email, motivo),
    }).catch(e => console.error('[suspender-usuario] Error email:', e.message));
  }

  res.json(data);
});

// PUT /api/admin/usuarios/:id/rehabilitar
router.put('/usuarios/:id/rehabilitar', authMiddleware, adminOnly, async (req, res) => {
  const { rol_restaurar } = req.body;
  const rolFinal = rol_restaurar || 'cliente';

  const { data: u } = await supabase.from('usuarios').select('email,nombre,apellido').eq('id', req.params.id).single();

  const { data, error } = await supabase.from('usuarios').update({ rol: rolFinal }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });

  if (u?.email) {
    const nombreDisplay = [u.nombre, u.apellido].filter(Boolean).join(' ') || 'Usuario';
    console.log(`[rehabilitar-usuario] Enviando email a ${u.email}`);
    enviarEmail({
      to: u.email,
      subject: '✅ Tu cuenta en Bocara Food ha sido reactivada',
      html: templateRehabilitadoUsuario(nombreDisplay, u.email),
    }).catch(e => console.error('[rehabilitar-usuario] Error email:', e.message));
  }

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

// GET /api/admin/negocios/pendientes — restaurantes esperando verificación
router.get('/negocios/pendientes', authMiddleware, adminOnly, async (req, res) => {
  // Intentar con estado_verificacion primero
  let { data, error } = await supabase
    .from('negocios')
    .select('*')
    .eq('estado_verificacion', 'pendiente')
    .order('created_at', { ascending: false });

  if (error) {
    // Fallback: columna no existe aún — usar verificado + activo
    const r = await supabase
      .from('negocios')
      .select('id,nombre,descripcion,categoria,zona,ciudad,telefono,direccion,email,verificado,activo,propietario_id,created_at')
      .eq('verificado', false)
      .eq('activo', false)
      .order('created_at', { ascending: false });
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  // Enriquecer con datos del propietario (query separada, más compatible)
  const negocios = data || [];
  if (negocios.length > 0) {
    const propIds = [...new Set(negocios.map(n => n.propietario_id).filter(Boolean))];
    if (propIds.length > 0) {
      const { data: users } = await supabase
        .from('usuarios')
        .select('id,nombre,apellido,email,expo_push_token')
        .in('id', propIds);
      const usersMap = {};
      for (const u of (users || [])) usersMap[u.id] = u;
      for (const n of negocios) {
        n.usuarios = usersMap[n.propietario_id] || null;
      }
    }
  }
  res.json(negocios);
});

async function notificarPropietario(propietarioId, nombre, tipo, titulo, cuerpo, extra = {}) {
  try {
    const { data: u } = await supabase.from('usuarios').select('expo_push_token,email,nombre,apellido').eq('id', propietarioId).single();
    if (u?.expo_push_token) {
      await enviarNotificacionPush(u.expo_push_token, titulo, cuerpo, { tipo, ...extra }).catch(e =>
        console.error(`[notificar] Push error para ${propietarioId}:`, e.message)
      );
    }
    await guardarNotificacion(supabase, propietarioId, tipo, titulo, cuerpo, extra).catch(e =>
      console.error(`[notificar] Error guardando notificación:`, e.message)
    );

    // Enviar email si hay dirección
    if (u?.email) {
      const nombreProp = [u.nombre, u.apellido].filter(Boolean).join(' ') || 'Propietario';
      console.log(`[notificar] Intentando email tipo="${tipo}" → ${u.email}`);
      if (tipo === 'negocio_aprobado') {
        await enviarEmail({
          to: u.email,
          subject: '🎉 ¡Tu negocio fue aprobado en Bocara Food!',
          html: templateAprobado(nombre, nombreProp),
        });
      } else if (tipo === 'negocio_rechazado') {
        await enviarEmail({
          to: u.email,
          subject: '❌ Actualización sobre tu solicitud en Bocara Food',
          html: templateRechazado(nombre, nombreProp, extra.motivo, extra.campos),
        });
      } else if (tipo === 'negocio_suspendido') {
        console.log(`[notificar] Email suspensión → negocio="${nombre}" propietario="${nombreProp}" motivo="${extra.motivo}"`);
        await enviarEmail({
          to: u.email,
          subject: '⚠️ Tu cuenta en Bocara Food fue suspendida',
          html: templateSuspendido(nombre, nombreProp, extra.motivo),
        });
      }
    } else {
      console.warn(`[notificar] Propietario ${propietarioId} sin email — no se envió correo`);
    }
  } catch (e) {
    console.error(`[notificar] Error en notificarPropietario (tipo=${tipo}):`, e.message);
  }
}

// PUT /api/admin/negocios/:id/verificar (alias de /aprobar)
router.put('/negocios/:id/verificar', authMiddleware, adminOnly, async (req, res) => {
  const updates = { verificado: true, activo: true };
  const { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  // Intentar marcar estado_verificacion si la columna existe
  await supabase.from('negocios').update({ estado_verificacion: 'aprobado', motivo_rechazo: null }).eq('id', req.params.id);
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_aprobado', '🎉 ¡Negocio aprobado!', `${data.nombre} ya está activo en Bocara. ¡Empieza a publicar bolsas!`);
  res.json({ ...data, estado_verificacion: 'aprobado' });
});

// PUT /api/admin/negocios/:id/aprobar
router.put('/negocios/:id/aprobar', authMiddleware, adminOnly, async (req, res) => {
  const updates = { verificado: true, activo: true };
  const { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('negocios').update({ estado_verificacion: 'aprobado', motivo_rechazo: null }).eq('id', req.params.id);
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_aprobado', '🎉 ¡Negocio aprobado!', `${data.nombre} ya está activo en Bocara. ¡Empieza a publicar bolsas!`);
  res.json({ ...data, estado_verificacion: 'aprobado' });
});

// PUT /api/admin/negocios/:id/rechazar
router.put('/negocios/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  const { motivo, campos_incorrectos } = req.body;
  const { data, error } = await supabase.from('negocios').update({ verificado: false, activo: false }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  const rechazarUpd = { estado_verificacion: 'rechazado' };
  const hayCampos = Array.isArray(campos_incorrectos) && campos_incorrectos.length > 0;
  if (motivo || hayCampos) {
    rechazarUpd.motivo_rechazo = JSON.stringify({ texto: motivo || '', campos: campos_incorrectos || [] });
  }
  await supabase.from('negocios').update(rechazarUpd).eq('id', req.params.id);
  const motivoTexto = motivo ? `: ${motivo}` : (hayCampos ? '. Revisa los campos indicados en el correo.' : '. Contacta a soporte para más información.');
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_rechazado', '❌ Solicitud rechazada', `Tu solicitud para ${data.nombre} fue rechazada${motivoTexto}`, { motivo, campos: campos_incorrectos || [] });
  res.json({ ...data, estado_verificacion: 'rechazado', motivo_rechazo: rechazarUpd.motivo_rechazo });
});

// PUT /api/admin/negocios/:id/toggle
router.put('/negocios/:id/toggle', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body || {};
  const { data: negocio } = await supabase.from('negocios').select('activo,propietario_id,nombre').eq('id', req.params.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const nuevoActivo = !negocio.activo;
  const { data, error } = await supabase
    .from('negocios').update({ activo: nuevoActivo }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  // Notificar al propietario cuando se suspende con motivo
  if (!nuevoActivo && motivo && negocio.propietario_id) {
    await notificarPropietario(
      negocio.propietario_id, negocio.nombre, 'negocio_suspendido',
      '⚠️ Tu negocio fue suspendido',
      `"${negocio.nombre}" ha sido suspendido temporalmente. Motivo: ${motivo}`,
      { motivo }
    );
  }
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

// POST /api/admin/geocodificar — geocodifica todos los negocios sin coordenadas (endpoint canónico)
router.post('/geocodificar', authMiddleware, adminOnly, async (req, res) => {
  const { data: negocios, error } = await supabase
    .from('negocios')
    .select('id,nombre,direccion,zona,ciudad')
    .or('latitud.is.null,longitud.is.null');
  if (error) return res.status(500).json({ error: error.message });

  let geocodificados = 0;
  const sin_resultado = [];
  console.log(`[geocodificar] Iniciando para ${negocios?.length || 0} negocios sin coords`);
  for (const n of (negocios || [])) {
    try {
      const coords = await geocodeAddress(n.direccion, n.zona, n.ciudad, n.nombre);
      if (coords) {
        await supabase.from('negocios').update({ latitud: coords.lat, longitud: coords.lng }).eq('id', n.id);
        geocodificados++;
        console.log(`[geocodificar] ✓ ${n.nombre}: ${coords.lat}, ${coords.lng}`);
      } else {
        sin_resultado.push(n.nombre);
        console.warn(`[geocodificar] ✗ Sin resultado: "${n.nombre}" — dir="${n.direccion}" zona="${n.zona}" ciudad="${n.ciudad}"`);
      }
      await new Promise(r => setTimeout(r, 1100));
    } catch (e) {
      sin_resultado.push(n.nombre);
      console.error(`[geocodificar] Error con "${n.nombre}":`, e.message);
    }
  }
  console.log(`[geocodificar] Resultado: ${geocodificados} geocodificados, ${sin_resultado.length} sin resultado`);
  res.json({ geocodificados, fallidos: sin_resultado.length, sin_resultado, total: negocios?.length || 0 });
});

// GET /api/admin/geocodificar-negocios/count — cuántos negocios faltan por geocodificar
router.get('/geocodificar-negocios/count', authMiddleware, adminOnly, async (req, res) => {
  const { count, error } = await supabase
    .from('negocios')
    .select('id', { count: 'exact', head: true })
    .or('latitud.is.null,longitud.is.null');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0 });
});

// POST /api/admin/geocodificar-negocios — geocodifica todos los negocios sin coordenadas
router.post('/geocodificar-negocios', authMiddleware, adminOnly, async (req, res) => {
  const { data: negocios, error } = await supabase
    .from('negocios')
    .select('id,nombre,direccion,zona,ciudad')
    .or('latitud.is.null,longitud.is.null');
  if (error) return res.status(500).json({ error: error.message });

  const resultados = { ok: 0, sin_resultado: 0, errores: 0 };
  console.log(`[geocodificar] Iniciando geocodificación de ${negocios?.length || 0} negocios`);
  // Nominatim pide máximo 1 req/seg — procesamos secuencialmente con delay
  for (const n of (negocios || [])) {
    try {
      const coords = await geocodeAddress(n.direccion, n.zona, n.ciudad, n.nombre);
      if (coords) {
        await supabase.from('negocios').update({ latitud: coords.lat, longitud: coords.lng }).eq('id', n.id);
        resultados.ok++;
        console.log(`[geocodificar] ✓ ${n.nombre}: ${coords.lat}, ${coords.lng}`);
      } else {
        resultados.sin_resultado++;
        console.warn(`[geocodificar] ✗ Sin resultado: "${n.nombre}" — ${n.direccion}, ${n.zona}`);
      }
      await new Promise(r => setTimeout(r, 1100)); // respetar rate limit de Nominatim
    } catch (e) {
      resultados.errores++;
      console.error(`[geocodificar] Error con "${n.nombre}":`, e.message);
    }
  }
  console.log(`[geocodificar] Resultado final:`, resultados);
  res.json({ total: negocios?.length || 0, ...resultados });
});

// GET /api/admin/liquidaciones — deuda pendiente por restaurante
router.get('/liquidaciones', authMiddleware, adminOnly, async (req, res) => {
  // Calcular neto por restaurante desde pedidos no liquidados
  const { data: pedidos } = await supabase
    .from('pedidos')
    .select('negocio_id,precio_bolsa,total,monto_neto_restaurante,created_at,negocios(id,nombre,datos_bancarios,propietario_id)')
    .eq('estado', 'recogido')
    .is('liquidacion_id', null);

  // Liquidaciones ya pagadas
  let { data: liquidaciones } = await supabase
    .from('liquidaciones')
    .select('*,negocios(nombre)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (!liquidaciones) liquidaciones = [];

  // Agrupar pedidos por negocio
  const mapa = {};
  for (const p of (pedidos || [])) {
    const nid = p.negocio_id;
    if (!mapa[nid]) {
      mapa[nid] = {
        negocio_id: nid,
        nombre: p.negocios?.nombre || 'Sin nombre',
        datos_bancarios: p.negocios?.datos_bancarios || null,
        propietario_id: p.negocios?.propietario_id,
        pedidos: 0,
        bruto: 0,
        neto: 0,
      };
    }
    const bruto = p.precio_bolsa || p.total || 0;
    mapa[nid].pedidos += 1;
    mapa[nid].bruto += bruto;
    mapa[nid].neto += p.monto_neto_restaurante || bruto * 0.75;
  }

  // Enriquecer con push token del propietario
  const propIds = [...new Set(Object.values(mapa).map((r) => r.propietario_id).filter(Boolean))];
  if (propIds.length > 0) {
    const { data: propUsers } = await supabase
      .from('usuarios').select('id,expo_push_token').in('id', propIds);
    const tokenMap = {};
    for (const u of (propUsers || [])) tokenMap[u.id] = u.expo_push_token;
    for (const r of Object.values(mapa)) {
      r.push_token = tokenMap[r.propietario_id] || null;
    }
  }
  const pendientes = Object.values(mapa)
    .map(r => ({ ...r, bruto: parseFloat(r.bruto.toFixed(2)), neto: parseFloat(r.neto.toFixed(2)) }))
    .filter(r => r.neto > 0)
    .sort((a, b) => b.neto - a.neto);

  res.json({ pendientes, historial: liquidaciones });
});

// POST /api/admin/liquidaciones/:restaurante_id/pagar
router.post('/liquidaciones/:restaurante_id/pagar', authMiddleware, adminOnly, async (req, res) => {
  const { restaurante_id } = req.params;
  const { datos_transferencia, monto } = req.body;

  // Buscar pedidos pendientes del restaurante
  const { data: pedidosPend } = await supabase
    .from('pedidos')
    .select('id,precio_bolsa,total,monto_neto_restaurante')
    .eq('negocio_id', restaurante_id)
    .eq('estado', 'recogido')
    .is('liquidacion_id', null);

  const bruto = (pedidosPend || []).reduce((s, p) => s + (p.precio_bolsa || p.total || 0), 0);
  const neto = monto || parseFloat(((pedidosPend || []).reduce((s, p) => s + (p.monto_neto_restaurante || (p.precio_bolsa || p.total || 0) * 0.75), 0)).toFixed(2));

  // Crear liquidacion
  const { data: liq, error: liqErr } = await supabase
    .from('liquidaciones')
    .insert([{
      negocio_id: restaurante_id,
      monto: neto,
      ventas_brutas: parseFloat(bruto.toFixed(2)),
      comision_bocara: parseFloat((bruto * 0.25).toFixed(2)),
      estado: 'pagado',
      datos_transferencia: datos_transferencia || null,
      total_pedidos: (pedidosPend || []).length,
      pagado_en: new Date().toISOString(),
      pagado_por: req.usuario.id,
    }])
    .select()
    .single();
  if (liqErr) return res.status(400).json({ error: liqErr.message });

  // Marcar pedidos como liquidados
  if (pedidosPend?.length && liq?.id) {
    const ids = pedidosPend.map(p => p.id);
    await supabase.from('pedidos').update({ liquidacion_id: liq.id }).in('id', ids);
  }

  // Push al propietario
  const { data: negocio } = await supabase
    .from('negocios')
    .select('nombre,propietario_id')
    .eq('id', restaurante_id)
    .single();
  if (negocio?.propietario_id) {
    const { data: propUser } = await supabase
      .from('usuarios').select('expo_push_token').eq('id', negocio.propietario_id).single();
    if (propUser?.expo_push_token) {
      await enviarNotificacionPush(
        propUser.expo_push_token,
        '💸 ¡Pago recibido!',
        `Recibiste Q${neto.toFixed(2)} por ${(pedidosPend || []).length} pedidos. Revisa tu cuenta bancaria.`,
        { tipo: 'liquidacion_pagada', monto: neto }
      );
    }
    await guardarNotificacion(supabase, negocio.propietario_id, 'liquidacion', '¡Pago recibido!', `Q${neto.toFixed(2)} transferidos a tu cuenta.`, { monto: neto });
  }

  res.json({ ok: true, liquidacion: liq });
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

// GET /api/admin/contenido/pendiente — bolsas y cupones pendientes de aprobación
router.get('/contenido/pendiente', authMiddleware, adminOnly, async (req, res) => {
  let { data, error } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,zona,ciudad,propietario_id)')
    .eq('estado_aprobacion', 'pendiente')
    .order('created_at', { ascending: false });

  if (error) {
    // Columna no existe aún — devolver lista vacía de forma segura
    return res.json([]);
  }

  const bolsas = data || [];

  // Enriquecer con datos del propietario
  if (bolsas.length > 0) {
    const propIds = [...new Set(bolsas.map(b => b.negocios?.propietario_id).filter(Boolean))];
    if (propIds.length > 0) {
      const { data: users } = await supabase
        .from('usuarios')
        .select('id,nombre,apellido,email,expo_push_token')
        .in('id', propIds);
      const usersMap = {};
      for (const u of (users || [])) usersMap[u.id] = u;
      for (const b of bolsas) {
        if (b.negocios?.propietario_id) {
          b.negocios.usuarios = usersMap[b.negocios.propietario_id] || null;
        }
      }
    }
  }

  res.json(bolsas);
});

// PUT /api/admin/bolsas/:id/aprobar
router.put('/bolsas/:id/aprobar', authMiddleware, adminOnly, async (req, res) => {
  const { data: bolsa, error: fetchErr } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });

  // Intentar con estado_aprobacion; si la columna no existe, activar con activo=true
  let { data, error } = await supabase
    .from('bolsas')
    .update({ estado_aprobacion: 'aprobado', activo: true, motivo_rechazo: null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    // Fallback: solo activar la bolsa
    const r = await supabase.from('bolsas').update({ activo: true }).eq('id', req.params.id).select().single();
    if (r.error) return res.status(400).json({ error: r.error.message });
    data = r.data;
  }

  // Notificar al propietario del restaurante
  const propietarioId = bolsa.negocios?.propietario_id;
  if (propietarioId) {
    await notificarPropietario(
      propietarioId,
      bolsa.nombre,
      'bolsa_aprobada',
      '✅ ¡Bolsa aprobada!',
      `Tu bolsa "${bolsa.nombre}" ya está visible para los clientes en Bocara.`,
      { bolsaId: bolsa.id, negocioId: bolsa.negocio_id }
    );
  }

  // Notificar a favoritos que hay una nueva bolsa disponible
  try {
    const { data: negocio } = await supabase.from('negocios').select('nombre').eq('id', bolsa.negocio_id).single();
    const nombreNegocio = negocio?.nombre || 'Tu restaurante favorito';
    const { data: favs } = await supabase
      .from('favoritos')
      .select('usuario_id, usuarios(expo_push_token)')
      .eq('negocio_id', bolsa.negocio_id);
    if (favs?.length) {
      const { enviarNotificacionesMultiples } = require('../services/notificaciones');
      const tokens = favs.map(f => f.usuarios?.expo_push_token).filter(Boolean);
      if (tokens.length) {
        await enviarNotificacionesMultiples(
          tokens,
          '🛍️ ¡Nueva bolsa disponible!',
          `${nombreNegocio} publicó: ${bolsa.nombre}`,
          { negocioId: bolsa.negocio_id, bolsaId: bolsa.id, screen: 'home' }
        );
      }
      for (const fav of favs) {
        await guardarNotificacion(
          supabase, fav.usuario_id, 'nueva_bolsa',
          '🛍️ Nueva bolsa disponible',
          `${nombreNegocio} publicó: ${bolsa.nombre}`,
          { negocioId: bolsa.negocio_id, bolsaId: bolsa.id }
        );
      }
    }
  } catch { /* tabla favoritos puede no existir aún — fallo silencioso */ }

  res.json(data);
});

// PUT /api/admin/bolsas/:id/rechazar
router.put('/bolsas/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body;

  const { data: bolsa, error: fetchErr } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });

  const updates = { estado_aprobacion: 'rechazado', activo: false };
  if (motivo) updates.motivo_rechazo = motivo;

  let { data, error } = await supabase
    .from('bolsas')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    // Fallback: solo desactivar la bolsa
    const r = await supabase.from('bolsas').update({ activo: false }).eq('id', req.params.id).select().single();
    if (r.error) return res.status(400).json({ error: r.error.message });
    data = r.data;
  }

  // Notificar al propietario del restaurante
  const propietarioId = bolsa.negocios?.propietario_id;
  if (propietarioId) {
    const motivoTexto = motivo ? `: ${motivo}` : '. Contacta a soporte para más información.';
    await notificarPropietario(
      propietarioId,
      bolsa.nombre,
      'bolsa_rechazada',
      '❌ Bolsa rechazada',
      `Tu bolsa "${bolsa.nombre}" fue rechazada${motivoTexto}`,
      { bolsaId: bolsa.id, negocioId: bolsa.negocio_id, motivo }
    );
  }

  res.json(data);
});

// GET /api/admin/cambios-perfil — solicitudes de cambio de perfil de restaurantes
router.get('/cambios-perfil', authMiddleware, adminOnly, async (req, res) => {
  let { data, error } = await supabase
    .from('negocio_cambios_pendientes')
    .select('*, negocios(id,nombre,propietario_id,usuarios:propietario_id(nombre,apellido,email))')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.json([]); // tabla puede no existir aún
  res.json(data || []);
});

// PUT /api/admin/cambios-perfil/:id/aprobar
router.put('/cambios-perfil/:id/aprobar', authMiddleware, adminOnly, async (req, res) => {
  const { data: solicitud, error: fetchErr } = await supabase
    .from('negocio_cambios_pendientes')
    .select('*, negocios(id,propietario_id,nombre)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (solicitud.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya fue procesada' });

  // Aplicar los cambios al negocio
  const { error: updErr } = await supabase
    .from('negocios')
    .update(solicitud.cambios)
    .eq('id', solicitud.negocio_id);
  if (updErr) return res.status(400).json({ error: updErr.message });

  // Marcar solicitud como aprobada
  await supabase.from('negocio_cambios_pendientes')
    .update({ estado: 'aprobado', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);

  // Notificar al propietario
  const propietarioId = solicitud.negocios?.propietario_id;
  if (propietarioId) {
    await guardarNotificacion(supabase, propietarioId, 'perfil_aprobado',
      '✅ Cambios de perfil aprobados',
      `Los cambios que enviaste para "${solicitud.negocios?.nombre}" fueron aprobados y ya están activos.`,
      { negocioId: solicitud.negocio_id }
    );
  }

  res.json({ ok: true });
});

// PUT /api/admin/cambios-perfil/:id/rechazar
router.put('/cambios-perfil/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body;
  const { data: solicitud, error: fetchErr } = await supabase
    .from('negocio_cambios_pendientes')
    .select('*, negocios(id,propietario_id,nombre)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });

  await supabase.from('negocio_cambios_pendientes')
    .update({ estado: 'rechazado', motivo_rechazo: motivo || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);

  const propietarioId = solicitud.negocios?.propietario_id;
  if (propietarioId) {
    const motivoTexto = motivo ? `: ${motivo}` : '. Contacta al equipo Bocara para más información.';
    await guardarNotificacion(supabase, propietarioId, 'perfil_rechazado',
      '❌ Cambios de perfil rechazados',
      `Los cambios enviados para "${solicitud.negocios?.nombre}" fueron rechazados${motivoTexto}`,
      { negocioId: solicitud.negocio_id, motivo }
    );
  }

  res.json({ ok: true });
});

module.exports = router;
