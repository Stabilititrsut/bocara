-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Cubo Pago Guatemala: migración auditada v5                   ║
-- ║                                                                        ║
-- ║  ORDEN DE EJECUCIÓN:                                                   ║
-- ║  0. Ejecutar sql/introspect-schema.sql (solo lectura, sin cambios)     ║
-- ║  1. BLOQUE 0:    Prechecks — terminar con NOTICE ✓ sin EXCEPTION      ║
-- ║  2. BLOQUEs 1-8: BEGIN atómico único — todo o nada                    ║
-- ║     · BLOQUE 1: Columnas Cubo en pedidos                              ║
-- ║     · BLOQUE 2: Idempotencia de notificaciones (OBLIGATORIO)          ║
-- ║     · BLOQUE 3: Eventos pendientes (tabla con estados)                ║
-- ║     · BLOQUE 4: Idempotencia de puntos (movimientos_puntos)           ║
-- ║     · BLOQUE 5: Restricciones e índices                               ║
-- ║     · BLOQUE 6: RPC confirmar_pago_cubo v5 (modelo híbrido)          ║
-- ║     · BLOQUE 7: sumar_puntos (fix) + sumar_puntos_idempotente        ║
-- ║     · BLOQUE 8: Permisos                                              ║
-- ║  3. BLOQUE 9:    Verificaciones post-migración                        ║
-- ║  4. BLOQUE 10:   Tests en ROLLBACK (12 pruebas modelo híbrido)        ║
-- ║                                                                        ║
-- ║  CUBO_PAYMENTS_ENABLED debe permanecer en "false" durante todo       ║
-- ║  el proceso. Activar SOLO tras verificar la migración completa.      ║
-- ║                                                                        ║
-- ║  Modelo híbrido (REAL — verificado por introspección):                ║
-- ║  · pedido_items YA EXISTE con 36 filas. No se crea en esta migración.║
-- ║  · pedidos.cantidad YA EXISTE. No se crea en esta migración.         ║
-- ║  · Todo pedido Cubo (POST /api/pagos/cubopago) inserta pedido_items. ║
-- ║  · Los 15 pedidos sin items son legacy (efectivo/PayU) — no Cubo.   ║
-- ║  · pedidos.bolsa_id = primera bolsa (compatibilidad, no inventario). ║
-- ║  · pedidos.cantidad = cantidad de la primera bolsa (no suma total).  ║
-- ║  · confirmar_pago_cubo usa pedido_items como única fuente de verdad. ║
-- ║  · Sin items → items_ausentes (fail-closed, no fallback bolsa_id).  ║
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

  -- Verificar que pedido_items existe (debe existir en producción antes de esta migración)
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'pedido_items') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: tabla pedido_items no existe. '
      'Debe existir antes de ejecutar esta migración (ya tiene datos en producción). '
      'Crearla primero: CREATE TABLE pedido_items (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, '
      'pedido_id UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE, '
      'bolsa_id UUID NOT NULL REFERENCES bolsas(id), cantidad INTEGER NOT NULL DEFAULT 1, '
      'precio_unitario NUMERIC(10,2) NOT NULL);';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'pedido_items'
                   AND column_name = 'cantidad') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: pedido_items.cantidad no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'pedido_items'
                   AND column_name = 'bolsa_id') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: pedido_items.bolsa_id no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'pedido_items'
                   AND column_name = 'precio_unitario') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: pedido_items.precio_unitario no existe';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'pedido_items'
                   AND column_name = 'subtotal') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: pedido_items.subtotal no existe — '
      'Agregar con: ALTER TABLE pedido_items ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);';
  END IF;

  -- Verificar que pedidos.cantidad existe (debe existir en producción antes de esta migración)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'pedidos'
                   AND column_name = 'cantidad') THEN
    RAISE EXCEPTION 'PRECHECK FAILED: pedidos.cantidad no existe. '
      'Agregar con: ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cantidad INTEGER DEFAULT 1;';
  END IF;

  RAISE NOTICE '✓ PRECHECKS: todas las verificaciones pasaron (incluyendo pedido_items, pedido_items.subtotal y pedidos.cantidad).';
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUEs 1-8 — MIGRACIÓN ATÓMICA ÚNICA
-- Todo o nada: si cualquier instrucción falla, ROLLBACK automático completo.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — OBLIGATORIO CUBO: columnas de verificación de pagos en pedidos
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_identifier           TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_authorization_code   TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagado_en                 TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_payment_intent_token TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_esperado_centavos   INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_reference_id         TEXT;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — IDEMPOTENCIA DE NOTIFICACIONES (OBLIGATORIO)
--
-- Requerido por services/pagoEventos.js. Si esta columna no existe,
-- los eventos notificar_pago_cliente y notificar_pago_restaurante lanzarán
-- un error y quedarán pendientes hasta que se ejecute esta migración.
-- NO está comentado ni es opcional: es parte del núcleo Cubo.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS clave_idempotencia TEXT;

-- Índice único parcial: solo se aplica a notificaciones con clave establecida.
-- Garantiza que cubo_pago:{pedidoId}:cliente y cubo_pago:{pedidoId}:restaurante
-- nunca se dupliquen aunque el evento se reintente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_clave_idempotencia
  ON notificaciones(clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — EVENTOS PENDIENTES
--
-- Tabla con estados explícitos: pendiente → procesando → completado | fallido
-- La columna procesando_desde permite recuperar eventos abandonados por
-- timeout (proceso que murió con estado='procesando').
--
-- Escenarios posibles (introspección jun 2026):
--   A. No existe            → CREATE TABLE crea todo.
--   B. Existe con estado    → ADD COLUMN IF NOT EXISTS + DO block completan lo faltante.
--   C. Existe sin estado, 0 filas → DROP seguro + CREATE.
--   D. Existe sin estado, ≥1 fila → RAISE EXCEPTION: migración bloqueada, intervención manual.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_row_count INTEGER := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
      AND column_name = 'estado'
  ) THEN
    -- Tabla existe con esquema anterior (sin columna estado): verificar filas antes de DROP
    EXECUTE 'SELECT COUNT(*) FROM pago_eventos_pendientes' INTO v_row_count;
    IF v_row_count > 0 THEN
      RAISE EXCEPTION
        'MIGRACIÓN BLOQUEADA: pago_eventos_pendientes tiene % fila(s) y carece de columna estado. '
        'No se puede eliminar con datos. Agregar manualmente primero: '
        'ALTER TABLE pago_eventos_pendientes '
        'ADD COLUMN estado TEXT NOT NULL DEFAULT ''pendiente'' '
        'CHECK (estado IN (''pendiente'',''procesando'',''completado'',''fallido''));'
        ' Después re-ejecutar esta migración.',
        v_row_count;
    ELSE
      RAISE NOTICE 'pago_eventos_pendientes: esquema anterior sin datos — reconstruyendo con esquema v5.';
      DROP TABLE pago_eventos_pendientes CASCADE;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pago_eventos_pendientes (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id        UUID        NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo_evento      TEXT        NOT NULL,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  estado           TEXT        NOT NULL DEFAULT 'pendiente'
                               CONSTRAINT chk_pago_eventos_estado
                               CHECK (estado IN ('pendiente','procesando','completado','fallido')),
  intentos         INTEGER     NOT NULL DEFAULT 0,
  procesando_desde TIMESTAMPTZ,
  ultimo_intento_at TIMESTAMPTZ,
  error_ultimo     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completado_at    TIMESTAMPTZ,
  CONSTRAINT pago_eventos_pend_uniq_ped_tipo UNIQUE (pedido_id, tipo_evento)
);

-- Para el procesador de eventos: solo los pendientes, ordenados por creación
CREATE INDEX IF NOT EXISTS idx_pago_eventos_pendiente
  ON pago_eventos_pendientes(created_at)
  WHERE estado = 'pendiente';

-- Para recuperación de eventos abandonados (stuck en 'procesando' por timeout)
CREATE INDEX IF NOT EXISTS idx_pago_eventos_procesando
  ON pago_eventos_pendientes(procesando_desde)
  WHERE estado = 'procesando';

-- Completar columnas faltantes si la tabla pre-existía (escenario B — idempotente)
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS payload           JSONB       NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS intentos          INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS procesando_desde  TIMESTAMPTZ;
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS ultimo_intento_at TIMESTAMPTZ;
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS error_ultimo      TEXT;
ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS completado_at     TIMESTAMPTZ;

-- Añadir constraints si no existen (tabla pre-existente puede carecer de ellos)
DO $$
DECLARE
  v_dups INTEGER := 0;
BEGIN
  -- CHECK estado: por nombre explícito; si existe con otro nombre, el nuevo es redundante pero inofensivo
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name   = 'pago_eventos_pendientes'
      AND constraint_name = 'chk_pago_eventos_estado'
  ) THEN
    ALTER TABLE pago_eventos_pendientes
      ADD CONSTRAINT chk_pago_eventos_estado
      CHECK (estado IN ('pendiente','procesando','completado','fallido'));
  END IF;

  -- UNIQUE(pedido_id, tipo_evento): detectar duplicados antes de crear
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a1 ON a1.attrelid = t.oid AND a1.attname = 'pedido_id'
    JOIN pg_attribute a2 ON a2.attrelid = t.oid AND a2.attname = 'tipo_evento'
    WHERE n.nspname = 'public'
      AND t.relname = 'pago_eventos_pendientes'
      AND c.contype = 'u'
      AND a1.attnum = ANY(c.conkey)
      AND a2.attnum = ANY(c.conkey)
      AND array_length(c.conkey, 1) = 2
  ) THEN
    SELECT COUNT(*) INTO v_dups FROM (
      SELECT pedido_id, tipo_evento FROM pago_eventos_pendientes
      GROUP BY pedido_id, tipo_evento HAVING COUNT(*) > 1
    ) d;
    IF v_dups > 0 THEN
      RAISE EXCEPTION
        'MIGRACIÓN BLOQUEADA: % par(es) (pedido_id, tipo_evento) duplicados en '
        'pago_eventos_pendientes — resolver antes de crear UNIQUE.', v_dups;
    END IF;
    ALTER TABLE pago_eventos_pendientes
      ADD CONSTRAINT pago_eventos_pend_uniq_ped_tipo UNIQUE (pedido_id, tipo_evento);
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — IDEMPOTENCIA DE PUNTOS
--
-- UNIQUE(pedido_id, concepto) garantiza que sumar_puntos_idempotente no
-- acumula puntos dos veces aunque el evento se reintente múltiples veces.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS movimientos_puntos (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  usuario_id UUID        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  pedido_id  UUID        REFERENCES pedidos(id) ON DELETE SET NULL,
  concepto   TEXT        NOT NULL,
  puntos     INTEGER     NOT NULL CONSTRAINT chk_movimientos_puntos_positivo CHECK (puntos > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT movimientos_puntos_uniq_ped_concepto UNIQUE (pedido_id, concepto)
);

CREATE INDEX IF NOT EXISTS idx_movimientos_puntos_usuario
  ON movimientos_puntos(usuario_id);

-- Completar columnas faltantes si la tabla pre-existía (idempotente)
ALTER TABLE movimientos_puntos ADD COLUMN IF NOT EXISTS concepto   TEXT        NOT NULL DEFAULT '';
ALTER TABLE movimientos_puntos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Añadir constraints si no existen
DO $$
DECLARE
  v_dups INTEGER := 0;
BEGIN
  -- CHECK puntos > 0
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name   = 'movimientos_puntos'
      AND constraint_name = 'chk_movimientos_puntos_positivo'
  ) THEN
    ALTER TABLE movimientos_puntos
      ADD CONSTRAINT chk_movimientos_puntos_positivo CHECK (puntos > 0);
  END IF;

  -- UNIQUE(pedido_id, concepto): detectar duplicados antes de crear
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a1 ON a1.attrelid = t.oid AND a1.attname = 'pedido_id'
    JOIN pg_attribute a2 ON a2.attrelid = t.oid AND a2.attname = 'concepto'
    WHERE n.nspname = 'public'
      AND t.relname = 'movimientos_puntos'
      AND c.contype = 'u'
      AND a1.attnum = ANY(c.conkey)
      AND a2.attnum = ANY(c.conkey)
      AND array_length(c.conkey, 1) = 2
  ) THEN
    SELECT COUNT(*) INTO v_dups FROM (
      SELECT pedido_id, concepto FROM movimientos_puntos
      GROUP BY pedido_id, concepto HAVING COUNT(*) > 1
    ) d;
    IF v_dups > 0 THEN
      RAISE EXCEPTION
        'MIGRACIÓN BLOQUEADA: % par(es) (pedido_id, concepto) duplicados en '
        'movimientos_puntos — resolver antes de crear UNIQUE.', v_dups;
    END IF;
    ALTER TABLE movimientos_puntos
      ADD CONSTRAINT movimientos_puntos_uniq_ped_concepto UNIQUE (pedido_id, concepto);
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 5 — RESTRICCIONES E ÍNDICES
-- ════════════════════════════════════════════════════════════════════════════

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


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 6 — RPC confirmar_pago_cubo v5 — modelo híbrido
--
-- Fuente de verdad para inventario: pedido_items (nunca pedidos.bolsa_id ni
-- pedidos.cantidad — ambos son campos de compatibilidad).
--
-- Todo pedido creado por POST /api/pagos/cubopago inserta en pedido_items.
-- Si el pedido no tiene filas en pedido_items → items_ausentes (fail-closed).
-- Sin fallback al modelo bolsa_id (esos pedidos son legacy/PayU, no Cubo).
--
-- Algoritmo de inventario — dos bucles para garantizar "todo o nada":
--   Paso A — Agregar SUM(cantidad) por bolsa_id desde pedido_items.
--            Cargar en arrays en ORDER BY bolsa_id (deadlock prevention).
--   Paso B — Bloquear cada bolsa (FOR UPDATE) y verificar stock.
--            RETURN en el primer fallo: ninguna fila modificada aún.
--   Paso C — Descontar (filas ya bloqueadas, solo si Paso B terminó sin RETURN).
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
  v_puntos       integer := 10;
  v_puntos_cfg   text;
  v_eventos_pend jsonb;
  -- Inventario multi-ítem
  v_n_bolsas     integer;
  v_bolsa_ids    uuid[];
  v_cantidades   integer[];
  v_idx          integer;
  v_disponible   integer;
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

  -- ── 6. Inventario — modelo híbrido, pedido_items como única fuente ────────

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

COMMIT; -- fin migración atómica BLOQUEs 1-8


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

-- 6. Permisos — permitidos: postgres (propietario) y service_role.
--             Prohibidos: PUBLIC, anon, authenticated.
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN ('confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente')
ORDER BY routine_name, grantee;

-- Verificación automática: falla si aparece cualquier rol prohibido
DO $$
DECLARE
  v_forbidden TEXT;
BEGIN
  SELECT string_agg(grantee || ' → ' || routine_name, ', ' ORDER BY routine_name, grantee)
  INTO v_forbidden
  FROM information_schema.routine_privileges
  WHERE specific_schema = 'public'
    AND routine_name IN ('confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente')
    AND grantee IN ('PUBLIC', 'anon', 'authenticated');

  IF v_forbidden IS NOT NULL THEN
    RAISE EXCEPTION
      'PERMISOS INSEGUROS: los siguientes roles tienen EXECUTE y no deberían: [%]. '
      'Verificar que el BLOQUE 8 se ejecutó correctamente.', v_forbidden;
  END IF;
  RAISE NOTICE '✓ Permisos: ningún rol prohibido (PUBLIC/anon/authenticated) tiene EXECUTE.';
END $$;

-- 7. puntos_por_pedido y clave_idempotencia
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';

SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'notificaciones'
  AND column_name = 'clave_idempotencia';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 10 — TESTS EN ROLLBACK (12 pruebas — modelo híbrido pedido_items)
--
-- Ejecutar el bloque BEGIN…ROLLBACK completo de una sola vez.
-- El ROLLBACK final revierte todo. No afecta producción.
--
-- Inventario de prueba:
--   bolsa_a: 10 unidades   (usada en tests multi-item, agrupación, cantidad)
--   bolsa_b: 5  unidades   (usada en test multi-item)
--   bolsa_c: 0  unidades   (sin stock — usada en test stock insuficiente)
--
-- Evolución esperada de bolsa_a: 10 → 8 (T1) → 6 (T2) → 6 (T3, sin cambio)
--                                   → 6 (T4, sin cambio) → 2 (T5, −4 vía items)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_result        jsonb;
  v_rpc           jsonb;
  v_usr_id        uuid;
  v_neg_id        uuid;
  v_bolsa_a       uuid;
  v_bolsa_b       uuid;
  v_bolsa_c       uuid;
  v_ped_mi        uuid;   -- multi-item: bolsa_a × 2 + bolsa_b × 1
  v_ped_mb        uuid;   -- misma bolsa × 2 (bolsa_a + bolsa_a)
  v_ped_si        uuid;   -- sin items (histórico/legacy)
  v_ped_ins       uuid;   -- stock insuficiente (bolsa_a × 1 + bolsa_c × 2)
  v_ped_qty       uuid;   -- discrepancia cantidad (pedidos.cantidad=1, items sum=4)
  v_tok_mi        text;
  v_tok_mb        text;
  v_tok_si        text;
  v_tok_ins       text;
  v_tok_qty       text;
  v_monto         integer := 20000;
  v_disp_a        integer;
  v_disp_b        integer;
  v_disp_a_antes  integer;
  v_filas_1       integer;
  v_filas_2       integer;
  v_notif_clave   text;
  v_notif_count   integer;
BEGIN

  -- ──────────────────────────────────────────────────────────────────────────
  -- Prechecks de parámetros y pedido inexistente (precondiciones de la RPC)
  -- ──────────────────────────────────────────────────────────────────────────
  SELECT confirmar_pago_cubo(NULL, 'tok', 100, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido' AND v_result->>'campo' = 'p_pedido_id',
    'Precheck 1a FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Precheck 1a: parametro_invalido (pedido_id NULL)';

  SELECT confirmar_pago_cubo(gen_random_uuid(), '', 100, 'SUCCEEDED', '', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido',
    'Precheck 1b FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Precheck 1b: parametro_invalido (token vacío)';

  SELECT confirmar_pago_cubo(gen_random_uuid(), 'tok', -1, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'parametro_invalido',
    'Precheck 1c FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Precheck 1c: parametro_invalido (monto <= 0)';

  SELECT confirmar_pago_cubo(gen_random_uuid(), 'tok', 100, 'SUCCEEDED', 'tok', NULL, NULL, NULL) INTO v_result;
  ASSERT v_result->>'resultado' = 'pedido_no_encontrado',
    'Precheck 2 FALLÓ: ' || v_result::text;
  RAISE NOTICE '✓ Precheck 2: pedido_no_encontrado';

  -- ──────────────────────────────────────────────────────────────────────────
  -- Datos de prueba
  -- ──────────────────────────────────────────────────────────────────────────
  INSERT INTO usuarios (id, email, password_hash, nombre, rol, puntos, total_bolsas_salvadas)
  VALUES (gen_random_uuid(), 'v5_test@bocara.test', 'TEST_ONLY_INVALID_PASSWORD_HASH', 'Test v5', 'cliente', 0, 0)
  RETURNING id INTO v_usr_id;

  INSERT INTO negocios (id, propietario_id, nombre, direccion, zona, ciudad, categoria)
  VALUES (gen_random_uuid(), v_usr_id, 'Negocio v5', 'Zona 10', 'Zona 10', 'Guatemala', 'restaurante')
  RETURNING id INTO v_neg_id;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa A v5', 150.00, 75.00, 10, '18:00', '20:00')
  RETURNING id INTO v_bolsa_a;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa B v5', 120.00, 60.00, 5, '18:00', '20:00')
  RETURNING id INTO v_bolsa_b;

  INSERT INTO bolsas (id, negocio_id, nombre, precio_original, precio_descuento,
                      cantidad_disponible, hora_recogida_inicio, hora_recogida_fin)
  VALUES (gen_random_uuid(), v_neg_id, 'Bolsa C v5 sin stock', 100.00, 50.00, 0, '18:00', '20:00')
  RETURNING id INTO v_bolsa_c;

  v_tok_mi  := 'tok_v5_mi_'  || replace(gen_random_uuid()::text, '-', '');
  v_tok_mb  := 'tok_v5_mb_'  || replace(gen_random_uuid()::text, '-', '');
  v_tok_si  := 'tok_v5_si_'  || replace(gen_random_uuid()::text, '-', '');
  v_tok_ins := 'tok_v5_ins_' || replace(gen_random_uuid()::text, '-', '');
  v_tok_qty := 'tok_v5_qty_' || replace(gen_random_uuid()::text, '-', '');

  -- Pedido multi-item: bolsa_a × 2 + bolsa_b × 1
  -- pedidos.bolsa_id = bolsa_a (campo compatibilidad), pedidos.cantidad = 2 (primera bolsa únicamente)
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos, cantidad)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_a, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 210.00, 'BOC-MI',
          v_tok_mi, v_monto, 2)
  RETURNING id INTO v_ped_mi;
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_ped_mi, v_bolsa_a, 2, 75.00, 150.00),
         (v_ped_mi, v_bolsa_b, 1, 60.00,  60.00);

  -- Pedido misma bolsa: bolsa_a × 1 + bolsa_a × 1 (mismo bolsa_id en dos filas)
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos, cantidad)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_a, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 150.00, 'BOC-MB',
          v_tok_mb, v_monto, 1)
  RETURNING id INTO v_ped_mb;
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_ped_mb, v_bolsa_a, 1, 75.00, 75.00),
         (v_ped_mb, v_bolsa_a, 1, 75.00, 75.00);

  -- Pedido sin items — legacy/histórico (no Cubo): NO se insertan pedido_items
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_a, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 75.00, 'BOC-SI',
          v_tok_si, v_monto)
  RETURNING id INTO v_ped_si;

  -- Pedido stock insuficiente: bolsa_a × 1 (ok) + bolsa_c × 2 (bolsa_c = 0)
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos, cantidad)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_a, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 175.00, 'BOC-INS',
          v_tok_ins, v_monto, 1)
  RETURNING id INTO v_ped_ins;
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_ped_ins, v_bolsa_a, 1, 75.00,  75.00),
         (v_ped_ins, v_bolsa_c, 2, 50.00, 100.00);

  -- Pedido discrepancia: pedidos.cantidad=1 (primera bolsa), items sum=4 (bolsa_a × 1 + bolsa_a × 3)
  INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                       tipo_entrega, total, codigo_recogida,
                       cubo_payment_intent_token, monto_esperado_centavos, cantidad)
  VALUES (gen_random_uuid(), v_usr_id, v_bolsa_a, v_neg_id,
          'pendiente', 'pendiente', 'recogida', 300.00, 'BOC-QTY',
          v_tok_qty, v_monto, 1)
  RETURNING id INTO v_ped_qty;
  INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
  VALUES (v_ped_qty, v_bolsa_a, 1, 75.00,  75.00),
         (v_ped_qty, v_bolsa_a, 3, 75.00, 225.00);

  -- ════════════════════════════════════════════════════════════════
  -- TEST 1 — Multi-item: todas las bolsas descontadas exactamente una vez
  -- Verifica que pedido_items controla el inventario, no pedidos.bolsa_id
  -- ════════════════════════════════════════════════════════════════
  SELECT confirmar_pago_cubo(v_ped_mi, v_tok_mi, v_monto, 'SUCCEEDED', v_tok_mi, 'REF-MI', 'AUTH-MI', NOW())
  INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado', 'Test 1 FALLÓ: ' || v_result::text;

  SELECT cantidad_disponible INTO v_disp_a FROM bolsas WHERE id = v_bolsa_a;
  SELECT cantidad_disponible INTO v_disp_b FROM bolsas WHERE id = v_bolsa_b;
  ASSERT v_disp_a = 8, 'Test 1 FALLÓ: bolsa_a esperado 8 (10−2), actual=' || v_disp_a;
  ASSERT v_disp_b = 4, 'Test 1 FALLÓ: bolsa_b esperado 4 (5−1), actual=' || v_disp_b;

  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_ped_mi) = 3,
    'Test 1 FALLÓ: esperados 3 eventos separados';

  RAISE NOTICE '✓ Test 1: multi-item — bolsa_a=8 (10−2), bolsa_b=4 (5−1), 3 eventos registrados';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 2 — Misma bolsa × 2: cantidades agrupadas correctamente
  -- items: (bolsa_a, 1) + (bolsa_a, 1) → SUM = 2 → un solo descuento de 2
  -- ════════════════════════════════════════════════════════════════
  SELECT confirmar_pago_cubo(v_ped_mb, v_tok_mb, v_monto, 'SUCCEEDED', v_tok_mb, 'REF-MB', 'AUTH-MB', NOW())
  INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado', 'Test 2 FALLÓ: ' || v_result::text;

  SELECT cantidad_disponible INTO v_disp_a FROM bolsas WHERE id = v_bolsa_a;
  ASSERT v_disp_a = 6,
    'Test 2 FALLÓ: bolsa_a esperado 6 (8−2, suma de 2 items de bolsa_a), actual=' || v_disp_a;

  RAISE NOTICE '✓ Test 2: misma bolsa × 2 — agrupada correctamente, bolsa_a=6 (8−2)';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 3 — Stock insuficiente: ninguna bolsa modificada (todo o nada)
  -- bolsa_c tiene 0 unidades, se piden 2. bolsa_a (1 pedida, 6 disponibles) NO debe modificarse.
  -- ════════════════════════════════════════════════════════════════
  SELECT cantidad_disponible INTO v_disp_a_antes FROM bolsas WHERE id = v_bolsa_a;

  SELECT confirmar_pago_cubo(v_ped_ins, v_tok_ins, v_monto, 'SUCCEEDED', v_tok_ins, NULL, NULL, NULL)
  INTO v_result;
  ASSERT v_result->>'resultado' = 'stock_insuficiente',
    'Test 3 FALLÓ: esperado stock_insuficiente, obtenido=' || (v_result->>'resultado');
  ASSERT v_result->>'bolsa_id' = v_bolsa_c::text,
    'Test 3 FALLÓ: bolsa incorrecta — esperado bolsa_c, obtenido=' || (v_result->>'bolsa_id');
  ASSERT (v_result->>'disponible')::integer = 0,
    'Test 3 FALLÓ: disponible esperado 0';
  ASSERT (v_result->>'solicitado')::integer = 2,
    'Test 3 FALLÓ: solicitado esperado 2';

  SELECT cantidad_disponible INTO v_disp_a FROM bolsas WHERE id = v_bolsa_a;
  ASSERT v_disp_a = v_disp_a_antes,
    'Test 3 FALLÓ: bolsa_a fue modificada pese a fallo en bolsa_c (no es todo o nada) — '
    'antes=' || v_disp_a_antes || ' despues=' || v_disp_a;

  RAISE NOTICE '✓ Test 3: stock_insuficiente(bolsa_c=0/2) — bolsa_a SIN modificar (todo o nada), bolsa_a=% (sin cambio)', v_disp_a;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 4 — Webhook duplicado: sin doble descuento, retorna eventos pendientes
  -- ════════════════════════════════════════════════════════════════
  SELECT cantidad_disponible INTO v_disp_b FROM bolsas WHERE id = v_bolsa_b;

  SELECT confirmar_pago_cubo(v_ped_mi, v_tok_mi, v_monto, 'SUCCEEDED', v_tok_mi, 'REF-MI', 'AUTH-MI', NOW())
  INTO v_result;
  ASSERT v_result->>'resultado' = 'duplicado',
    'Test 4 FALLÓ: esperado duplicado, obtenido=' || (v_result->>'resultado');
  ASSERT jsonb_typeof(v_result->'eventos_pendientes') = 'array',
    'Test 4 FALLÓ: falta eventos_pendientes como array';

  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_a) = 6,
    'Test 4 FALLÓ: bolsa_a descontada en webhook duplicado (debe permanecer en 6)';
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_b) = v_disp_b,
    'Test 4 FALLÓ: bolsa_b descontada en webhook duplicado';
  ASSERT (SELECT COUNT(*) FROM pago_eventos_pendientes WHERE pedido_id = v_ped_mi) = 3,
    'Test 4 FALLÓ: eventos creados en webhook duplicado (UNIQUE(pedido_id, tipo_evento) no funcionó)';

  RAISE NOTICE '✓ Test 4: duplicado — eventos_pendientes=%, inventario sin doble descuento', v_result->'eventos_pendientes';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 5 — pedidos.cantidad != SUM(items): usa SUM(items), ignora pedidos.cantidad
  -- Pedido: pedidos.cantidad=1 (primera bolsa), items=4 (bolsa_a × 1 + bolsa_a × 3)
  -- Si la RPC usa pedidos.cantidad=1, bolsa_a bajaría 1.
  -- Si la RPC usa SUM(items)=4, bolsa_a bajaría 4. Solo el segundo es correcto.
  -- ════════════════════════════════════════════════════════════════
  SELECT cantidad_disponible INTO v_disp_a_antes FROM bolsas WHERE id = v_bolsa_a;

  SELECT confirmar_pago_cubo(v_ped_qty, v_tok_qty, v_monto, 'SUCCEEDED', v_tok_qty, 'REF-QTY', 'AUTH-QTY', NOW())
  INTO v_result;
  ASSERT v_result->>'resultado' = 'procesado', 'Test 5 FALLÓ: ' || v_result::text;

  SELECT cantidad_disponible INTO v_disp_a FROM bolsas WHERE id = v_bolsa_a;
  ASSERT v_disp_a = v_disp_a_antes - 4,
    'Test 5 FALLÓ: RPC usó pedidos.cantidad (−1) en lugar de SUM(items) (−4). '
    'bolsa_a esperado=' || (v_disp_a_antes - 4) || ' actual=' || v_disp_a;
  ASSERT v_disp_a <> v_disp_a_antes - 1,
    'Test 5 FALLÓ: bolsa_a bajó solo 1 — RPC usó pedidos.cantidad=1, no SUM(items)=4';

  RAISE NOTICE '✓ Test 5: usa SUM(items)=4, no pedidos.cantidad=1 — bolsa_a=% (antes=%)', v_disp_a, v_disp_a_antes;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 6 — pedidos.bolsa_id no genera descuento adicional
  -- En Test 1: bolsa_a es a la vez pedidos.bolsa_id Y el primer item.
  -- El viejo modelo descontaba vía bolsa_id = 1 unidad.
  -- El nuevo modelo descuenta vía items = 2 unidades (bolsa_a × 2).
  -- Si bolsa_a = 8 después de Test 1, descuenta correctamente 2 (no 3).
  -- bolsa_b solo fue tocada en Test 1 (−1) y no en ningún otro pedido.
  -- ════════════════════════════════════════════════════════════════
  ASSERT (SELECT cantidad_disponible FROM bolsas WHERE id = v_bolsa_b) = 4,
    'Test 6 FALLÓ: bolsa_b fue descontada más de una vez — '
    'pedidos.bolsa_id no debe usarse para inventario '
    '(bolsa_b solo tiene 1 item en v_ped_mi, debe quedar en 4)';

  RAISE NOTICE '✓ Test 6: pedidos.bolsa_id no genera descuento extra — bolsa_b=4 (solo Test 1, exactamente −1)';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 7 — Pedido histórico sin items: fail-closed (items_ausentes)
  -- v_ped_si tiene bolsa_id y token pero no pedido_items.
  -- La RPC no debe usar bolsa_id como fallback. Debe retornar items_ausentes.
  -- ════════════════════════════════════════════════════════════════
  SELECT confirmar_pago_cubo(v_ped_si, v_tok_si, v_monto, 'SUCCEEDED', v_tok_si, NULL, NULL, NULL)
  INTO v_result;
  ASSERT v_result->>'resultado' = 'items_ausentes',
    'Test 7 FALLÓ: esperado items_ausentes, obtenido=' || (v_result->>'resultado');
  ASSERT v_result->>'pedido_id' = v_ped_si::text,
    'Test 7 FALLÓ: pedido_id en respuesta incorrecto';
  ASSERT (SELECT estado_pago FROM pedidos WHERE id = v_ped_si) = 'pendiente',
    'Test 7 FALLÓ: pedido histórico fue marcado pagado';

  RAISE NOTICE '✓ Test 7: items_ausentes (histórico) — pedido estado_pago=pendiente, no modificado';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 8 — Cualquier pedido sin items → items_ausentes (no importa el origen)
  -- No hay distinción entre "histórico" y "nuevo sin items": misma respuesta.
  -- bolsa_id presente, token válido, monto válido — pero sin items → fail-closed.
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_ped_nsi uuid;
    v_tok_nsi text;
  BEGIN
    v_tok_nsi := 'tok_v5_nsi_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                         tipo_entrega, total, codigo_recogida,
                         cubo_payment_intent_token, monto_esperado_centavos)
    VALUES (gen_random_uuid(), v_usr_id, v_bolsa_b, v_neg_id,
            'pendiente', 'pendiente', 'recogida', 60.00, 'BOC-NSI',
            v_tok_nsi, v_monto)
    RETURNING id INTO v_ped_nsi;
    -- Sin pedido_items deliberadamente

    SELECT confirmar_pago_cubo(v_ped_nsi, v_tok_nsi, v_monto, 'SUCCEEDED', v_tok_nsi, NULL, NULL, NULL)
    INTO v_result;
    ASSERT v_result->>'resultado' = 'items_ausentes',
      'Test 8 FALLÓ: esperado items_ausentes, obtenido=' || (v_result->>'resultado');
    ASSERT (SELECT estado_pago FROM pedidos WHERE id = v_ped_nsi) = 'pendiente',
      'Test 8 FALLÓ: pedido sin items fue marcado pagado';
    ASSERT NOT EXISTS (SELECT 1 FROM pago_eventos_pendientes WHERE pedido_id = v_ped_nsi),
      'Test 8 FALLÓ: se crearon eventos para un pedido sin items';
  END;
  RAISE NOTICE '✓ Test 8: items_ausentes (nuevo pedido sin items) — sin fallback bolsa_id, pedido intacto';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 9 — monto verificado contra valor almacenado en BD (server-side)
  -- monto_esperado_centavos fue calculado en routes/pagos.js desde precios reales.
  -- La RPC lo compara contra el monto que Cubo informa — el cliente nunca lo decide.
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_ped_mt uuid;
    v_tok_mt text;
  BEGIN
    v_tok_mt := 'tok_v5_mt_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO pedidos (id, usuario_id, bolsa_id, negocio_id, estado, estado_pago,
                         tipo_entrega, total, codigo_recogida,
                         cubo_payment_intent_token, monto_esperado_centavos)
    VALUES (gen_random_uuid(), v_usr_id, v_bolsa_b, v_neg_id,
            'pendiente', 'pendiente', 'recogida', 60.00, 'BOC-MT',
            v_tok_mt, 5000)   -- monto_esperado = 5000 centavos (server-computed)
    RETURNING id INTO v_ped_mt;
    INSERT INTO pedido_items (pedido_id, bolsa_id, cantidad, precio_unitario, subtotal)
    VALUES (v_ped_mt, v_bolsa_b, 1, 50.00, 50.00);

    -- Enviar monto distinto al almacenado → monto_incorrecto
    SELECT confirmar_pago_cubo(v_ped_mt, v_tok_mt, 9999, 'SUCCEEDED', v_tok_mt, NULL, NULL, NULL)
    INTO v_result;
    ASSERT v_result->>'resultado' = 'monto_incorrecto',
      'Test 9 FALLÓ: RPC aceptó monto incorrecto — ' || v_result::text;
    ASSERT (v_result->>'esperado')::integer = 5000,
      'Test 9 FALLÓ: esperado=5000 en respuesta, obtenido=' || (v_result->>'esperado');
    ASSERT (v_result->>'recibido')::integer = 9999,
      'Test 9 FALLÓ: recibido=9999 en respuesta, obtenido=' || (v_result->>'recibido');
  END;
  RAISE NOTICE '✓ Test 9: monto verificado contra BD server-side — mismatch(9999≠5000) rechazado';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 10 — Concurrencia: exactamente un procesador reclama el evento
  -- Simula dos procesadores leyendo el mismo evento (estado='pendiente', intentos=0)
  -- y tratando de reclamarlo. Solo el primero debe ganar (bloqueo optimista).
  -- ════════════════════════════════════════════════════════════════
  UPDATE pago_eventos_pendientes
  SET estado = 'pendiente', intentos = 0, procesando_desde = NULL
  WHERE pedido_id = v_ped_mi AND tipo_evento = 'notificar_pago_restaurante';

  UPDATE pago_eventos_pendientes
  SET estado = 'procesando', intentos = 1, procesando_desde = NOW()
  WHERE pedido_id = v_ped_mi AND tipo_evento = 'notificar_pago_restaurante'
    AND estado = 'pendiente' AND intentos = 0;
  GET DIAGNOSTICS v_filas_1 = ROW_COUNT;

  UPDATE pago_eventos_pendientes
  SET estado = 'procesando', intentos = 1, procesando_desde = NOW()
  WHERE pedido_id = v_ped_mi AND tipo_evento = 'notificar_pago_restaurante'
    AND estado = 'pendiente' AND intentos = 0;
  GET DIAGNOSTICS v_filas_2 = ROW_COUNT;

  ASSERT v_filas_1 + v_filas_2 = 1,
    'Test 10 FALLÓ: exactamente 1 procesador debe ganar — filas_1=' || v_filas_1 || ' filas_2=' || v_filas_2;
  ASSERT v_filas_1 = 1 AND v_filas_2 = 0,
    'Test 10 FALLÓ: procesador 1 debió ganar (1,0), obtenido (' || v_filas_1 || ',' || v_filas_2 || ')';

  RAISE NOTICE '✓ Test 10: concurrencia — proc 1 ganó (%), proc 2 perdió (%)', v_filas_1, v_filas_2;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 11 — Puntos idempotentes + notificaciones idempotentes
  -- sumar_puntos_idempotente: primer intento = sumado; reintento = duplicado (no doble suma)
  -- notificaciones con clave_idempotencia: segunda inserción rechazada (UNIQUE)
  -- ════════════════════════════════════════════════════════════════
  SELECT sumar_puntos_idempotente(v_usr_id, v_ped_mi, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'sumado',
    'Test 11a FALLÓ: primer intento debe sumar — ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10,
    'Test 11a FALLÓ: puntos esperado 10, actual=' || (SELECT puntos FROM usuarios WHERE id = v_usr_id);
  RAISE NOTICE '✓ Test 11a: sumar_puntos_idempotente → sumado (puntos=10)';

  SELECT sumar_puntos_idempotente(v_usr_id, v_ped_mi, 10, 'pago_cubo') INTO v_rpc;
  ASSERT v_rpc->>'resultado' = 'duplicado',
    'Test 11b FALLÓ: reintento debe ser duplicado — ' || v_rpc::text;
  ASSERT (SELECT puntos FROM usuarios WHERE id = v_usr_id) = 10,
    'Test 11b FALLÓ: puntos sumados dos veces (esperado 10, actual=' || (SELECT puntos FROM usuarios WHERE id = v_usr_id) || ')';
  RAISE NOTICE '✓ Test 11b: sumar_puntos_idempotente reintento → duplicado (puntos siguen=10)';

  v_notif_clave := 'cubo_pago:' || v_ped_mi || ':cliente';
  INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, data, leida, clave_idempotencia)
  VALUES (v_usr_id, 'pago_confirmado', 'Pago confirmado', 'Test v5', '{"test":true}'::jsonb, false, v_notif_clave);

  BEGIN
    INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, data, leida, clave_idempotencia)
    VALUES (v_usr_id, 'pago_confirmado', 'Pago confirmado', 'Test v5 dup', '{"test":true}'::jsonb, false, v_notif_clave);
    ASSERT FALSE, 'Test 11c FALLÓ: segunda inserción debió ser UNIQUE violation';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  SELECT COUNT(*) INTO v_notif_count FROM notificaciones WHERE clave_idempotencia = v_notif_clave;
  ASSERT v_notif_count = 1,
    'Test 11c FALLÓ: esperada 1 notificación, encontradas=' || v_notif_count;
  RAISE NOTICE '✓ Test 11c: notificación idempotente — 1 sola entrada con clave %', v_notif_clave;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 12 — Pedidos históricos sin items completamente inmutables
  -- Después de Test 7 (items_ausentes), el pedido debe estar exactamente
  -- como fue creado: estado_pago=pendiente, sin eventos, sin cubo_identifier.
  -- ════════════════════════════════════════════════════════════════
  ASSERT (SELECT estado_pago FROM pedidos WHERE id = v_ped_si) = 'pendiente',
    'Test 12 FALLÓ: pedido histórico tiene estado_pago modificado';
  ASSERT (SELECT estado FROM pedidos WHERE id = v_ped_si) = 'pendiente',
    'Test 12 FALLÓ: pedido histórico tiene estado modificado';
  ASSERT (SELECT cubo_identifier FROM pedidos WHERE id = v_ped_si) IS NULL,
    'Test 12 FALLÓ: cubo_identifier fue escrito en pedido histórico';
  ASSERT (SELECT pagado_en FROM pedidos WHERE id = v_ped_si) IS NULL,
    'Test 12 FALLÓ: pagado_en fue escrito en pedido histórico';
  ASSERT NOT EXISTS (SELECT 1 FROM pago_eventos_pendientes WHERE pedido_id = v_ped_si),
    'Test 12 FALLÓ: se crearon eventos para pedido histórico';

  RAISE NOTICE '✓ Test 12: pedido histórico completamente inmutable (estado=pendiente, sin eventos, sin cubo_identifier)';

  -- ════════════════════════════════════════════════════════════════
  -- TEST 13 — pago_eventos_pendientes: 11 columnas requeridas presentes
  -- Verifica que la migración completó la tabla aunque pre-existiera
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_col13 INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_col13
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
      AND column_name IN (
        'id','pedido_id','tipo_evento','payload','estado','intentos',
        'procesando_desde','ultimo_intento_at','error_ultimo','created_at','completado_at'
      );
    ASSERT v_col13 = 11,
      'Test 13 FALLÓ: pago_eventos_pendientes tiene ' || v_col13 || '/11 columnas requeridas';
    RAISE NOTICE '✓ Test 13: pago_eventos_pendientes — 11/11 columnas requeridas presentes';
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 14 — movimientos_puntos: 6 columnas requeridas presentes
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_col14 INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_col14
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
      AND column_name IN ('id','usuario_id','pedido_id','concepto','puntos','created_at');
    ASSERT v_col14 = 6,
      'Test 14 FALLÓ: movimientos_puntos tiene ' || v_col14 || '/6 columnas requeridas';
    RAISE NOTICE '✓ Test 14: movimientos_puntos — 6/6 columnas requeridas presentes';
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 15 — 4 constraints requeridos existen post-migración
  -- ════════════════════════════════════════════════════════════════
  BEGIN
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.constraint_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = 'pago_eventos_pendientes'
        AND cc.check_clause LIKE '%pendiente%'
    ), 'Test 15a FALLÓ: CHECK estado IN (...) falta en pago_eventos_pendientes';

    ASSERT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a1 ON a1.attrelid = t.oid AND a1.attname = 'pedido_id'
      JOIN pg_attribute a2 ON a2.attrelid = t.oid AND a2.attname = 'tipo_evento'
      WHERE n.nspname = 'public' AND t.relname = 'pago_eventos_pendientes'
        AND c.contype = 'u'
        AND a1.attnum = ANY(c.conkey) AND a2.attnum = ANY(c.conkey)
        AND array_length(c.conkey, 1) = 2
    ), 'Test 15b FALLÓ: UNIQUE(pedido_id, tipo_evento) falta en pago_eventos_pendientes';

    ASSERT EXISTS (
      SELECT 1 FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.constraint_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = 'movimientos_puntos'
        AND cc.check_clause LIKE '%puntos%0%'
    ), 'Test 15c FALLÓ: CHECK puntos > 0 falta en movimientos_puntos';

    ASSERT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a1 ON a1.attrelid = t.oid AND a1.attname = 'pedido_id'
      JOIN pg_attribute a2 ON a2.attrelid = t.oid AND a2.attname = 'concepto'
      WHERE n.nspname = 'public' AND t.relname = 'movimientos_puntos'
        AND c.contype = 'u'
        AND a1.attnum = ANY(c.conkey) AND a2.attnum = ANY(c.conkey)
        AND array_length(c.conkey, 1) = 2
    ), 'Test 15d FALLÓ: UNIQUE(pedido_id, concepto) falta en movimientos_puntos';

    RAISE NOTICE '✓ Test 15: 4/4 constraints requeridos presentes en ambas tablas';
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 16 — PUBLIC/anon/authenticated sin EXECUTE en funciones Cubo
  -- BLOQUE 8 debe haber revocado estos privilegios
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_forbidden TEXT;
  BEGIN
    SELECT string_agg(grantee || '→' || routine_name, ', ' ORDER BY routine_name)
    INTO v_forbidden
    FROM information_schema.routine_privileges
    WHERE specific_schema = 'public'
      AND routine_name IN ('confirmar_pago_cubo','sumar_puntos','sumar_puntos_idempotente')
      AND grantee IN ('PUBLIC','anon','authenticated');
    ASSERT v_forbidden IS NULL,
      'Test 16 FALLÓ: roles prohibidos con EXECUTE: [' || COALESCE(v_forbidden,'') || ']. BLOQUE 8 incompleto.';
    RAISE NOTICE '✓ Test 16: PUBLIC/anon/authenticated sin EXECUTE en funciones Cubo';
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 17 — postgres y service_role son legítimos (no generan EXCEPTION)
  -- El propietario de la función conserva privilegios implícitos — es correcto.
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_legit INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_legit
    FROM information_schema.routine_privileges
    WHERE specific_schema = 'public'
      AND routine_name IN ('confirmar_pago_cubo','sumar_puntos','sumar_puntos_idempotente')
      AND grantee IN ('postgres','service_role');
    RAISE NOTICE '✓ Test 17: % privilegio(s) legítimos (postgres/service_role) — sin EXCEPTION', v_legit;
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 18 — Anti-DROP: tabla con filas + columna estado = sin riesgo de DROP
  -- pago_eventos_pendientes tiene filas (de tests 1-12) y columna estado.
  -- El DO del BLOQUE 3 evaluó la rama B (completar), no la rama DROP.
  -- ════════════════════════════════════════════════════════════════
  DECLARE
    v_rows18 INTEGER;
  BEGIN
    SELECT COUNT(*) INTO v_rows18 FROM pago_eventos_pendientes WHERE pedido_id = v_ped_mi;
    ASSERT v_rows18 > 0,
      'Test 18 FALLÓ: no hay filas de prueba en pago_eventos_pendientes para v_ped_mi';
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
        AND column_name = 'estado'
    ), 'Test 18 FALLÓ: columna estado no existe — migración no completó la tabla';
    RAISE NOTICE '✓ Test 18: anti-DROP — pago_eventos_pendientes con % fila(s) + estado presente; datos seguros', v_rows18;
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 19 — Idempotencia: ADD COLUMN IF NOT EXISTS es no-op en columnas existentes
  -- Segunda ejecución no falla ni duplica objetos
  -- ════════════════════════════════════════════════════════════════
  BEGIN
    ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS procesando_desde  TIMESTAMPTZ;
    ALTER TABLE pago_eventos_pendientes ADD COLUMN IF NOT EXISTS completado_at      TIMESTAMPTZ;
    ALTER TABLE movimientos_puntos      ADD COLUMN IF NOT EXISTS concepto           TEXT;
    CREATE INDEX IF NOT EXISTS idx_pago_eventos_pendiente
      ON pago_eventos_pendientes(created_at) WHERE estado = 'pendiente';
    CREATE INDEX IF NOT EXISTS idx_movimientos_puntos_usuario
      ON movimientos_puntos(usuario_id);
    RAISE NOTICE '✓ Test 19: idempotencia — ADD COLUMN IF NOT EXISTS y CREATE INDEX IF NOT EXISTS no-op en objetos existentes';
  END;

  -- ════════════════════════════════════════════════════════════════
  -- TEST 20 — UNIQUE(pedido_id, concepto) rechaza duplicado en movimientos_puntos
  -- Test 11a ya insertó (v_ped_mi, 'pago_cubo'). Verificar que un segundo
  -- INSERT con la misma clave lanza unique_violation.
  -- ════════════════════════════════════════════════════════════════
  BEGIN
    BEGIN
      INSERT INTO movimientos_puntos (usuario_id, pedido_id, concepto, puntos)
      VALUES (v_usr_id, v_ped_mi, 'pago_cubo', 5);
      ASSERT FALSE, 'Test 20 FALLÓ: UNIQUE(pedido_id, concepto) no rechazó el duplicado';
    EXCEPTION
      WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE '✓ Test 20: UNIQUE(pedido_id, concepto) en movimientos_puntos rechaza duplicados';
  END;

  -- ──────────────────────────────────────────────────────────────────────────
  -- Resumen
  -- ──────────────────────────────────────────────────────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Todos los tests v5 pasaron (20/20) — modelo híbrido pedido_items';
  RAISE NOTICE '  pedido_items es la única fuente de verdad para inventario Cubo.';
  RAISE NOTICE '  pedidos.bolsa_id y pedidos.cantidad son campos de compatibilidad.';
  RAISE NOTICE '  Sin items → items_ausentes (fail-closed). Sin fallback bolsa_id.';
  RAISE NOTICE '  Doble descuento imposible: lock FOR UPDATE + ORDER BY bolsa_id.';
  RAISE NOTICE '  Puntos e idempotencia de notificaciones verificados.';
  RAISE NOTICE '  Pedidos históricos sin items son inmutables para esta RPC.';
  RAISE NOTICE '  Migración idempotente: tablas existentes completadas sin DROP.';
  RAISE NOTICE '  Permisos: PUBLIC/anon/authenticated sin EXECUTE verificado.';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════════';

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
