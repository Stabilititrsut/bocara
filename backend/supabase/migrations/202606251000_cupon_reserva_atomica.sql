-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: Reserva atómica de cupón en pedido borrador
-- Archivo   : supabase/migrations/202606251000_cupon_reserva_atomica.sql
--
-- Idempotente : SÍ — segura para ejecutar varias veces
-- Pre-condición: migración 202406241200_cupones_referidos.sql ejecutada
--
-- PROBLEMA CORREGIDO:
--   El flujo anterior (liberar_reserva_cupon + reservar_cupon en Node.js)
--   exponía una condición de carrera: dos solicitudes concurrentes con
--   cupones distintos podían liberar sin que ninguna hubiera insertado
--   su reserva aún, terminando con DOS reservas activas para el mismo pedido.
--
-- SOLUCIÓN:
--   1. Índice único parcial: garantiza a nivel DB que nunca existan dos
--      reservas activas para el mismo pedido.
--   2. Función aplicar_cupon_borrador: ejecuta los 5 pasos en una única
--      transacción, comenzando por bloquear el pedido (FOR UPDATE) para
--      serializar solicitudes concurrentes antes de liberar e insertar.
--
-- ORDEN DE EJECUCIÓN:
--   1. BLOQUE 0: Prechecks
--   2. BLOQUE 1: Columna propina (idempotente)
--   3. BLOQUE 2: Índice único parcial
--   4. BLOQUE 3: Función aplicar_cupon_borrador
--   5. BLOQUE 4: Tests en ROLLBACK
--
-- DESPLIEGUE: ejecutar esta migración ANTES de desplegar el código Node.js
--             que llama a aplicar_cupon_borrador.
-- ══════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 0 — PRECHECKS
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_conflictos integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'cupon_reservas') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla cupon_reservas no existe — ejecutar 202406241200_cupones_referidos.sql primero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'pedido_items') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla pedido_items no existe — ejecutar cubo-pago-schema.sql primero';
  END IF;

  -- Verificar que no existan conflictos que impidan crear el índice único
  SELECT COUNT(*) INTO v_conflictos FROM (
    SELECT pedido_id FROM cupon_reservas
    WHERE estado = 'activa'
    GROUP BY pedido_id HAVING COUNT(*) > 1
  ) t;
  IF v_conflictos > 0 THEN
    RAISE EXCEPTION
      'PRECHECK FAILED: % pedido(s) tienen múltiples reservas activas. '
      'Resolver antes de crear el índice único. Limpiar con: '
      'UPDATE cupon_reservas cr SET estado = ''liberada'', liberada_at = now() '
      'FROM (SELECT pedido_id, MAX(created_at) AS ultima FROM cupon_reservas '
      'WHERE estado = ''activa'' GROUP BY pedido_id HAVING COUNT(*) > 1) dup '
      'WHERE cr.pedido_id = dup.pedido_id AND cr.estado = ''activa'' '
      'AND cr.created_at < dup.ultima;', v_conflictos;
  END IF;

  RAISE NOTICE '✓ PRECHECKS: tablas cupon_reservas y pedido_items presentes, sin conflictos de unicidad.';
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUEs 1-3 — MIGRACIÓN ATÓMICA
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;


-- ── BLOQUE 1: Columna propina en pedidos (requerida por la función) ──────────

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS propina numeric NOT NULL DEFAULT 0
  CHECK (propina >= 0);


-- ── BLOQUE 2: Índice único parcial ──────────────────────────────────────────
-- Garantiza a nivel DB que un pedido nunca tenga dos reservas activas.
-- Es la red de seguridad ante bugs upstream; la serialización por FOR UPDATE
-- en la función es la primera línea de defensa.

CREATE UNIQUE INDEX IF NOT EXISTS uq_cupon_reserva_activa_por_pedido
  ON cupon_reservas (pedido_id)
  WHERE estado = 'activa';


-- ── BLOQUE 3: Función aplicar_cupon_borrador ─────────────────────────────────
-- Aplica o retira un cupón en un pedido borrador de forma completamente atómica.
--
-- Los 5 pasos ocurren en una única transacción PostgreSQL:
--   1. Bloquea el pedido (SELECT … FOR UPDATE) — serializa concurrentes.
--   2. Libera todas las reservas activas del pedido.
--   3. Valida y reserva el nuevo cupón (o solo libera si cupon_id IS NULL).
--   4. Recalcula comisionPasarela, total y montoNeto desde pedido_items.
--   5. Actualiza el mismo registro de pedidos (pedidoId invariante).
--
-- Parámetros:
--   p_pedido_id  — id del pedido borrador
--   p_cupon_id   — id del cupón a aplicar, o NULL para quitar el cupón
--   p_usuario_id — id del usuario autenticado (verificación de propiedad)
--
-- Retorna jsonb:
--   ok=true  → { ok, resultado, descuentoCupon, comisionPasarela, total, mensaje }
--   ok=false → { ok, resultado: <codigo_error> }
--     códigos: pedido_no_encontrado | no_autorizado | pedido_no_borrador |
--              cupon_no_encontrado | cupon_inactivo | cupon_vencido |
--              cupon_exclusivo | limite_global_alcanzado | limite_usuario_alcanzado |
--              reserva_duplicada

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
  v_subtotal           numeric;
  v_comision_pasarela  numeric;
  v_total_base         numeric;
  v_total              numeric;
  v_monto_neto         numeric;
  COMISION_CUBO        CONSTANT numeric := 0.035;
BEGIN

  -- ── 1. Bloquear el pedido borrador ───────────────────────────────────────
  -- FOR UPDATE serializa solicitudes concurrentes para el mismo pedido:
  -- la segunda transacción espera hasta que la primera libere el lock.
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
  v_subtotal           := v_subtotal_productos + v_pedido.costo_envio + v_propina;
  v_comision_pasarela  := ROUND(v_subtotal * COMISION_CUBO, 2);
  v_total_base         := ROUND(v_subtotal + v_comision_pasarela, 2);

  -- ── 4a. Sin cupón: actualizar pedido y retornar ──────────────────────────
  IF p_cupon_id IS NULL THEN
    v_total      := v_total_base;
    v_monto_neto := ROUND(v_subtotal_productos - v_pedido.comision_bocara
                          - v_comision_pasarela + v_propina, 2);

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
  -- Reservas activas no vencidas (de otros pedidos) + usos confirmados
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
  -- El FOR UPDATE del pedido serializa las transacciones concurrentes, por lo
  -- que en condiciones normales el índice único nunca se viola aquí.
  -- Si llegara a violarse por algún bug upstream, devolvemos error controlado
  -- (no 500 genérico).
  BEGIN
    INSERT INTO cupon_reservas (cupon_id, usuario_id, pedido_id, descuento_aplicado, expires_at)
    VALUES (p_cupon_id, p_usuario_id, p_pedido_id, v_descuento, now() + INTERVAL '2 hours')
    RETURNING id INTO v_reserva_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'reserva_duplicada');
  END;

  -- ── 8. Actualizar pedido con descuento y totales recalculados ────────────
  v_total      := GREATEST(0, ROUND(v_total_base - v_descuento, 2));
  v_monto_neto := ROUND(v_subtotal_productos - v_pedido.comision_bocara
                        - v_comision_pasarela + v_propina, 2);

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

COMMIT; -- fin BLOQUEs 1-3


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — VERIFICACIONES POST-MIGRACIÓN
-- ════════════════════════════════════════════════════════════════════════════

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'uq_cupon_reserva_activa_por_pedido';

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name = 'propina';

SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'aplicar_cupon_borrador';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 — TESTS EN ROLLBACK
-- Ejecutar el bloque BEGIN…ROLLBACK completo de una sola vez.
-- El ROLLBACK final revierte todo. No afecta producción.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_result      jsonb;
  v_usr_id      uuid;
  v_usr2_id     uuid;
  v_neg_id      uuid;
  v_bolsa_id    uuid;
  v_cupon_id    uuid;
  v_cupon2_id   uuid;
  v_ped_id      uuid;
  v_ped2_id     uuid;
  v_reservas    integer;
  v_total_antes numeric;
  v_total_desp  numeric;
BEGIN

  -- ── Datos de prueba ───────────────────────────────────────────────────────
  INSERT INTO usuarios (id, email, password_hash, nombre, rol, puntos, total_bolsas_salvadas)
  VALUES (gen_random_uuid(), 'test_cupon_atomico@bocara.test', 'HASH_INVALIDO_TEST', 'Test Cupon', 'cliente', 0, 0)
  RETURNING id INTO v_usr_id;

  INSERT INTO usuarios (id, email, password_hash, nombre, rol, puntos, total_bolsas_salvadas)
  VALUES (gen_random_uuid(), 'test_cupon_otro@bocara.test', 'HASH_INVALIDO_TEST', 'Test Otro', 'cliente', 0, 0)
  RETURNING id INTO v_usr2_id;

  INSERT INTO negocios (id, propietario_id, nombre, direccion, zona, ciudad, categoria)
  VALUES (gen_random_uuid(), v_usr_id, 'Negocio Test Cupon', 'Zona 1', 'Zona 1', 'Guatemala', 'restaurante')
  RETURNING id INTO v_neg_id;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa Test', 100.00, 50.00, 10, '18:00', '20:00')
  RETURNING id INTO v_bolsa_id;

  INSERT INTO cupones (id, codigo, tipo, valor, uso_maximo, uso_por_usuario, activo)
  VALUES (gen_random_uuid(), 'TEST-CUPON-A', 'monto_fijo', 10.00, 5, 1, true)
  RETURNING id INTO v_cupon_id;

  INSERT INTO cupones (id, codigo, tipo, valor, uso_maximo, uso_por_usuario, activo)
  VALUES (gen_random_uuid(), 'TEST-CUPON-B', 'porcentaje', 20, 5, 1, true)
  RETURNING id INTO v_cupon2_id;

  -- Pedido borrador del usuario 1
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, precio_bolsa, costo_envio, comision_bocara,
                       comision_pasarela, monto_neto_restaurante, total,
                       codigo_recogida, payu_reference_code,
                       descuento_cupon, propina)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_id, v_neg_id,
          'borrador', 'pendiente', 'recogida', 50.00, 0, 12.50,
          1.75, 35.75, 51.75, 'BOC-TST1', 'REF-TST1', 0, 0)
  RETURNING id INTO v_ped_id;

  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_ped_id, v_bolsa_id, 1, 50.00, 50.00);

  -- ── TEST 1: Aplicar cupón monto_fijo — mismo pedidoId, descuento correcto ─
  SELECT aplicar_cupon_borrador(v_ped_id, v_cupon_id, v_usr_id) INTO v_result;
  ASSERT v_result->>'ok' = 'true',
    'Test 1 FALLÓ: esperado ok=true, obtenido=' || v_result::text;
  ASSERT v_result->>'resultado' = 'reservado',
    'Test 1 FALLÓ: resultado=' || (v_result->>'resultado');
  ASSERT (v_result->>'descuentoCupon')::numeric = 10.00,
    'Test 1 FALLÓ: descuentoCupon esperado 10, obtenido=' || (v_result->>'descuentoCupon');

  -- Verificar que solo hay una reserva activa
  SELECT COUNT(*) INTO v_reservas
  FROM cupon_reservas WHERE pedido_id = v_ped_id AND estado = 'activa';
  ASSERT v_reservas = 1,
    'Test 1 FALLÓ: esperada 1 reserva activa, encontradas=' || v_reservas;

  -- Verificar que el total del pedido se actualizó
  SELECT total INTO v_total_desp FROM pedidos WHERE id = v_ped_id;
  ASSERT v_total_desp = 41.75,  -- 51.75 - 10.00
    'Test 1 FALLÓ: total esperado 41.75, obtenido=' || v_total_desp;

  -- Verificar que el descuento_cupon se actualizó en el pedido
  ASSERT (SELECT descuento_cupon FROM pedidos WHERE id = v_ped_id) = 10.00,
    'Test 1 FALLÓ: descuento_cupon en pedidos no actualizado';

  RAISE NOTICE '✓ Test 1: aplicar cupón monto_fijo — mismo pedidoId, descuento=10, total=41.75, 1 reserva activa';

  -- ── TEST 2: Aplicar segundo cupón — primer cupón liberado, nuevo activo ───
  SELECT aplicar_cupon_borrador(v_ped_id, v_cupon2_id, v_usr_id) INTO v_result;
  ASSERT v_result->>'ok' = 'true',
    'Test 2 FALLÓ: esperado ok=true, obtenido=' || v_result::text;

  -- Verificar que SOLO hay una reserva activa (no dos)
  SELECT COUNT(*) INTO v_reservas
  FROM cupon_reservas WHERE pedido_id = v_ped_id AND estado = 'activa';
  ASSERT v_reservas = 1,
    'Test 2 FALLÓ: esperada 1 reserva activa tras cambiar cupón, encontradas=' || v_reservas;

  -- Verificar que el cupón anterior está liberado
  ASSERT EXISTS (
    SELECT 1 FROM cupon_reservas
    WHERE pedido_id = v_ped_id AND cupon_id = v_cupon_id AND estado = 'liberada'
  ), 'Test 2 FALLÓ: reserva del cupón A no fue liberada';

  -- Verificar que la reserva activa es del nuevo cupón
  ASSERT EXISTS (
    SELECT 1 FROM cupon_reservas
    WHERE pedido_id = v_ped_id AND cupon_id = v_cupon2_id AND estado = 'activa'
  ), 'Test 2 FALLÓ: reserva del cupón B no está activa';

  -- Verificar descuento del 20% sobre total_base (50 + 0 propina + 0 envío + comisión)
  -- total_base = 50 + 0 + 0 + round(50*0.035, 2) = 50 + 1.75 = 51.75
  -- descuento = round(51.75 * 20/100, 2) = 10.35
  ASSERT (v_result->>'descuentoCupon')::numeric = 10.35,
    'Test 2 FALLÓ: descuento 20% sobre 51.75 esperado=10.35, obtenido=' || (v_result->>'descuentoCupon');
  ASSERT (v_result->>'total')::numeric = 41.40,  -- 51.75 - 10.35
    'Test 2 FALLÓ: total esperado=41.40, obtenido=' || (v_result->>'total');

  RAISE NOTICE '✓ Test 2: cambio de cupón — cupón A liberado, cupón B activo, descuento=10.35, total=41.40';

  -- ── TEST 3: Quitar cupón — cero reservas activas, descuento=0 ─────────────
  SELECT aplicar_cupon_borrador(v_ped_id, NULL, v_usr_id) INTO v_result;
  ASSERT v_result->>'ok' = 'true',
    'Test 3 FALLÓ: esperado ok=true, obtenido=' || v_result::text;
  ASSERT v_result->>'resultado' = 'sin_cupon',
    'Test 3 FALLÓ: resultado=' || (v_result->>'resultado');
  ASSERT (v_result->>'descuentoCupon')::numeric = 0,
    'Test 3 FALLÓ: descuentoCupon esperado 0, obtenido=' || (v_result->>'descuentoCupon');

  SELECT COUNT(*) INTO v_reservas
  FROM cupon_reservas WHERE pedido_id = v_ped_id AND estado = 'activa';
  ASSERT v_reservas = 0,
    'Test 3 FALLÓ: esperadas 0 reservas activas tras quitar cupón, encontradas=' || v_reservas;

  ASSERT (SELECT total FROM pedidos WHERE id = v_ped_id) = 51.75,
    'Test 3 FALLÓ: total sin cupón esperado=51.75, obtenido=' || (SELECT total FROM pedidos WHERE id = v_ped_id);
  ASSERT (SELECT descuento_cupon FROM pedidos WHERE id = v_ped_id) = 0,
    'Test 3 FALLÓ: descuento_cupon en pedidos no resetado a 0';

  RAISE NOTICE '✓ Test 3: quitar cupón — 0 reservas activas, descuento=0, total=51.75';

  -- ── TEST 4: Usuario incorrecto → no_autorizado ────────────────────────────
  SELECT aplicar_cupon_borrador(v_ped_id, v_cupon_id, v_usr2_id) INTO v_result;
  ASSERT v_result->>'ok' = 'false',
    'Test 4 FALLÓ: esperado ok=false para usuario incorrecto';
  ASSERT v_result->>'resultado' = 'no_autorizado',
    'Test 4 FALLÓ: resultado=' || (v_result->>'resultado');

  RAISE NOTICE '✓ Test 4: usuario incorrecto → no_autorizado';

  -- ── TEST 5: Pedido inexistente → pedido_no_encontrado ─────────────────────
  SELECT aplicar_cupon_borrador(gen_random_uuid(), v_cupon_id, v_usr_id) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_encontrado',
    'Test 5 FALLÓ: resultado=' || (v_result->>'resultado');

  RAISE NOTICE '✓ Test 5: pedido inexistente → pedido_no_encontrado';

  -- ── TEST 6: Pedido no borrador → pedido_no_borrador ──────────────────────
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, precio_bolsa, costo_envio, comision_bocara,
                       comision_pasarela, monto_neto_restaurante, total,
                       codigo_recogida, payu_reference_code, descuento_cupon)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_id, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 50.00, 0, 12.50,
          1.75, 35.75, 51.75, 'BOC-TST2', 'REF-TST2', 0)
  RETURNING id INTO v_ped2_id;

  SELECT aplicar_cupon_borrador(v_ped2_id, v_cupon_id, v_usr_id) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_borrador',
    'Test 6 FALLÓ: resultado=' || (v_result->>'resultado');

  RAISE NOTICE '✓ Test 6: pedido en estado pendiente → pedido_no_borrador';

  -- ── TEST 7: Cupón inválido → cupon_no_encontrado ──────────────────────────
  SELECT aplicar_cupon_borrador(v_ped_id, gen_random_uuid(), v_usr_id) INTO v_result;
  ASSERT v_result->>'resultado' = 'cupon_no_encontrado',
    'Test 7 FALLÓ: resultado=' || (v_result->>'resultado');

  RAISE NOTICE '✓ Test 7: cupón inexistente → cupon_no_encontrado';

  -- ── TEST 8: Índice único — inserción duplicada de reserva activa rechazada ─
  -- Simulamos insertar directamente dos reservas activas para el mismo pedido.
  -- La segunda debe fallar con unique_violation.
  INSERT INTO cupon_reservas (cupon_id, usuario_id, pedido_id, descuento_aplicado, expires_at)
  VALUES (v_cupon_id, v_usr_id, v_ped_id, 10.00, now() + INTERVAL '2 hours');

  BEGIN
    INSERT INTO cupon_reservas (cupon_id, usuario_id, pedido_id, descuento_aplicado, expires_at)
    VALUES (v_cupon2_id, v_usr_id, v_ped_id, 5.00, now() + INTERVAL '2 hours');
    ASSERT FALSE, 'Test 8 FALLÓ: índice único no rechazó la segunda reserva activa para el mismo pedido';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- Esperado
  END;

  SELECT COUNT(*) INTO v_reservas
  FROM cupon_reservas WHERE pedido_id = v_ped_id AND estado = 'activa';
  ASSERT v_reservas = 1,
    'Test 8 FALLÓ: esperada 1 reserva activa, encontradas=' || v_reservas;

  RAISE NOTICE '✓ Test 8: índice único uq_cupon_reserva_activa_por_pedido rechaza segunda reserva activa';

  -- ── TEST 9: Cupón exclusivo de otro usuario ───────────────────────────────
  DECLARE v_cupon_excl_id uuid;
  BEGIN
    INSERT INTO cupones (id, codigo, tipo, valor, uso_maximo, uso_por_usuario,
                         activo, usuario_id_exclusivo)
    VALUES (gen_random_uuid(), 'TEST-EXCLUSIVO', 'monto_fijo', 5.00, 1, 1, true, v_usr2_id)
    RETURNING id INTO v_cupon_excl_id;

    SELECT aplicar_cupon_borrador(v_ped_id, v_cupon_excl_id, v_usr_id) INTO v_result;
    ASSERT v_result->>'resultado' = 'cupon_exclusivo',
      'Test 9 FALLÓ: resultado=' || (v_result->>'resultado');

    RAISE NOTICE '✓ Test 9: cupón exclusivo de otro usuario → cupon_exclusivo';
  END;

  -- ── TEST 10: Cupón vencido ────────────────────────────────────────────────
  DECLARE v_cupon_venc_id uuid;
  BEGIN
    INSERT INTO cupones (id, codigo, tipo, valor, uso_maximo, uso_por_usuario,
                         activo, fecha_vencimiento)
    VALUES (gen_random_uuid(), 'TEST-VENCIDO', 'monto_fijo', 5.00, 1, 1, true,
            now() - INTERVAL '1 day')
    RETURNING id INTO v_cupon_venc_id;

    SELECT aplicar_cupon_borrador(v_ped_id, v_cupon_venc_id, v_usr_id) INTO v_result;
    ASSERT v_result->>'resultado' = 'cupon_vencido',
      'Test 10 FALLÓ: resultado=' || (v_result->>'resultado');

    RAISE NOTICE '✓ Test 10: cupón vencido → cupon_vencido';
  END;

  -- ── Resumen ───────────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Todos los tests pasaron (10/10) — reserva atómica de cupón';
  RAISE NOTICE '  · pedidoId invariante en aplicar/quitar cupón';
  RAISE NOTICE '  · Cambiar cupón: reserva anterior liberada, nueva activa (1 única)';
  RAISE NOTICE '  · Quitar cupón: 0 reservas activas, total y descuento_cupon = 0';
  RAISE NOTICE '  · Autorización, estado borrador y validez del cupón verificados';
  RAISE NOTICE '  · Índice único uq_cupon_reserva_activa_por_pedido activo y funcional';
  RAISE NOTICE '══════════════════════════════════════════════════════════════════════';

END $$;

ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — cómo revertir esta migración si es necesario
-- EJECUTAR SOLO SI ES NECESARIO. Afecta datos reales.
-- ════════════════════════════════════════════════════════════════════════════

/*

BEGIN;

DROP FUNCTION IF EXISTS aplicar_cupon_borrador(uuid, uuid, uuid);
DROP INDEX IF EXISTS uq_cupon_reserva_activa_por_pedido;
-- No revertir la columna propina si ya tiene datos.

COMMIT;

*/
