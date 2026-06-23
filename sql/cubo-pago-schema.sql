-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Cubo Pago Guatemala: migración auditada v4                   ║
-- ║                                                                        ║
-- ║  ORDEN DE EJECUCIÓN:                                                   ║
-- ║  0. Ejecutar sql/introspect-schema.sql (solo lectura, sin cambios)     ║
-- ║  1. BLOQUE 0:  Prechecks — terminar con NOTICE ✓ sin EXCEPTION        ║
-- ║  2. BLOQUE 1:  Columnas Cubo en pedidos                               ║
-- ║  3. BLOQUE 2:  Idempotencia de notificaciones (OBLIGATORIO)           ║
-- ║  4. BLOQUE 3:  Eventos pendientes (tabla con estados)                 ║
-- ║  5. BLOQUE 4:  Idempotencia de puntos (movimientos_puntos)            ║
-- ║  6. BLOQUE 5:  Restricciones e índices                               ║
-- ║  7. BLOQUE 6:  RPC confirmar_pago_cubo v4                            ║
-- ║  8. BLOQUE 7:  sumar_puntos (fix) + sumar_puntos_idempotente         ║
-- ║  9. BLOQUE 8:  Permisos                                              ║
-- ║  10. BLOQUE 9:  Verificaciones post-migración                        ║
-- ║  11. BLOQUE 10: Tests en ROLLBACK                                    ║
-- ║                                                                        ║
-- ║  CUBO_PAYMENTS_ENABLED debe permanecer en "false" durante todo       ║
-- ║  el proceso. Activar SOLO tras verificar la migración completa.      ║
-- ║                                                                        ║
-- ║  Multi-ítem (pedido_items, pedidos.cantidad):                         ║
-- ║  → Ver sql/cubo-pago-multi-item-opcional.sql — NO ejecutar aún.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 0 — PRECHECKS (solo lectura, sin BEGIN/COMMIT)
-- Debe terminar con NOTICE ✓ sin EXCEPTION.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_dup_count INTEGER;
BEGIN
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
    RAISE EXCEPTION 'PRECHECK FAILED: tabla configuracion no existe — ejecutar migrations.sql primero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'notificaciones') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla notificaciones no existe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'sumar_puntos' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'PRECHECK FAILED: función sumar_puntos no existe — ejecutar schema_fix.sql primero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'bolsas'
                   AND column_name = 'cantidad_disponible') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: bolsas.cantidad_disponible no existe';
  END IF;

  -- Verificar duplicados en cubo_payment_intent_token si la columna ya existe
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
        'PRECHECK FAILED: % token(s) Cubo duplicados en pedidos — resolver antes de continuar',
        v_dup_count;
    END IF;
  END IF;

  RAISE NOTICE '✓ PRECHECKS: todas las verificaciones pasaron.';
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — OBLIGATORIO CUBO: columnas de verificación de pagos en pedidos
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_identifier           TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_authorization_code   TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagado_en                 TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_payment_intent_token TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_esperado_centavos   INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_reference_id         TEXT;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — IDEMPOTENCIA DE NOTIFICACIONES (OBLIGATORIO)
--
-- Requerido por services/pagoEventos.js. Si esta columna no existe,
-- los eventos notificar_pago_cliente y notificar_pago_restaurante lanzarán
-- un error y quedarán pendientes hasta que se ejecute esta migración.
-- NO está comentado ni es opcional: es parte del núcleo Cubo.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS clave_idempotencia TEXT;

-- Índice único parcial: solo se aplica a notificaciones con clave establecida.
-- Garantiza que cubo_pago:{pedidoId}:cliente y cubo_pago:{pedidoId}:restaurante
-- nunca se dupliquen aunque el evento se reintente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_clave_idempotencia
  ON notificaciones(clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — EVENTOS PENDIENTES
--
-- Tabla con estados explícitos: pendiente → procesando → completado | fallido
-- La columna procesando_desde permite recuperar eventos abandonados por
-- timeout (proceso que murió con estado='procesando').
--
-- Si existe la versión anterior (sin columna estado), se elimina y recrea.
-- Es seguro porque CUBO_PAYMENTS_ENABLED=false — no hay datos en producción.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
      AND column_name = 'estado'
  ) THEN
    RAISE NOTICE 'Migrando pago_eventos_pendientes: eliminando esquema anterior (CUBO_PAYMENTS_ENABLED=false — sin datos en producción)...';
    DROP TABLE pago_eventos_pendientes CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pago_eventos_pendientes (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id        UUID        NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo_evento      TEXT        NOT NULL,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  estado           TEXT        NOT NULL DEFAULT 'pendiente'
                               CHECK (estado IN ('pendiente','procesando','completado','fallido')),
  intentos         INTEGER     NOT NULL DEFAULT 0,
  procesando_desde TIMESTAMPTZ,           -- NULL cuando no está siendo procesado
  ultimo_intento_at TIMESTAMPTZ,
  error_ultimo     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completado_at    TIMESTAMPTZ,
  UNIQUE (pedido_id, tipo_evento)
);

-- Para el procesador de eventos: solo los pendientes, ordenados por creación
CREATE INDEX IF NOT EXISTS idx_pago_eventos_pendiente
  ON pago_eventos_pendientes(created_at)
  WHERE estado = 'pendiente';

-- Para recuperación de eventos abandonados (stuck en 'procesando' por timeout)
CREATE INDEX IF NOT EXISTS idx_pago_eventos_procesando
  ON pago_eventos_pendientes(procesando_desde)
  WHERE estado = 'procesando';

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — IDEMPOTENCIA DE PUNTOS
--
-- UNIQUE(pedido_id, concepto) garantiza que sumar_puntos_idempotente no
-- acumula puntos dos veces aunque el evento se reintente múltiples veces.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS movimientos_puntos (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id UUID        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  pedido_id  UUID        REFERENCES pedidos(id) ON DELETE SET NULL,
  concepto   TEXT        NOT NULL,
  puntos     INTEGER     NOT NULL CHECK (puntos > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pedido_id, concepto)
);

CREATE INDEX IF NOT EXISTS idx_movimientos_puntos_usuario
  ON movimientos_puntos(usuario_id);

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 — RESTRICCIONES E ÍNDICES
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

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

-- Índice UNIQUE parcial: cada token Cubo corresponde a un solo pedido.
-- El BLOQUE 0 verificó que no hay duplicados preexistentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_cubo_token_unique
  ON pedidos(cubo_payment_intent_token)
  WHERE cubo_payment_intent_token IS NOT NULL;

INSERT INTO configuracion (clave, valor)
VALUES ('puntos_por_pedido', '10')
ON CONFLICT (clave) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 6 — RPC confirmar_pago_cubo v4
--
-- Modelo vigente: 1 pedido → 1 bolsa (pedidos.bolsa_id).
-- Descuenta exactamente 1 unidad de cantidad_disponible.
-- NO referencia pedido_items ni pedidos.cantidad.
-- Para soporte multi-ítem ver sql/cubo-pago-multi-item-opcional.sql.
--
-- Registra 3 eventos separados (ON CONFLICT DO NOTHING = idempotente):
--   · sumar_puntos
--   · notificar_pago_cliente
--   · notificar_pago_restaurante
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

  -- ── 1. Bloquear pedido (serializa webhooks concurrentes del mismo pedido) ──
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 2. Idempotencia: pago ya procesado ────────────────────────────────────
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

  -- ── 6. Verificar bolsa y descontar inventario (modelo bolsa_id único) ─────
  -- Modelo vigente: 1 pedido → 1 bolsa. Descuenta exactamente 1 unidad.
  -- Para multi-ítem ver sql/cubo-pago-multi-item-opcional.sql.
  IF v_pedido.bolsa_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', NULL);
  END IF;

  SELECT * INTO v_bolsa FROM bolsas WHERE id = v_pedido.bolsa_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', v_pedido.bolsa_id);
  END IF;

  IF v_bolsa.cantidad_disponible < 1 THEN
    RETURN jsonb_build_object(
      'resultado',  'stock_insuficiente',
      'bolsa_id',   v_pedido.bolsa_id,
      'disponible', v_bolsa.cantidad_disponible,
      'solicitado', 1
    );
  END IF;

  UPDATE bolsas
  SET cantidad_disponible = cantidad_disponible - 1
  WHERE id = v_pedido.bolsa_id;

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
  -- ON CONFLICT DO NOTHING: webhook duplicado no crea eventos nuevos.
  -- Cada evento tiene su propia idempotencia y estado de reintento.
  INSERT INTO pago_eventos_pendientes (pedido_id, tipo_evento, payload)
  VALUES
  (
    p_pedido_id,
    'sumar_puntos',
    jsonb_build_object(
      'usuario_id', v_pedido.usuario_id,
      'puntos',     v_puntos
    )
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
-- BLOQUE 7 — sumar_puntos (fix search_path) + sumar_puntos_idempotente
-- ════════════════════════════════════════════════════════════════════════════

-- Corregir SET search_path en sumar_puntos existente
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

-- sumar_puntos_idempotente: INSERT con UNIQUE(pedido_id, concepto) garantiza
-- que el punto solo se suma una vez aunque el evento se reintente múltiples veces.
-- Si la función se llama mientras el evento está pendiente (Node falló antes de
-- marcar completado), retorna 'duplicado' y no vuelve a sumar.
CREATE OR REPLACE FUNCTION sumar_puntos_idempotente(
  p_usuario_id uuid,
  p_pedido_id  uuid,
  p_puntos     integer,
  p_concepto   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_puntos IS NULL OR p_puntos <= 0 THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_puntos');
  END IF;
  IF p_usuario_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_usuario_id');
  END IF;

  INSERT INTO movimientos_puntos (usuario_id, pedido_id, concepto, puntos)
  VALUES (p_usuario_id, p_pedido_id, p_concepto, p_puntos)
  ON CONFLICT (pedido_id, concepto) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('resultado', 'duplicado');
  END IF;

  UPDATE usuarios
  SET puntos                = usuarios.puntos + p_puntos,
      total_bolsas_salvadas = total_bolsas_salvadas + 1
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object('resultado', 'sumado', 'puntos', p_puntos);
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 8 — PERMISOS
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM anon;
REVOKE EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  FROM authenticated;
GRANT  EXECUTE ON FUNCTION confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION sumar_puntos(uuid, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 9 — VERIFICACIONES POST-MIGRACIÓN (ejecutar tras migración)
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Funciones: SECURITY DEFINER + search_path configurado
SELECT
  p.proname                                             AS funcion,
  p.prosecdef                                           AS security_definer,
  p.proconfig                                           AS search_path_config,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente')
ORDER BY p.proname;

-- 2. Columnas Cubo en pedidos
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name IN (
    'cubo_identifier', 'cubo_authorization_code', 'pagado_en',
    'cubo_payment_intent_token', 'monto_esperado_centavos', 'cubo_reference_id'
  )
ORDER BY column_name;

-- 3. Nuevas tablas
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pago_eventos_pendientes', 'movimientos_puntos');

-- 4. Índices
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_pedidos_cubo_token_unique',
    'idx_pago_eventos_pendiente',
    'idx_pago_eventos_procesando',
    'idx_movimientos_puntos_usuario',
    'idx_notificaciones_clave_idempotencia'
  );

-- 5. CHECK constraint
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'chk_monto_esperado_centavos';

-- 6. Permisos — esperado: solo service_role para las tres funciones
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN ('confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente')
ORDER BY routine_name, grantee;

-- 7. puntos_por_pedido y clave_idempotencia
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';

SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'notificaciones'
  AND column_name = 'clave_idempotencia';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 10 — TESTS EN ROLLBACK
-- Ejecutar el bloque BEGIN…ROLLBACK completo de una sola vez.
-- El ROLLBACK final revierte todo. No afecta producción.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_result          jsonb;
  v_rpc             jsonb;
  v_usr_id          uuid;
  v_neg_id          uuid;
  v_bolsa_id        uuid;
  v_pedido_id       uuid;
  v_token           text    := 'tok_test_v4_' || replace(gen_random_uuid()::text, '-', '');
  v_monto           integer := 20000;
  v_filas_1         integer;
  v_filas_2         integer;
  v_evento_abd_id   uuid;
  v_notif_clave     text;
  v_notif_count     integer;
  v_estado_abd      text;
BEGIN

  -- ── Test 1: parámetros inválidos ──────────────────────────────────────────
  SELECT confirmar_pago_cubo(NULL, 'tok', 100, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido' AND v_result->>'campo' = 'p_pedido_id',
    'Test 1a FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 1a: parametro_invalido (pedido_id NULL)';

  SELECT confirmar_pago_cubo(gen_random_uuid(), '', 100, 'SUCCEEDED', '', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido' AND v_result->>'campo' = 'p_payment_intent_token',
    'Test 1b FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 1b: parametro_invalido (token vacío)';

  SELECT confirmar_pago_cubo(gen_random_uuid(), 'tok', 0, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido' AND v_result->>'campo' = 'p_monto_centavos',
    'Test 1c FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 1c: parametro_invalido (monto = 0)';

  -- ── Test 2: pedido_no_encontrado ──────────────────────────────────────────
  SELECT confirmar_pago_cubo(gen_random_uuid(), 'tok', 100, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_encontrado',
    'Test 2 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 2: pedido_no_encontrado';

  -- ── Crear datos de prueba ─────────────────────────────────────────────────
  INSERT INTO usuarios (id, email, nombre, rol, puntos, total_bolsas_salvadas)
  VALUES (gen_random_uuid(), 'cubo_test_v4@bocara.test', 'Test Cubo v4', 'cliente', 0, 0)
  RETURNING id INTO v_usr_id;

  INSERT INTO negocios (id, propietario_id, nombre, direccion, zona, ciudad, categoria)
  VALUES (gen_random_uuid(), v_usr_id, 'Negocio Test v4', 'Zona 10', 'Zona 10', 'Guatemala', 'restaurante')
  RETURNING id INTO v_neg_id;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa Test v4', 100.00, 50.00, 5, '18:00', '20:00')
  RETURNING id INTO v_bolsa_id;

  -- Pedido con bolsa_id — SIN pedido_items, SIN cantidad
  INSERT INTO pedidos (
    id, usuario_id, bolsa_id, negocio_id, estado, estado_pago, tipo_entrega,
    total, codigo_recogida, cubo_payment_intent_token, monto_esperado_centavos
  )
  VALUES (
    gen_random_uuid(), v_usr_id, v_bolsa_id, v_neg_id,
    'pendiente', 'pendiente', 'recogida',
    200.00, 'BOC-TST-V4', v_token, v_monto
  )
  RETURNING id INTO v_pedido_id;

  -- ── Test 3: rutas de error ────────────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'PENDING', v_token, NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'estado_invalido', 'Test 3a FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 3a: estado_invalido';

  SELECT confirmar_pago_cubo(v_pedido_id, 'token_malo', v_monto, 'SUCCEEDED', 'token_malo', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'token_incorrecto', 'Test 3b FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 3b: token_incorrecto';

  SELECT confirmar_pago_cubo(v_pedido_id, v_token, 99999, 'SUCCEEDED', v_token, NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'monto_incorrecto', 'Test 3c FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 3c: monto_incorrecto';

  -- ── Test 4: confirmación válida — modelo bolsa_id descuenta 1 unidad ──────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-V4', 'AUTH-V4', NOW()) INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado', 'Test 4 FALLÓ: ' || v_result::text;
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 4 FALLÓ: inventario incorrecto — esperado 4';
  RAISE NOTICE '✓ Test 4: procesado, bolsa cantidad_disponible 5 → 4 (exactamente 1 unidad)';

  -- ── Test 4b: 3 eventos separados registrados ──────────────────────────────
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 3,
    'Test 4b FALLÓ: esperados 3 eventos';
  ASSERT EXISTS (SELECT 1 FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id AND tipo_evento = 'sumar_puntos'),
    'Test 4b FALLÓ: falta sumar_puntos';
  ASSERT EXISTS (SELECT 1 FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id AND tipo_evento = 'notificar_pago_cliente'),
    'Test 4b FALLÓ: falta notificar_pago_cliente';
  ASSERT EXISTS (SELECT 1 FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id AND tipo_evento = 'notificar_pago_restaurante'),
    'Test 4b FALLÓ: falta notificar_pago_restaurante';
  RAISE NOTICE '✓ Test 4b: 3 eventos separados (sumar_puntos, notificar_pago_cliente, notificar_pago_restaurante)';

  -- ── Test 5: webhook duplicado → retorna eventos_pendientes ────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-V4', 'AUTH-V4', NOW()) INTO v_result;
  ASSERT v_result->>'resultado' = 'duplicado', 'Test 5 FALLÓ: ' || v_result::text;
  ASSERT jsonb_typeof(v_result->'eventos_pendientes') = 'array',
    'Test 5 FALLÓ: falta eventos_pendientes como array';
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 5 FALLÓ: inventario descontado dos veces';
  RAISE NOTICE '✓ Test 5: duplicado con eventos_pendientes=%, inventario sin doble descuento', v_result->'eventos_pendientes';

  -- ── Test 6: eventos no se duplican (UNIQUE) ───────────────────────────────
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 3,
    'Test 6 FALLÓ: eventos duplicados tras segundo webhook';
  RAISE NOTICE '✓ Test 6: UNIQUE(pedido_id, tipo_evento) — eventos no duplicados';

  -- ── Test 7: puntos aplicados, fallo posterior → reintento no suma doble ───
  -- Simula: sumar_puntos_idempotente se ejecuta (Node llama RPC), pero Node
  -- falla ANTES de marcar el evento completado. Al reintentar:
  SELECT sumar_puntos_idempotente(v_usr_id, v_pedido_id, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'sumado', 'Test 7a FALLÓ: primer llamado debe sumar — ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10,
    'Test 7a FALLÓ: puntos no sumados';
  RAISE NOTICE '✓ Test 7a: sumar_puntos_idempotente → sumado (puntos=10)';

  -- Evento sigue pendiente (Node no marcó completado — simulación de fallo)
  -- Reintento: segunda llamada con los mismos parámetros
  SELECT sumar_puntos_idempotente(v_usr_id, v_pedido_id, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'duplicado', 'Test 7b FALLÓ: segundo llamado debe ser duplicado — ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10,
    'Test 7b FALLÓ: puntos duplicados — esperado 10, no 20';
  RAISE NOTICE '✓ Test 7b: sumar_puntos_idempotente reintento → duplicado (puntos siguen siendo 10)';

  -- ── Test 8: notificación idempotente con clave_idempotencia ───────────────
  v_notif_clave := 'cubo_pago:' || v_pedido_id || ':cliente';

  INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, data, leida, clave_idempotencia)
  VALUES (v_usr_id, 'pago_confirmado', '✅ Pago confirmado', 'Código: BOC-TST-V4',
          '{"pedidoId": "test"}'::jsonb, false, v_notif_clave);

  -- Segunda inserción con misma clave: debe fallar por UNIQUE
  BEGIN
    INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, data, leida, clave_idempotencia)
    VALUES (v_usr_id, 'pago_confirmado', '✅ Pago confirmado', 'Código: BOC-TST-V4',
            '{"pedidoId": "test"}'::jsonb, false, v_notif_clave);
    ASSERT FALSE, 'Test 8 FALLÓ: segunda inserción debió lanzar excepción UNIQUE';
  EXCEPTION
    WHEN unique_violation THEN
      NULL; -- esperado
  END;

  SELECT COUNT(*) INTO v_notif_count
  FROM notificaciones WHERE clave_idempotencia = v_notif_clave;
  ASSERT v_notif_count = 1, 'Test 8 FALLÓ: esperada 1 notificación, encontradas ' || v_notif_count;
  RAISE NOTICE '✓ Test 8: notificación idempotente — única entrada con clave %', v_notif_clave;

  -- ── Test 9: cliente completado, restaurante pendiente ─────────────────────
  -- Marcar sumar_puntos y notificar_pago_cliente como completados
  UPDATE pago_eventos_pendientes
  SET estado = 'completado', completado_at = NOW()
  WHERE pedido_id = v_pedido_id
    AND tipo_evento IN ('sumar_puntos', 'notificar_pago_cliente');

  -- Solo notificar_pago_restaurante debe quedar pendiente
  ASSERT (
    SELECT COUNT(*) FROM pago_eventos_pendientes
    WHERE pedido_id = v_pedido_id AND estado = 'pendiente'
  ) = 1, 'Test 9 FALLÓ: esperado 1 evento pendiente (solo restaurante)';

  ASSERT EXISTS (
    SELECT 1 FROM pago_eventos_pendientes
    WHERE pedido_id = v_pedido_id
      AND tipo_evento = 'notificar_pago_restaurante'
      AND estado = 'pendiente'
  ), 'Test 9 FALLÓ: notificar_pago_restaurante debe estar pendiente';
  RAISE NOTICE '✓ Test 9: cliente completado, restaurante pendiente — solo restaurante se reintenta';

  -- ── Test 10: dos procesadores concurrentes → exactamente uno reclama ──────
  -- Reset notificar_pago_restaurante a pendiente, intentos=0
  UPDATE pago_eventos_pendientes
  SET estado = 'pendiente', intentos = 0, procesando_desde = NULL
  WHERE pedido_id = v_pedido_id AND tipo_evento = 'notificar_pago_restaurante';

  -- Procesador 1 intenta reclamar
  UPDATE pago_eventos_pendientes
  SET estado = 'procesando', intentos = 1, procesando_desde = NOW()
  WHERE pedido_id = v_pedido_id
    AND tipo_evento = 'notificar_pago_restaurante'
    AND estado = 'pendiente'
    AND intentos = 0;
  GET DIAGNOSTICS v_filas_1 = ROW_COUNT;

  -- Procesador 2 intenta reclamar (demasiado tarde)
  UPDATE pago_eventos_pendientes
  SET estado = 'procesando', intentos = 1, procesando_desde = NOW()
  WHERE pedido_id = v_pedido_id
    AND tipo_evento = 'notificar_pago_restaurante'
    AND estado = 'pendiente'
    AND intentos = 0;
  GET DIAGNOSTICS v_filas_2 = ROW_COUNT;

  ASSERT v_filas_1 + v_filas_2 = 1,
    'Test 10 FALLÓ: exactamente un procesador debe ganar — filas_1=' || v_filas_1 || ' filas_2=' || v_filas_2;
  ASSERT v_filas_1 = 1, 'Test 10 FALLÓ: procesador 1 debió ganar';
  ASSERT v_filas_2 = 0, 'Test 10 FALLÓ: procesador 2 debió perder';
  RAISE NOTICE '✓ Test 10: concurrencia — procesador 1 ganó (%), procesador 2 perdió (%)', v_filas_1, v_filas_2;

  -- ── Test 11: proceso abandonado → recuperable por timeout ─────────────────
  INSERT INTO pago_eventos_pendientes
    (pedido_id, tipo_evento, payload, estado, intentos, procesando_desde)
  VALUES
    (v_pedido_id, 'sumar_puntos_abandonado_test', '{}',
     'procesando', 1, NOW() - INTERVAL '10 minutes')
  RETURNING id INTO v_evento_abd_id;

  -- Recovery query: debe encontrar el evento abandonado
  ASSERT EXISTS (
    SELECT 1 FROM pago_eventos_pendientes
    WHERE id = v_evento_abd_id
      AND estado = 'procesando'
      AND procesando_desde < NOW() - INTERVAL '5 minutes'
      AND intentos < 5
  ), 'Test 11a FALLÓ: evento abandonado no encontrado por query de recuperación';
  RAISE NOTICE '✓ Test 11a: evento abandonado detectado (procesando_desde hace 10 min)';

  -- Resetear a pendiente (lo que hace procesarEventosFallidos)
  UPDATE pago_eventos_pendientes
  SET estado = 'pendiente', procesando_desde = NULL
  WHERE id = v_evento_abd_id
    AND estado = 'procesando'
    AND procesando_desde < NOW() - INTERVAL '5 minutes';

  SELECT estado INTO v_estado_abd FROM pago_eventos_pendientes WHERE id = v_evento_abd_id;
  ASSERT v_estado_abd = 'pendiente',
    'Test 11b FALLÓ: evento debe ser pendiente tras recuperación — estado=' || v_estado_abd;
  RAISE NOTICE '✓ Test 11b: evento abandonado recuperado y resetado a pendiente';

  -- ── Test 12: SQL principal no crea pedido_items ni pedidos.cantidad ────────
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pedido_items'
  ), 'Test 12a FALLÓ: pedido_items existe — debe estar solo en cubo-pago-multi-item-opcional.sql';
  RAISE NOTICE '✓ Test 12a: pedido_items NO existe (solo en archivo opcional)';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedidos' AND column_name = 'cantidad'
  ), 'Test 12b FALLÓ: pedidos.cantidad existe — debe estar solo en cubo-pago-multi-item-opcional.sql';
  RAISE NOTICE '✓ Test 12b: pedidos.cantidad NO existe (solo en archivo opcional)';

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Todos los tests pasaron (12+/12)';
  RAISE NOTICE '  Nota: Tests 1-2 (infra ausente → evento pendiente) son comportamiento';
  RAISE NOTICE '  de Node.js: si sumar_puntos_idempotente o clave_idempotencia no existe,';
  RAISE NOTICE '  _procesarEvento lanza error, el evento queda en pendiente/fallido.';
  RAISE NOTICE '  Verificar tras ejecutar migración completa.';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';

END $$;

ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE ROLLBACK — Cómo revertir si es necesario
-- EJECUTAR SOLO SI ES NECESARIO. Afecta datos reales.
-- ════════════════════════════════════════════════════════════════════════════

/*

BEGIN;

DROP FUNCTION IF EXISTS confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS sumar_puntos_idempotente(uuid, uuid, integer, text);

DROP TABLE IF EXISTS pago_eventos_pendientes  CASCADE;
DROP TABLE IF EXISTS movimientos_puntos        CASCADE;

ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_identifier;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_authorization_code;
ALTER TABLE pedidos DROP COLUMN IF EXISTS pagado_en;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_payment_intent_token;
ALTER TABLE pedidos DROP COLUMN IF EXISTS monto_esperado_centavos;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_reference_id;
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS chk_monto_esperado_centavos;

ALTER TABLE notificaciones DROP COLUMN IF EXISTS clave_idempotencia;
DROP INDEX IF EXISTS idx_notificaciones_clave_idempotencia;
DROP INDEX IF EXISTS idx_pedidos_cubo_token_unique;

-- Restaurar sumar_puntos sin search_path
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
