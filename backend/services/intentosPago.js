// Registro de intentos de pago (tabla `intentos_pago`, migración 202610070900)
// para los KPIs "Abandono del pago" y "Pagos fallidos".
//
// Todo es best-effort: medir un intento nunca puede bloquear ni revertir un
// cobro. Cada función captura sus errores, los registra y devuelve un resultado;
// ninguna lanza. Si la migración aún no corrió, la tabla no existe y el flujo
// de pago sigue exactamente igual que antes.
//
// Transiciones permitidas de `resultado`:
//   pendiente → aprobado | fallido | expirado      (primer resultado final gana)
//   expirado  → aprobado                           (solo si el pago SÍ se confirmó:
//                                                   la verdad del cobro manda)

function supabasePorDefecto() {
  return require('../config/supabase');
}

const RESULTADOS_FINALES = Object.freeze(['aprobado', 'fallido', 'expirado']);

function registrar(nivel, evento, datos = {}) {
  const linea = JSON.stringify({ origen: 'intentos_pago', evento, ...datos });
  if (nivel === 'error') console.error(linea);
  else if (nivel === 'warn') console.warn(linea);
  else console.log(linea);
}

// Registra el inicio de un intento cuando el cliente recibe el link de pago.
// Un reintento con el mismo token choca con el UNIQUE y se ignora.
async function registrarInicioIntento({ pedidoId, paymentIntentToken, cliente = supabasePorDefecto() } = {}) {
  if (!pedidoId || !paymentIntentToken) return { ok: false, motivo: 'datos_incompletos' };
  try {
    const { error } = await cliente.from('intentos_pago').insert([{
      pedido_id: pedidoId,
      payment_intent_token: paymentIntentToken,
      resultado: 'pendiente',
    }]);
    if (error) {
      if (error.code === '23505') return { ok: true, duplicado: true };
      registrar('warn', 'inicio_no_registrado', { pedido_id: pedidoId, detalle: error.message });
      return { ok: false, motivo: 'error_bd' };
    }
    return { ok: true };
  } catch (err) {
    registrar('warn', 'inicio_no_registrado', { pedido_id: pedidoId, detalle: err.message });
    return { ok: false, motivo: 'excepcion' };
  }
}

// Cierra el intento identificado por su token. `desde` limita qué resultados
// previos pueden sobrescribirse (compare-and-swap): un webhook reintentado o
// tardío no mueve un intento que ya tiene resultado final.
async function finalizarIntento({
  paymentIntentToken, resultado, statusRaw = null, cliente = supabasePorDefecto(), ahora = new Date(),
} = {}) {
  if (!paymentIntentToken || !RESULTADOS_FINALES.includes(resultado)) {
    return { ok: false, motivo: 'datos_incompletos' };
  }
  const desde = resultado === 'aprobado' ? ['pendiente', 'expirado'] : ['pendiente'];
  try {
    const { data, error } = await cliente.from('intentos_pago')
      .update({ resultado, finalizado_en: ahora.toISOString(), status_raw: statusRaw })
      .eq('payment_intent_token', paymentIntentToken)
      .in('resultado', desde)
      .select('id');
    if (error) {
      registrar('warn', 'cierre_no_registrado', { resultado, detalle: error.message });
      return { ok: false, motivo: 'error_bd' };
    }
    return { ok: true, actualizados: data?.length || 0 };
  } catch (err) {
    registrar('warn', 'cierre_no_registrado', { resultado, detalle: err.message });
    return { ok: false, motivo: 'excepcion' };
  }
}

// Fallback del barrido de reservas vencidas: los intentos que siguen
// 'pendiente' en pedidos cuya reserva expiró ya no pueden aprobarse por el
// flujo normal (la RPC rechaza el pago tardío).
async function expirarIntentosDePedidos(pedidoIds = [], { cliente = supabasePorDefecto(), ahora = new Date() } = {}) {
  const ids = [...new Set((pedidoIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: true, actualizados: 0 };
  try {
    const { data, error } = await cliente.from('intentos_pago')
      .update({ resultado: 'expirado', finalizado_en: ahora.toISOString(), status_raw: 'RESERVA_EXPIRADA' })
      .in('pedido_id', ids)
      .eq('resultado', 'pendiente')
      .select('id');
    if (error) {
      registrar('warn', 'expiracion_no_registrada', { pedidos: ids.length, detalle: error.message });
      return { ok: false, motivo: 'error_bd' };
    }
    return { ok: true, actualizados: data?.length || 0 };
  } catch (err) {
    registrar('warn', 'expiracion_no_registrada', { pedidos: ids.length, detalle: err.message });
    return { ok: false, motivo: 'excepcion' };
  }
}

module.exports = {
  RESULTADOS_FINALES,
  registrarInicioIntento,
  finalizarIntento,
  expirarIntentosDePedidos,
};
