// ════════════════════════════════════════════════════════════════════════════
// Bocara — Máquina de estados de pedidos (FUENTE CANÓNICA)
// ════════════════════════════════════════════════════════════════════════════
//
// Antes de este módulo la matriz de transiciones vivía dentro de
// routes/pedidos.js y las reglas de cancelación estaban repartidas entre
// routes/pedidos.js, routes/pagos.js y routes/webhooks.js. Las copias
// divergieron: la de routes/pedidos.js permitía 'pendiente' → 'confirmado', es
// decir, confirmar un pedido SIN que nadie hubiera verificado el pago.
//
// Este archivo es la única fuente de verdad. Ninguna ruta debe declarar su
// propia matriz ni mutar `pedidos.estado` sin pasar por validarTransicion().
//
// ── Dos vocabularios, una sola máquina ──────────────────────────────────────
//
// El modelo CANÓNICO del negocio (el que se documenta y con el que se razona)
// tiene seis estados: pendiente, pagado, confirmado, completado, cancelado,
// reembolsado.
//
// La columna `pedidos.estado` en producción usa además estados OPERATIVOS que
// el modelo canónico no nombra — 'borrador' (carrito antes de pagar) y el tramo
// de preparación del restaurante ('en_preparacion', 'listo') — más 'recogido',
// el nombre anterior de 'completado' que sobrevive en filas viejas.
//
// Y hay un desfase importante: 'pagado' y 'reembolsado' NO son hoy valores de
// `pedidos.estado`; el pago verificado se marca en la columna aparte
// `estado_pago`. Por eso la máquina expone las dos matrices:
//
//   TRANSICIONES            → modelo canónico puro (seis estados)
//   TRANSICIONES_OPERATIVAS → lo anterior + los estados reales de la columna
//
// Las dos comparten la misma regla crítica y las mismas condiciones. La
// operativa es la que se aplica contra la BD; la canónica es el contrato con el
// que se diseña. Ver docs/STATE_MACHINE_Y_CONTRATOS.md.

// ── Estados ─────────────────────────────────────────────────────────────────

// Modelo canónico del negocio.
const ESTADOS = Object.freeze([
  'pendiente',
  'pagado',
  'confirmado',
  'completado',
  'cancelado',
  'reembolsado',
]);

// Valores que existen en `pedidos.estado` y que el modelo canónico no nombra.
//   borrador       — carrito creado por POST /pagos/preparar, sin intención de pago aún
//   en_preparacion — el restaurante aceptó y está armando la bolsa
//   listo          — bolsa lista para recoger
//   recogido       — nombre anterior de 'completado' (sql/renombrar-recogido-completado.sql)
const ESTADOS_OPERATIVOS = Object.freeze([
  'borrador',
  'en_preparacion',
  'listo',
  'recogido',
]);

const ESTADOS_TODOS = Object.freeze([...ESTADOS, ...ESTADOS_OPERATIVOS]);

// Un pedido en estado terminal no vuelve a moverse nunca. No se revive un
// cancelado ni se "descompleta" un completado: para eso se crea un pedido nuevo.
const ESTADOS_TERMINALES = Object.freeze([
  'completado',
  'recogido',
  'cancelado',
  'reembolsado',
]);

// Estados en los que el pedido todavía no representa dinero cobrado. El stock
// que ocupan es una RESERVA implícita (services/stock.js los cuenta como
// reservados), no un descuento real de `bolsas.cantidad_disponible`.
const ESTADOS_SIN_COBRO = Object.freeze(['borrador', 'pendiente']);

// ── Matriz canónica ─────────────────────────────────────────────────────────

const TRANSICIONES = Object.freeze({
  pendiente:   Object.freeze(['pagado', 'cancelado']),
  pagado:      Object.freeze(['confirmado', 'cancelado', 'reembolsado']),
  confirmado:  Object.freeze(['completado', 'cancelado', 'reembolsado']),
  completado:  Object.freeze([]), // terminal
  cancelado:   Object.freeze([]), // terminal
  reembolsado: Object.freeze([]), // terminal
});

// ── Matriz operativa (la que se aplica contra `pedidos.estado`) ─────────────
//
// Extiende la canónica sin contradecirla: 'confirmado' gana la salida hacia el
// tramo de preparación del restaurante, y se añaden las entradas de 'borrador'.
//
// 'listo' → 'recogido' NO se incluye a propósito: hoy routes/pedidos.js tampoco
// lo permite, y 'recogido' solo existe como terminal heredado en filas
// anteriores al renombrado. Añadirlo crearía pedidos nuevos con el nombre viejo.
const TRANSICIONES_OPERATIVAS = Object.freeze({
  borrador:       Object.freeze(['pendiente', 'cancelado']),
  pendiente:      Object.freeze(['pagado', 'cancelado']),
  pagado:         Object.freeze(['confirmado', 'cancelado', 'reembolsado']),
  confirmado:     Object.freeze(['en_preparacion', 'completado', 'cancelado', 'reembolsado']),
  en_preparacion: Object.freeze(['listo', 'cancelado', 'reembolsado']),
  listo:          Object.freeze(['completado', 'cancelado']),
  completado:     Object.freeze([]), // terminal
  recogido:       Object.freeze([]), // terminal (legacy)
  cancelado:      Object.freeze([]), // terminal
  reembolsado:    Object.freeze([]), // terminal
});

// ── REGLA CRÍTICA ───────────────────────────────────────────────────────────
//
// 'pendiente' → 'confirmado' está PROHIBIDO de forma terminante.
//
// Un pedido 'pendiente' es uno con link de pago generado y nada más: nadie ha
// comprobado que el dinero se movió. Confirmarlo directamente entregaría la
// bolsa al cliente y se la mostraría al restaurante sin cobro alguno. Para
// llegar a 'confirmado' el pedido tiene que haber pasado por 'pagado', y a
// 'pagado' solo se llega con verificación independiente de Cubo (el webhook
// consulta a Cubo y la RPC confirmar_pago_cubo escribe la prueba).
//
// Esta lista se comprueba ANTES que la matriz. Es un cinturón sobre el tirante:
// aunque alguien edite TRANSICIONES por error y añada la arista, la transición
// seguirá siendo rechazada aquí.
const TRANSICIONES_PROHIBIDAS = Object.freeze([
  Object.freeze({
    desde: 'pendiente',
    hacia: 'confirmado',
    motivo:
      'Un pedido solo puede confirmarse después de estar en "pagado" con el pago ' +
      'verificado por el webhook de Cubo o la RPC confirmar_pago_cubo. Confirmar ' +
      'desde "pendiente" entregaría la bolsa sin haber cobrado.',
  }),
  Object.freeze({
    desde: 'borrador',
    hacia: 'confirmado',
    motivo:
      'Un borrador es un carrito sin intención de pago registrada. Debe pasar por ' +
      '"pendiente" (link de pago emitido) y "pagado" (pago verificado) antes de confirmarse.',
  }),
  Object.freeze({
    desde: 'borrador',
    hacia: 'pagado',
    motivo:
      'El pago se registra sobre un pedido con link de Cubo emitido. Un borrador aún ' +
      'no tiene cubo_payment_intent_token con el que verificar nada.',
  }),
]);

// ── Códigos de error ────────────────────────────────────────────────────────

const ERRORES = Object.freeze({
  TRANSICION_INVALIDA:     'TRANSICION_INVALIDA',
  ESTADO_DESCONOCIDO:      'ESTADO_DESCONOCIDO',
  ESTADO_TERMINAL:         'ESTADO_TERMINAL',
  PAGO_NO_VERIFICADO:      'PAGO_NO_VERIFICADO',
  REEMBOLSO_NO_REGISTRADO: 'REEMBOLSO_NO_REGISTRADO',
});

// Toda respuesta de error de transición sale con 400. `error` es siempre
// 'TRANSICION_INVALIDA' (el contrato acordado con el cliente móvil) y `codigo`
// afina el motivo sin obligar a parsear el texto de `detalle`.
const HTTP_TRANSICION_INVALIDA = 400;

// ── Condiciones por estado destino ──────────────────────────────────────────
//
// Hay transiciones que están en la matriz pero que además exigen que se cumpla
// algo del mundo real: que exista prueba de pago, que el reembolso esté
// registrado. Se declaran aquí para que ninguna ruta las reimplemente.

// Prueba de pago aceptable. cubo_payment_intent_token Y cubo_identifier solo se
// escriben juntos dentro de la RPC confirmar_pago_cubo, y solo después de que
// el webhook consultó a Cubo por su cuenta y obtuvo SUCCEEDED — es la única
// evidencia confiable de que el dinero existe. `estado_pago = 'pagado'` por sí
// solo NO basta: el webhook legacy de PayU y la ruta retirada /pedidos/crear
// también lo escribían sin verificar nada.
function pagoVerificado(contexto = {}) {
  if (contexto.pagoVerificado === true) return true;
  const pedido = contexto.pedido || contexto;
  return Boolean(pedido.cubo_payment_intent_token && pedido.cubo_identifier);
}

// Cubo Pago no tiene API de reembolso: el admin devuelve el dinero por fuera y
// registra la evidencia. Sin esos tres datos no se marca 'reembolsado', porque
// el pedido quedaría cerrado sin rastro de a dónde fue el dinero.
function reembolsoRegistrado(contexto = {}) {
  const r = contexto.reembolso || {};
  return Boolean(r.monto_reembolsado && r.referencia_reembolso && r.fecha_reembolso);
}

const CONDICIONES = Object.freeze({
  pagado: Object.freeze({
    codigo: ERRORES.PAGO_NO_VERIFICADO,
    cumple: pagoVerificado,
    detalle:
      'Marcar un pedido como pagado exige verificación independiente de Cubo ' +
      '(cubo_payment_intent_token y cubo_identifier escritos por confirmar_pago_cubo).',
  }),
  confirmado: Object.freeze({
    codigo: ERRORES.PAGO_NO_VERIFICADO,
    cumple: pagoVerificado,
    detalle:
      'Un pedido no puede confirmarse sin prueba de pago verificada por Cubo. ' +
      'Revisar cubo_payment_intent_token y cubo_identifier del pedido.',
  }),
  reembolsado: Object.freeze({
    codigo: ERRORES.REEMBOLSO_NO_REGISTRADO,
    cumple: reembolsoRegistrado,
    detalle:
      'Antes de marcar el reembolso hay que registrarlo: monto_reembolsado, ' +
      'referencia_reembolso y fecha_reembolso.',
  }),
});

// ── API ─────────────────────────────────────────────────────────────────────

function matriz(opciones = {}) {
  return opciones.canonico === true ? TRANSICIONES : TRANSICIONES_OPERATIVAS;
}

function esEstadoValido(estado, opciones = {}) {
  return Object.prototype.hasOwnProperty.call(matriz(opciones), estado);
}

// Un estado terminal es uno sin ninguna salida. Se comprueba contra la lista
// explícita para que 'recogido' cuente como terminal aunque sea legacy.
function esTerminal(estado) {
  return ESTADOS_TERMINALES.includes(estado);
}

function transicionesDesde(estado, opciones = {}) {
  const permitidas = matriz(opciones)[estado];
  return permitidas ? [...permitidas] : [];
}

function transicionProhibida(estadoActual, nuevoEstado) {
  return TRANSICIONES_PROHIBIDAS.find(
    (p) => p.desde === estadoActual && p.hacia === nuevoEstado,
  ) || null;
}

// true / false, sin explicación. Para ramas internas y para la capa de lectura
// (¿muestro el botón "marcar listo"?). Las rutas que mutan la BD deben usar
// validarTransicion, que además explica el rechazo.
//
// El tercer argumento acepta el mismo contexto que validarTransicion: sin él,
// las transiciones condicionadas ('pagado', 'confirmado', 'reembolsado') se
// evalúan solo contra la matriz.
function puedeTransicionar(estadoActual, nuevoEstado, opciones = {}) {
  return validarTransicion(estadoActual, nuevoEstado, opciones).ok === true;
}

/**
 * Valida una transición de estado de pedido.
 *
 * @param {string} estadoActual  estado leído de `pedidos.estado`
 * @param {string} nuevoEstado   estado al que se quiere mover
 * @param {object} [opciones]
 *   @param {boolean} [opciones.canonico]          validar contra el modelo de seis estados
 *   @param {object}  [opciones.pedido]            fila del pedido, para condiciones de pago
 *   @param {boolean} [opciones.pagoVerificado]    fuerza la condición de pago (webhook/RPC)
 *   @param {object}  [opciones.reembolso]         { monto_reembolsado, referencia_reembolso, fecha_reembolso }
 *   @param {boolean} [opciones.omitirCondiciones] valida solo la matriz
 *
 * @returns {{ ok: true, estadoActual: string, nuevoEstado: string }}
 *        | {{ ok: false, error: 'TRANSICION_INVALIDA', codigo: string, detalle: string,
 *             status: 400, estadoActual: string, nuevoEstado: string,
 *             transicionesPermitidas: string[] }}
 *
 * La forma del rechazo es directamente la del cuerpo HTTP acordado con el
 * cliente móvil: { ok: false, error: 'TRANSICION_INVALIDA', detalle: '…' }.
 */
function validarTransicion(estadoActual, nuevoEstado, opciones = {}) {
  const base = { estadoActual, nuevoEstado };

  const rechazo = (codigo, detalle) => ({
    ok: false,
    error: ERRORES.TRANSICION_INVALIDA,
    codigo,
    detalle,
    status: HTTP_TRANSICION_INVALIDA,
    transicionesPermitidas: transicionesDesde(estadoActual, opciones),
    ...base,
  });

  // 1. Estados conocidos. Un estado fuera de la matriz es un dato corrupto o
  //    una migración a medias: se rechaza en vez de adivinar.
  if (!esEstadoValido(estadoActual, opciones)) {
    return rechazo(ERRORES.ESTADO_DESCONOCIDO, `Estado actual desconocido: "${estadoActual}".`);
  }
  if (!esEstadoValido(nuevoEstado, opciones)) {
    return rechazo(ERRORES.ESTADO_DESCONOCIDO, `Estado destino desconocido: "${nuevoEstado}".`);
  }

  // 2. Prohibiciones explícitas — antes que la matriz, a propósito.
  const prohibida = transicionProhibida(estadoActual, nuevoEstado);
  if (prohibida) {
    return rechazo(
      ERRORES.TRANSICION_INVALIDA,
      `Transición prohibida "${estadoActual}" → "${nuevoEstado}". ${prohibida.motivo}`,
    );
  }

  // 3. Reentrada al mismo estado: no es una transición. Quien necesite
  //    idempotencia debe detectarla antes de llamar (ver liberarInventarioPedido
  //    en services/stock.js).
  if (estadoActual === nuevoEstado) {
    return rechazo(ERRORES.TRANSICION_INVALIDA, `El pedido ya está en estado "${estadoActual}".`);
  }

  // 4. Estados terminales: un pedido cerrado no se revive.
  if (esTerminal(estadoActual)) {
    return rechazo(
      ERRORES.ESTADO_TERMINAL,
      `El pedido está en estado final "${estadoActual}" y ya no admite cambios.`,
    );
  }

  // 5. Matriz.
  if (!transicionesDesde(estadoActual, opciones).includes(nuevoEstado)) {
    const permitidas = transicionesDesde(estadoActual, opciones);
    return rechazo(
      ERRORES.TRANSICION_INVALIDA,
      `No se puede cambiar de "${estadoActual}" a "${nuevoEstado}". ` +
        `Transiciones válidas desde "${estadoActual}": ${permitidas.join(', ') || 'ninguna'}.`,
    );
  }

  // 6. Condiciones del estado destino.
  if (opciones.omitirCondiciones !== true) {
    const condicion = CONDICIONES[nuevoEstado];
    if (condicion && !condicion.cumple(opciones)) {
      return rechazo(condicion.codigo, condicion.detalle);
    }
  }

  return { ok: true, ...base };
}

/**
 * Valida el salto compuesto que ejecuta el pago verificado de Cubo.
 *
 * La RPC confirmar_pago_cubo escribe `estado='confirmado', estado_pago='pagado'`
 * en una sola transacción. Visto desde la máquina eso es 'pendiente' → 'pagado'
 * → 'confirmado': dos aristas legítimas encadenadas, no la arista prohibida
 * 'pendiente' → 'confirmado'. Esta función valida las dos y es la ÚNICA forma
 * soportada de llegar a 'confirmado' desde 'pendiente'.
 *
 * @param {string} estadoActual estado previo del pedido ('pendiente' o 'pagado')
 * @param {object} [contexto]   mismo contexto que validarTransicion
 */
function validarConfirmacionPago(estadoActual, contexto = {}) {
  if (estadoActual === 'pagado') {
    return validarTransicion('pagado', 'confirmado', contexto);
  }

  const aPagado = validarTransicion(estadoActual, 'pagado', contexto);
  if (!aPagado.ok) return aPagado;

  const aConfirmado = validarTransicion('pagado', 'confirmado', contexto);
  if (!aConfirmado.ok) return aConfirmado;

  return { ok: true, estadoActual, nuevoEstado: 'confirmado', via: 'pagado' };
}

// ── Inventario ──────────────────────────────────────────────────────────────

/**
 * ¿Esta cancelación tiene que devolver unidades a `bolsas.cantidad_disponible`?
 *
 * El stock se descuenta de la tabla `bolsas` UNA sola vez, dentro de la RPC
 * confirmar_pago_cubo. Antes de eso el pedido solo ocupa una RESERVA implícita:
 * services/stock.js cuenta los pedidos 'pendiente' como reservados al calcular
 * la disponibilidad, sin tocar la columna.
 *
 * Consecuencia directa: cancelar un pedido no cobrado libera su reserva por el
 * simple hecho de cambiar de estado — sumar unidades ahí DUPLICARÍA el stock.
 * Solo las cancelaciones de pedidos ya cobrados devuelven unidades.
 */
function requiereDevolucionDeStock(estadoActual) {
  return !ESTADOS_SIN_COBRO.includes(estadoActual);
}

// Estados desde los que una cancelación puede ganar la carrera (compare-and-swap
// sobre `estado`). Sirve como cláusula .in('estado', …) del UPDATE.
function estadosCancelables(opciones = {}) {
  return Object.keys(matriz(opciones)).filter((estado) =>
    transicionesDesde(estado, opciones).includes('cancelado'),
  );
}

module.exports = {
  ESTADOS,
  ESTADOS_OPERATIVOS,
  ESTADOS_TODOS,
  ESTADOS_TERMINALES,
  ESTADOS_SIN_COBRO,
  TRANSICIONES,
  TRANSICIONES_OPERATIVAS,
  TRANSICIONES_PROHIBIDAS,
  CONDICIONES,
  ERRORES,
  HTTP_TRANSICION_INVALIDA,
  esEstadoValido,
  esTerminal,
  transicionesDesde,
  transicionProhibida,
  puedeTransicionar,
  validarTransicion,
  validarConfirmacionPago,
  pagoVerificado,
  reembolsoRegistrado,
  requiereDevolucionDeStock,
  estadosCancelables,
};
