-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Cubo Pago Guatemala: migración de esquema y función RPC      ║
-- ║                                                                        ║
-- ║  INSTRUCCIONES:                                                        ║
-- ║  1. Abrir Supabase → SQL Editor                                        ║
-- ║  2. Ejecutar primero el BLOQUE 1 (columnas)                           ║
-- ║  3. Verificar que no hay errores                                       ║
-- ║  4. Ejecutar el BLOQUE 2 (función RPC)                                ║
-- ║  5. Verificar que la función aparece en Database → Functions          ║
-- ║  NO ejecutar automáticamente. Revisar antes de correr.                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1: Columnas para verificación independiente de pagos Cubo
-- Seguro correr múltiples veces (IF NOT EXISTS)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Columnas de la migración anterior (idempotente si ya existen)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_identifier          TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_authorization_code  TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagado_en                TIMESTAMPTZ;

-- Nuevas columnas para verificación independiente del webhook
-- cubo_payment_intent_token: se guarda al CREAR el link (respuesta de POST /links/one-use)
-- Se verifica al recibir el webhook: body.identifier debe coincidir
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_payment_intent_token TEXT;

-- monto_esperado_centavos: se guarda al CREAR el link, calculado desde Supabase (no del frontend)
-- Se verifica contra el monto que devuelve GET /transactions/{token}
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_esperado_centavos   INTEGER;

-- cubo_reference_id: referenceId del payload del webhook (referencia del banco/procesador)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_reference_id         TEXT;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2: Función RPC confirmar_pago_cubo
-- EJECUTAR DESPUÉS del BLOQUE 1 (la función usa %ROWTYPE de pedidos)
-- La función garantiza atomicidad: o todo se confirma o nada cambia.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION confirmar_pago_cubo(
  p_pedido_id                uuid,
  p_payment_intent_token     text,
  p_monto_centavos           integer,
  p_estado_verificado        text,        -- debe ser 'SUCCEEDED'
  p_cubo_identifier          text,
  p_cubo_reference_id        text,
  p_cubo_authorization_code  text,
  p_cubo_processed_at        timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido       pedidos%ROWTYPE;
  v_bolsa        bolsas%ROWTYPE;
  v_item         RECORD;
  v_items_count  integer;
  v_cantidad     integer;
  v_puntos       integer := 10;
  v_puntos_cfg   text;
BEGIN

  -- ── 1. Bloquear el pedido ────────────────────────────────────────────────
  -- FOR UPDATE garantiza que dos llamadas concurrentes no puedan procesar
  -- el mismo pedido al mismo tiempo. La segunda espera hasta que la primera
  -- haga COMMIT o ROLLBACK antes de continuar.
  SELECT * INTO v_pedido
  FROM pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  -- ── 2. Verificar que el pedido existe ────────────────────────────────────
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 3. Idempotencia: ya fue procesado ────────────────────────────────────
  IF v_pedido.estado_pago = 'pagado' THEN
    RETURN jsonb_build_object(
      'resultado',       'duplicado',
      'pedido_id',       v_pedido.id,
      'codigo_recogida', v_pedido.codigo_recogida
    );
  END IF;

  -- ── 4. Verificar token almacenado (segunda barrera tras la validación Node) ──
  IF v_pedido.cubo_payment_intent_token IS NULL
     OR v_pedido.cubo_payment_intent_token <> p_payment_intent_token THEN
    RETURN jsonb_build_object(
      'resultado', 'token_incorrecto',
      'esperado',  v_pedido.cubo_payment_intent_token,
      'recibido',  p_payment_intent_token
    );
  END IF;

  -- ── 5. Verificar monto esperado (segunda barrera) ────────────────────────
  IF v_pedido.monto_esperado_centavos IS NULL
     OR v_pedido.monto_esperado_centavos <> p_monto_centavos THEN
    RETURN jsonb_build_object(
      'resultado', 'monto_incorrecto',
      'esperado',  v_pedido.monto_esperado_centavos,
      'recibido',  p_monto_centavos
    );
  END IF;

  -- ── 6. Verificar estado confirmado externamente ──────────────────────────
  IF p_estado_verificado <> 'SUCCEEDED' THEN
    RETURN jsonb_build_object('resultado', 'estado_invalido', 'estado', p_estado_verificado);
  END IF;

  -- ── 7. Verificar y descontar inventario ──────────────────────────────────
  -- Todo o nada: si cualquier bolsa tiene stock insuficiente, ninguna se descuenta.
  -- ORDER BY garantiza orden de bloqueo consistente y evita deadlocks entre transacciones.

  SELECT COUNT(*) INTO v_items_count
  FROM pedido_items
  WHERE pedido_id = p_pedido_id;

  IF v_items_count > 0 THEN
    -- Carrito multi-bolsa: bloquear y verificar todas las bolsas primero
    FOR v_item IN
      SELECT pi.bolsa_id, pi.cantidad, b.cantidad_disponible
      FROM pedido_items pi
      JOIN bolsas b ON b.id = pi.bolsa_id
      WHERE pi.pedido_id = p_pedido_id
      ORDER BY pi.bolsa_id  -- orden determinista para evitar deadlocks
      FOR UPDATE OF b
    LOOP
      IF v_item.cantidad_disponible < v_item.cantidad THEN
        RETURN jsonb_build_object(
          'resultado',   'stock_insuficiente',
          'bolsa_id',    v_item.bolsa_id,
          'disponible',  v_item.cantidad_disponible,
          'solicitado',  v_item.cantidad
        );
      END IF;
    END LOOP;

    -- Todas las verificaciones pasaron: descontar inventario
    FOR v_item IN
      SELECT bolsa_id, cantidad
      FROM pedido_items
      WHERE pedido_id = p_pedido_id
    LOOP
      UPDATE bolsas
      SET cantidad_disponible = cantidad_disponible - v_item.cantidad
      WHERE id = v_item.bolsa_id;
    END LOOP;

  ELSE
    -- Fallback: pedido con bolsa única (esquema anterior a pedido_items)
    v_cantidad := COALESCE(v_pedido.cantidad, 1);

    SELECT * INTO v_bolsa
    FROM bolsas
    WHERE id = v_pedido.bolsa_id
    FOR UPDATE;

    IF v_bolsa.cantidad_disponible < v_cantidad THEN
      RETURN jsonb_build_object(
        'resultado',   'stock_insuficiente',
        'bolsa_id',    v_pedido.bolsa_id,
        'disponible',  v_bolsa.cantidad_disponible,
        'solicitado',  v_cantidad
      );
    END IF;

    UPDATE bolsas
    SET cantidad_disponible = cantidad_disponible - v_cantidad
    WHERE id = v_pedido.bolsa_id;
  END IF;

  -- ── 8. Marcar pedido como pagado ─────────────────────────────────────────
  UPDATE pedidos SET
    estado                    = 'confirmado',
    estado_pago               = 'pagado',
    cubo_identifier           = p_cubo_identifier,
    cubo_payment_intent_token = p_payment_intent_token,
    cubo_reference_id         = p_cubo_reference_id,
    cubo_authorization_code   = p_cubo_authorization_code,
    pagado_en                 = COALESCE(p_cubo_processed_at, now())
  WHERE id = p_pedido_id;

  -- ── 9. Sumar puntos al cliente ────────────────────────────────────────────
  -- Error en puntos NO revierte el pago (bloque EXCEPTION aislado)
  BEGIN
    SELECT valor INTO v_puntos_cfg
    FROM configuracion
    WHERE clave = 'puntos_por_pedido';

    IF FOUND AND v_puntos_cfg IS NOT NULL THEN
      BEGIN
        v_puntos := v_puntos_cfg::integer;
      EXCEPTION WHEN OTHERS THEN
        v_puntos := 10;
      END;
    END IF;

    PERFORM sumar_puntos(v_pedido.usuario_id, v_puntos);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[confirmar_pago_cubo] sumar_puntos falló para pedido %: %', p_pedido_id, SQLERRM;
  END;

  -- ── Resultado exitoso ─────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'resultado',       'procesado',
    'pedido_id',       v_pedido.id,
    'codigo_recogida', v_pedido.codigo_recogida
  );

END;
$$;

-- Verificar que la función fue creada correctamente:
-- SELECT proname, proargnames FROM pg_proc WHERE proname = 'confirmar_pago_cubo';
