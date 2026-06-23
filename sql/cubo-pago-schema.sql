-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Cubo Pago Guatemala: migración auditada v2                   ║
-- ║                                                                        ║
-- ║  INSTRUCCIONES:                                                        ║
-- ║  1. Leer COMPLETAMENTE este archivo antes de ejecutar nada             ║
-- ║  2. BLOQUE 0 (prechecks) — ejecutar solo. Debe terminar con NOTICE ✓  ║
-- ║  3. BLOQUE 1 (columnas/tablas) — ejecutar; verificar 0 errores        ║
-- ║  4. BLOQUE 2 (RPC) — ejecutar; verificar que la función aparece       ║
-- ║     en Database → Functions                                            ║
-- ║  5. BLOQUE 3 (permisos) — ejecutar                                    ║
-- ║  6. BLOQUE 4 (verificación post-migración) — ejecutar y revisar       ║
-- ║  7. BLOQUE 5 (tests ROLLBACK) — ejecutar para validar sin afectar DB  ║
-- ║                                                                        ║
-- ║  CUBO_PAYMENTS_ENABLED debe permanecer en "false" durante todo        ║
-- ║  el proceso. Solo activar tras verificar la migración completa.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 0 — PRECHECKS (solo lectura — no altera nada)
-- Ejecutar primero. Debe terminar con RAISE NOTICE ✓ y sin EXCEPTION.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_dup_count INTEGER;
BEGIN
  -- Tablas base obligatorias
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'pedidos') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla pedidos no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'bolsas') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla bolsas no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla usuarios no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'configuracion') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla configuracion no existe — ejecutar backend/scripts/migrations.sql primero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'notificaciones') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla notificaciones no existe';
  END IF;

  -- Función sumar_puntos (schema_fix.sql)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'sumar_puntos' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'PRECHECK FAILED: función sumar_puntos no existe — ejecutar schema_fix.sql primero';
  END IF;

  -- Columna inventario en bolsas
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'bolsas'
                   AND column_name = 'cantidad_disponible') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: bolsas.cantidad_disponible no existe';
  END IF;

  -- Verificar duplicados en cubo_payment_intent_token si la columna ya existe
  -- (se creará índice UNIQUE en BLOQUE 1; fallaría con duplicados)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedidos'
      AND column_name = 'cubo_payment_intent_token'
  ) THEN
    SELECT COUNT(*) INTO v_dup_count
    FROM (
      SELECT cubo_payment_intent_token
      FROM pedidos
      WHERE cubo_payment_intent_token IS NOT NULL
      GROUP BY cubo_payment_intent_token
      HAVING COUNT(*) > 1
    ) dups;

    IF v_dup_count > 0 THEN
      RAISE EXCEPTION
        'PRECHECK FAILED: % token(s) Cubo duplicados en pedidos — resolver manualmente antes de crear índice único',
        v_dup_count;
    END IF;
  END IF;

  RAISE NOTICE '✓ PRECHECKS: todas las verificaciones pasaron. Proceder con BLOQUE 1.';
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — COLUMNAS, TABLAS NUEVAS, RESTRICCIONES E ÍNDICES
-- Idempotente (IF NOT EXISTS / ON CONFLICT). Ejecutar dentro de BEGIN/COMMIT.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1a. Columnas Cubo en pedidos ─────────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_identifier           TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_authorization_code   TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagado_en                 TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_payment_intent_token TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_esperado_centavos   INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_reference_id         TEXT;

-- CRÍTICO: la RPC usa pedidos%ROWTYPE y accede a v_pedido.cantidad en el
-- fallback de bolsa única. Si la columna no existe, la función no compila.
-- El código Node.js ya intenta insertar esta columna con fallback gracioso.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cantidad INTEGER DEFAULT 1;

-- ── 1b. Tabla pedido_items ───────────────────────────────────────────────
-- Requerida por la RPC y por services/stock.js. No estaba en ninguna
-- migración anterior a pesar de ser referenciada en el código productivo.
CREATE TABLE IF NOT EXISTS pedido_items (
  id              UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id       UUID          NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  bolsa_id        UUID          NOT NULL REFERENCES bolsas(id),
  cantidad        INTEGER       NOT NULL CHECK (cantidad > 0),
  precio_unitario NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal        NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items(pedido_id);

-- ── 1c. Tabla pago_eventos_pendientes ────────────────────────────────────
-- Registra eventos post-pago (notificaciones push, suma de puntos) dentro
-- de la misma transacción que confirma el pago. Permite:
--   · Webhook duplicado: el evento ya existe (UNIQUE) → no se duplica
--   · Fallo de notificación/puntos: evento queda pendiente para reintento
--   · Reintento manual o periódico sin riesgo de confirmar el pago de nuevo
CREATE TABLE IF NOT EXISTS pago_eventos_pendientes (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id     UUID        NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo_evento   TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  completado    BOOLEAN     NOT NULL DEFAULT FALSE,
  intentos      INTEGER     NOT NULL DEFAULT 0,
  error_ultimo  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completado_at TIMESTAMPTZ,
  UNIQUE (pedido_id, tipo_evento)
);
-- Índice parcial para procesamiento de eventos pendientes
CREATE INDEX IF NOT EXISTS idx_pago_eventos_pendientes
  ON pago_eventos_pendientes(created_at)
  WHERE NOT completado;

-- ── 1d. CHECK: monto_esperado_centavos > 0 (si está presente) ────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'pedidos'
      AND constraint_name = 'chk_monto_esperado_centavos'
  ) THEN
    ALTER TABLE pedidos ADD CONSTRAINT chk_monto_esperado_centavos
      CHECK (monto_esperado_centavos IS NULL OR monto_esperado_centavos > 0);
  END IF;
END $$;

-- ── 1e. Índice único parcial en cubo_payment_intent_token ─────────────────
-- Cada token Cubo debe corresponder a un único pedido. Parcial: solo tokens
-- no nulos. El BLOQUE 0 verificó que no existen duplicados existentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_cubo_token_unique
  ON pedidos(cubo_payment_intent_token)
  WHERE cubo_payment_intent_token IS NOT NULL;

-- ── 1f. Configuración de puntos por pedido ────────────────────────────────
INSERT INTO configuracion (clave, valor)
VALUES ('puntos_por_pedido', '10')
ON CONFLICT (clave) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — RPC confirmar_pago_cubo (versión auditada)
--
-- Cambios respecto a la versión anterior:
--   · SET search_path = public, pg_temp  (seguridad SECURITY DEFINER)
--   · Validación explícita de todos los parámetros de entrada
--   · Inventario: verificación y descuento en la misma pasada bloqueada
--     con FOR UPDATE OF b (eliminado el segundo loop sin bloqueo)
--   · Bolsa no encontrada en fallback: retorna error explícito en vez de
--     continuar con stock insuficiente falso
--   · Puntos: reemplaza EXCEPTION silencioso por evento 'sumar_puntos'
--     registrado dentro de la transacción (reintentable, no se pierde)
--   · Evento 'pago_cubo_confirmado' registrado dentro de la transacción
--     para manejo idempotente de notificaciones push post-commit
--   · Caso 'duplicado': devuelve lista de eventos pendientes para que el
--     backend pueda reintentarlos sin re-confirmar el pago
--   · Sin SQL dinámico; sin aceptar estado arbitrario del cliente
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
  v_bolsa        bolsas%ROWTYPE;
  v_item         RECORD;
  v_items_count  integer;
  v_cantidad     integer;
  v_puntos       integer := 10;
  v_puntos_cfg   text;
  v_eventos_pend jsonb;
BEGIN

  -- ── 0. Validar parámetros de entrada ─────────────────────────────────────
  -- No aceptar datos arbitrarios de clientes públicos: todos los parámetros
  -- son verificados antes de tocar la base de datos.
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_pedido_id');
  END IF;
  IF p_payment_intent_token IS NULL OR p_payment_intent_token = '' THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_payment_intent_token');
  END IF;
  IF p_monto_centavos IS NULL OR p_monto_centavos <= 0 THEN
    RETURN jsonb_build_object(
      'resultado', 'parametro_invalido',
      'campo',     'p_monto_centavos',
      'valor',     p_monto_centavos
    );
  END IF;
  IF p_estado_verificado IS NULL OR p_estado_verificado = '' THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_estado_verificado');
  END IF;

  -- ── 1. Bloquear el pedido ────────────────────────────────────────────────
  -- FOR UPDATE: dos webhooks concurrentes del mismo pedido no pueden avanzar
  -- al mismo tiempo. El segundo espera a que el primero haga COMMIT/ROLLBACK.
  SELECT * INTO v_pedido
  FROM pedidos
  WHERE id = p_pedido_id
  FOR UPDATE;

  -- ── 2. Verificar que el pedido existe ────────────────────────────────────
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 3. Idempotencia: ya fue procesado ────────────────────────────────────
  -- En caso de webhook duplicado, devolver la lista de eventos pendientes
  -- para que el backend los reintente sin volver a confirmar el pago ni
  -- descontar inventario.
  IF v_pedido.estado_pago = 'pagado' THEN
    SELECT jsonb_agg(tipo_evento) INTO v_eventos_pend
    FROM pago_eventos_pendientes
    WHERE pedido_id = p_pedido_id AND NOT completado;

    RETURN jsonb_build_object(
      'resultado',          'duplicado',
      'pedido_id',          v_pedido.id,
      'codigo_recogida',    v_pedido.codigo_recogida,
      'eventos_pendientes', COALESCE(v_eventos_pend, '[]'::jsonb)
    );
  END IF;

  -- ── 4. Verificar token almacenado (segunda barrera) ───────────────────────
  -- El token fue guardado al crear el link de pago (no llega solo del webhook).
  IF v_pedido.cubo_payment_intent_token IS NULL
     OR v_pedido.cubo_payment_intent_token <> p_payment_intent_token THEN
    RETURN jsonb_build_object(
      'resultado', 'token_incorrecto',
      'esperado',  v_pedido.cubo_payment_intent_token,
      'recibido',  p_payment_intent_token
    );
  END IF;

  -- ── 5. Verificar monto esperado (segunda barrera) ────────────────────────
  -- El monto fue calculado y guardado en el servidor al crear el link.
  IF v_pedido.monto_esperado_centavos IS NULL
     OR v_pedido.monto_esperado_centavos <> p_monto_centavos THEN
    RETURN jsonb_build_object(
      'resultado', 'monto_incorrecto',
      'esperado',  v_pedido.monto_esperado_centavos,
      'recibido',  p_monto_centavos
    );
  END IF;

  -- ── 6. Verificar estado confirmado externamente ──────────────────────────
  -- Solo acepta 'SUCCEEDED'; el estado viene del backend (ya verificado con
  -- Cubo), nunca directamente de un cliente público.
  IF p_estado_verificado <> 'SUCCEEDED' THEN
    RETURN jsonb_build_object(
      'resultado', 'estado_invalido',
      'estado',    p_estado_verificado
    );
  END IF;

  -- ── 7. Verificar y descontar inventario ──────────────────────────────────
  -- Estrategia: bloquear todas las bolsas en orden determinista (ORDER BY
  -- bolsa_id) para evitar deadlocks entre transacciones concurrentes con
  -- carritos solapados. Verificar disponibilidad ANTES de modificar
  -- cualquier fila: si falla una, se retorna sin haber descontado nada.
  -- La función retorna JSONB de error (no lanza EXCEPTION), por lo tanto
  -- las actualizaciones anteriores dentro del mismo LOOP no quedan
  -- confirmadas — el loop se interrumpe y la transacción completa es
  -- revertida por el caller si este hace ROLLBACK, o confirmada solo si
  -- todos los ítems pasan la verificación.

  SELECT COUNT(*) INTO v_items_count
  FROM pedido_items
  WHERE pedido_id = p_pedido_id;

  IF v_items_count > 0 THEN
    -- Modo carrito (pedido_items): verificar TODO antes de modificar nada
    FOR v_item IN
      SELECT pi.bolsa_id, pi.cantidad, b.cantidad_disponible
      FROM pedido_items pi
      JOIN bolsas b ON b.id = pi.bolsa_id
      WHERE pi.pedido_id = p_pedido_id
      ORDER BY pi.bolsa_id   -- orden determinista anti-deadlock
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

    -- Todas las verificaciones pasaron: descontar (filas ya bloqueadas FOR UPDATE)
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
    -- Modo bolsa única (fallback: pedidos sin pedido_items — esquema anterior)
    v_cantidad := COALESCE(v_pedido.cantidad, 1);

    SELECT * INTO v_bolsa
    FROM bolsas
    WHERE id = v_pedido.bolsa_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'resultado', 'bolsa_no_encontrada',
        'bolsa_id',  v_pedido.bolsa_id
      );
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

  -- ── 9. Leer configuración de puntos ──────────────────────────────────────
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

  -- ── 10. Registrar eventos post-pago dentro de la transacción ────────────
  -- Los eventos se registran DENTRO de la misma transacción que confirma el
  -- pago. Si el INSERT falla (error de BD), toda la transacción revierte.
  -- Si el procesamiento posterior de cada evento falla (push, sumar_puntos),
  -- el evento queda completado=false para reintento sin riesgo de doble pago.
  --
  -- ON CONFLICT DO NOTHING: webhook duplicado no crea eventos duplicados.
  -- El BLOQUE 3 del webhook Node.js debe procesar estos eventos y marcarlos
  -- completado=true. En el caso 'duplicado', los eventos pendientes se
  -- devuelven para reintento.

  -- Evento de confirmación para notificaciones push (cliente + restaurante)
  INSERT INTO pago_eventos_pendientes (pedido_id, tipo_evento, payload)
  VALUES (
    p_pedido_id,
    'pago_cubo_confirmado',
    jsonb_build_object(
      'pedido_id',       p_pedido_id,
      'codigo_recogida', v_pedido.codigo_recogida,
      'usuario_id',      v_pedido.usuario_id,
      'negocio_id',      v_pedido.negocio_id,
      'tipo_entrega',    v_pedido.tipo_entrega,
      'total',           v_pedido.total
    )
  )
  ON CONFLICT (pedido_id, tipo_evento) DO NOTHING;

  -- Evento de suma de puntos (procesamiento asíncrono post-commit)
  INSERT INTO pago_eventos_pendientes (pedido_id, tipo_evento, payload)
  VALUES (
    p_pedido_id,
    'sumar_puntos',
    jsonb_build_object(
      'usuario_id', v_pedido.usuario_id,
      'puntos',     v_puntos
    )
  )
  ON CONFLICT (pedido_id, tipo_evento) DO NOTHING;

  -- ── Resultado exitoso ─────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'resultado',       'procesado',
    'pedido_id',       v_pedido.id,
    'codigo_recogida', v_pedido.codigo_recogida
  );

END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — PERMISOS
-- ════════════════════════════════════════════════════════════════════════════

-- ── confirmar_pago_cubo ───────────────────────────────────────────────────
-- Solo el rol service_role (backend Node.js via SUPABASE_SERVICE_KEY) puede
-- llamar esta función. Anon y authenticated no deben poder invocarla nunca.
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(
  uuid, text, integer, text, text, text, text, timestamptz
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(
  uuid, text, integer, text, text, text, text, timestamptz
) FROM anon;

REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(
  uuid, text, integer, text, text, text, text, timestamptz
) FROM authenticated;

GRANT EXECUTE ON FUNCTION confirmar_pago_cubo(
  uuid, text, integer, text, text, text, text, timestamptz
) TO service_role;

-- ── sumar_puntos: corregir search_path y permisos ─────────────────────────
-- La versión de schema_fix.sql no tiene SET search_path. Se reemplaza con
-- la misma lógica pero con la protección requerida para SECURITY DEFINER.
-- Se usa $1/$2 posicionales para evitar ambigüedad con el nombre de columna.
CREATE OR REPLACE FUNCTION sumar_puntos(user_id uuid, puntos int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE usuarios
  SET puntos                = usuarios.puntos + $2,
      total_bolsas_salvadas = total_bolsas_salvadas + 1
  WHERE id = $1;
END;
$$;

REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION sumar_puntos(uuid, integer) TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — VERIFICACIONES POST-MIGRACIÓN
-- Ejecutar tras BLOQUE 3. Revisar los resultados manualmente.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Funciones creadas con search_path y SECURITY DEFINER
SELECT
  p.proname                             AS funcion,
  p.prosecdef                           AS security_definer,
  p.proconfig                           AS search_path_config,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('confirmar_pago_cubo', 'sumar_puntos');

-- 2. Columnas añadidas a pedidos
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name IN (
    'cubo_identifier', 'cubo_authorization_code', 'pagado_en',
    'cubo_payment_intent_token', 'monto_esperado_centavos',
    'cubo_reference_id', 'cantidad'
  )
ORDER BY column_name;

-- 3. Tablas nuevas
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pedido_items', 'pago_eventos_pendientes');

-- 4. Índices
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('pedidos', 'pedido_items', 'pago_eventos_pendientes')
  AND indexname IN (
    'idx_pedidos_cubo_token_unique',
    'idx_pedido_items_pedido',
    'idx_pago_eventos_pendientes'
  );

-- 5. CHECK constraint
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'chk_monto_esperado_centavos';

-- 6. Permisos de confirmar_pago_cubo
-- Esperado: solo service_role con EXECUTE; anon y authenticated sin acceso
SELECT grantee, privilege_type, is_grantable
FROM information_schema.routine_privileges
WHERE routine_name = 'confirmar_pago_cubo'
ORDER BY grantee;

-- 7. Registro de puntos_por_pedido
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 — PRUEBAS EN ROLLBACK
-- Ejecutar el bloque completo BEGIN...ROLLBACK de una sola vez.
-- El ROLLBACK final revierte todo. No afecta datos de producción.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_result       jsonb;
  v_fake_id      uuid := gen_random_uuid();
  v_usr_id       uuid;
  v_neg_id       uuid;
  v_bolsa_id     uuid;
  v_pedido_id    uuid;
  v_token        text := 'cubo_tok_test_' || gen_random_uuid()::text;
  v_monto        integer := 15000;
BEGIN

  -- ── Test 1: pedido inexistente ───────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_fake_id, 'tok_test', 1000, 'SUCCEEDED', 'tok_test', NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_encontrado',
    'Test 1 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 1: pedido_no_encontrado';

  -- ── Test 2: token vacío ──────────────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_fake_id, '', 1000, 'SUCCEEDED', '', NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido'
     AND v_result->>'campo' = 'p_payment_intent_token',
    'Test 2 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 2: parametro_invalido (token vacío)';

  -- ── Test 3: monto = 0 ────────────────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_fake_id, 'tok', 0, 'SUCCEEDED', 'tok', NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido'
     AND v_result->>'campo' = 'p_monto_centavos',
    'Test 3 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 3: parametro_invalido (monto = 0)';

  -- ── Test 4: monto negativo ───────────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_fake_id, 'tok', -500, 'SUCCEEDED', 'tok', NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido',
    'Test 4 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 4: parametro_invalido (monto negativo)';

  -- ── Test 5: estado inválido ──────────────────────────────────────────────
  -- Crear datos de prueba mínimos para llegar al check de estado
  INSERT INTO usuarios (id, email, nombre, rol, puntos)
  VALUES (gen_random_uuid(), 'test_cubo@bocara.test', 'Test Cubo', 'cliente', 0)
  RETURNING id INTO v_usr_id;

  INSERT INTO negocios (id, propietario_id, nombre, direccion, zona, ciudad, categoria)
  VALUES (gen_random_uuid(), v_usr_id, 'Restaurante Test Cubo', 'Zona 10', 'Zona 10', 'Guatemala', 'restaurante')
  RETURNING id INTO v_neg_id;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa Test', 50.00, 25.00,
          5, '18:00', '20:00')
  RETURNING id INTO v_bolsa_id;

  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_id, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 150.00, 'BOC-TESTCU',
          v_token, v_monto)
  RETURNING id INTO v_pedido_id;

  SELECT confirmar_pago_cubo(
    v_pedido_id, v_token, v_monto, 'PENDING', v_token, NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'estado_invalido',
    'Test 5 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 5: estado_invalido';

  -- ── Test 6: token incorrecto ─────────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_pedido_id, 'token_incorrecto_xyz', v_monto, 'SUCCEEDED',
    'token_incorrecto_xyz', NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'token_incorrecto',
    'Test 6 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 6: token_incorrecto';

  -- ── Test 7: monto incorrecto ─────────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_pedido_id, v_token, 99999, 'SUCCEEDED', v_token, NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'monto_incorrecto',
    'Test 7 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 7: monto_incorrecto';

  -- ── Test 8: stock insuficiente ───────────────────────────────────────────
  -- Insertar item que pide más de lo disponible (disponible=5, pedimos 99)
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_pedido_id, v_bolsa_id, 99, 25.00, 2475.00);

  SELECT confirmar_pago_cubo(
    v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, NULL, NULL, NULL
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'stock_insuficiente',
    'Test 8 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 8: stock_insuficiente (% disponible, pedido 99)', 5;

  -- Corregir cantidad para tests siguientes
  DELETE FROM pedido_items WHERE pedido_id = v_pedido_id;
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_pedido_id, v_bolsa_id, 1, 25.00, 25.00);

  -- ── Test 9: confirmación válida ──────────────────────────────────────────
  SELECT confirmar_pago_cubo(
    v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-001', 'AUTH-001', NOW()
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado',
    'Test 9 FALLÓ: ' || v_result::text;
  ASSERT v_result->>'codigo_recogida' = 'BOC-TESTCU',
    'Test 9 FALLÓ: codigo_recogida incorrecto ' || v_result::text;
  RAISE NOTICE '✓ Test 9: procesado (confirmación válida)';

  -- Verificar que el inventario se descontó
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 9b FALLÓ: inventario no descontado';
  RAISE NOTICE '✓ Test 9b: inventario descontado (5 → 4)';

  -- Verificar que los eventos quedaron registrados
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 2,
    'Test 9c FALLÓ: eventos pendientes no registrados';
  RAISE NOTICE '✓ Test 9c: 2 eventos pendientes registrados (pago_cubo_confirmado + sumar_puntos)';

  -- ── Test 10: webhook duplicado (idempotencia) ────────────────────────────
  SELECT confirmar_pago_cubo(
    v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-001', 'AUTH-001', NOW()
  ) INTO v_result;
  ASSERT v_result->>'resultado' = 'duplicado',
    'Test 10 FALLÓ: ' || v_result::text;
  -- Debe devolver eventos_pendientes para que el backend los reintente
  ASSERT jsonb_array_length(v_result->'eventos_pendientes') >= 0,
    'Test 10 FALLÓ: falta campo eventos_pendientes';
  RAISE NOTICE '✓ Test 10: duplicado con eventos_pendientes=%', v_result->'eventos_pendientes';

  -- Verificar que el inventario NO se descontó una segunda vez
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 10b FALLÓ: inventario descontado dos veces';
  RAISE NOTICE '✓ Test 10b: inventario sin doble descuento';

  -- ── Test 11: eventos no se duplican ─────────────────────────────────────
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 2,
    'Test 11 FALLÓ: se duplicaron eventos';
  RAISE NOTICE '✓ Test 11: UNIQUE de eventos respetado (siguen siendo 2)';

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════';
  RAISE NOTICE '✓ Todos los tests pasaron (11/11)';
  RAISE NOTICE '  Concurrencia: probar con pgbench o test-webhook-cubo.js';
  RAISE NOTICE '  Datos reales de prod: NO usar en este bloque';
  RAISE NOTICE '═══════════════════════════════════════════════';

END $$;

ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE ROLLBACK — Cómo revertir esta migración si algo falla
-- EJECUTAR SOLO SI ES NECESARIO REVERTIR. Afecta datos reales.
-- ════════════════════════════════════════════════════════════════════════════

/*

BEGIN;

-- Eliminar función RPC
DROP FUNCTION IF EXISTS confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz);

-- Eliminar tablas nuevas (CASCADE para eliminar índices y FK)
DROP TABLE IF EXISTS pago_eventos_pendientes CASCADE;
DROP TABLE IF EXISTS pedido_items CASCADE;

-- Eliminar columnas añadidas a pedidos
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_identifier;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_authorization_code;
ALTER TABLE pedidos DROP COLUMN IF EXISTS pagado_en;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_payment_intent_token;
ALTER TABLE pedidos DROP COLUMN IF EXISTS monto_esperado_centavos;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_reference_id;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cantidad;

-- Eliminar restricción y índice
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS chk_monto_esperado_centavos;
DROP INDEX IF EXISTS idx_pedidos_cubo_token_unique;

-- Restaurar sumar_puntos a la versión original (sin search_path)
CREATE OR REPLACE FUNCTION sumar_puntos(user_id uuid, puntos int)
RETURNS void AS $$
BEGIN
  UPDATE usuarios
  SET    puntos             = usuarios.puntos + $2,
         total_bolsas_salvadas = total_bolsas_salvadas + 1
  WHERE  id = $1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;

*/
