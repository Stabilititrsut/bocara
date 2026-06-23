-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ADVERTENCIA: ARCHIVO OPCIONAL — NO EJECUTAR PARA EL MODELO ACTUAL     ║
-- ║                                                                        ║
-- ║  El modelo vigente de Bocara es: 1 pedido → 1 bolsa (pedidos.bolsa_id) ║
-- ║  Este archivo agrega soporte para carrito multi-ítem.                  ║
-- ║                                                                        ║
-- ║  NO EJECUTAR hasta confirmar que:                                      ║
-- ║  1. El flujo de creación de pedidos Cubo usa pedido_items activamente  ║
-- ║  2. cubo-pago-schema.sql ya fue ejecutado exitosamente                 ║
-- ║  3. Se verificó con introspect-schema.sql que no hay conflictos        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Evidencia de uso futuro:
--   · bocara-mobile/app/pago.tsx línea 166: envía items[] al llamar cubopago()
--   · routes/pagos.js línea 401-413: inserta en pedido_items con fallback explícito
--   · services/stock.js línea 10-28: lee de pedido_items con fallback a []
--
-- Cuando el flujo Cubo esté activo y los datos anteriores ya existan en pedido_items,
-- ejecutar este archivo y luego reemplazar confirmar_pago_cubo por
-- confirmar_pago_cubo_multi_item (ver instrucciones al final).


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 1 — Tabla pedido_items
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS pedido_items (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id       UUID          NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  bolsa_id        UUID          NOT NULL REFERENCES bolsas(id),
  cantidad        INTEGER       NOT NULL CHECK (cantidad > 0),
  precio_unitario NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal        NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido
  ON pedido_items(pedido_id);

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 2 — Columna pedidos.cantidad
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Almacena la cantidad del ítem principal (fallback legacy cuando no hay pedido_items).
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cantidad INTEGER DEFAULT 1;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 3 — confirmar_pago_cubo_multi_item
--
-- Variante de la RPC principal con soporte para carrito multi-ítem.
-- Camino multi-ítem (pedido_items):
--   · Verifica TODO el stock antes de modificar cualquier fila (todo o nada).
--   · ORDER BY bolsa_id: orden determinista para evitar deadlocks entre
--     transacciones concurrentes que compartan bolsas.
-- Fallback bolsa única:
--   · Si pedido_items no tiene filas para el pedido, usa bolsa_id con
--     COALESCE(v_pedido.cantidad, 1).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION confirmar_pago_cubo_multi_item(
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
  v_bolsa        bolsas%ROWTYPE;
  v_item         RECORD;
  v_items_count  integer;
  v_cantidad     integer;
  v_puntos       integer := 10;
  v_puntos_cfg   text;
  v_eventos_pend jsonb;
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

  -- ── 1. Bloquear pedido ───────────────────────────────────────────────────
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 2. Idempotencia ──────────────────────────────────────────────────────
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

  -- ── 3-5. Verificar token, monto, estado ──────────────────────────────────
  IF v_pedido.cubo_payment_intent_token IS NULL
     OR v_pedido.cubo_payment_intent_token <> p_payment_intent_token THEN
    RETURN jsonb_build_object('resultado', 'token_incorrecto',
      'esperado', v_pedido.cubo_payment_intent_token, 'recibido', p_payment_intent_token);
  END IF;

  IF v_pedido.monto_esperado_centavos IS NULL
     OR v_pedido.monto_esperado_centavos <> p_monto_centavos THEN
    RETURN jsonb_build_object('resultado', 'monto_incorrecto',
      'esperado', v_pedido.monto_esperado_centavos, 'recibido', p_monto_centavos);
  END IF;

  IF p_estado_verificado <> 'SUCCEEDED' THEN
    RETURN jsonb_build_object('resultado', 'estado_invalido', 'estado', p_estado_verificado);
  END IF;

  -- ── 6. Inventario — multi-ítem con fallback bolsa única ──────────────────
  SELECT COUNT(*) INTO v_items_count
  FROM pedido_items WHERE pedido_id = p_pedido_id;

  IF v_items_count > 0 THEN
    -- Verificar disponibilidad en TODAS las bolsas antes de modificar ninguna.
    -- ORDER BY bolsa_id: orden determinista para evitar deadlocks entre
    -- transacciones que comparten bolsas.
    FOR v_item IN
      SELECT pi.bolsa_id, pi.cantidad, b.cantidad_disponible
      FROM pedido_items pi
      JOIN bolsas b ON b.id = pi.bolsa_id
      WHERE pi.pedido_id = p_pedido_id
      ORDER BY pi.bolsa_id
      FOR UPDATE OF b
    LOOP
      IF v_item.cantidad_disponible < v_item.cantidad THEN
        RETURN jsonb_build_object(
          'resultado',  'stock_insuficiente',
          'bolsa_id',   v_item.bolsa_id,
          'disponible', v_item.cantidad_disponible,
          'solicitado', v_item.cantidad
        );
      END IF;
    END LOOP;

    -- Todas las verificaciones pasaron: descontar (filas ya bloqueadas)
    FOR v_item IN
      SELECT pi.bolsa_id, pi.cantidad
      FROM pedido_items pi
      WHERE pi.pedido_id = p_pedido_id
    LOOP
      UPDATE bolsas
      SET cantidad_disponible = cantidad_disponible - v_item.cantidad
      WHERE id = v_item.bolsa_id;
    END LOOP;

  ELSE
    -- Fallback: bolsa única (pedidos sin pedido_items)
    IF v_pedido.bolsa_id IS NULL THEN
      RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', NULL);
    END IF;

    v_cantidad := COALESCE(v_pedido.cantidad, 1);

    SELECT * INTO v_bolsa FROM bolsas WHERE id = v_pedido.bolsa_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', v_pedido.bolsa_id);
    END IF;

    IF v_bolsa.cantidad_disponible < v_cantidad THEN
      RETURN jsonb_build_object(
        'resultado',  'stock_insuficiente',
        'bolsa_id',   v_pedido.bolsa_id,
        'disponible', v_bolsa.cantidad_disponible,
        'solicitado', v_cantidad
      );
    END IF;

    UPDATE bolsas
    SET cantidad_disponible = cantidad_disponible - v_cantidad
    WHERE id = v_pedido.bolsa_id;
  END IF;

  -- ── 7. Marcar pedido como pagado ─────────────────────────────────────────
  UPDATE pedidos SET
    estado                    = 'confirmado',
    estado_pago               = 'pagado',
    cubo_identifier           = p_cubo_identifier,
    cubo_payment_intent_token = p_payment_intent_token,
    cubo_reference_id         = p_cubo_reference_id,
    cubo_authorization_code   = p_cubo_authorization_code,
    pagado_en                 = COALESCE(p_cubo_processed_at, NOW())
  WHERE id = p_pedido_id;

  -- ── 8. Leer puntos configurados ──────────────────────────────────────────
  SELECT valor INTO v_puntos_cfg FROM configuracion WHERE clave = 'puntos_por_pedido';
  IF FOUND AND v_puntos_cfg IS NOT NULL THEN
    BEGIN
      v_puntos := v_puntos_cfg::integer;
    EXCEPTION WHEN OTHERS THEN
      v_puntos := 10;
    END;
  END IF;

  -- ── 9. Registrar 3 eventos separados ─────────────────────────────────────
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
-- PASO 4 — Permisos
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo_multi_item(uuid, text, integer, text, text, text, text, timestamptz)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo_multi_item(uuid, text, integer, text, text, text, text, timestamptz)
  FROM anon;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo_multi_item(uuid, text, integer, text, text, text, text, timestamptz)
  FROM authenticated;
GRANT  EXECUTE ON FUNCTION confirmar_pago_cubo_multi_item(uuid, text, integer, text, text, text, text, timestamptz)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 5 — Cómo reemplazar la RPC principal por la variante multi-ítem
--
-- Cuando pedido_items esté activo en producción y confirmado con datos reales:
--
--   1. Verificar que pedido_items tiene filas para pedidos Cubo recientes:
--      SELECT COUNT(*) FROM pedido_items pi
--      JOIN pedidos p ON p.id = pi.pedido_id
--      WHERE p.estado_pago = 'pagado' AND p.cubo_identifier IS NOT NULL;
--
--   2. Reemplazar el nombre en routes/webhooks.js:
--      Buscar: supabase.rpc('confirmar_pago_cubo', {
--      Reemplazar: supabase.rpc('confirmar_pago_cubo_multi_item', {
--
--   3. O bien: renombrar confirmar_pago_cubo_multi_item a confirmar_pago_cubo
--      (DROP la original, CREATE OR REPLACE con el nuevo cuerpo).
--
-- ════════════════════════════════════════════════════════════════════════════
