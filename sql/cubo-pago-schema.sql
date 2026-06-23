-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Cubo Pago Guatemala: migración auditada v3                   ║
-- ║                                                                        ║
-- ║  INSTRUCCIONES:                                                        ║
-- ║  0. Ejecutar sql/introspect-schema.sql primero (solo lectura)          ║
-- ║  1. BLOQUE 0: prechecks — debe terminar con NOTICE ✓ sin EXCEPTION    ║
-- ║  2. BLOQUE 1: columnas obligatorias Cubo                              ║
-- ║  3. BLOQUE 2: eventos pendientes (reintentos)                         ║
-- ║  4. BLOQUE 3: idempotencia de puntos                                  ║
-- ║  5. BLOQUE 4: carrito multi-ítem (pedido_items + pedidos.cantidad)    ║
-- ║  6. BLOQUE 5: restricciones e índices                                 ║
-- ║  7. BLOQUE 6: RPC confirmar_pago_cubo                                 ║
-- ║  8. BLOQUE 7: sumar_puntos (fix) + sumar_puntos_idempotente           ║
-- ║  9. BLOQUE 8: permisos                                                ║
-- ║  10. BLOQUE 9: preparado (idempotencia notificaciones — leer antes)   ║
-- ║  11. BLOQUE 10: verificaciones post-migración                         ║
-- ║  12. BLOQUE 11: tests en ROLLBACK                                     ║
-- ║                                                                        ║
-- ║  CUBO_PAYMENTS_ENABLED debe permanecer en "false" durante todo       ║
-- ║  el proceso. Activar solo tras verificar la migración completa.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 0 — PRECHECKS (solo lectura)
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
-- BLOQUE 1 — OBLIGATORIO PARA CUBO: columnas de verificación de pagos
-- Idempotente. Ejecutar dentro de BEGIN/COMMIT.
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
-- BLOQUE 2 — EVENTOS PENDIENTES
-- Tabla de eventos post-pago para reintentos idempotentes.
-- La columna ultimo_intento_at se usa como versión en el bloqueo optimista
-- de services/pagoEventos.js: solo una instancia puede procesar cada evento.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS pago_eventos_pendientes (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id         UUID        NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo_evento       TEXT        NOT NULL,
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  completado        BOOLEAN     NOT NULL DEFAULT FALSE,
  intentos          INTEGER     NOT NULL DEFAULT 0,
  ultimo_intento_at TIMESTAMPTZ,
  error_ultimo      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completado_at     TIMESTAMPTZ,
  UNIQUE (pedido_id, tipo_evento)
);

-- Índice para el procesador periódico de eventos fallidos
CREATE INDEX IF NOT EXISTS idx_pago_eventos_pendientes
  ON pago_eventos_pendientes(created_at)
  WHERE NOT completado;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — IDEMPOTENCIA DE PUNTOS
-- Tabla de movimientos con restricción UNIQUE (pedido_id, concepto).
-- Garantiza que sumar_puntos_idempotente no acumula puntos dos veces
-- aunque se llame múltiples veces con el mismo pedido y concepto.
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
-- BLOQUE 4 — CARRITO MULTI-ÍTEM CUBO (cambio de modelo comercial)
--
-- Evidencia de uso activo:
--   · app/pago.tsx línea 166: SIEMPRE envía items[] al llamar cubopago()
--   · routes/pagos.js línea 401-413: inserta en pedido_items con fallback
--     explícito "tabla pedido_items no existe aún — ejecutar migración SQL"
--   · services/stock.js línea 10-28: lee de pedido_items con fallback a []
--
-- El código para ambas columnas YA EXISTE en el backend con graceful fallback.
-- Este bloque crea las tablas para que el código funcione como fue diseñado.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- pedido_items: registra cada ítem del carrito cuando el cliente paga via Cubo.
-- La RPC usa esta tabla para descontar inventario de múltiples bolsas.
-- Si no tiene filas para un pedido, la RPC usa el fallback pedidos.bolsa_id.
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

-- pedidos.cantidad: almacena la cantidad del ítem principal del pedido.
-- Usado por services/stock.js (fallback legacy) y la RPC (fallback bolsa única).
-- El backend intenta insertar este campo con cascade de fallbacks si no existe.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cantidad INTEGER DEFAULT 1;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 — RESTRICCIONES E ÍNDICES
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- CHECK: monto_esperado_centavos debe ser positivo si está presente
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

-- Configuración: puntos por pedido (default si no existe)
INSERT INTO configuracion (clave, valor)
VALUES ('puntos_por_pedido', '10')
ON CONFLICT (clave) DO NOTHING;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 6 — RPC confirmar_pago_cubo (versión auditada v3)
--
-- Cambios respecto a v2:
--   · Inventario: bloquea y verifica en el mismo loop FOR UPDATE (antes usaba
--     dos loops separados lo que dejaba filas ya actualizadas si algo fallaba
--     después). Ahora: verifica TODO antes de modificar cualquier fila.
--   · Fallback bolsa única: usa COALESCE(v_pedido.cantidad, 1)
--   · Fallback bolsa única: retorna bolsa_no_encontrada si bolsa_id es NULL
--   · Eventos: registra pago_cubo_confirmado y sumar_puntos dentro de la
--     misma transacción con ON CONFLICT DO NOTHING
--   · Caso duplicado: devuelve eventos_pendientes para reintento en Node.js
--   · SET search_path = public, pg_temp (SECURITY DEFINER)
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
  v_pedido        pedidos%ROWTYPE;
  v_bolsa         bolsas%ROWTYPE;
  v_item          RECORD;
  v_items_count   integer;
  v_cantidad      integer;
  v_puntos        integer := 10;
  v_puntos_cfg    text;
  v_eventos_pend  jsonb;
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

  -- ── 1. Bloquear el pedido ────────────────────────────────────────────────
  -- FOR UPDATE: serializa dos webhooks concurrentes del mismo pedido.
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 2. Idempotencia ──────────────────────────────────────────────────────
  -- Devuelve eventos_pendientes para que el backend los reintente sin
  -- re-confirmar el pago ni volver a descontar inventario.
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

  -- ── 3. Verificar token almacenado ────────────────────────────────────────
  IF v_pedido.cubo_payment_intent_token IS NULL
     OR v_pedido.cubo_payment_intent_token <> p_payment_intent_token THEN
    RETURN jsonb_build_object(
      'resultado', 'token_incorrecto',
      'esperado',  v_pedido.cubo_payment_intent_token,
      'recibido',  p_payment_intent_token
    );
  END IF;

  -- ── 4. Verificar monto esperado ──────────────────────────────────────────
  IF v_pedido.monto_esperado_centavos IS NULL
     OR v_pedido.monto_esperado_centavos <> p_monto_centavos THEN
    RETURN jsonb_build_object(
      'resultado', 'monto_incorrecto',
      'esperado',  v_pedido.monto_esperado_centavos,
      'recibido',  p_monto_centavos
    );
  END IF;

  -- ── 5. Verificar estado ──────────────────────────────────────────────────
  IF p_estado_verificado <> 'SUCCEEDED' THEN
    RETURN jsonb_build_object('resultado', 'estado_invalido', 'estado', p_estado_verificado);
  END IF;

  -- ── 6. Verificar y descontar inventario ──────────────────────────────────
  --
  -- Camino multi-ítem (pedido_items):
  --   · Verificar TODO antes de modificar cualquier fila (todo o nada).
  --   · ORDER BY bolsa_id: orden determinista para evitar deadlocks entre
  --     transacciones concurrentes que compartan bolsas.
  --   · Primer loop bloquea y verifica; si cualquier bolsa falla → RETURN.
  --   · Segundo loop descuenta (las filas ya están bloqueadas del primer loop).
  --
  -- Camino fallback (bolsa única del pedido):
  --   · Usa COALESCE(v_pedido.cantidad, 1) para compatibilidad con pedidos
  --     creados antes de que existiera la columna cantidad.

  SELECT COUNT(*) INTO v_items_count
  FROM pedido_items
  WHERE pedido_id = p_pedido_id;

  IF v_items_count > 0 THEN
    -- Verificar disponibilidad en todas las bolsas antes de modificar ninguna
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
    -- Fallback: bolsa única del pedido (pedidos sin pedido_items)
    IF v_pedido.bolsa_id IS NULL THEN
      RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', NULL);
    END IF;

    v_cantidad := COALESCE(v_pedido.cantidad, 1);

    SELECT * INTO v_bolsa
    FROM bolsas WHERE id = v_pedido.bolsa_id
    FOR UPDATE;

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

  -- ── 9. Registrar eventos post-pago dentro de la transacción ──────────────
  -- ON CONFLICT DO NOTHING: webhook duplicado no crea eventos nuevos.
  -- services/pagoEventos.js los procesa post-commit y los marca completados.
  -- Si el procesamiento falla: el evento queda completado=false para reintento.

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

  RETURN jsonb_build_object(
    'resultado',       'procesado',
    'pedido_id',       v_pedido.id,
    'codigo_recogida', v_pedido.codigo_recogida
  );

END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 7 — sumar_puntos (fix search_path) + sumar_puntos_idempotente (nueva)
-- ════════════════════════════════════════════════════════════════════════════

-- Corregir search_path en sumar_puntos existente
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

-- sumar_puntos_idempotente: inserta movimiento ÚNICO y actualiza saldo atómicamente.
-- Si ya existe el movimiento (pedido_id + concepto), retorna 'duplicado' sin sumar.
-- Esto garantiza que un reintento no acumula puntos dos veces.
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

REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION sumar_puntos(uuid, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION sumar_puntos(uuid, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION sumar_puntos_idempotente(uuid, uuid, integer, text) TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 9 — PREPARADO: idempotencia de notificaciones
--
-- La tabla notificaciones NO tiene columna clave_idempotencia en el esquema
-- actual (confirmado por sql/introspect-schema.sql). Las instrucciones abajo
-- están comentadas para revisión manual antes de ejecutar.
--
-- PASOS ANTES DE DESCOMENTAR Y EJECUTAR:
--   1. Ejecutar introspect-schema.sql → consulta 8 (tiene_clave_idempotencia)
--   2. Si el resultado es false: las sentencias abajo son seguras
--   3. Si el resultado es true: la columna ya existe, no re-ejecutar
--
-- En services/pagoEventos.js, _guardarNotificacionIdempotente ya intenta
-- usar clave_idempotencia y hace fallback a guardarNotificacion() si la
-- columna no existe (código de error de Supabase en la respuesta).
-- Cuando se ejecute esta migración, el servicio empezará a usar la clave.
-- ════════════════════════════════════════════════════════════════════════════

/*

BEGIN;

ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS
  clave_idempotencia TEXT;

-- Índice único parcial: solo para notificaciones con clave establecida.
-- Pedidos anteriores que no tengan clave podrán tener múltiples notificaciones
-- (comportamiento existente); solo los nuevos serán idempotentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_clave_idempotencia
  ON notificaciones(clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL;

COMMIT;

*/


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 10 — VERIFICACIONES POST-MIGRACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Funciones creadas con search_path y SECURITY DEFINER
SELECT
  p.proname                                               AS funcion,
  p.prosecdef                                             AS security_definer,
  p.proconfig                                             AS search_path_config,
  pg_catalog.pg_get_function_identity_arguments(p.oid)   AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('confirmar_pago_cubo','sumar_puntos','sumar_puntos_idempotente')
ORDER BY p.proname;

-- 2. Columnas obligatorias para Cubo en pedidos
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name IN (
    'cubo_identifier','cubo_authorization_code','pagado_en',
    'cubo_payment_intent_token','monto_esperado_centavos',
    'cubo_reference_id','cantidad'
  )
ORDER BY column_name;

-- 3. Tablas nuevas
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pedido_items','pago_eventos_pendientes','movimientos_puntos');

-- 4. Índices
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_pedidos_cubo_token_unique',
    'idx_pedido_items_pedido',
    'idx_pago_eventos_pendientes',
    'idx_movimientos_puntos_usuario'
  );

-- 5. CHECK constraint
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'chk_monto_esperado_centavos';

-- 6. Permisos — esperado: solo service_role para las tres funciones
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN ('confirmar_pago_cubo','sumar_puntos','sumar_puntos_idempotente')
ORDER BY routine_name, grantee;

-- 7. puntos_por_pedido
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 11 — TESTS EN ROLLBACK
-- Ejecutar el bloque BEGIN...ROLLBACK completo de una vez.
-- El ROLLBACK final revierte todo. No afecta producción.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_result     jsonb;
  v_fake_id    uuid := gen_random_uuid();
  v_usr_id     uuid;
  v_neg_id     uuid;
  v_bolsa_id   uuid;
  v_pedido_id  uuid;
  v_token      text := 'tok_test_' || replace(gen_random_uuid()::text, '-', '');
  v_monto      integer := 20000;
  v_rpc        jsonb;
BEGIN

  -- ── Test 1: pedido inexistente ───────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_fake_id,'tok',100,'SUCCEEDED','tok',NULL,NULL,NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_encontrado', 'Test 1 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 1: pedido_no_encontrado';

  -- ── Test 2: parámetro inválido — token vacío ──────────────────────────────
  SELECT confirmar_pago_cubo(v_fake_id,'',100,'SUCCEEDED','',NULL,NULL,NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido', 'Test 2 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 2: parametro_invalido (token vacío)';

  -- ── Test 3: parámetro inválido — monto ≤ 0 ───────────────────────────────
  SELECT confirmar_pago_cubo(v_fake_id,'tok',0,'SUCCEEDED','tok',NULL,NULL,NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido', 'Test 3 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 3: parametro_invalido (monto = 0)';

  -- ── Crear datos de prueba mínimos ─────────────────────────────────────────
  INSERT INTO usuarios (id, email, nombre, rol, puntos, total_bolsas_salvadas)
  VALUES (gen_random_uuid(), 'cubo_test_v3@bocara.test', 'Test Cubo v3', 'cliente', 0, 0)
  RETURNING id INTO v_usr_id;

  INSERT INTO negocios (id, propietario_id, nombre, direccion, zona, ciudad, categoria)
  VALUES (gen_random_uuid(), v_usr_id, 'Negocio Test Cubo v3', 'Zona 10', 'Zona 10', 'Guatemala', 'restaurante')
  RETURNING id INTO v_neg_id;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa Test Cubo', 100.00, 50.00, 5, '18:00', '20:00')
  RETURNING id INTO v_bolsa_id;

  INSERT INTO pedidos (
    id, usuario_id, bolsa_id, negocio_id, estado, estado_pago, tipo_entrega,
    total, codigo_recogida, cubo_payment_intent_token, monto_esperado_centavos, cantidad
  )
  VALUES (
    gen_random_uuid(), v_usr_id, v_bolsa_id, v_neg_id,
    'pendiente', 'pendiente', 'recogida',
    200.00, 'BOC-TSTV3', v_token, v_monto, 1
  )
  RETURNING id INTO v_pedido_id;

  -- ── Test 4: estado inválido ───────────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'PENDING', v_token, NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'estado_invalido', 'Test 4 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 4: estado_invalido';

  -- ── Test 5: token incorrecto ──────────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, 'token_malo', v_monto, 'SUCCEEDED', 'token_malo', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'token_incorrecto', 'Test 5 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 5: token_incorrecto';

  -- ── Test 6: monto incorrecto ──────────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, 99999, 'SUCCEEDED', v_token, NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'monto_incorrecto', 'Test 6 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 6: monto_incorrecto';

  -- ── Test 7: stock insuficiente (via pedido_items) ─────────────────────────
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_pedido_id, v_bolsa_id, 99, 50.00, 4950.00);

  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'stock_insuficiente', 'Test 7 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Test 7: stock_insuficiente (disponible=5, pedido=99)';

  -- Corregir cantidad para tests 8-10
  UPDATE pedido_items SET cantidad = 1, subtotal = 50.00 WHERE pedido_id = v_pedido_id;

  -- ── Test 8: confirmación válida ───────────────────────────────────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-1', 'AUTH-1', NOW()) INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado', 'Test 8 FALLÓ: ' || v_result::text;
  ASSERT v_result->>'codigo_recogida' = 'BOC-TSTV3', 'Test 8 FALLÓ: codigo_recogida ' || v_result::text;
  RAISE NOTICE '✓ Test 8: procesado';

  -- Test 8b: inventario descontado una sola vez
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 8b FALLÓ: inventario no descontado correctamente';
  RAISE NOTICE '✓ Test 8b: inventario descontado (5 → 4)';

  -- Test 8c: 2 eventos registrados
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 2,
    'Test 8c FALLÓ: eventos no registrados';
  RAISE NOTICE '✓ Test 8c: 2 eventos registrados (pago_cubo_confirmado + sumar_puntos)';

  -- ── Test 9: webhook duplicado — retorna eventos_pendientes ───────────────
  SELECT confirmar_pago_cubo(v_pedido_id, v_token, v_monto, 'SUCCEEDED', v_token, 'REF-1', 'AUTH-1', NOW()) INTO v_result;
  ASSERT v_result->>'resultado' = 'duplicado', 'Test 9 FALLÓ: ' || v_result::text;
  ASSERT jsonb_typeof(v_result->'eventos_pendientes') = 'array', 'Test 9 FALLÓ: falta eventos_pendientes array';
  RAISE NOTICE '✓ Test 9: duplicado con eventos_pendientes=%', v_result->'eventos_pendientes';

  -- Test 9b: inventario sin doble descuento
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_id) = 4,
    'Test 9b FALLÓ: inventario descontado dos veces';
  RAISE NOTICE '✓ Test 9b: inventario sin doble descuento';

  -- ── Test 10: eventos no se duplican (UNIQUE constraint) ──────────────────
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_pedido_id) = 2,
    'Test 10 FALLÓ: eventos duplicados';
  RAISE NOTICE '✓ Test 10: eventos no duplicados (UNIQUE confirmado)';

  -- ── Test 11: sumar_puntos_idempotente — primer llamado suma ──────────────
  SELECT sumar_puntos_idempotente(v_usr_id, v_pedido_id, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'sumado', 'Test 11 FALLÓ: ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10, 'Test 11 FALLÓ: puntos no sumados';
  RAISE NOTICE '✓ Test 11: sumar_puntos_idempotente sumado (10 puntos)';

  -- ── Test 12: sumar_puntos_idempotente — segundo llamado duplicado ─────────
  SELECT sumar_puntos_idempotente(v_usr_id, v_pedido_id, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'duplicado', 'Test 12 FALLÓ: ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10, 'Test 12 FALLÓ: puntos duplicados';
  RAISE NOTICE '✓ Test 12: sumar_puntos_idempotente duplicado (puntos siguen siendo 10)';

  -- ── Test 13: la RPC no depende de tablas inexistentes ─────────────────────
  -- Verificar que pedido_items existe antes de que la RPC fuera creada
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pedido_items'
  ), 'Test 13 FALLÓ: pedido_items no existe — la RPC podría fallar en runtime';
  RAISE NOTICE '✓ Test 13: pedido_items existe (RPC no tiene dependencias rotas)';

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Todos los tests pasaron (13/13)';
  RAISE NOTICE '  Concurrencia (Test 8 arquitectural): SELECT FOR UPDATE';
  RAISE NOTICE '  serializa webhooks — garantía de PostgreSQL, no testeable aquí.';
  RAISE NOTICE '  Concurrencia de procesadores (pagoEventos.js): lock optimista';
  RAISE NOTICE '  por columna "intentos" — verificar con dos procesos paralelos.';
  RAISE NOTICE '══════════════════════════════════════════════════════';

END $$;

ROLLBACK;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE ROLLBACK — Cómo revertir si algo falla
-- EJECUTAR SOLO SI ES NECESARIO. Afecta datos reales.
-- ════════════════════════════════════════════════════════════════════════════

/*

BEGIN;

DROP FUNCTION IF EXISTS confirmar_pago_cubo(uuid, text, integer, text, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS sumar_puntos_idempotente(uuid, uuid, integer, text);

DROP TABLE IF EXISTS pedido_items           CASCADE;
DROP TABLE IF EXISTS pago_eventos_pendientes CASCADE;
DROP TABLE IF EXISTS movimientos_puntos      CASCADE;

ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_identifier;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_authorization_code;
ALTER TABLE pedidos DROP COLUMN IF EXISTS pagado_en;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_payment_intent_token;
ALTER TABLE pedidos DROP COLUMN IF EXISTS monto_esperado_centavos;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cubo_reference_id;
ALTER TABLE pedidos DROP COLUMN IF EXISTS cantidad;
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS chk_monto_esperado_centavos;
DROP INDEX IF EXISTS idx_pedidos_cubo_token_unique;

-- Restaurar sumar_puntos sin search_path (versión schema_fix.sql)
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
