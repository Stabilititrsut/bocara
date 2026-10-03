// Fuente única de las reglas de ciclo de vida de una publicación (tabla `bolsas`,
// tanto tipo 'bolsa' = Tiempo limitado como tipo 'cupon' = Promoción):
//
//   crear → pendiente → aprobado / rechazado
//   rechazado → (restaurante corrige) → pendiente → aprobado
//   aprobado → (restaurante cambia algo relevante) → pendiente → aprobado
//
// y de la regla "¿la ve el cliente?", que antes estaba repetida —con pequeñas
// diferencias— en seis consultas de routes/bolsas.js y routes/negocios.js.

const { ahoraGuatemala, estaVencida, normalizarHora, normalizarFecha } = require('./horarioGuatemala');

const ESTADOS_APROBACION = Object.freeze({
  PENDIENTE: 'pendiente',
  APROBADO: 'aprobado',
  RECHAZADO: 'rechazado',
});

// Único campo contractual del tipo de publicación. Las banderas de menú
// (es_promocion, es_tiempo_limitado, ...) NO deciden el tipo.
const TIPOS_PUBLICACION = Object.freeze(['bolsa', 'cupon']);

const MOTIVO_RECHAZO_POR_DEFECTO = 'Rechazada por el administrador sin un motivo especificado. Contacta a soporte para más información.';

// Por qué una publicación no está en el catálogo del cliente.
const MOTIVOS_NO_VISIBLE = Object.freeze({
  ELIMINADA: 'eliminada',
  NO_APROBADA: 'no_aprobada',
  INACTIVA: 'inactiva',
  SIN_UNIDADES: 'sin_unidades',
  VENCIDA: 'vencida',
  NEGOCIO_NO_DISPONIBLE: 'negocio_no_disponible',
});

// `estado_aprobacion` null = fila anterior a la columna (legado): se considera
// aprobada, igual que hacían las consultas públicas con `estado_aprobacion.is.null`.
function esAprobada(bolsa) {
  return bolsa?.estado_aprobacion === ESTADOS_APROBACION.APROBADO || bolsa?.estado_aprobacion == null;
}

// eliminado_en es permanente y nunca lo deshace ningún endpoint (ver DELETE
// /api/bolsas/:id) — a diferencia de `activo`/estado_aprobacion, que sí
// pueden volver a cambiar. `== null` cubre tanto NULL real (columna ya
// migrada, fila no eliminada) como la ausencia total de la columna
// (despliegue sin la migración aplicada aún: nada puede estar eliminado).
function estaEliminada(bolsa) {
  return bolsa?.eliminado_en != null;
}

// Un negocio solo es navegable para clientes si está activo y, cuando el campo
// existe, aprobado (compat con despliegues sin estado_verificacion).
function negocioDisponiblePublico(negocio) {
  return !!negocio && negocio.activo !== false &&
    (negocio.estado_verificacion === 'aprobado' || negocio.estado_verificacion == null);
}

// Lista de motivos por los que `bolsa` NO aparece al cliente ([] = visible).
//
// · `exigirUnidades: false` lo usa el detalle de producto: una publicación
//   agotada sigue siendo consultable (la app muestra "agotado"), pero no se lista.
// · El negocio solo se evalúa si la fila trae el embebido `negocios` con
//   `activo`/`estado_verificacion`; los endpoints que ya validaron el negocio
//   por separado no lo seleccionan.
function motivosNoVisible(bolsa, { ahora = ahoraGuatemala(), exigirUnidades = true } = {}) {
  const motivos = [];
  // Primer chequeo, antes que cualquier otro: una eliminada nunca es visible
  // sin importar su estado_aprobacion/activo/vigencia — no hay combinación de
  // esos campos que la haga reaparecer.
  if (estaEliminada(bolsa)) motivos.push(MOTIVOS_NO_VISIBLE.ELIMINADA);
  if (!esAprobada(bolsa)) motivos.push(MOTIVOS_NO_VISIBLE.NO_APROBADA);
  if (bolsa?.activo !== true) motivos.push(MOTIVOS_NO_VISIBLE.INACTIVA);
  if (exigirUnidades && !(Number(bolsa?.cantidad_disponible) > 0)) motivos.push(MOTIVOS_NO_VISIBLE.SIN_UNIDADES);
  if (estaVencida(bolsa, ahora)) motivos.push(MOTIVOS_NO_VISIBLE.VENCIDA);
  if (bolsa && 'negocios' in bolsa && !negocioDisponiblePublico(bolsa.negocios)) {
    motivos.push(MOTIVOS_NO_VISIBLE.NEGOCIO_NO_DISPONIBLE);
  }
  return motivos;
}

function esVisibleParaCliente(bolsa, opciones) {
  return motivosNoVisible(bolsa, opciones).length === 0;
}

// Filtro final de TODO endpoint público que lista publicaciones. Se aplica
// después de la consulta aunque esta ya filtre en SQL: así un fallback que
// relaje los filtros (columna faltante, error transitorio) falla CERRADO en
// vez de mostrar pendientes o rechazadas. Una sola lectura de la hora por lote.
function filtrarVisiblesParaCliente(bolsas, { ahora = ahoraGuatemala() } = {}) {
  return (bolsas || []).filter(b => esVisibleParaCliente(b, { ahora }));
}

// ── Re-revisión ─────────────────────────────────────────────────────────────
//
// Regla: lo que el admin aprobó es lo que ve el cliente. Cualquier cambio de
// contenido de la oferta (texto, precio, tipo, imagen, horario, vigencia,
// categoría, banderas de menú) vuelve a revisión. Solo dos campos operativos
// quedan fuera porque no alteran la oferta revisada:
//   · activo              → el switch de visibilidad del propio restaurante
//   · cantidad_disponible → reponer o ajustar unidades del día
const CAMPOS_SIN_REVISION = new Set(['activo', 'cantidad_disponible']);

const CAMPOS_NUMERICOS = new Set(['precio_original', 'precio_descuento', 'cantidad_disponible', 'peso_estimado_kg']);
const CAMPOS_HORA = new Set(['hora_recogida_inicio', 'hora_recogida_fin']);
const CAMPOS_FECHA = new Set(['fecha_caducidad']);
const CAMPOS_BOOLEANOS = new Set(['activo', 'permite_envio', 'es_tiempo_limitado', 'es_promocion',
  'es_descuento', 'es_destacado', 'es_mas_vendido', 'es_precio_bajo']);

// Forma comparable de un valor: la app reenvía el formulario completo con
// números como texto y la BD devuelve horas con segundos ('18:00:00'); nada de
// eso es un cambio real y no debe mandar la publicación a revisión.
function normalizarValor(campo, valor) {
  if (valor === undefined || valor === '' || valor === null) {
    return CAMPOS_BOOLEANOS.has(campo) ? false : null;
  }
  if (CAMPOS_NUMERICOS.has(campo)) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : String(valor);
  }
  if (CAMPOS_HORA.has(campo)) return normalizarHora(String(valor)) ?? String(valor).trim();
  if (CAMPOS_FECHA.has(campo)) return normalizarFecha(valor) ?? String(valor).trim();
  if (CAMPOS_BOOLEANOS.has(campo)) return valor === true || valor === 'true';
  return typeof valor === 'string' ? valor.trim() : valor;
}

// Campos de `updates` cuyo valor difiere realmente del de `actual`.
function camposCambiados(actual, updates) {
  return Object.keys(updates).filter(campo =>
    normalizarValor(campo, actual?.[campo]) !== normalizarValor(campo, updates[campo]));
}

// Qué le pasa al estado de revisión cuando el RESTAURANTE guarda `updates`
// sobre `actual` (el admin no pasa por aquí). Devuelve:
//   cambios       → columnas extra a escribir (estado_aprobacion, motivo_rechazo, activo)
//   reenvio       → true si la publicación vuelve (o sigue) a la cola del admin
//   campos        → campos que realmente cambiaron (para auditoría)
//
// · rechazado + guardar el formulario = reenviar a revisión. El rechazo puso
//   activo=false; reenviar lo deshace (salvo que el restaurante mande
//   activo=false explícitamente), porque si no, al aprobarla quedaba aprobada
//   pero invisible — el fallo del caso Ola Azul.
// · aprobado + cambio relevante = vuelve a pendiente (deja de verse hasta que
//   el admin revise la versión nueva).
// · pendiente con "pedir cambios" (motivo) + guardar = reenvío: se limpia el motivo.
// · Solo el switch `activo`, o solo unidades en una aprobada, no tocan la revisión.
function decidirRevision(actual, updates) {
  const campos = camposCambiados(actual, updates);
  const claves = Object.keys(updates);
  const soloVisibilidad = claves.length > 0 && claves.every(c => c === 'activo');
  if (claves.length === 0 || soloVisibilidad) return { cambios: {}, reenvio: false, campos };

  const estado = actual?.estado_aprobacion;

  if (estado === ESTADOS_APROBACION.RECHAZADO) {
    const cambios = { estado_aprobacion: ESTADOS_APROBACION.PENDIENTE, motivo_rechazo: null };
    if (updates.activo === undefined) cambios.activo = true;
    return { cambios, reenvio: true, campos };
  }

  if (estado === ESTADOS_APROBACION.PENDIENTE) {
    return actual.motivo_rechazo
      ? { cambios: { motivo_rechazo: null }, reenvio: true, campos }
      : { cambios: {}, reenvio: false, campos };
  }

  // aprobado o legado (null)
  const relevantes = campos.filter(c => !CAMPOS_SIN_REVISION.has(c));
  if (relevantes.length === 0) return { cambios: {}, reenvio: false, campos };
  return {
    cambios: { estado_aprobacion: ESTADOS_APROBACION.PENDIENTE, motivo_rechazo: null },
    reenvio: true,
    campos: relevantes,
  };
}

// ── Invariante del switch "activo" ──────────────────────────────────────────
//
// esAprobada()/motivosNoVisible() ya garantizan que una pendiente o rechazada
// nunca se le muestra al cliente, sin importar su `activo` — pero eso por sí
// solo deja que la propia PETICIÓN de "activar" se acepte y se guarde en la
// fila, aunque no cambie la visibilidad real. El switch de visibilidad del
// restaurante (y cualquier llamada directa a la API que mande solo
// { activo: true }) no debe poder "activar" una publicación que el admin no
// aprobó — ni aunque el resultado sea inocuo hoy, para no depender de que
// ninguna otra regla cambie en el futuro (ver tarea "toggle rechazada").
//
// A propósito NO se activa cuando `updates` también cambia otros campos: ese
// es el camino de CORRECCIÓN (decidirRevision más abajo), que sí necesita
// restaurar `activo=true` sobre una rechazada para que, al aprobarla después,
// no quede aprobada pero invisible (caso Ola Azul) — ese `activo=true` lo
// decide el propio backend, nunca lo pide el cliente junto con el resto del
// formulario (ver bocara-mobile construirPayload, que nunca incluye `activo`).
function activarSinAprobacionEsInvalido(actual, updates) {
  if (!updates || typeof updates !== 'object') return false;
  const claves = Object.keys(updates);
  const soloActivo = claves.length > 0 && claves.every(c => c === 'activo');
  const intentaActivar = updates.activo === true || updates.activo === 'true';
  return soloActivo && intentaActivar && !esAprobada(actual);
}

module.exports = {
  ESTADOS_APROBACION,
  TIPOS_PUBLICACION,
  MOTIVO_RECHAZO_POR_DEFECTO,
  MOTIVOS_NO_VISIBLE,
  CAMPOS_SIN_REVISION,
  esAprobada,
  estaEliminada,
  negocioDisponiblePublico,
  motivosNoVisible,
  esVisibleParaCliente,
  filtrarVisiblesParaCliente,
  camposCambiados,
  decidirRevision,
  activarSinAprobacionEsInvalido,
};
