-- ════════════════════════════════════════════════════════════════════════════
-- Bocara — El pago no puede confirmarse si la reserva ya venció
--
-- Cierre de AC-03 (auditoría del PR #16): asincronía entre la vigencia del link
-- de pago y la vigencia de la reserva de stock.
--
-- ── El problema ─────────────────────────────────────────────────────────────
--
-- La migración 202609121200 puso a caducar las reservas: un pedido 'pendiente'
-- deja de bloquear stock a los 15 minutos (RESERVA_TTL_MINUTOS) y la unidad
-- vuelve al catálogo. Pero confirmar_pago_cubo v5 no miraba el reloj de la
-- reserva ni el estado del pedido: le bastaba con que `estado_pago` no fuera
-- todavía 'pagado'. Consecuencias, las dos con dinero de por medio:
--
--   1. Sobreventa por pago tardío. El cliente A abre el link, lo deja aparcado,
--      su reserva expira, el cliente B compra la última unidad. A paga a los 40
--      minutos y confirmar_pago_cubo descuenta stock… que ya no existe, o que
--      existía porque el negocio repuso. Dos clientes, una bolsa.
--   2. Limbo pagable. Un pedido 'cancelado' (por el barrido o por el propio
--      checkout, que cancela los pendientes anteriores del usuario) seguía
--      siendo confirmable: la RPC no comprobaba `estado`. Un webhook tardío lo
--      revivía a 'confirmado' saltándose la máquina de estados.
--
-- ── La regla ────────────────────────────────────────────────────────────────
--
-- Un pago solo se confirma si, con la fila BLOQUEADA:
--   · el pedido sigue en 'pendiente'  (es decir: la reserva existe), y
--   · COALESCE(reservado_at, created_at) está dentro del TTL.
--
-- Si no, no se toca nada y se devuelve 'estado_no_pagable' / 'reserva_expirada'.
-- services/cuboWebhook.js traduce ambos a 409 con
-- `accion: 'reembolso_manual'`: el cargo existe y hay que devolverlo, pero
-- NUNCA se entrega una bolsa que no está reservada.
--
-- Sin marca temporal utilizable la reserva se considera VENCIDA. Ojo: es la
-- dirección contraria a reservas_vigentes_bolsa (donde un dato incompleto
-- cuenta como reserva viva). Las dos son la misma decisión fail-closed vista
-- desde sus dos lados — ante la duda, no vender de más: allí no se libera
-- stock, aquí no se confirma un cobro.
--
-- Esta es la capa 3 de 3. Las otras dos evitan llegar hasta aquí:
--   1. services/visaLink.js   — el link de Cubo nace con TTL = RESERVA_TTL_MINUTOS
--   2. server.js              — expirar_reservas_vencidas cierra el pedido al vencer
--   3. esta RPC               — la única comprobación sin carrera posible (FOR UPDATE)
--
-- Firma INTACTA (mismos 8 parámetros que la v5): no hay sobrecargas nuevas ni
-- cambios en las llamadas desde Node, así que el orden de despliegue entre esta
-- migración y el backend es indiferente.
--
-- Idempotente: se puede ejecutar varias veces.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — reserva_ttl_minutos(): el TTL, en un solo sitio del lado SQL
--
-- Gemela de RESERVA_TTL_MINUTOS en services/stock.js. Node pasa su constante
-- explícitamente a reservar_stock_pedido y a expirar_reservas_vencidas; esta
-- función es para las rutas que NO reciben el TTL como parámetro —
-- confirmar_pago_cubo, cuya firma no se toca a propósito.
--
-- Si alguna vez cambia el plazo, hay que cambiarlo en los DOS sitios. El
-- comentario de la columna lo recuerda; no hay forma de que PostgreSQL lea una
-- constante de Node.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reserva_ttl_minutos()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 15 $$;

COMMENT ON FUNCTION reserva_ttl_minutos() IS
  'Minutos que vive una reserva de stock. DEBE coincidir con RESERVA_TTL_MINUTOS '
  'de backend/services/stock.js y con el TTL del link de pago (services/visaLink.js).';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — confirmar_pago_cubo v6
--
-- Idéntica a la v5 (sql/cubo-pago-schema.sql, BLOQUE 6) salvo por el nuevo
-- paso 6: la puerta de la reserva. El resto del algoritmo —bloqueo FOR UPDATE,
-- idempotencia, token, monto, inventario en dos bucles, eventos post-pago— se
-- conserva palabra por palabra.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION confirmar_pago_cubo(
  p_pedido_id                uuid,
  p_payment_intent_token     text,
  p_monto_centavos           integer,
  p_estado_verificado        text,
  p_cubo_identifier          text,
  p_cubo_reference_id        text,
  p_cubo_authorization_code  text,
  p_cubo_processed_at        timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pedido       pedidos%ROWTYPE;
  v_puntos       integer := 10;
  v_puntos_cfg   text;
  v_eventos_pend jsonb;
  -- Inventario multi-ítem
  v_n_bolsas     integer;
  v_bolsa_ids    uuid[];
  v_cantidades   integer[];
  v_idx          integer;
  v_disponible   integer;
  -- Vigencia de la reserva
  v_ttl          integer;
  v_reservada_en timestamptz;
BEGIN

  -- ── 0. Validar parámetros ─────────────────────────────────────────────────
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_pedido_id');
  END IF;
  IF p_payment_intent_token IS NULL OR p_payment_intent_token = '' THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_payment_intent_token');
  END IF;
  IF p_monto_centavos IS NULL OR p_monto_centavos <= 0 THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_monto_centavos', 'valor', p_monto_centavos);
  END IF;
  IF p_estado_verificado IS NULL OR p_estado_verificado = '' THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_estado_verificado');
  END IF;

  -- ── 1. Bloquear pedido (serializa webhooks concurrentes del mismo pedido) ──
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 2. Idempotencia: pago ya procesado ────────────────────────────────────
  -- Va ANTES de la puerta de la reserva: el reintento de un pago ya confirmado
  -- es un duplicado benigno aunque su reserva lleve horas vencida.
  IF v_pedido.estado_pago = 'pagado' THEN
    SELECT jsonb_agg(tipo_evento) INTO v_eventos_pend
    FROM pago_eventos_pendientes
    WHERE pedido_id = p_pedido_id AND estado IN ('pendiente', 'procesando');

    RETURN jsonb_build_object(
      'resultado',          'duplicado',
      'pedido_id',          v_pedido.id,
      'codigo_recogida',    v_pedido.codigo_recogida,
      'eventos_pendientes', COALESCE(v_eventos_pend, '[]'::jsonb)
    );
  END IF;

  -- ── 3. Verificar token ───────────────────────────────────────────────────
  IF v_pedido.cubo_payment_intent_token IS NULL
     OR v_pedido.cubo_payment_intent_token <> p_payment_intent_token THEN
    RETURN jsonb_build_object(
      'resultado', 'token_incorrecto',
      'esperado',  v_pedido.cubo_payment_intent_token,
      'recibido',  p_payment_intent_token
    );
  END IF;

  -- ── 4. Verificar monto ───────────────────────────────────────────────────
  -- monto_esperado_centavos fue calculado server-side en routes/pagos.js
  -- a partir de SUM(precio_descuento × cantidad) + comisión. El cliente
  -- no puede alterarlo: se compara contra el valor almacenado en BD.
  IF v_pedido.monto_esperado_centavos IS NULL
     OR v_pedido.monto_esperado_centavos <> p_monto_centavos THEN
    RETURN jsonb_build_object(
      'resultado', 'monto_incorrecto',
      'esperado',  v_pedido.monto_esperado_centavos,
      'recibido',  p_monto_centavos
    );
  END IF;

  -- ── 5. Verificar estado Cubo ─────────────────────────────────────────────
  IF p_estado_verificado <> 'SUCCEEDED' THEN
    RETURN jsonb_build_object('resultado', 'estado_invalido', 'estado', p_estado_verificado);
  END IF;

  -- ── 6. La reserva tiene que seguir viva ──────────────────────────────────
  --
  -- Con la fila ya bloqueada (paso 1), esta es la comprobación que ninguna
  -- carrera puede saltarse: si el barrido cancela el pedido justo ahora, o lo
  -- acaba de cancelar, aquí se ve el estado commiteado y el pago NO se
  -- confirma. El chequeo equivalente en services/cuboWebhook.js falla antes y
  -- con mejor mensaje, pero solo este es atómico.
  --
  -- Nada se ha escrito todavía: se devuelve sin tocar stock, estado ni eventos.

  IF v_pedido.estado <> 'pendiente' THEN
    RETURN jsonb_build_object(
      'resultado', 'estado_no_pagable',
      'pedido_id', v_pedido.id,
      'estado',    v_pedido.estado,
      'detalle',   'Solo un pedido con reserva viva (estado pendiente) puede confirmarse. '
                   'El cargo existe: requiere reembolso manual.'
    );
  END IF;

  v_ttl          := reserva_ttl_minutos();
  v_reservada_en := COALESCE(v_pedido.reservado_at, v_pedido.created_at);

  -- Sin marca temporal no se puede demostrar que la reserva siga viva; para un
  -- cobro, la respuesta segura es no confirmar (ver cabecera).
  IF v_reservada_en IS NULL
     OR v_reservada_en <= now() - make_interval(mins => GREATEST(v_ttl, 0)) THEN
    RETURN jsonb_build_object(
      'resultado',    'reserva_expirada',
      'pedido_id',    v_pedido.id,
      'reservada_en', v_reservada_en,
      'ttl_minutos',  v_ttl,
      'detalle',      'El pago llegó después del TTL de la reserva: la unidad pudo venderse a otro cliente. '
                      'El cargo existe: requiere reembolso manual.'
    );
  END IF;

  -- ── 7. Inventario — modelo híbrido, pedido_items como única fuente ────────

  -- Paso A: agregar cantidades por bolsa_id en ORDER BY bolsa_id.
  -- El ORDER BY determina el orden de locking en el Paso B — orden determinista
  -- entre transacciones concurrentes que comparten bolsas, evita deadlocks.
  SELECT
    COUNT(*)::integer,
    array_agg(bolsa_id      ORDER BY bolsa_id),
    array_agg(cantidad_total ORDER BY bolsa_id)
  INTO v_n_bolsas, v_bolsa_ids, v_cantidades
  FROM (
    SELECT bolsa_id, SUM(cantidad)::integer AS cantidad_total
    FROM pedido_items
    WHERE pedido_id = p_pedido_id
    GROUP BY bolsa_id
  ) agg;

  -- Sin items → pedido no pertenece al flujo Cubo. Fail-closed: no fallback bolsa_id.
  IF v_n_bolsas = 0 OR v_n_bolsas IS NULL THEN
    RETURN jsonb_build_object(
      'resultado', 'items_ausentes',
      'pedido_id', p_pedido_id,
      'detalle',   'El pedido no tiene filas en pedido_items. Todo pedido Cubo (POST /api/pagos/cubopago) inserta items. Los pedidos legacy (efectivo/PayU) no pueden procesarse por este flujo.'
    );
  END IF;

  -- Paso B: bloquear y verificar cada bolsa (ORDER BY ya fijado en los arrays).
  -- RETURN en el primer fallo: la transacción no ha modificado ninguna fila aún.
  FOR v_idx IN 1..v_n_bolsas LOOP
    SELECT cantidad_disponible INTO v_disponible
    FROM bolsas WHERE id = v_bolsa_ids[v_idx] FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'resultado', 'bolsa_no_encontrada',
        'bolsa_id',  v_bolsa_ids[v_idx]
      );
    END IF;

    IF v_disponible < v_cantidades[v_idx] THEN
      RETURN jsonb_build_object(
        'resultado',  'stock_insuficiente',
        'bolsa_id',   v_bolsa_ids[v_idx],
        'disponible', v_disponible,
        'solicitado', v_cantidades[v_idx]
      );
    END IF;
  END LOOP;

  -- Paso C: descontar (filas ya bloqueadas en Paso B, solo se llega aquí si todo pasó).
  FOR v_idx IN 1..v_n_bolsas LOOP
    UPDATE bolsas
    SET cantidad_disponible = cantidad_disponible - v_cantidades[v_idx]
    WHERE id = v_bolsa_ids[v_idx];
  END LOOP;

  -- ── 8. Marcar pedido como pagado ─────────────────────────────────────────
  UPDATE pedidos SET
    estado                    = 'confirmado',
    estado_pago               = 'pagado',
    cubo_identifier           = p_cubo_identifier,
    cubo_payment_intent_token = p_payment_intent_token,
    cubo_reference_id         = p_cubo_reference_id,
    cubo_authorization_code   = p_cubo_authorization_code,
    pagado_en                 = COALESCE(p_cubo_processed_at, NOW())
  WHERE id = p_pedido_id;

  -- ── 9. Leer puntos configurados ──────────────────────────────────────────
  SELECT valor INTO v_puntos_cfg FROM configuracion WHERE clave = 'puntos_por_pedido';
  IF FOUND AND v_puntos_cfg IS NOT NULL THEN
    BEGIN
      v_puntos := v_puntos_cfg::integer;
    EXCEPTION WHEN OTHERS THEN
      v_puntos := 10;
    END;
  END IF;

  -- ── 10. Registrar 3 eventos separados ────────────────────────────────────
  -- ON CONFLICT DO NOTHING: webhook duplicado no crea eventos nuevos.
  INSERT INTO pago_eventos_pendientes (pedido_id, tipo_evento, payload)
  VALUES
  (
    p_pedido_id,
    'sumar_puntos',
    jsonb_build_object('usuario_id', v_pedido.usuario_id, 'puntos', v_puntos)
  ),
  (
    p_pedido_id,
    'notificar_pago_cliente',
    jsonb_build_object(
      'pedido_id',       p_pedido_id,
      'usuario_id',      v_pedido.usuario_id,
      'tipo_entrega',    v_pedido.tipo_entrega,
      'codigo_recogida', v_pedido.codigo_recogida
    )
  ),
  (
    p_pedido_id,
    'notificar_pago_restaurante',
    jsonb_build_object(
      'pedido_id',       p_pedido_id,
      'negocio_id',      v_pedido.negocio_id,
      'codigo_recogida', v_pedido.codigo_recogida,
      'total',           v_pedido.total
    )
  )
  ON CONFLICT (pedido_id, tipo_evento) DO NOTHING;

  RETURN jsonb_build_object(
    'resultado',       'procesado',
    'pedido_id',       v_pedido.id,
    'codigo_recogida', v_pedido.codigo_recogida
  );

END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — Permisos (CREATE OR REPLACE los conserva, se reafirman igualmente)
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM anon;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM authenticated;
GRANT  EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION reserva_ttl_minutos() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reserva_ttl_minutos() TO service_role;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- Verificación manual tras aplicar
-- ════════════════════════════════════════════════════════════════════════════
--
--   -- El TTL que aplica la base de datos (debe ser 15, igual que Node)
--   SELECT reserva_ttl_minutos();
--
--   -- Pedidos 'pendiente' que ya NO son pagables (su webhook tardío daría 409)
--   SELECT id,
--          COALESCE(reservado_at, created_at)              AS reservada_en,
--          now() - COALESCE(reservado_at, created_at)      AS antiguedad
--   FROM pedidos
--   WHERE estado = 'pendiente' AND estado_pago = 'pendiente'
--     AND COALESCE(reservado_at, created_at)
--         <= now() - make_interval(mins => reserva_ttl_minutos())
--   ORDER BY reservada_en;
--
--   -- Pagos tardíos rechazados: buscar en los logs de Render
--   --   evento="pago_tardio_reserva_expirada"  (accion=reembolso_manual)
