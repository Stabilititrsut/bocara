-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Consultas de introspección del esquema real                  ║
-- ║  Solo lectura. No modifica ningún dato.                                ║
-- ║  Ejecutar en Supabase → SQL Editor ANTES de cubo-pago-schema.sql      ║
-- ║  para confirmar el estado real del esquema desplegado.                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. Columnas reales de pedidos ────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  character_maximum_length,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
ORDER BY ordinal_position;

-- ── 2. Columnas reales de bolsas ─────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'bolsas'
ORDER BY ordinal_position;

-- ── 3. ¿Existe pedido_items? Columnas si existe ──────────────────────────────
SELECT EXISTS(
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'pedido_items'
) AS pedido_items_existe;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedido_items'
ORDER BY ordinal_position;

-- ── 4. ¿Existe la columna cantidad en pedidos? ───────────────────────────────
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'pedidos'
    AND column_name = 'cantidad'
) AS pedidos_tiene_cantidad;

-- ── 5. Restricciones y FK de tablas clave ────────────────────────────────────
SELECT
  tc.constraint_name,
  tc.constraint_type,
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS tabla_referenciada,
  ccu.column_name AS columna_referenciada,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema   = kcu.table_schema
LEFT JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
LEFT JOIN information_schema.constraint_column_usage ccu
  ON rc.unique_constraint_name = ccu.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.table_name IN ('pedidos','bolsas','pedido_items','notificaciones','liquidaciones','usuarios')
  AND tc.constraint_type IN ('FOREIGN KEY','PRIMARY KEY','UNIQUE','CHECK')
ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;

-- ── 6. Funciones existentes en el esquema public ─────────────────────────────
SELECT
  p.proname                                                     AS nombre,
  pg_catalog.pg_get_function_identity_arguments(p.oid)         AS argumentos,
  l.lanname                                                     AS lenguaje,
  p.prosecdef                                                   AS security_definer,
  p.proconfig                                                   AS search_path_config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language  l ON l.oid = p.prolang
WHERE n.nspname = 'public'
ORDER BY p.proname;

-- ── 7. Estructura de notificaciones ─────────────────────────────────────────
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'notificaciones'
ORDER BY ordinal_position;

-- ── 8. ¿Tiene notificaciones la columna clave_idempotencia? ──────────────────
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'notificaciones'
    AND column_name = 'clave_idempotencia'
) AS notificaciones_tiene_clave_idempotencia;

-- ── 9. Estructura de liquidaciones ──────────────────────────────────────────
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'liquidaciones'
ORDER BY ordinal_position;

-- ── 10. Índices existentes en tablas de interés ──────────────────────────────
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'pedidos','bolsas','pedido_items','notificaciones',
    'usuarios','movimientos_puntos','pago_eventos_pendientes'
  )
ORDER BY tablename, indexname;

-- ── 11. Permisos actuales de funciones Cubo ──────────────────────────────────
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN ('confirmar_pago_cubo','sumar_puntos','sumar_puntos_idempotente')
ORDER BY routine_name, grantee;

-- ── 12. Duplicados en cubo_payment_intent_token (si columna existe) ───────────
-- Resultado esperado: 0 filas. Si devuelve filas, resolver antes de crear índice UNIQUE.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedidos'
      AND column_name = 'cubo_payment_intent_token'
  ) THEN
    RAISE NOTICE '--- Duplicados en cubo_payment_intent_token ---';
  ELSE
    RAISE NOTICE 'cubo_payment_intent_token no existe aún — sin duplicados';
  END IF;
END $$;

SELECT cubo_payment_intent_token, COUNT(*) AS veces, array_agg(id) AS pedido_ids
FROM pedidos
WHERE cubo_payment_intent_token IS NOT NULL
GROUP BY cubo_payment_intent_token
HAVING COUNT(*) > 1;
-- Sin filas = seguro crear índice UNIQUE.
