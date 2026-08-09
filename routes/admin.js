const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { enviarEmail, templateAprobado, templateRechazado, templateSuspendido, templateSuspendidoUsuario, templateRehabilitadoUsuario } = require('../services/email');
const { obtenerConfig, obtenerComisionFraccion, COMISION_PLATAFORMA_FRACCION } = require('../services/configuracion');
const router = express.Router();

// 2026-08-09: ya no confía en req.usuario.rol (el rol tal como venía en el
// JWT firmado al momento del login/registro). POST /auth/registro aceptaba
// cualquier valor de `rol` sin validar, así que cualquiera podía autoemitirse
// un JWT con rol:"admin" (ya corregido ahí) — pero un JWT viejo emitido antes
// de ese fix, o el rol de un admin real que fue degradado después, seguían
// pasando esta verificación mientras el token no expirara. Ahora se confirma
// el rol contra la base de datos en cada request (con cache — ver esAdminReal
// en middleware/auth.js), igual que ya se hacía para la suspensión.
async function adminOnly(req, res, next) {
  let esAdmin = false;
  try {
    esAdmin = await authMiddleware.esAdminReal(req.usuario.id);
  } catch (err) {
    console.error('[adminOnly] esAdminReal falló, denegando (fail-closed):', err.message);
  }
  if (!esAdmin) return res.status(403).json({ error: 'Acceso solo para administradores' });
  next();
}

// GET /api/admin/stats
router.get('/stats', authMiddleware, adminOnly, async (req, res) => {
  const [usersRes, negociosRes, pedidosRes] = await Promise.all([
    supabase.from('usuarios').select('id', { count: 'exact', head: true }),
    supabase.from('negocios').select('id,verificado,activo,estado_verificacion'),
    supabase.from('pedidos').select('total,estado,estado_pago,cubo_payment_intent_token,cubo_identifier,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon'),
  ]);
  const pedidos = pedidosRes.data || [];
  // 'cancelado' excluido explícitamente: /pedidos/:id/cancelar (admin, con reembolso)
  // nunca resetea estado_pago, así que un pedido reembolsado se queda con
  // estado_pago='pagado' para siempre. Sin este filtro, ingresos_totales y
  // comision_generada cuentan ventas que en realidad fueron devueltas.
  //
  // cubo_payment_intent_token/cubo_identifier no nulos, además de estado_pago:
  // estado_pago='pagado' también lo escriben /pedidos/crear (sin pasarela) y el
  // webhook legacy de PayU, ninguno con verificación real. Esos dos campos solo
  // se escriben juntos dentro de confirmar_pago_cubo, después de que el webhook
  // confirmó el pago con Cubo de forma independiente — es la única evidencia
  // confiable de que el dinero se movió de verdad.
  //
  // Los contadores de pedidos (total_pedidos, pedidos_completados) también deben
  // filtrarse por `pagados`: un pedido en borrador/pendiente/cancelado nunca tuvo
  // dinero real de por medio y no debe aparecer en ningún indicador del dashboard.
  const pagados = pedidos.filter(p =>
    p.estado_pago === 'pagado' && p.estado !== 'cancelado' &&
    p.cubo_payment_intent_token != null && p.cubo_identifier != null
  );
  const ingresos = pagados.reduce((s, p) => s + (p.total || 0), 0);
  const negocios = negociosRes.data || [];
  // Comisión de Bocara sumada desde el snapshot financiero guardado en cada pedido
  // (comision_bocara + comision_pasarela), no recalculada sobre `ingresos` con el
  // % de configuración actual — así las cifras no se mueven retroactivamente si
  // la comisión configurada cambia después de una venta.
  const comisionBocara  = pagados.reduce((s, p) => s + (p.comision_bocara   || 0), 0);
  const cargoPlataforma = pagados.reduce((s, p) => s + (p.comision_pasarela || 0), 0);
  const propinasTotales = pagados.reduce((s, p) => s + (p.propina           || 0), 0);
  const pagoRestaurantes = pagados.reduce((s, p) => s + (p.monto_neto_restaurante || 0), 0);
  const descuentosCupon = pagados.reduce((s, p) => s + (p.descuento_cupon || 0), 0);
  const comision = comisionBocara + cargoPlataforma; // total ingreso Bocara bruto: 25% + 3.5%, ANTES de cupones
  // Bocara absorbe el descuento de cupón de su propia comisión (el restaurante
  // siempre recibe su 75%+propina+envío completo, sin importar el cupón — los
  // cupones no son promociones del restaurante). Puede quedar negativo si el
  // descuento de una campaña supera lo que Bocara ganó en esas ventas — eso es
  // una pérdida real y debe verse como tal, no camuflarse dentro de "comisión".
  const comisionBocaraNeta = comision - descuentosCupon;
  // Contar pendientes: estado_verificacion='pendiente' o activo=false y no verificado (legacy)
  const negocios_pendientes = negocios.filter(n =>
    n.estado_verificacion === 'pendiente' || (!n.verificado && n.activo === false && n.estado_verificacion !== 'rechazado')
  ).length;
  res.json({
    total_usuarios: usersRes.count || 0,
    total_negocios: negocios.length,
    negocios_activos: negocios.filter(n => n.activo !== false).length,
    negocios_sin_verificar: negocios_pendientes,
    total_pedidos: pagados.length,
    pedidos_completados: pagados.filter(p => p.estado === 'completado' || p.estado === 'recogido').length,
    ingresos_totales: ingresos,
    comision_generada: comisionBocaraNeta, // total ingreso Bocara YA NETO de cupones
    comision_bocara: comisionBocara,
    cargo_plataforma: cargoPlataforma,
    propinas_totales: propinasTotales,
    pago_restaurantes: pagoRestaurantes,
    descuentos_cupon: descuentosCupon,
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
  authMiddleware.invalidateUsuarioCache(req.params.id);
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
  authMiddleware.invalidateUsuarioCache(req.params.id);

  // Cascada: si el usuario suspendido es dueño de un restaurante, apagar también
  // su negocio (mismo campo `activo` que ya usa el toggle de negocios) — de lo
  // contrario el negocio sigue visible y recibiendo pedidos con el dueño bloqueado.
  if (u.rol === 'restaurante') {
    const { data: negocio } = await supabase
      .from('negocios').select('id,activo').eq('propietario_id', req.params.id).maybeSingle();
    if (negocio && negocio.activo !== false) {
      await supabase.from('negocios').update({ activo: false }).eq('id', negocio.id);
    }
  }

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

  // No confiar ciegamente en lo que mande el cliente: si el usuario tiene un
  // negocio asociado (dueño de restaurante), el rol correcto es 'restaurante'
  // sin importar qué llegue en rol_restaurar — evita que un dueño suspendido
  // se reactive como 'cliente' y pierda acceso a su negocio.
  const { data: negocioPropio } = await supabase
    .from('negocios').select('id,activo').eq('propietario_id', req.params.id).maybeSingle();
  const rolFinal = negocioPropio ? 'restaurante' : (rol_restaurar || 'cliente');

  const { data: u } = await supabase.from('usuarios').select('email,nombre,apellido,rol').eq('id', req.params.id).single();

  const { data, error } = await supabase.from('usuarios').update({ rol: rolFinal }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  authMiddleware.invalidateUsuarioCache(req.params.id);

  // Cascada inversa a la de suspender: si el dueño estaba realmente suspendido
  // y esa suspensión fue la que apagó su negocio (negocios.activo=false), al
  // rehabilitarlo debe reactivarse también — de lo contrario el rol se
  // restaura pero el restaurante sigue invisible para los clientes.
  if (negocioPropio && u?.rol === 'suspendido' && negocioPropio.activo === false) {
    await supabase.from('negocios').update({ activo: true }).eq('id', negocioPropio.id);
  }

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
  // Una sola escritura atómica: verificado, activo y estado_verificacion deben
  // quedar consistentes juntos o no quedar aplicados en absoluto. Antes eran dos
  // updates separados y el segundo (estado_verificacion) no verificaba su error,
  // así que un fallo ahí dejaba el negocio "aprobado" en la respuesta pero
  // "pendiente" en la fila real — reaparecía al recargar /admin/negocios/pendientes.
  const { data, error } = await supabase
    .from('negocios')
    .update({ verificado: true, activo: true, estado_verificacion: 'aprobado', motivo_rechazo: null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_aprobado', '🎉 ¡Negocio aprobado!', `${data.nombre} ya está activo en Bocara. ¡Empieza a publicar bolsas!`);
  res.json(data);
});

// PUT /api/admin/negocios/:id/aprobar
router.put('/negocios/:id/aprobar', authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('negocios')
    .update({ verificado: true, activo: true, estado_verificacion: 'aprobado', motivo_rechazo: null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_aprobado', '🎉 ¡Negocio aprobado!', `${data.nombre} ya está activo en Bocara. ¡Empieza a publicar bolsas!`);
  res.json(data);
});

// PUT /api/admin/negocios/:id/rechazar
router.put('/negocios/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  const { motivo, campos_incorrectos } = req.body;
  const hayCampos = Array.isArray(campos_incorrectos) && campos_incorrectos.length > 0;
  const updates = { verificado: false, activo: false, estado_verificacion: 'rechazado' };
  if (motivo || hayCampos) {
    updates.motivo_rechazo = JSON.stringify({ texto: motivo || '', campos: campos_incorrectos || [] });
  }
  const { data, error } = await supabase.from('negocios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  const motivoTexto = motivo ? `: ${motivo}` : (hayCampos ? '. Revisa los campos indicados en el correo.' : '. Contacta a soporte para más información.');
  await notificarPropietario(data.propietario_id, data.nombre, 'negocio_rechazado', '❌ Solicitud rechazada', `Tu solicitud para ${data.nombre} fue rechazada${motivoTexto}`, { motivo, campos: campos_incorrectos || [] });
  res.json(data);
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

  // Venta real = hubo transacción monetaria confirmada por Cubo, sin importar si
  // ya se recogió. No exigir estado IN (completado,recogido): un pedido confirmado/
  // en_preparacion/listo ya cobró y debe verse en finanzas el mismo día, no hasta
  // que el cliente pase a recogerlo. 'cancelado' se excluye aparte porque el
  // endpoint de cancelación con reembolso no resetea estado_pago.
  //
  // cubo_payment_intent_token/cubo_identifier no nulos: estado_pago='pagado' solo
  // no basta — /pedidos/crear y el webhook legacy de PayU también lo escriben sin
  // verificación real contra ninguna pasarela. Esos dos campos son la única
  // evidencia confiable de un pago confirmado por Cubo (ver confirmar_pago_cubo).
  let query = supabase
    .from('pedidos')
    .select('id,total,estado,estado_pago,negocio_id,created_at,creado_en,cubo_payment_intent_token,cubo_identifier,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon,negocios(id,nombre,zona)')
    .eq('estado_pago', 'pagado')
    .neq('estado', 'cancelado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null);

  if (periodo === '7d') {
    const desde = new Date(Date.now() - 7 * 86400000).toISOString();
    query = query.gte('created_at', desde);
  } else if (periodo === '30d') {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    query = query.gte('created_at', desde);
  }

  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('pedidos').select('id,total,estado,estado_pago,negocio_id,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon,cubo_payment_intent_token,cubo_identifier')
      .eq('estado_pago', 'pagado').neq('estado', 'cancelado')
      .not('cubo_payment_intent_token', 'is', null).not('cubo_identifier', 'is', null);
    data = r.data; error = r.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  // Filtro defensivo en JS: solo pedidos realmente pagados, no cancelados y
  // verificados por Cubo cuentan para finanzas, sin importar si vino del camino
  // principal o del fallback.
  data = (data || []).filter(p =>
    p.estado_pago === 'pagado' && p.estado !== 'cancelado' &&
    p.cubo_payment_intent_token != null && p.cubo_identifier != null
  );

  // Agrupar por negocio. Cada componente se suma desde el snapshot financiero
  // guardado en el pedido (comision_bocara, comision_pasarela, monto_neto_restaurante,
  // propina) — nunca recalculado desde `bruto` con el % de configuración actual,
  // para que las cifras no cambien retroactivamente si la comisión configurada
  // cambia después de una venta. Desglose explícito: comisión 25%, cargo de
  // plataforma 3.5% (ambos ingreso de Bocara) y propinas (100% del restaurante,
  // separadas de su 75%) — nunca mezclados en un solo número.
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
        comisionBocara: 0,
        cargoPlataforma: 0,
        propinas: 0,
        neto: 0,
        descuentoCupon: 0,
      };
    }
    map[nid].pedidos += 1;
    map[nid].bruto += p.total || 0;
    map[nid].comisionBocara  += p.comision_bocara   || 0;
    map[nid].cargoPlataforma += p.comision_pasarela || 0;
    map[nid].propinas        += p.propina           || 0;
    map[nid].neto            += p.monto_neto_restaurante || 0;
    map[nid].descuentoCupon  += p.descuento_cupon   || 0;
  }
  // Bocara absorbe el descuento de cupón — nunca el restaurante (montoNetoRestaurante
  // arriba ya no lo incluye). "comision" queda NETO de cupones: puede ser negativo si
  // una campaña costó más de lo que esas ventas generaron — se muestra tal cual, no se oculta.
  const resumen = Object.values(map)
    .map(r => ({ ...r, comision: r.comisionBocara + r.cargoPlataforma - r.descuentoCupon }))
    .sort((a, b) => b.bruto - a.bruto);

  const totales = resumen.reduce((acc, r) => ({
    bruto:            acc.bruto            + r.bruto,
    comisionBocara:   acc.comisionBocara   + r.comisionBocara,
    cargoPlataforma:  acc.cargoPlataforma  + r.cargoPlataforma,
    propinas:         acc.propinas         + r.propinas,
    neto:             acc.neto             + r.neto,
    pedidos:          acc.pedidos          + r.pedidos,
    descuentoCupon:   acc.descuentoCupon   + r.descuentoCupon,
  }), { bruto: 0, comisionBocara: 0, cargoPlataforma: 0, propinas: 0, neto: 0, pedidos: 0, descuentoCupon: 0 });
  totales.comision = totales.comisionBocara + totales.cargoPlataforma - totales.descuentoCupon; // ingreso Bocara neto de cupones

  res.json({ resumen, totales });
});

// GET /api/admin/pedidos-todos — ventas reales, verificadas por Cubo, para
// finanzas y el dashboard. Únicos consumidores hoy: admin/index.tsx (gráfica
// semanal) y admin/financiero.tsx (transacciones + export) — ambos financieros,
// por eso el filtro va server-side y no queda a criterio del cliente.
//
// cubo_payment_intent_token/cubo_identifier no nulos, además de estado_pago:
// estado_pago='pagado' también lo escriben /pedidos/crear y el webhook legacy
// de PayU sin verificación real — ver confirmar_pago_cubo para el porqué estos
// dos campos son la única evidencia confiable de un pago confirmado por Cubo.
router.get('/pedidos-todos', authMiddleware, adminOnly, async (req, res) => {
  const { negocio_id, limite } = req.query;
  let query = supabase
    .from('pedidos')
    .select('id,total,estado,estado_pago,codigo_recogida,created_at,creado_en,negocio_id,usuario_id,liquidacion_id,precio_bolsa,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon,cubo_payment_intent_token,cubo_identifier,negocios(nombre),usuarios(nombre,email)')
    .eq('estado_pago', 'pagado')
    .neq('estado', 'cancelado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null)
    .order('created_at', { ascending: false })
    .limit(parseInt(limite) || 100);
  if (negocio_id) query = query.eq('negocio_id', negocio_id);
  let { data, error } = await query;
  if (error) {
    const r = await supabase.from('pedidos').select('id,total,estado,negocio_id,cubo_payment_intent_token,cubo_identifier')
      .eq('estado_pago', 'pagado').neq('estado', 'cancelado')
      .not('cubo_payment_intent_token', 'is', null).not('cubo_identifier', 'is', null).limit(100);
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
  // Calcular neto por restaurante desde pedidos no liquidados. Exigir
  // cubo_payment_intent_token/cubo_identifier no nulos: no se le puede pagar a
  // un restaurante por un pedido cuyo estado_pago='pagado' nunca fue verificado
  // contra Cubo (ver confirmar_pago_cubo) — pagar de más por eso es dinero real
  // perdido, no solo una cifra mal mostrada.
  const { data: pedidos } = await supabase
    .from('pedidos')
    .select('id,negocio_id,precio_bolsa,total,monto_neto_restaurante,comision_bocara,comision_pasarela,propina,created_at,negocios(id,nombre,datos_bancarios,propietario_id)')
    .in('estado', ['completado', 'recogido'])
    .eq('estado_pago', 'pagado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null)
    .is('liquidacion_id', null);

  // Liquidaciones ya pagadas
  let { data: liquidaciones } = await supabase
    .from('liquidaciones')
    .select('*,negocios(nombre)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (!liquidaciones) liquidaciones = [];

  // Agrupar pedidos por negocio. Desglose explícito para que la liquidación sea
  // auditable sin ambigüedad: cuánto es venta bruta del producto, cuánto se quedó
  // Bocara (comisión 25% + cargo de plataforma 3.5%, nunca mezclados) y cuánto de
  // eso es propina (100% del restaurante, aparte de su 75%).
  //
  // Todo sale de columnas guardadas al confirmar el pago — nunca de un % recalculado
  // aquí. Un pedido Cubo-verificado sin monto_neto_restaurante calculado sería un
  // dato faltante real (nunca debería pasar: routes/pagos.js siempre lo guarda al
  // crear el pedido) — se excluye del neto y se cuenta en `pedidos_sin_desglose`
  // para que quede visible en vez de camuflarse con una cifra inventada.
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
        comisionBocara: 0,
        cargoPlataforma: 0,
        propinas: 0,
        neto: 0,
        pedidosSinDesglose: 0,
      };
    }
    const bruto = p.precio_bolsa || p.total || 0;
    mapa[nid].pedidos += 1;
    mapa[nid].bruto += bruto;
    mapa[nid].comisionBocara  += p.comision_bocara   || 0;
    mapa[nid].cargoPlataforma += p.comision_pasarela || 0;
    mapa[nid].propinas        += p.propina           || 0;
    if (p.monto_neto_restaurante == null) {
      mapa[nid].pedidosSinDesglose += 1;
      console.warn('[LIQUIDACIONES] pedido pagado sin monto_neto_restaurante — excluido del neto:', p.id);
    } else {
      mapa[nid].neto += p.monto_neto_restaurante;
    }
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
    .map(r => ({
      ...r,
      bruto:           parseFloat(r.bruto.toFixed(2)),
      comisionBocara:  parseFloat(r.comisionBocara.toFixed(2)),
      cargoPlataforma: parseFloat(r.cargoPlataforma.toFixed(2)),
      propinas:        parseFloat(r.propinas.toFixed(2)),
      neto:            parseFloat(r.neto.toFixed(2)),
    }))
    .filter(r => r.neto > 0 || r.pedidosSinDesglose > 0)
    .sort((a, b) => b.neto - a.neto);

  res.json({ pendientes, historial: liquidaciones });
});

// POST /api/admin/liquidaciones/:restaurante_id/pagar
router.post('/liquidaciones/:restaurante_id/pagar', authMiddleware, adminOnly, async (req, res) => {
  const { restaurante_id } = req.params;
  const { datos_transferencia, monto } = req.body;

  // Buscar pedidos pendientes del restaurante — mismo filtro que GET /liquidaciones,
  // deben coincidir exactamente o el monto que se marca "pagado" aquí no
  // corresponderá con lo que el admin vio como pendiente.
  const { data: pedidosPend } = await supabase
    .from('pedidos')
    .select('id,precio_bolsa,total,monto_neto_restaurante,comision_bocara,comision_pasarela,propina')
    .eq('negocio_id', restaurante_id)
    .in('estado', ['completado', 'recogido'])
    .eq('estado_pago', 'pagado')
    .not('cubo_payment_intent_token', 'is', null)
    .not('cubo_identifier', 'is', null)
    .is('liquidacion_id', null);

  // Sin fallback por % recalculado: si algún pedido Cubo-verificado no tiene
  // monto_neto_restaurante guardado (no debería ocurrir — ver GET /liquidaciones),
  // no se le paga por ese pedido en este lote en vez de inventarle un monto; queda
  // fuera de `pedidosPend` filtrados aquí y se avisa por consola para investigar.
  const pedidosConDesglose = (pedidosPend || []).filter(p => p.monto_neto_restaurante != null);
  const pedidosSinDesglose = (pedidosPend || []).filter(p => p.monto_neto_restaurante == null);
  if (pedidosSinDesglose.length > 0) {
    console.warn('[LIQUIDACIONES PAGAR] pedidos sin monto_neto_restaurante excluidos del pago:',
      pedidosSinDesglose.map(p => p.id));
  }

  const bruto           = pedidosConDesglose.reduce((s, p) => s + (p.precio_bolsa || p.total || 0), 0);
  const comisionBocara  = pedidosConDesglose.reduce((s, p) => s + (p.comision_bocara   || 0), 0);
  const cargoPlataforma = pedidosConDesglose.reduce((s, p) => s + (p.comision_pasarela || 0), 0);
  const propinas        = pedidosConDesglose.reduce((s, p) => s + (p.propina           || 0), 0);
  const neto = monto || parseFloat(pedidosConDesglose.reduce((s, p) => s + p.monto_neto_restaurante, 0).toFixed(2));

  // Crear liquidacion — desglose completo guardado para que el pago quede auditable
  // sin ambigüedad: de dónde sale cada quetzal (venta, comisión, cargo de
  // plataforma, propina), no solo el monto final transferido.
  const { data: liq, error: liqErr } = await supabase
    .from('liquidaciones')
    .insert([{
      negocio_id: restaurante_id,
      monto: neto,
      ventas_brutas: parseFloat(bruto.toFixed(2)),
      comision_bocara: parseFloat(comisionBocara.toFixed(2)),
      comision_plataforma: parseFloat(cargoPlataforma.toFixed(2)),
      propinas: parseFloat(propinas.toFixed(2)),
      estado: 'pagado',
      datos_transferencia: datos_transferencia || null,
      total_pedidos: pedidosConDesglose.length,
      pagado_en: new Date().toISOString(),
      pagado_por: req.usuario.id,
    }])
    .select()
    .single();
  if (liqErr) return res.status(400).json({ error: liqErr.message });

  // Marcar como liquidados solo los pedidos que realmente entraron en este pago
  // (pedidosConDesglose) — los que se excluyeron por falta de monto_neto_restaurante
  // se quedan is('liquidacion_id', null) y volverán a aparecer en GET /liquidaciones
  // hasta que se investigue y corrija su dato faltante.
  if (pedidosConDesglose.length && liq?.id) {
    const ids = pedidosConDesglose.map(p => p.id);
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

  // Aprobar solo cambia el estado de revisión — nunca fuerza "activo": la visibilidad
  // la controla el restaurante con su propio switch, y aprobar una bolsa que el
  // restaurante ya había ocultado no debe hacerla reaparecer sin que él lo decida.
  let { data, error } = await supabase
    .from('bolsas')
    .update({ estado_aprobacion: 'aprobado', motivo_rechazo: null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    // Fallback legado: columna estado_aprobacion no existe en este despliegue —
    // sin ella no hay forma de "aprobar" salvo activar la bolsa directamente.
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

  // inactivo_desde marca desde cuándo cuenta el plazo de 5 días hábiles del cron
  // de limpieza (server.js). Si la columna aún no existe (migración pendiente:
  // sql/limpieza-automatica-bolsas.sql), se degrada sin ella en vez de fallar.
  const inactivoDesde = new Date().toISOString();
  const updates = { estado_aprobacion: 'rechazado', activo: false, inactivo_desde: inactivoDesde };
  if (motivo) updates.motivo_rechazo = motivo;

  let { data, error } = await supabase
    .from('bolsas')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    // Fallback 1: reintentar sin inactivo_desde (columna puede no existir aún)
    const { inactivo_desde, ...sinInactivoDesde } = updates;
    const r1 = await supabase.from('bolsas').update(sinInactivoDesde).eq('id', req.params.id).select().single();
    if (!r1.error) {
      data = r1.data;
    } else {
      // Fallback 2: solo desactivar la bolsa
      const r2 = await supabase.from('bolsas').update({ activo: false }).eq('id', req.params.id).select().single();
      if (r2.error) return res.status(400).json({ error: r2.error.message });
      data = r2.data;
    }
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

// PUT /api/admin/bolsas/:id/pedir-cambios — solicitar correcciones al restaurante
router.put('/bolsas/:id/pedir-cambios', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body;

  const { data: bolsa, error: fetchErr } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });

  // Mantener en pendiente con el motivo guardado para que el restaurante sepa qué corregir
  const { error: estadoErr } = await supabase.from('bolsas')
    .update({ estado_aprobacion: 'pendiente', motivo_rechazo: motivo || null })
    .eq('id', req.params.id);
  if (estadoErr) return res.status(400).json({ error: estadoErr.message });

  const propietarioId = bolsa.negocios?.propietario_id;
  if (propietarioId) {
    const motivoTexto = motivo ? `: ${motivo}` : '. Por favor revisa y reenvía la publicación.';
    await notificarPropietario(
      propietarioId,
      bolsa.nombre,
      'bolsa_cambios_solicitados',
      '⚠️ Se solicitan cambios en tu publicación',
      `El administrador te pide corregir "${bolsa.nombre}"${motivoTexto}`,
      { bolsaId: bolsa.id, negocioId: bolsa.negocio_id, motivo }
    );
  }

  res.json({ ok: true });
});

// GET /api/admin/cambios-perfil — solicitudes de cambio de perfil de restaurantes
router.get('/cambios-perfil', authMiddleware, adminOnly, async (req, res) => {
  let query = supabase
    .from('negocio_cambios_pendientes')
    .select('*, negocios(id,nombre,propietario_id,usuarios:propietario_id(nombre,apellido,email))')
    .order('created_at', { ascending: false })
    .limit(50);
  if (req.query.estado) query = query.eq('estado', req.query.estado);
  let { data, error } = await query;
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

  // Marcar solicitud como aprobada. reviewed_at (no updated_at, esa columna no
  // existe en negocio_cambios_pendientes) — si esta escritura fallara, la
  // solicitud quedaría en 'pendiente' para siempre pese a que los cambios ya
  // se aplicaron al negocio, dejando el banner "Cambios en revisión" fijo en
  // el panel del restaurante. Por eso ahora se verifica su error.
  const { error: estadoErr } = await supabase.from('negocio_cambios_pendientes')
    .update({ estado: 'aprobado', reviewed_at: new Date().toISOString(), revisado_por: req.usuario.id })
    .eq('id', req.params.id);
  if (estadoErr) return res.status(400).json({ error: estadoErr.message });

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

// PUT /api/admin/cambios-perfil/:id/pedir-cambios — mantener pendiente con motivo para que el restaurante corrija y reenvíe
router.put('/cambios-perfil/:id/pedir-cambios', authMiddleware, adminOnly, async (req, res) => {
  const { motivo } = req.body;
  const { data: solicitud, error: fetchErr } = await supabase
    .from('negocio_cambios_pendientes')
    .select('*, negocios(id,propietario_id,nombre)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (solicitud.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya fue procesada' });

  const { error: estadoErr } = await supabase.from('negocio_cambios_pendientes')
    .update({ estado: 'pendiente', motivo_rechazo: motivo || null })
    .eq('id', req.params.id);
  if (estadoErr) return res.status(400).json({ error: estadoErr.message });

  const propietarioId = solicitud.negocios?.propietario_id;
  if (propietarioId) {
    const motivoTexto = motivo ? `: ${motivo}` : '. Revisa y reenvía tus cambios de perfil.';
    await guardarNotificacion(supabase, propietarioId, 'perfil_cambios_solicitados',
      '⚠️ Se solicitan cambios en tu perfil',
      `El administrador te pide corregir los cambios enviados para "${solicitud.negocios?.nombre}"${motivoTexto}`,
      { negocioId: solicitud.negocio_id, motivo }
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

  const { error: estadoErr } = await supabase.from('negocio_cambios_pendientes')
    .update({ estado: 'rechazado', motivo_rechazo: motivo || null, reviewed_at: new Date().toISOString(), revisado_por: req.usuario.id })
    .eq('id', req.params.id);
  if (estadoErr) return res.status(400).json({ error: estadoErr.message });

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

// ── Cupones (CRUD admin) ──────────────────────────────────────────────────────

const TIPOS_CUPON = ['porcentaje', 'monto_fijo', 'referido'];
const UUID_REGEX  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validarUUID(valor) {
  if (!valor) return null;
  const v = String(valor).trim();
  if (!v) return null;
  if (!UUID_REGEX.test(v)) throw Object.assign(new Error('El UUID de usuario exclusivo no es válido. Debe tener el formato: 550e8400-e29b-41d4-a716-446655440000'), { statusCode: 400 });
  return v;
}

// Advierte (nunca bloquea) si un cupón podría generar pérdida para Bocara — el
// cupón lo absorbe Bocara de su propia comisión (comision_bocara + comision_pasarela),
// nunca el restaurante, así que un cupón mal dimensionado sale directo del bolsillo
// de Bocara. No es una aproximación: usa el precio real más bajo entre las bolsas
// activas hoy (el peor caso real, no un umbral inventado) y, para cupones de
// porcentaje, una comparación exacta e independiente del tamaño del pedido.
async function evaluarRiesgoCupon(tipo, valorNum) {
  const comisionFraccion = await obtenerComisionFraccion();
  const comisionTotalFraccion = comisionFraccion + COMISION_PLATAFORMA_FRACCION; // 25% + 3.5%

  if (tipo === 'porcentaje') {
    const umbralPct = comisionTotalFraccion * 100;
    if (valorNum >= umbralPct) {
      return `Este cupón descuenta ${valorNum}% del total, pero la comisión de Bocara es ` +
        `${umbralPct.toFixed(1)}% (25% + 3.5% de plataforma). Cada uso generará pérdida ` +
        `para Bocara sin importar el tamaño del pedido — Bocara pondrá dinero de su ` +
        `bolsillo en cada transacción con este cupón.`;
    }
    return null;
  }

  // monto_fijo y referido se aplican como un descuento en quetzales — el riesgo
  // depende del tamaño del pedido, así que se compara contra la bolsa activa más
  // barata hoy (el peor caso real y exacto, consultado en vivo, no estimado).
  const { data: masBarata } = await supabase
    .from('bolsas')
    .select('precio_descuento')
    .eq('activo', true)
    .order('precio_descuento', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!masBarata) return null; // sin bolsas activas — no hay con qué comparar todavía

  const comisionMinima = Math.round(masBarata.precio_descuento * comisionTotalFraccion * 100) / 100;
  if (valorNum > comisionMinima) {
    return `Este cupón descuenta Q${valorNum.toFixed(2)}, pero la comisión de Bocara en la ` +
      `bolsa activa más barata hoy (Q${masBarata.precio_descuento.toFixed(2)}) es de solo ` +
      `Q${comisionMinima.toFixed(2)}. Si se usa en un pedido así de pequeño, Bocara pierde ` +
      `Q${(valorNum - comisionMinima).toFixed(2)} en esa transacción.`;
  }
  return null;
}

// GET /api/admin/cupones
router.get('/cupones', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cupones')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const cupones = data || [];
    const exclusivoIds = [...new Set(cupones.filter(c => c.usuario_id_exclusivo).map(c => c.usuario_id_exclusivo))];
    let userMap = {};
    if (exclusivoIds.length > 0) {
      const { data: users } = await supabase
        .from('usuarios').select('id,email,nombre,apellido').in('id', exclusivoIds);
      userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    res.json(cupones.map(c => ({
      ...c,
      usuario_exclusivo: c.usuario_id_exclusivo ? (userMap[c.usuario_id_exclusivo] || null) : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cupones
router.post('/cupones', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      codigo, tipo, valor, uso_maximo, uso_por_usuario,
      fecha_vencimiento, usuario_id_exclusivo, activo, descripcion,
    } = req.body;

    if (!codigo || !tipo || valor == null)
      return res.status(400).json({ error: 'codigo, tipo y valor son requeridos' });
    if (!TIPOS_CUPON.includes(tipo))
      return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_CUPON.join(', ')}` });
    if (parseFloat(valor) <= 0)
      return res.status(400).json({ error: 'valor debe ser mayor que 0' });
    if (tipo === 'porcentaje' && parseFloat(valor) > 100)
      return res.status(400).json({ error: 'el porcentaje no puede superar 100' });
    if (fecha_vencimiento && new Date(fecha_vencimiento) <= new Date())
      return res.status(400).json({ error: 'la fecha de vencimiento debe ser futura' });
    const usoMaxNum = parseInt(uso_maximo) || 1;
    if (usoMaxNum < 1)
      return res.status(400).json({ error: 'uso_maximo debe ser al menos 1' });

    let usuarioExclusivo;
    try { usuarioExclusivo = validarUUID(usuario_id_exclusivo); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const { data, error } = await supabase.from('cupones').insert([{
      codigo:               codigo.toUpperCase().trim(),
      tipo,
      valor:                parseFloat(valor),
      uso_maximo:           usoMaxNum,
      uso_por_usuario:      parseInt(uso_por_usuario) || 1,
      usos_actuales:        0,
      activo:               activo !== false,
      fecha_vencimiento:    fecha_vencimiento || null,
      usuario_id_exclusivo: usuarioExclusivo,
      descripcion:          descripcion?.trim() || null,
    }]).select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ya existe un cupón con ese código' });
      return res.status(400).json({ error: error.message });
    }

    const advertencia = await evaluarRiesgoCupon(tipo, parseFloat(valor));
    res.status(201).json({ ...data, advertencia });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/cupones/:id
router.put('/cupones/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      codigo, tipo, valor, uso_maximo, uso_por_usuario,
      fecha_vencimiento, usuario_id_exclusivo, activo, descripcion,
    } = req.body;

    if (tipo !== undefined && !TIPOS_CUPON.includes(tipo))
      return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_CUPON.join(', ')}` });
    if (valor !== undefined && parseFloat(valor) <= 0)
      return res.status(400).json({ error: 'valor debe ser mayor que 0' });
    if (tipo === 'porcentaje' && valor !== undefined && parseFloat(valor) > 100)
      return res.status(400).json({ error: 'el porcentaje no puede superar 100' });
    if (fecha_vencimiento && new Date(fecha_vencimiento) <= new Date())
      return res.status(400).json({ error: 'la fecha de vencimiento debe ser futura' });

    if (uso_maximo !== undefined) {
      const cupon = await supabase.from('cupones').select('usos_actuales').eq('id', req.params.id).single();
      if (parseInt(uso_maximo) < (cupon.data?.usos_actuales || 0))
        return res.status(400).json({ error: 'uso_maximo no puede ser menor que los usos actuales' });
    }

    if (usuario_id_exclusivo !== undefined) {
      try { validarUUID(usuario_id_exclusivo); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }

    const campos = {};
    if (codigo            !== undefined) campos.codigo               = codigo.toUpperCase().trim();
    if (tipo              !== undefined) campos.tipo                  = tipo;
    if (valor             !== undefined) campos.valor                 = parseFloat(valor);
    if (uso_maximo        !== undefined) campos.uso_maximo            = parseInt(uso_maximo);
    if (uso_por_usuario   !== undefined) campos.uso_por_usuario       = parseInt(uso_por_usuario);
    if (fecha_vencimiento !== undefined) campos.fecha_vencimiento     = fecha_vencimiento || null;
    if (usuario_id_exclusivo !== undefined) {
      const v = typeof usuario_id_exclusivo === 'string' ? usuario_id_exclusivo.trim() : '';
      campos.usuario_id_exclusivo = v || null;
    }
    if (activo            !== undefined) campos.activo                = activo;
    if (descripcion       !== undefined) campos.descripcion           = descripcion?.trim() || null;

    const { data, error } = await supabase
      .from('cupones').update(campos).eq('id', req.params.id).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ya existe un cupón con ese código' });
      return res.status(400).json({ error: error.message });
    }
    // Evaluar sobre el estado final del cupón (data), no solo los campos que
    // llegaron en este PATCH — así se avisa igual si tipo/valor no cambiaron
    // pero ya eran riesgosos.
    const advertencia = await evaluarRiesgoCupon(data.tipo, parseFloat(data.valor));
    res.json({ ...data, advertencia });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/cupones/:id/estado — solo activa o desactiva
router.patch('/cupones/:id/estado', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { activo } = req.body;
    if (activo === undefined) return res.status(400).json({ error: 'activo requerido' });
    const { data, error } = await supabase
      .from('cupones').update({ activo }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/cupones/:id
router.delete('/cupones/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { count } = await supabase
      .from('cupon_reservas').select('id', { count: 'exact', head: true })
      .eq('cupon_id', req.params.id).eq('estado', 'activa');
    if (count > 0)
      return res.status(409).json({ error: `Este cupón tiene ${count} reserva(s) activa(s). Desactívalo primero.` });
    const { error } = await supabase.from('cupones').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cupones/:id/usos — historial de usos consumidos
router.get('/cupones/:id/usos', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cupon_usos')
      .select('id,usuario_id,pedido_id,descuento_aplicado,created_at')
      .eq('cupon_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    const usos = data || [];
    const userIds = [...new Set(usos.map(u => u.usuario_id))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('usuarios').select('id,email,nombre,apellido').in('id', userIds);
      userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    res.json(usos.map(u => ({ ...u, usuario: userMap[u.usuario_id] || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cupones/:id/reservas — reservas activas del cupón
router.get('/cupones/:id/reservas', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cupon_reservas')
      .select('id,usuario_id,pedido_id,descuento_aplicado,estado,expires_at,created_at')
      .eq('cupon_id', req.params.id)
      .eq('estado', 'activa')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const reservas = data || [];
    const userIds = [...new Set(reservas.map(r => r.usuario_id))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('usuarios').select('id,email,nombre,apellido').in('id', userIds);
      userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    res.json(reservas.map(r => ({ ...r, usuario: userMap[r.usuario_id] || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cubo-status — diagnóstico de integración Cubo Pago (nunca expone keys ni fragmentos)
router.get('/cubo-status', authMiddleware, adminOnly, (req, res) => {
  const apiUrl = process.env.CUBO_API_URL || '';
  res.json({
    configurado:                    !!(apiUrl && process.env.CUBO_API_KEY),
    ambiente:                       process.env.CUBO_ENVIRONMENT || 'no configurado',
    pagos_habilitados:              process.env.CUBO_PAYMENTS_ENABLED === 'true',
    api_url_produccion:             !!(apiUrl && !/sandbox/i.test(apiUrl)),
    api_key_configurada:            !!(process.env.CUBO_API_KEY || (process.env.CUBO_ENVIRONMENT !== 'production' && process.env.CUBOPAGO_API_KEY)),
    webhook_url:                    'https://bocara.onrender.com/api/webhooks/cubo',
    verificacion_webhook_disponible: false,
  });
});

// GET /api/admin/datos-prueba — identifica registros de prueba conocidos SIN
// borrar nada. Único marcador determinístico en el código: el usuario demo
// que crea/resetea POST /auth/setup-demo (demo@bocara.gt). Sirve para que el
// admin revise manualmente qué borrar en Supabase — esta ruta nunca elimina.
router.get('/datos-prueba', authMiddleware, adminOnly, async (req, res) => {
  const DEMO_EMAIL = 'demo@bocara.gt';
  const candidatos = [];

  const { data: demoUser } = await supabase
    .from('usuarios').select('id,email,nombre,rol,created_at').eq('email', DEMO_EMAIL).maybeSingle();

  if (!demoUser) return res.json({ candidatos: [] });

  candidatos.push({
    tabla: 'usuarios', id: demoUser.id, motivo: `Usuario demo creado por /auth/setup-demo (${DEMO_EMAIL})`,
    detalle: { email: demoUser.email, nombre: demoUser.nombre, rol: demoUser.rol, created_at: demoUser.created_at },
  });

  const { data: negocios } = await supabase
    .from('negocios').select('id,nombre,created_at').eq('propietario_id', demoUser.id);
  for (const n of (negocios || [])) {
    candidatos.push({ tabla: 'negocios', id: n.id, motivo: 'Negocio del usuario demo', detalle: { nombre: n.nombre, created_at: n.created_at } });
  }

  const { data: pedidos } = await supabase
    .from('pedidos').select('id,total,estado,created_at').eq('usuario_id', demoUser.id);
  for (const p of (pedidos || [])) {
    candidatos.push({ tabla: 'pedidos', id: p.id, motivo: 'Pedido hecho por el usuario demo', detalle: { total: p.total, estado: p.estado, created_at: p.created_at } });
  }

  if ((negocios || []).length > 0) {
    const negocioIds = negocios.map(n => n.id);
    const { data: bolsas } = await supabase
      .from('bolsas').select('id,nombre,negocio_id,created_at').in('negocio_id', negocioIds);
    for (const b of (bolsas || [])) {
      candidatos.push({ tabla: 'bolsas', id: b.id, motivo: 'Publicación del negocio demo', detalle: { nombre: b.nombre, created_at: b.created_at } });
    }
  }

  res.json({ candidatos, nota: 'Ningún registro fue eliminado. Revisa la lista y borra manualmente en Supabase si corresponde.' });
});

module.exports = router;
