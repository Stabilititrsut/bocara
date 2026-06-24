-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Diagnóstico de tablas existentes pre-migración v7            ║
-- ║                                                                        ║
-- ║  Diagnóstico no destructivo.                                           ║
-- ║  No modifica tablas ni datos persistentes de Bocara.                   ║
-- ║  Solo crea y utiliza tablas temporales dentro de la sesión del         ║
-- ║  SQL Editor.                                                           ║
-- ║                                                                        ║
-- ║  Ejecutar en Supabase → SQL Editor ANTES de cubo-pago-schema.sql v5   ║
-- ║  para confirmar la estructura real de las dos tablas Cubo.             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │  NOTA TÉCNICA: PGRST205 — qué significa y qué NO significa             │
-- │                                                                          │
-- │  PGRST205 = "Could not find table/function in schema cache"             │
-- │                                                                          │
-- │  Causas posibles (todas, no solo una):                                  │
-- │    1. La tabla NO existe en PostgreSQL  ← causa más común               │
-- │    2. La tabla existe pero PostgREST no tiene grants al rol API          │
-- │       (anon / authenticated / service_role)                              │
-- │    3. La tabla existe con grants, pero el caché PostgREST no se         │
-- │       actualizó desde la última DDL (NOTIFY pgrst.reload o reinicio)    │
-- │    4. El schema no está en la lista pgrst.db-schemas                    │
-- │                                                                          │
-- │  RLS (Row Level Security) NO causa PGRST205.                            │
-- │  RLS controla qué filas ve un rol, no si la tabla aparece en el cache. │
-- │  Una tabla con RLS habilitado y sin políticas devuelve 0 filas,         │
-- │  NO un error 205.                                                        │
-- │                                                                          │
-- │  Por eso este diagnóstico usa to_regclass() + information_schema        │
-- │  (accesibles directamente en SQL Editor) en lugar del REST API.         │
-- └──────────────────────────────────────────────────────────────────────────┘


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 1 — Limpiar tablas temporales de ejecuciones anteriores
-- ════════════════════════════════════════════════════════════════════════════
-- Calificadas con pg_temp. para evitar alcanzar tablas persistentes
-- homónimas en public aunque existieran por accidente.

DROP TABLE IF EXISTS pg_temp._diag_cubo_existencia;
DROP TABLE IF EXISTS pg_temp._diag_cubo_columnas;
DROP TABLE IF EXISTS pg_temp._diag_cubo_conteo;
DROP TABLE IF EXISTS pg_temp._diag_cubo_constraints;
DROP TABLE IF EXISTS pg_temp._diag_cubo_fk;
DROP TABLE IF EXISTS pg_temp._diag_cubo_indices;
DROP TABLE IF EXISTS pg_temp._diag_cubo_dup_pep;
DROP TABLE IF EXISTS pg_temp._diag_cubo_dup_mp;
DROP TABLE IF EXISTS pg_temp._diag_cubo_seguridad;
DROP TABLE IF EXISTS pg_temp._diag_cubo_politicas;
DROP TABLE IF EXISTS pg_temp._diag_cubo_clasificacion;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 2 — Crear tablas temporales de resultado
-- ════════════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _diag_cubo_existencia (
  tabla   TEXT,
  existe  BOOLEAN
);

CREATE TEMP TABLE _diag_cubo_columnas (
  tabla           TEXT,
  ordinal         INTEGER,
  column_name     TEXT,
  data_type       TEXT,
  is_nullable     TEXT,
  column_default  TEXT
);

CREATE TEMP TABLE _diag_cubo_conteo (
  tabla   TEXT,
  filas   BIGINT,
  estado  TEXT
);

CREATE TEMP TABLE _diag_cubo_constraints (
  tabla            TEXT,
  constraint_type  TEXT,
  constraint_name  TEXT,
  definicion       TEXT
);

CREATE TEMP TABLE _diag_cubo_fk (
  tabla              TEXT,
  column_name        TEXT,
  references_table   TEXT,
  references_column  TEXT,
  delete_rule        TEXT
);

CREATE TEMP TABLE _diag_cubo_indices (
  tabla      TEXT,
  indexname  TEXT,
  indexdef   TEXT
);

CREATE TEMP TABLE _diag_cubo_dup_pep (
  pedido_id    TEXT,
  tipo_evento  TEXT,
  repeticiones BIGINT
);

CREATE TEMP TABLE _diag_cubo_dup_mp (
  pedido_id    TEXT,
  concepto     TEXT,
  repeticiones BIGINT
);

CREATE TEMP TABLE _diag_cubo_seguridad (
  tabla          TEXT,
  rls_habilitado BOOLEAN,
  rol            TEXT,
  privilegio     TEXT
);

CREATE TEMP TABLE _diag_cubo_politicas (
  tabla        TEXT,
  policyname   TEXT,
  permissive   TEXT,
  roles        TEXT,
  cmd          TEXT
);

CREATE TEMP TABLE _diag_cubo_clasificacion (
  tabla          TEXT,
  clasificacion  TEXT,
  detalle        TEXT
);


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 3 — DO block principal (toda la lógica de diagnóstico)
-- ════════════════════════════════════════════════════════════════════════════
--
-- IMPORTANTE (PL/pgSQL):
--   SQL estático dentro de un DO block se parsea en tiempo de compilación.
--   "IF tabla_existe THEN SELECT * FROM tabla_posiblemente_ausente"
--   falla en compile-time aunque la tabla exista — el parser lo rechaza.
--   Solución: EXECUTE '...' se parsea en runtime, cuando ya sabemos
--   que la tabla existe. Ver secciones de conteo y duplicados.

DO $diagnostico$
DECLARE
  v_pep_exists       BOOLEAN;
  v_mp_exists        BOOLEAN;
  v_has_pep_dup_cols BOOLEAN;
  v_has_mp_dup_cols  BOOLEAN;
  r                  RECORD;
  v_clasi            TEXT;
  v_detalle          TEXT;
  v_pep_tiene_estado BOOLEAN;
  v_pep_count        BIGINT := 0;
  v_mp_count         BIGINT := 0;
BEGIN

  -- ── 1. EXISTENCIA ──────────────────────────────────────────────────────────
  -- to_regclass() siempre es seguro: devuelve NULL si la tabla no existe,
  -- OID si existe. Nunca lanza error.

  v_pep_exists := to_regclass('public.pago_eventos_pendientes') IS NOT NULL;
  v_mp_exists  := to_regclass('public.movimientos_puntos')      IS NOT NULL;

  INSERT INTO _diag_cubo_existencia VALUES
    ('pago_eventos_pendientes', v_pep_exists),
    ('movimientos_puntos',      v_mp_exists);


  -- ── 2. COLUMNAS ────────────────────────────────────────────────────────────
  -- information_schema.columns es siempre seguro: devuelve 0 filas si la
  -- tabla no existe, no lanza error.

  INSERT INTO _diag_cubo_columnas
  SELECT
    table_name,
    ordinal_position,
    column_name,
    data_type,
    is_nullable,
    column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('pago_eventos_pendientes', 'movimientos_puntos')
  ORDER BY table_name, ordinal_position;


  -- ── 3. CONSTRAINTS ─────────────────────────────────────────────────────────
  -- pg_constraint + pg_class siempre seguros.

  INSERT INTO _diag_cubo_constraints
  SELECT
    t.relname,
    CASE c.contype
      WHEN 'p' THEN 'PRIMARY KEY'
      WHEN 'f' THEN 'FOREIGN KEY'
      WHEN 'u' THEN 'UNIQUE'
      WHEN 'c' THEN 'CHECK'
      ELSE c.contype::TEXT
    END,
    c.conname,
    pg_get_constraintdef(c.oid, true)
  FROM pg_constraint c
  JOIN pg_class     t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname IN ('pago_eventos_pendientes', 'movimientos_puntos')
  ORDER BY t.relname, c.contype, c.conname;


  -- ── 4. FOREIGN KEYS detalladas ─────────────────────────────────────────────

  INSERT INTO _diag_cubo_fk
  SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name  AS references_table,
    ccu.column_name AS references_column,
    rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema    = tc.table_schema
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name   = tc.constraint_name
   AND rc.constraint_schema = tc.constraint_schema
  JOIN information_schema.key_column_usage ccu
    ON ccu.constraint_name = rc.unique_constraint_name
   AND ccu.table_schema    = tc.table_schema
  WHERE tc.table_schema    = 'public'
    AND tc.table_name      IN ('pago_eventos_pendientes', 'movimientos_puntos')
    AND tc.constraint_type = 'FOREIGN KEY'
  ORDER BY tc.table_name, kcu.column_name;


  -- ── 5. ÍNDICES ─────────────────────────────────────────────────────────────
  -- pg_indexes siempre seguro.

  INSERT INTO _diag_cubo_indices
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename  IN ('pago_eventos_pendientes', 'movimientos_puntos')
  ORDER BY tablename, indexname;


  -- ── 6. SEGURIDAD: RLS + grants ─────────────────────────────────────────────
  -- pg_class y role_table_grants siempre seguros.

  INSERT INTO _diag_cubo_seguridad
  SELECT
    pc.relname,
    pc.relrowsecurity,
    COALESCE(g.grantee,        '(sin grants)'),
    COALESCE(g.privilege_type, '—')
  FROM pg_class pc
  JOIN pg_namespace n ON n.oid = pc.relnamespace
  LEFT JOIN information_schema.role_table_grants g
    ON g.table_schema = n.nspname AND g.table_name = pc.relname
  WHERE n.nspname  = 'public'
    AND pc.relname IN ('pago_eventos_pendientes', 'movimientos_puntos')
    AND pc.relkind  = 'r'
  ORDER BY pc.relname, g.grantee;


  -- ── 7. POLÍTICAS RLS ───────────────────────────────────────────────────────

  INSERT INTO _diag_cubo_politicas
  SELECT tablename, policyname, permissive, roles::TEXT, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  IN ('pago_eventos_pendientes', 'movimientos_puntos')
  ORDER BY tablename, policyname;


  -- ── 8. CONTEO DE FILAS — EXECUTE obligatorio ───────────────────────────────
  -- SQL estático referenciando una tabla potencialmente ausente fallaría en
  -- compile-time, incluso dentro de un IF. EXECUTE evalúa en runtime.

  IF v_pep_exists THEN
    EXECUTE 'SELECT COUNT(*) FROM public.pago_eventos_pendientes' INTO v_pep_count;
    INSERT INTO _diag_cubo_conteo VALUES ('pago_eventos_pendientes', v_pep_count, 'OK');
  ELSE
    INSERT INTO _diag_cubo_conteo VALUES ('pago_eventos_pendientes', NULL, 'NO EXISTE');
  END IF;

  IF v_mp_exists THEN
    EXECUTE 'SELECT COUNT(*) FROM public.movimientos_puntos' INTO v_mp_count;
    INSERT INTO _diag_cubo_conteo VALUES ('movimientos_puntos', v_mp_count, 'OK');
  ELSE
    INSERT INTO _diag_cubo_conteo VALUES ('movimientos_puntos', NULL, 'NO EXISTE');
  END IF;


  -- ── 9. DUPLICADOS — EXECUTE obligatorio ────────────────────────────────────

  -- pago_eventos_pendientes: UNIQUE futuro sobre (pedido_id, tipo_evento)
  IF v_pep_exists THEN
    SELECT COUNT(*) = 2 INTO v_has_pep_dup_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'pago_eventos_pendientes'
      AND column_name  IN ('pedido_id', 'tipo_evento');

    IF v_has_pep_dup_cols THEN
      FOR r IN
        EXECUTE '
          SELECT pedido_id::TEXT     AS pedido_id,
                 tipo_evento,
                 COUNT(*)::BIGINT    AS repeticiones
          FROM public.pago_eventos_pendientes
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          ORDER BY 3 DESC'
      LOOP
        INSERT INTO _diag_cubo_dup_pep VALUES (r.pedido_id, r.tipo_evento, r.repeticiones);
      END LOOP;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM _diag_cubo_dup_pep) THEN
      IF v_has_pep_dup_cols THEN
        INSERT INTO _diag_cubo_dup_pep VALUES (NULL, '(sin duplicados)', 0);
      ELSE
        INSERT INTO _diag_cubo_dup_pep VALUES (NULL, '(columnas pedido_id/tipo_evento no encontradas)', NULL);
      END IF;
    END IF;
  ELSE
    INSERT INTO _diag_cubo_dup_pep VALUES (NULL, 'TABLA NO EXISTE', NULL);
  END IF;

  -- movimientos_puntos: UNIQUE futuro sobre (pedido_id, concepto)
  IF v_mp_exists THEN
    SELECT COUNT(*) = 2 INTO v_has_mp_dup_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'movimientos_puntos'
      AND column_name  IN ('pedido_id', 'concepto');

    IF v_has_mp_dup_cols THEN
      FOR r IN
        EXECUTE '
          SELECT pedido_id::TEXT     AS pedido_id,
                 concepto,
                 COUNT(*)::BIGINT    AS repeticiones
          FROM public.movimientos_puntos
          GROUP BY 1, 2
          HAVING COUNT(*) > 1
          ORDER BY 3 DESC'
      LOOP
        INSERT INTO _diag_cubo_dup_mp VALUES (r.pedido_id, r.concepto, r.repeticiones);
      END LOOP;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM _diag_cubo_dup_mp) THEN
      IF v_has_mp_dup_cols THEN
        INSERT INTO _diag_cubo_dup_mp VALUES (NULL, '(sin duplicados)', 0);
      ELSE
        INSERT INTO _diag_cubo_dup_mp VALUES (NULL, '(columnas pedido_id/concepto no encontradas)', NULL);
      END IF;
    END IF;
  ELSE
    INSERT INTO _diag_cubo_dup_mp VALUES (NULL, 'TABLA NO EXISTE', NULL);
  END IF;


  -- ── 10. CLASIFICACIÓN AUTOMÁTICA ───────────────────────────────────────────
  --
  -- Clases (precedencia de más grave a más favorable):
  --   A_NO_EXISTE            → tabla ausente → CREATE TABLE la crea completa
  --   E_DUPLICADOS_BLOQ_UNIQ → duplicados presentes → migración bloqueará al crear UNIQUE
  --   D_EXISTE_DATOS_INCOMPL → tabla sin columna clave + filas > 0 → EXCEPTION (solo PEP)
  --   C_EXISTE_VACIA_INCOMPL → tabla sin columna clave + 0 filas → DROP seguro (solo PEP)
  --                            o tabla existe con 0 filas (movimientos_puntos)
  --   B_EXISTE_COMPATIBLE    → tabla tiene columnas clave, sin duplicados → idempotente

  -- ── pago_eventos_pendientes ──
  IF NOT v_pep_exists THEN
    v_clasi   := 'A_NO_EXISTE';
    v_detalle := 'Tabla ausente. BLOQUE 3 la creará completa con CREATE TABLE.';

  ELSIF EXISTS (
    SELECT 1 FROM _diag_cubo_dup_pep
    WHERE repeticiones > 0
  ) THEN
    v_clasi   := 'E_DUPLICADOS_BLOQ_UNIQ';
    v_detalle := 'Duplicados (pedido_id, tipo_evento) encontrados. '
              || 'BLOQUE 3 lanzará EXCEPTION al intentar crear UNIQUE. '
              || 'Requiere intervención manual antes de migrar.';

  ELSE
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'pago_eventos_pendientes'
        AND column_name  = 'estado'
    ) INTO v_pep_tiene_estado;

    IF NOT v_pep_tiene_estado AND v_pep_count > 0 THEN
      v_clasi   := 'D_EXISTE_DATOS_INCOMPL';
      v_detalle := 'Tabla existe sin columna ''estado'', con '
                || v_pep_count::TEXT
                || ' fila(s). BLOQUE 3 lanzará EXCEPTION. '
                || 'Requiere intervención manual (migrar o vaciar datos).';

    ELSIF NOT v_pep_tiene_estado AND v_pep_count = 0 THEN
      v_clasi   := 'C_EXISTE_VACIA_INCOMPL';
      v_detalle := 'Tabla existe sin columna ''estado'' y 0 filas. '
                || 'BLOQUE 3 hará DROP TABLE + CREATE TABLE (seguro).';

    ELSE
      v_clasi   := 'B_EXISTE_COMPATIBLE';
      v_detalle := 'Tabla existe con columna ''estado'', sin duplicados. '
                || 'BLOQUE 3 aplicará ADD COLUMN IF NOT EXISTS + DO constraint blocks (idempotente).';
    END IF;
  END IF;

  INSERT INTO _diag_cubo_clasificacion VALUES ('pago_eventos_pendientes', v_clasi, v_detalle);

  -- ── movimientos_puntos ──
  IF NOT v_mp_exists THEN
    v_clasi   := 'A_NO_EXISTE';
    v_detalle := 'Tabla ausente. BLOQUE 4 la creará completa con CREATE TABLE.';

  ELSIF EXISTS (
    SELECT 1 FROM _diag_cubo_dup_mp
    WHERE repeticiones > 0
  ) THEN
    v_clasi   := 'E_DUPLICADOS_BLOQ_UNIQ';
    v_detalle := 'Duplicados (pedido_id, concepto) encontrados. '
              || 'BLOQUE 4 lanzará EXCEPTION al intentar crear UNIQUE. '
              || 'Requiere intervención manual antes de migrar.';

  ELSIF v_mp_count = 0 THEN
    v_clasi   := 'C_EXISTE_VACIA_INCOMPL';
    v_detalle := 'Tabla existe con 0 filas. '
              || 'BLOQUE 4 aplicará ADD COLUMN IF NOT EXISTS + DO constraint blocks (idempotente).';

  ELSE
    v_clasi   := 'B_EXISTE_COMPATIBLE';
    v_detalle := 'Tabla existe con '
              || v_mp_count::TEXT
              || ' fila(s), sin duplicados. '
              || 'BLOQUE 4 aplicará ADD COLUMN IF NOT EXISTS + DO constraint blocks (idempotente).';
  END IF;

  INSERT INTO _diag_cubo_clasificacion VALUES ('movimientos_puntos', v_clasi, v_detalle);

END;
$diagnostico$;


-- ════════════════════════════════════════════════════════════════════════════
-- PASO 4 — Resultados (cada SELECT = una pestaña en SQL Editor)
-- ════════════════════════════════════════════════════════════════════════════

-- ── R1. Existencia ──────────────────────────────────────────────────────────
SELECT tabla, existe
FROM _diag_cubo_existencia
ORDER BY tabla;

-- ── R2. Clasificación automática ────────────────────────────────────────────
SELECT tabla, clasificacion, detalle
FROM _diag_cubo_clasificacion
ORDER BY tabla;

-- ── R3. Columnas ────────────────────────────────────────────────────────────
-- Columnas requeridas pago_eventos_pendientes:
--   id, pedido_id, tipo_evento, payload, estado, intentos,
--   procesando_desde, ultimo_intento_at, error_ultimo, created_at, completado_at  (11 total)
-- Columnas requeridas movimientos_puntos:
--   id, usuario_id, pedido_id, concepto, puntos, created_at  (6 total)
SELECT tabla, ordinal, column_name, data_type, is_nullable, column_default
FROM _diag_cubo_columnas
ORDER BY tabla, ordinal;

-- ── R4. Conteo de filas ─────────────────────────────────────────────────────
SELECT tabla, filas, estado
FROM _diag_cubo_conteo
ORDER BY tabla;

-- ── R5. Constraints ─────────────────────────────────────────────────────────
SELECT tabla, constraint_type, constraint_name, definicion
FROM _diag_cubo_constraints
ORDER BY tabla, constraint_type, constraint_name;

-- ── R6. Foreign keys ────────────────────────────────────────────────────────
SELECT tabla, column_name, references_table, references_column, delete_rule
FROM _diag_cubo_fk
ORDER BY tabla, column_name;

-- ── R7. Índices ─────────────────────────────────────────────────────────────
-- Índices requeridos post-migración:
--   pago_eventos_pendientes: idx_pago_eventos_pendiente, idx_pago_eventos_procesando
--   movimientos_puntos:      idx_movimientos_puntos_usuario
SELECT tabla, indexname, indexdef
FROM _diag_cubo_indices
ORDER BY tabla, indexname;

-- ── R8. Duplicados — pago_eventos_pendientes (pedido_id, tipo_evento) ───────
-- Resultado esperado: una fila con tipo_evento = '(sin duplicados)', repeticiones = 0
-- Si hay filas reales, BLOQUE 3 bloqueará la migración al crear UNIQUE.
SELECT pedido_id, tipo_evento, repeticiones
FROM _diag_cubo_dup_pep
ORDER BY repeticiones DESC NULLS LAST;

-- ── R9. Duplicados — movimientos_puntos (pedido_id, concepto) ───────────────
-- Resultado esperado: una fila con concepto = '(sin duplicados)', repeticiones = 0
SELECT pedido_id, concepto, repeticiones
FROM _diag_cubo_dup_mp
ORDER BY repeticiones DESC NULLS LAST;

-- ── R10. Seguridad: RLS y grants ────────────────────────────────────────────
SELECT tabla, rls_habilitado, rol, privilegio
FROM _diag_cubo_seguridad
ORDER BY tabla, rol;

-- ── R11. Políticas RLS ──────────────────────────────────────────────────────
SELECT tabla, policyname, permissive, roles, cmd
FROM _diag_cubo_politicas
ORDER BY tabla, policyname;

-- ── R12. Diagnóstico PGRST205 ───────────────────────────────────────────────
-- Explica por qué cada tabla arrojó PGRST205 en el REST API.
-- Sin JOIN a _diag_cubo_seguridad (cardinalidad N → filas duplicadas).
-- rls_habilitado se obtiene directamente de pg_class.
SELECT
  e.tabla,
  e.existe                                                     AS existe_en_postgres,
  (SELECT pc.relrowsecurity
   FROM pg_class pc
   JOIN pg_namespace n ON n.oid = pc.relnamespace
   WHERE n.nspname = 'public' AND pc.relname = e.tabla AND pc.relkind = 'r') AS rls_habilitado,
  CASE
    WHEN NOT e.existe
      THEN '1. TABLA NO EXISTE en PostgreSQL — causa directa del PGRST205'
    WHEN NOT EXISTS (
      SELECT 1 FROM _diag_cubo_seguridad sg
      WHERE sg.tabla = e.tabla
        AND sg.rol IN ('anon', 'authenticated', 'service_role')
        AND sg.privilegio IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE',
                              'TRUNCATE', 'REFERENCES', 'TRIGGER')
    )
      THEN '2. TABLA EXISTE pero sin grants a roles PostgREST '
        || '(anon/authenticated/service_role) — causa probable del PGRST205'
    ELSE
      '3. TABLA EXISTE con grants — PGRST205 posiblemente por caché no '
        || 'actualizada (NOTIFY pgrst.reload o reinicio del servicio)'
  END                                                          AS diagnostico_pgrst205
FROM _diag_cubo_existencia e
ORDER BY e.tabla;
