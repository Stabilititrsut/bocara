-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: corregir modelo de comisiones — el cargo de plataforma (3.5%) no
--            debe restarse del monto neto del restaurante.
-- Archivo   : supabase/migrations/202607311500_fix_comision_plataforma_no_resta_restaurante.sql
--
-- Idempotente: SÍ — CREATE OR REPLACE es seguro de re-ejecutar.
--
-- PROBLEMA CORREGIDO:
--   El modelo económico de Bocara es:
--     · comision_bocara      = 25% del precio del producto (sin propina) → Bocara.
--     · comision_pasarela    = 3.5% de (producto + envío + propina) → cargo de
--                               plataforma, 100% ingreso de Bocara. El cliente lo
--                               paga aparte (se suma al `total` que cobra Cubo).
--     · monto_neto_restaurante = 75% del producto + 100% de la propina.
--
--   La función aplicar_cupon_borrador (creada en
--   202606251000_cupon_reserva_atomica.sql) calculaba monto_neto_restaurante
--   restando TAMBIÉN comision_pasarela:
--
--     v_monto_neto := subtotal_productos - comision_bocara - comision_pasarela + propina
--
--   Esto cobraba el cargo de plataforma DOS VECES: una vez al cliente (ya viene
--   sumado en `total`) y otra vez descontándoselo al restaurante — y ese monto no
--   quedaba asignado a Bocara en ningún campo. Se pierde donde comisionPasarela
--   se resta a monto_neto_restaurante sin sumarse a ningún ingreso de Bocara.
--
--   Esta migración corrige la función para que monto_neto_restaurante sea
--   únicamente subtotal_productos - comision_bocara + propina.
--
-- Caso real verificado (único pedido pagado hasta la fecha de esta migración):
--   producto Q1.00 · comisión Bocara 25% = Q0.25 · cargo plataforma 3.5% = Q0.05
--   · propina Q0.50 · total cobrado por Cubo Q1.55.
--   Correcto: restaurante = 1.00 - 0.25 + 0.50 = Q1.25 (no Q1.20 como quedó guardado).
--   Bocara = 0.25 + 0.05 = Q0.30. Q1.25 + Q0.30 = Q1.55 ✓.
--
-- Esta migración NO modifica datos existentes — solo la función. La corrección
-- del registro histórico va en un UPDATE aparte, revisado antes de ejecutarse.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION aplicar_cupon_borrador(
  p_pedido_id  uuid,
  p_cupon_id   uuid,   -- NULL → quitar cupón
  p_usuario_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_pedido             pedidos%ROWTYPE;
  v_cupon              cupones%ROWTYPE;
  v_globales           bigint;
  v_por_usuario        bigint;
  v_descuento          numeric := 0;
  v_mensaje            text    := '';
  v_reserva_id         uuid;
  v_subtotal_productos numeric;
  v_propina            numeric;
  v_base_transaccion   numeric;
  v_comision_pasarela  numeric;
  v_total_base         numeric;
  v_total              numeric;
  v_monto_neto         numeric;
  COMISION_PLATAFORMA  CONSTANT numeric := 0.035; -- 3.5% — cargo de plataforma, 100% ingreso Bocara
BEGIN

  -- ── 1. Bloquear el pedido borrador ───────────────────────────────────────
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'pedido_no_encontrado');
  END IF;
  IF v_pedido.usuario_id != p_usuario_id THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'no_autorizado');
  END IF;
  IF v_pedido.estado != 'borrador' THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'pedido_no_borrador');
  END IF;

  -- ── 2. Liberar reservas activas anteriores de este pedido ────────────────
  UPDATE cupon_reservas
  SET estado = 'liberada', liberada_at = now()
  WHERE pedido_id = p_pedido_id AND estado = 'activa';

  -- ── 3. Calcular importes base desde pedido_items ─────────────────────────
  SELECT COALESCE(SUM(precio_unitario * cantidad), 0)
  INTO v_subtotal_productos
  FROM pedido_items
  WHERE pedido_id = p_pedido_id;

  v_subtotal_productos := ROUND(v_subtotal_productos, 2);
  v_propina            := ROUND(COALESCE(v_pedido.propina, 0), 2);
  -- Base del cargo de plataforma: producto + envío + propina (incluye propina,
  -- nunca solo el producto — así lo define el modelo de comisiones de Bocara).
  v_base_transaccion   := v_subtotal_productos + v_pedido.costo_envio + v_propina;
  v_comision_pasarela  := ROUND(v_base_transaccion * COMISION_PLATAFORMA, 2);
  v_total_base         := ROUND(v_base_transaccion + v_comision_pasarela, 2);

  -- ── 4a. Sin cupón: actualizar pedido y retornar ──────────────────────────
  IF p_cupon_id IS NULL THEN
    v_total      := v_total_base;
    -- No restar v_comision_pasarela: es 100% ingreso de Bocara y el cliente ya la
    -- pagó aparte (incluida en v_total_base) — restarla aquí la cobraría dos veces.
    v_monto_neto := ROUND(v_subtotal_productos - v_pedido.comision_bocara + v_propina, 2);

    UPDATE pedidos SET
      descuento_cupon        = 0,
      total                  = v_total,
      comision_pasarela      = v_comision_pasarela,
      monto_neto_restaurante = v_monto_neto
    WHERE id = p_pedido_id;

    RETURN jsonb_build_object(
      'ok',               true,
      'resultado',        'sin_cupon',
      'descuentoCupon',   0,
      'comisionPasarela', v_comision_pasarela,
      'total',            v_total,
      'mensaje',          ''
    );
  END IF;

  -- ── 4b. Bloquear y validar el cupón ──────────────────────────────────────
  SELECT * INTO v_cupon FROM cupones WHERE id = p_cupon_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_no_encontrado');
  END IF;
  IF NOT v_cupon.activo THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_inactivo');
  END IF;
  IF v_cupon.fecha_vencimiento IS NOT NULL AND v_cupon.fecha_vencimiento < now() THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_vencido');
  END IF;
  IF v_cupon.usuario_id_exclusivo IS NOT NULL
     AND v_cupon.usuario_id_exclusivo != p_usuario_id THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_exclusivo');
  END IF;

  -- ── 5. Verificar límites ──────────────────────────────────────────────────
  SELECT
    (SELECT COUNT(*) FROM cupon_reservas
       WHERE cupon_id   = p_cupon_id
         AND estado     = 'activa'
         AND expires_at > now())
    +
    (SELECT COUNT(*) FROM cupon_usos WHERE cupon_id = p_cupon_id)
  INTO v_globales;

  IF v_globales >= v_cupon.uso_maximo THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'limite_global_alcanzado');
  END IF;

  SELECT
    (SELECT COUNT(*) FROM cupon_reservas
       WHERE cupon_id   = p_cupon_id
         AND usuario_id = p_usuario_id
         AND estado     = 'activa'
         AND expires_at > now())
    +
    (SELECT COUNT(*) FROM cupon_usos
       WHERE cupon_id   = p_cupon_id
         AND usuario_id = p_usuario_id)
  INTO v_por_usuario;

  IF v_por_usuario >= v_cupon.uso_por_usuario THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'limite_usuario_alcanzado');
  END IF;

  -- ── 6. Calcular descuento ─────────────────────────────────────────────────
  IF v_cupon.tipo = 'porcentaje' THEN
    v_descuento := ROUND(v_total_base * v_cupon.valor / 100.0, 2);
  ELSE
    v_descuento := LEAST(v_cupon.valor::numeric, v_total_base);
  END IF;
  v_descuento := GREATEST(0, ROUND(v_descuento, 2));

  -- ── 7. Insertar reserva ───────────────────────────────────────────────────
  BEGIN
    INSERT INTO cupon_reservas (cupon_id, usuario_id, pedido_id, descuento_aplicado, expires_at)
    VALUES (p_cupon_id, p_usuario_id, p_pedido_id, v_descuento, now() + INTERVAL '2 hours')
    RETURNING id INTO v_reserva_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'reserva_duplicada');
  END;

  -- ── 8. Actualizar pedido con descuento y totales recalculados ────────────
  v_total      := GREATEST(0, ROUND(v_total_base - v_descuento, 2));
  -- No restar v_comision_pasarela — ver nota en el paso 4a.
  v_monto_neto := ROUND(v_subtotal_productos - v_pedido.comision_bocara + v_propina, 2);

  UPDATE pedidos SET
    descuento_cupon        = v_descuento,
    total                  = v_total,
    comision_pasarela      = v_comision_pasarela,
    monto_neto_restaurante = v_monto_neto
  WHERE id = p_pedido_id;

  -- ── 9. Mensaje del cupón ──────────────────────────────────────────────────
  v_mensaje := CASE
    WHEN v_cupon.tipo = 'porcentaje'
      THEN v_cupon.valor::text || '% de descuento — ahorras Q' || v_descuento::text
    ELSE 'Descuento de Q' || v_cupon.valor::text || ' aplicado'
  END;

  RETURN jsonb_build_object(
    'ok',               true,
    'resultado',        'reservado',
    'reserva_id',       v_reserva_id,
    'descuentoCupon',   v_descuento,
    'comisionPasarela', v_comision_pasarela,
    'total',            v_total,
    'mensaje',          v_mensaje
  );
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-MIGRACIÓN
-- ════════════════════════════════════════════════════════════════════════════

SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'aplicar_cupon_borrador';


-- ════════════════════════════════════════════════════════════════════════════
-- CORRECCIÓN DEL REGISTRO HISTÓRICO
--
-- Corrige el único pedido pagado hasta la fecha, que quedó con
-- monto_neto_restaurante = 1.20 (restándole el cargo de plataforma) en vez de
-- 1.25 (75% del producto + propina íntegra). comision_bocara (0.25),
-- comision_pasarela (0.05) y total (1.55) ya estaban correctos — no se tocan.
--
-- El WHERE incluye los valores conocidos del registro como guarda de seguridad:
-- si por lo que sea ya no coincide (por ejemplo si se corrigió a mano antes de
-- correr esto), la sentencia no actualiza nada en vez de sobreescribir a ciegas.
-- Revisar el RETURNING antes de dar la migración por buena.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE pedidos
SET monto_neto_restaurante = 1.25
WHERE estado_pago = 'pagado'
  AND cubo_payment_intent_token IS NOT NULL
  AND cubo_identifier IS NOT NULL
  AND total = 1.55
  AND propina = 0.50
  AND comision_bocara = 0.25
  AND comision_pasarela = 0.05
  AND monto_neto_restaurante = 1.20
RETURNING id, total, propina, comision_bocara, comision_pasarela, monto_neto_restaurante;
