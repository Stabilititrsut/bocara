const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geo');
const { enviarNotificacionPush, guardarNotificacion } = require('../services/notificaciones');
const { enviarEmail, templateAprobado, templateRechazado, templateSuspendido, templateSuspendidoUsuario, templateRehabilitadoUsuario, templateLiquidacionPagada } = require('../services/email');
const { obtenerConfig, obtenerComisionFraccion, COMISION_PLATAFORMA_FRACCION } = require('../services/configuracion');
const { aNumero, obtenerSubtotalProductos } = require('../services/finanzas');
const {
  esMesValido, ultimoMesCerrado, resumirPendientes, cargarPedidosPendientes, cargarLiquidacionesVivas,
  planParaNegocio, crearLiquidacionMensual, guardarComprobanteSeguro, urlFirmadaComprobante,
} = require('../services/liquidaciones');
const { validarModeracion } = require('../services/resenas');
const { ESTADOS_ENTREGADOS } = require('../services/orderStateMachine');
const { impactoDePedidos } = require('../services/impactoAmbiental');
const { enqueueEventBestEffort } = require('../services/eventosDominio');
const { encolarPublicacionVisible } = require('../services/notificacionesCercania');
const { MENSAJE_APROBAR_NEGOCIO_SIN_FOTO, MENSAJE_ACTIVAR_NEGOCIO_SIN_FOTO, MENSAJE_APROBAR_PUBLICACION_SIN_FOTO, tieneFoto } = require('../services/fotoObligatoria');
const {
  ESTADOS_APROBACION, MOTIVO_RECHAZO_POR_DEFECTO, motivosNoVisible, estaEliminada,
} = require('../services/publicaciones');
const router = express.Router();

const ESTADOS_LIQUIDACION = ['pendiente', 'pagado', 'liquidado', 'anulado'];

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
    // id y bolsa_id se piden para el impacto ambiental de más abajo: son la
    // llave hacia pedido_items (y hacia la bolsa, en los pedidos heredados).
    supabase.from('pedidos').select('id,bolsa_id,total,estado,estado_pago,cubo_payment_intent_token,cubo_identifier,precio_bolsa,cantidad,costo_envio,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon'),
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
  const totalCobradoClientes = pagados.reduce((s, p) => s + aNumero(p.total), 0);
  const ventasBrutasProductos = pagados.reduce((s, p) => s + obtenerSubtotalProductos(p), 0);
  const costosEnvio = pagados.reduce((s, p) => s + aNumero(p.costo_envio), 0);
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

  // Impacto ambiental de toda la plataforma. Se calcula SOLO sobre los pedidos
  // entregados: el dinero se cuenta cuando entra (`pagados`), pero la comida
  // solo se rescata cuando el cliente se la lleva. Que falle no puede tumbar el
  // dashboard financiero, que es lo que de verdad se viene a ver aquí.
  const entregados = pagados.filter(p => ESTADOS_ENTREGADOS.includes(p.estado));
  let impacto = null;
  try {
    impacto = await impactoDePedidos(entregados);
  } catch (err) {
    console.error('[ADMIN STATS] impacto ambiental no disponible:', err.message);
  }
  res.json({
    total_usuarios: usersRes.count || 0,
    total_negocios: negocios.length,
    negocios_activos: negocios.filter(n => n.activo !== false).length,
    negocios_sin_verificar: negocios_pendientes,
    total_pedidos: pagados.length,
    pedidos_completados: pagados.filter(p => p.estado === 'completado' || p.estado === 'recogido').length,
    ingresos_totales: parseFloat(totalCobradoClientes.toFixed(2)),
    ventas_brutas_productos: parseFloat(ventasBrutasProductos.toFixed(2)),
    costos_envio: parseFloat(costosEnvio.toFixed(2)),
    comision_generada: comisionBocaraNeta, // total ingreso Bocara YA NETO de cupones
    comision_bocara: comisionBocara,
    cargo_plataforma: cargoPlataforma,
    propinas_totales: propinasTotales,
    pago_restaurantes: pagoRestaurantes,
    descuentos_cupon: descuentosCupon,
    impacto_ambiental: impacto && {
      unidades_rescatadas: impacto.unidades_rescatadas,
      kg_rescatados: impacto.kg_rescatados,
      co2_evitado_kg: impacto.co2_evitado_kg,
      pedidos_entregados: entregados.length,
    },
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
    // enviarEmail ya registra el intento (con el destinatario enmascarado);
    // duplicarlo aquí solo repetía el mismo email completo en los logs.
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
      console.log(`[notificar] Intentando email tipo="${tipo}" para propietario_id=${propietarioId}`);
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

// Un negocio sin foto (registro incompleto o dato heredado) no se puede
// aprobar: quedaría activo y visible para los clientes sin imagen. 404 si no
// existe; 409 si existe pero le falta la foto. null si se puede aprobar.
async function bloqueoAprobacionSinFoto(id) {
  const { data: negocio } = await supabase.from('negocios').select('id,imagen_url').eq('id', id).maybeSingle();
  if (!negocio) return { status: 404, error: 'Negocio no encontrado' };
  if (!tieneFoto(negocio.imagen_url)) return { status: 409, error: MENSAJE_APROBAR_NEGOCIO_SIN_FOTO };
  return null;
}

// PUT /api/admin/negocios/:id/verificar (alias de /aprobar)
router.put('/negocios/:id/verificar', authMiddleware, adminOnly, async (req, res) => {
  const bloqueo = await bloqueoAprobacionSinFoto(req.params.id);
  if (bloqueo) return res.status(bloqueo.status).json({ error: bloqueo.error });
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
  const bloqueo = await bloqueoAprobacionSinFoto(req.params.id);
  if (bloqueo) return res.status(bloqueo.status).json({ error: bloqueo.error });
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
  const { data: negocio } = await supabase.from('negocios').select('activo,propietario_id,nombre,imagen_url').eq('id', req.params.id).single();
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  const nuevoActivo = !negocio.activo;
  // Suspender siempre se puede; reactivar un negocio sin foto, no.
  if (nuevoActivo && !tieneFoto(negocio.imagen_url)) {
    return res.status(409).json({ error: MENSAJE_ACTIVAR_NEGOCIO_SIN_FOTO });
  }
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
    .select('id,total,estado,estado_pago,negocio_id,created_at,creado_en,cubo_payment_intent_token,cubo_identifier,precio_bolsa,cantidad,costo_envio,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon,negocios(id,nombre,zona)')
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
    const r = await supabase.from('pedidos').select('id,total,estado,estado_pago,negocio_id,precio_bolsa,cantidad,costo_envio,comision_bocara,comision_pasarela,monto_neto_restaurante,propina,descuento_cupon,cubo_payment_intent_token,cubo_identifier')
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
        envios: 0,
        totalCobrado: 0,
      };
    }
    map[nid].pedidos += 1;
    map[nid].bruto += obtenerSubtotalProductos(p);
    map[nid].comisionBocara  += p.comision_bocara   || 0;
    map[nid].cargoPlataforma += p.comision_pasarela || 0;
    map[nid].propinas        += p.propina           || 0;
    map[nid].neto            += p.monto_neto_restaurante || 0;
    map[nid].descuentoCupon  += p.descuento_cupon   || 0;
    map[nid].envios          += aNumero(p.costo_envio);
    map[nid].totalCobrado    += aNumero(p.total);
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
    envios:           acc.envios           + r.envios,
    totalCobrado:     acc.totalCobrado     + r.totalCobrado,
  }), { bruto: 0, comisionBocara: 0, cargoPlataforma: 0, propinas: 0, neto: 0, pedidos: 0, descuentoCupon: 0, envios: 0, totalCobrado: 0 });
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

// GET /api/admin/liquidaciones?mes=YYYY-MM&estado=pendiente|pagado|liquidado|anulado&negocio_id=
// `pendientes`: lo que se pagaría hoy por negocio (meses cerrados liquidables +
// liquidaciones mensuales generadas y sin pagar), con el mes que toca liquidar.
// `historial` / `liquidaciones`: liquidaciones registradas, filtradas.
router.get('/liquidaciones', authMiddleware, adminOnly, async (req, res) => {
  const { mes, estado, negocio_id: negocioId } = req.query;
  if (mes && !esMesValido(mes)) return res.status(400).json({ error: 'mes debe tener formato YYYY-MM' });
  if (estado && !ESTADOS_LIQUIDACION.includes(estado))
    return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_LIQUIDACION.join(', ')}` });
  const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  let q = supabase
    .from('liquidaciones')
    .select('*,negocios(nombre)')
    .order('created_at', { ascending: false })
    .limit(limite);
  if (mes) q = q.eq('mes', mes);
  if (estado) q = q.eq('estado', estado);
  if (negocioId) q = q.eq('negocio_id', negocioId);

  try {
    const [{ data: liquidaciones, error }, pedidos, vivas] = await Promise.all([
      q, cargarPedidosPendientes(negocioId || null), cargarLiquidacionesVivas(negocioId || null),
    ]);
    if (error) return res.status(500).json({ error: error.message });
    const ultimoCerrado = ultimoMesCerrado();
    const pendientes = resumirPendientes({ pedidos, liquidacionesVivas: vivas, ultimoCerrado });

    // Enriquecer con push token del propietario
    const propIds = [...new Set(pendientes.map((r) => r.propietario_id).filter(Boolean))];
    if (propIds.length > 0) {
      const { data: propUsers } = await supabase
        .from('usuarios').select('id,expo_push_token').in('id', propIds);
      const tokenMap = {};
      for (const u of (propUsers || [])) tokenMap[u.id] = u.expo_push_token;
      for (const r of pendientes) r.push_token = tokenMap[r.propietario_id] || null;
    }

    res.json({
      pendientes,
      historial: liquidaciones || [],
      liquidaciones: liquidaciones || [],
      filtros: { mes: mes || null, estado: estado || null, negocio_id: negocioId || null },
      ultimo_mes_cerrado: ultimoCerrado,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/liquidaciones — { negocio_id, mes: 'YYYY-MM' }
// Genera la liquidación mensual con la RPC atómica (bloquea pedidos, suma del
// snapshot, inserta y vincula en una transacción) y su comprobante PDF.
// Exige liquidar del mes más antiguo al más reciente (409 mes_anterior_pendiente).
router.post('/liquidaciones', authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await crearLiquidacionMensual({
      negocioId: req.body?.negocio_id, mes: req.body?.mes, adminId: req.usuario.id,
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/liquidaciones/:id/comprobante[?descargar=1]
// URL firmada temporal (10 min) del PDF en el bucket privado. Si el PDF no se
// generó al crear la liquidación, se genera ahora.
router.get('/liquidaciones/:id/comprobante', authMiddleware, adminOnly, async (req, res) => {
  const { data: liq } = await supabase.from('liquidaciones').select('*').eq('id', req.params.id).maybeSingle();
  if (!liq) return res.status(404).json({ error: 'Liquidación no encontrada' });
  try {
    res.json(await urlFirmadaComprobante(liq, { descargar: req.query.descargar === '1' }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/admin/liquidaciones/:id/pagar — { datos_transferencia: { referencia, banco? } }
// `:id` puede ser:
//   · una liquidación mensual 'pendiente' → se marca pagada;
//   · un negocio (contrato legacy de la app admin) → se generan, en orden y vía
//     la RPC, las liquidaciones de sus meses cerrados pendientes, y se pagan
//     todas sus liquidaciones 'pendiente'.
// Este endpoint ya no escribe pedidos.liquidacion_id directamente: antes
// insertaba la liquidación y vinculaba los pedidos en dos llamadas, sin guarda,
// y podía sobrescribir pedidos ya liquidados en una liquidación mensual.
// El cambio a 'pagado' exige estado='pendiente' en el mismo UPDATE: dos admins
// confirmando a la vez → el segundo recibe 409, nunca un doble pago.
router.post('/liquidaciones/:id/pagar', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { datos_transferencia } = req.body || {};
  const referencia = String(datos_transferencia?.referencia || '').trim();
  if (!referencia) {
    return res.status(400).json({ error: 'Ingresa la referencia de la transferencia realizada' });
  }

  let negocioId;
  let ids;
  try {
    const { data: liqDirecta } = await supabase
      .from('liquidaciones').select('id,negocio_id,estado').eq('id', id).maybeSingle();
    if (liqDirecta) {
      if (liqDirecta.estado !== 'pendiente')
        return res.status(409).json({ error: `La liquidación ya está ${liqDirecta.estado}` });
      negocioId = liqDirecta.negocio_id;
      ids = [liqDirecta.id];
    } else {
      negocioId = id;
      const plan = await planParaNegocio(negocioId);
      for (const mes of plan.mesesAGenerar) {
        const r = await crearLiquidacionMensual({ negocioId, mes, adminId: req.usuario.id, validarOrden: false });
        if (r.status !== 201 && !['mes_ya_liquidado', 'sin_pedidos_pendientes'].includes(r.body.resultado)) {
          return res.status(r.status).json(r.body);
        }
      }
      const { data: pendientes, error } = await supabase
        .from('liquidaciones').select('id').eq('negocio_id', negocioId).eq('estado', 'pendiente');
      if (error) return res.status(500).json({ error: error.message });
      ids = (pendientes || []).map((l) => l.id);
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No hay pedidos completados pendientes de liquidar en meses cerrados' });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { data: pagadas, error: payErr } = await supabase
    .from('liquidaciones')
    .update({
      estado: 'pagado',
      pagado_en: new Date().toISOString(),
      pagado_por: req.usuario.id,
      datos_transferencia: { ...datos_transferencia, referencia },
    })
    .in('id', ids)
    .eq('estado', 'pendiente')
    .select('*');
  if (payErr) return res.status(400).json({ error: payErr.message });
  if (!pagadas?.length) return res.status(409).json({ error: 'La liquidación ya fue pagada por otro administrador' });

  const { data: negocio } = await supabase
    .from('negocios')
    .select('nombre,propietario_id')
    .eq('id', negocioId)
    .maybeSingle();

  // El comprobante se regenera con estado "Pagado" y la referencia (best-effort).
  await Promise.all(pagadas.map((l) => guardarComprobanteSeguro(l, { nombre: negocio?.nombre })));

  const suma = (k) => pagadas.reduce((s, l) => s + aNumero(l[k]), 0);
  const neto = parseFloat(suma('monto').toFixed(2));
  const totalPedidos = suma('total_pedidos');

  // Push + correo al propietario — el push es best-effort y muchos negocios
  // nuevos nunca abrieron la app en un celular (sin expo_push_token), así que
  // el correo es el único respaldo escrito de que el pago realmente llegó.
  if (negocio?.propietario_id) {
    const { data: propUser } = await supabase
      .from('usuarios').select('expo_push_token,email,nombre').eq('id', negocio.propietario_id).single();
    if (propUser?.expo_push_token) {
      await enviarNotificacionPush(
        propUser.expo_push_token,
        '💸 ¡Pago recibido!',
        `Recibiste Q${neto.toFixed(2)} por ${totalPedidos} pedidos. Revisa tu cuenta bancaria.`,
        { tipo: 'liquidacion_pagada', monto: neto }
      );
    }
    if (propUser?.email) {
      try {
        const html = templateLiquidacionPagada({
          nombrePropietario: propUser.nombre || 'equipo',
          nombreNegocio: negocio.nombre || 'tu negocio',
          monto: neto,
          ventasBrutas: suma('ventas_brutas'),
          comisionBocara: suma('comision_bocara'),
          cargoPlataforma: suma('comision_plataforma'),
          propinas: suma('propinas'),
          totalPedidos,
          referencia,
          banco: datos_transferencia?.banco || null,
        });
        await enviarEmail({ to: propUser.email, subject: `💸 Pago recibido — Q${neto.toFixed(2)}`, html });
      } catch (err) {
        console.warn('[LIQUIDACIONES PAGAR] Correo restaurante (best-effort) falló:', err.message);
      }
    }
    await guardarNotificacion(supabase, negocio.propietario_id, 'liquidacion', '¡Pago recibido!', `Q${neto.toFixed(2)} transferidos a tu cuenta.`, { monto: neto });
  }

  res.json({ ok: true, liquidacion: pagadas[0], liquidaciones: pagadas, monto_total: neto });
});

// GET /api/admin/resenas?negocio_id=&visible=true|false&limit= — auditoría
router.get('/resenas', authMiddleware, adminOnly, async (req, res) => {
  const { negocio_id: negocioId, visible } = req.query;
  if (visible != null && !['true', 'false'].includes(visible))
    return res.status(400).json({ error: 'visible debe ser true o false' });
  const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  let q = supabase
    .from('resenas')
    .select('*, usuarios(nombre), negocios(nombre)')
    .order('created_at', { ascending: false })
    .limit(limite);
  if (negocioId) q = q.eq('negocio_id', negocioId);
  if (visible != null) q = q.eq('visible', visible === 'true');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /api/admin/resenas/:id/moderar — { visible: boolean, motivo }
// Ocultar exige motivo. El trigger de la base recalcula el promedio del
// negocio solo con las reseñas visibles.
router.patch('/resenas/:id/moderar', authMiddleware, adminOnly, async (req, res) => {
  const moderacion = validarModeracion(req.body || {});
  if (moderacion.error) return res.status(400).json({ error: moderacion.error });
  const { data, error } = await supabase
    .from('resenas')
    .update({
      visible: moderacion.valor.visible,
      motivo_moderacion: moderacion.valor.motivo,
      moderada_por: req.usuario.id,
      moderada_en: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Reseña no encontrada' });
  res.json(data);
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

  // Eliminada nunca entra a la cola del admin, aunque haya quedado pendiente
  // justo antes de eliminarse. Filtro en JS (no en la query SQL): así sigue
  // funcionando igual si `eliminado_en` todavía no existe en este despliegue
  // (estaEliminada trata una columna ausente como "no eliminada").
  data = (data || []).filter(b => !estaEliminada(b));

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

// Texto para el restaurante cuando su publicación queda aprobada pero el cliente
// todavía no la ve (services/publicaciones.js → motivosNoVisible).
const EXPLICACION_NO_VISIBLE = {
  inactiva: 'está oculta: actívala desde tu panel para que los clientes la vean',
  vencida: 'su horario o fecha de vigencia ya venció: actualízalos desde tu panel',
  sin_unidades: 'no tiene unidades disponibles: agrégalas desde tu panel',
  negocio_no_disponible: 'tu negocio no está activo en este momento',
  no_aprobada: 'aún no está aprobada',
};

// PUT /api/admin/bolsas/:id/aprobar
//
// Respuesta: la fila actualizada + `visible_cliente` (boolean) y
// `motivos_no_visible` (string[]) — si el cliente la verá de verdad, con la misma
// regla que los endpoints públicos. Antes aprobar respondía éxito aunque la
// publicación quedara oculta (p. ej. activo=false heredado de un rechazo), y el
// admin no tenía forma de saberlo.
router.put('/bolsas/:id/aprobar', authMiddleware, adminOnly, async (req, res) => {
  const { data: bolsa, error: fetchErr } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,propietario_id,activo,estado_verificacion)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });

  // Eliminada = permanente, no reactivable por ningún camino (ver DELETE
  // /api/bolsas/:id) — ni siquiera "aprobarla" si el admin la tenía abierta
  // en otra pestaña justo cuando el restaurante la eliminó.
  if (estaEliminada(bolsa)) {
    return res.status(410).json({ error: 'Esta publicación fue eliminada y ya no puede aprobarse.' });
  }

  // Ninguna publicación se aprueba sin foto, tampoco una heredada: sigue
  // legible y el restaurante puede editarla para agregarla (PUT /bolsas/:id).
  if (!tieneFoto(bolsa.imagen_url)) {
    return res.status(409).json({ error: MENSAJE_APROBAR_PUBLICACION_SIN_FOTO });
  }

  // Repetir "aprobar" sobre algo ya aprobado es idempotente: no vuelve a
  // notificar ni a auditar una transición que no ocurrió.
  const yaAprobada = bolsa.estado_aprobacion === ESTADOS_APROBACION.APROBADO;

  // Aprobar solo cambia el estado de revisión — nunca fuerza "activo": la visibilidad
  // la controla el restaurante con su propio switch, y aprobar una bolsa que el
  // restaurante ya había ocultado no debe hacerla reaparecer sin que él lo decida.
  // (El activo=false que impone un RECHAZO se deshace al reenviar la corrección,
  // en PUT /bolsas/:id — ver decidirRevision.)
  let { data, error } = await supabase
    .from('bolsas')
    .update({ estado_aprobacion: ESTADOS_APROBACION.APROBADO, motivo_rechazo: null })
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

  const motivos = motivosNoVisible({ ...data, negocios: bolsa.negocios });
  const visible = motivos.length === 0;
  if (!visible) {
    console.warn('[ADMIN APROBAR] bolsa %s aprobada pero NO visible al cliente: %s', bolsa.id, motivos.join(','));
  }

  if (!yaAprobada) {
    // Notificar al propietario del restaurante
    const propietarioId = bolsa.negocios?.propietario_id;
    if (propietarioId) {
      const detalle = motivos.map(m => EXPLICACION_NO_VISIBLE[m] || m).join('; ');
      await notificarPropietario(
        propietarioId,
        bolsa.nombre,
        'bolsa_aprobada',
        '✅ ¡Bolsa aprobada!',
        visible
          ? `Tu bolsa "${bolsa.nombre}" ya está visible para los clientes en Bocara.`
          : `Tu bolsa "${bolsa.nombre}" fue aprobada, pero todavía no es visible para los clientes: ${detalle}.`,
        { bolsaId: bolsa.id, negocioId: bolsa.negocio_id, visible_cliente: visible }
      );
    }

    // Avisar a clientes cercanos (≤ 10 km) y favoritos solo si hay algo que el
    // cliente pueda ver de verdad. Lo hace el despachador de eventos
    // (services/notificacionesCercania.js), con una notificación por usuario y ciclo.
    if (visible) encolarPublicacionVisible(data);

    // Una fila por cada aprobación real: la misma publicación puede aprobarse
    // varias veces a lo largo de su vida (rechazo → corrección → aprobación), y
    // sin discriminador la clave determinista descartaba como duplicado toda
    // aprobación posterior a la primera.
    enqueueEventBestEffort({
      eventType: 'publicacion.aprobada', aggregateType: 'bolsa', aggregateId: bolsa.id,
      discriminator: new Date().toISOString(),
      payload: {
        negocio_id: bolsa.negocio_id, actor_admin_id: req.usuario.id,
        estado_anterior: bolsa.estado_aprobacion ?? null,
        visible_cliente: visible, motivos_no_visible: motivos,
      },
    });
  }

  res.json({ ...data, visible_cliente: visible, motivos_no_visible: motivos });
});

// PUT /api/admin/bolsas/:id/rechazar
router.put('/bolsas/:id/rechazar', authMiddleware, adminOnly, async (req, res) => {
  // El motivo SIEMPRE queda guardado: es lo que el restaurante necesita para
  // corregir. Sin motivo explícito se guarda uno por defecto — nunca vacío ni
  // el de una revisión anterior ("pedir cambios") que ya no aplica.
  const motivo = typeof req.body?.motivo === 'string' && req.body.motivo.trim()
    ? req.body.motivo.trim()
    : MOTIVO_RECHAZO_POR_DEFECTO;

  const { data: bolsa, error: fetchErr } = await supabase
    .from('bolsas')
    .select('*, negocios(id,nombre,propietario_id)')
    .eq('id', req.params.id)
    .single();
  if (fetchErr || !bolsa) return res.status(404).json({ error: 'Bolsa no encontrada' });

  if (estaEliminada(bolsa)) {
    return res.status(410).json({ error: 'Esta publicación fue eliminada y ya no puede rechazarse.' });
  }

  const yaRechazada = bolsa.estado_aprobacion === ESTADOS_APROBACION.RECHAZADO;

  // inactivo_desde marca desde cuándo cuenta el plazo de 5 días hábiles del cron
  // de limpieza (server.js). Si la columna aún no existe (migración pendiente:
  // sql/limpieza-automatica-bolsas.sql), se degrada sin ella en vez de fallar.
  // activo=false: una rechazada nunca debe verse. Al reenviar la corrección,
  // PUT /bolsas/:id la reactiva (services/publicaciones.js → decidirRevision).
  const inactivoDesde = new Date().toISOString();
  const updates = {
    estado_aprobacion: ESTADOS_APROBACION.RECHAZADO, activo: false, inactivo_desde: inactivoDesde,
    motivo_rechazo: motivo,
  };

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

  if (!yaRechazada) {
    // Notificar al propietario del restaurante
    const propietarioId = bolsa.negocios?.propietario_id;
    if (propietarioId) {
      await notificarPropietario(
        propietarioId,
        bolsa.nombre,
        'bolsa_rechazada',
        '❌ Bolsa rechazada',
        `Tu bolsa "${bolsa.nombre}" fue rechazada: ${motivo}. Puedes corregirla y guardarla para enviarla de nuevo a revisión.`,
        { bolsaId: bolsa.id, negocioId: bolsa.negocio_id, motivo }
      );
    }

    // Una fila por cada rechazo real (ver aprobar): rechazo → corrección →
    // rechazo debe dejar dos eventos, cada uno con su motivo.
    enqueueEventBestEffort({
      eventType: 'publicacion.rechazada', aggregateType: 'bolsa', aggregateId: bolsa.id,
      discriminator: new Date().toISOString(),
      payload: {
        negocio_id: bolsa.negocio_id, motivo, actor_admin_id: req.usuario.id,
        estado_anterior: bolsa.estado_aprobacion ?? null,
      },
    });
  }

  res.json(data);
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
