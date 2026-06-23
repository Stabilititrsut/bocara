-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Introspección del esquema real (v4)                          ║
-- ║  Solo lectura. No modifica ningún dato.                                ║
-- ║                                                                        ║
-- ║  Ejecutar en Supabase → SQL Editor ANTES de cubo-pago-schema.sql v4   ║
-- ║  para confirmar el estado real del esquema desplegado.                 ║
-- ║                                                                        ║
-- ║  Resultado esperado antes de ejecutar la migración:                   ║
-- ║    · consultas 1-6  → esquema base existente (pedidos, bolsas, etc.)  ║
-- ║    · consultas 7-9  → columnas Cubo: deben estar AUSENTES              ║
-- ║    · consultas 10-13 → tablas nuevas: deben estar AUSENTES             ║
-- ║    · consulta 14   → clave_idempotencia: debe estar AUSENTE            ║
-- ║    · consulta 15   → duplicados token: debe devolver 0 filas           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN A — ESQUEMA BASE (debe existir antes de la migración)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Tablas base requeridas ────────────────────────────────────────────────
-- Esperado: pedidos, bolsas, usuarios, configuracion, notificaciones, negocios
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pedidos','bolsas','usuarios','configuracion','notificaciones','negocios','liquidaciones')
ORDER BY table_name;

-- ── 2. Columnas de pedidos ───────────────────────────────────────────────────
-- Confirmar columnas base antes de agregar las de Cubo.
-- Requeridas por la RPC: id, estado_pago, bolsa_id, usuario_id,
--   negocio_id, codigo_recogida, tipo_entrega, total
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
ORDER BY ordinal_position;

-- ── 3. bolsas.cantidad_disponible ───────────────────────────────────────────
-- Requerida por la RPC para descontar inventario.
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'bolsas'
    AND column_name = 'cantidad_disponible'
) AS bolsas_tiene_cantidad_disponible;

-- ── 4. Función sumar_puntos (base) ──────────────────────────────────────────
-- Debe existir antes de la migración (schema_fix.sql).
-- La migración agrega SET search_path y crea sumar_puntos_idempotente.
SELECT
  p.proname                                                  AS nombre,
  pg_catalog.pg_get_function_identity_arguments(p.oid)      AS argumentos,
  p.prosecdef                                                AS security_definer,
  p.proconfig                                                AS search_path_config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'sumar_puntos';

-- ── 5. Todas las funciones del esquema public ────────────────────────────────
SELECT
  p.proname                                                  AS nombre,
  pg_catalog.pg_get_function_identity_arguments(p.oid)      AS argumentos,
  p.prosecdef                                                AS security_definer,
  p.proconfig                                                AS search_path_config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;

-- ── 6. Columnas de notificaciones ───────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'notificaciones'
ORDER BY ordinal_position;


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN B — COLUMNAS CUBO EN PEDIDOS
-- Esperado antes de migración: todas AUSENTES
-- Esperado después de migración: todas PRESENTES
-- ════════════════════════════════════════════════════════════════════════════

-- ── 7. Columnas Cubo en pedidos ──────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name IN (
    'cubo_identifier',
    'cubo_authorization_code',
    'pagado_en',
    'cubo_payment_intent_token',
    'monto_esperado_centavos',
    'cubo_reference_id'
  )
ORDER BY column_name;
-- 0 filas = migración pendiente. 6 filas = migración ejecutada.

-- ── 8. pedidos.cantidad ──────────────────────────────────────────────────────
-- PRECHECK: debe existir antes de la migración (verificado: ya existe en producción).
-- Significado real: cantidad del PRIMER ítem del carrito (no la suma total).
-- Para pedidos multi-ítem, usar SUM(pedido_items.cantidad) en lugar de pedidos.cantidad.
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'pedidos'
    AND column_name = 'cantidad'
) AS pedidos_tiene_cantidad;
-- Esperado ANTES de migración: true (ya existe — precheck fallará si es false)
-- Esperado DESPUÉS de migración: true (migración no la toca)

-- ── 9. pedido_items ──────────────────────────────────────────────────────────
-- PRECHECK: debe existir antes de la migración (verificado: ya existe con 36 filas).
-- La migración principal NO la crea — es un precheck que la verifica.
-- La RPC confirmar_pago_cubo v5 la usa como única fuente de inventario.
SELECT EXISTS(
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'pedido_items'
) AS pedido_items_existe;
-- Esperado ANTES de migración: true (ya existe — precheck fallará si es false)
-- Esperado DESPUÉS de migración: true (migración no la toca)


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN C — TABLAS NUEVAS (creadas por la migración)
-- Esperado antes de migración: AUSENTES
-- Esperado después de migración: PRESENTES con esquema correcto
-- ════════════════════════════════════════════════════════════════════════════

-- ── 10. pago_eventos_pendientes ──────────────────────────────────────────────
-- Columnas clave post-migración: estado (TEXT), procesando_desde (TIMESTAMPTZ)
-- Si existe sin columna estado = esquema anterior (v3); la migración lo recreará.
SELECT EXISTS(
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
) AS pago_eventos_existe;

SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
ORDER BY ordinal_position;

-- Verificación específica de columnas v4:
SELECT
  EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pago_eventos_pendientes'
      AND column_name='estado')      AS tiene_estado,
  EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pago_eventos_pendientes'
      AND column_name='procesando_desde') AS tiene_procesando_desde,
  EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pago_eventos_pendientes'
      AND column_name='completado')   AS tiene_completado_bool;
-- Esperado post-migración: tiene_estado=true, tiene_procesando_desde=true, tiene_completado_bool=false

-- ── 11. movimientos_puntos ───────────────────────────────────────────────────
SELECT EXISTS(
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
) AS movimientos_puntos_existe;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
ORDER BY ordinal_position;

-- ── 12. UNIQUE(pedido_id, concepto) en movimientos_puntos ───────────────────
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
  AND constraint_type = 'UNIQUE';
-- Esperado post-migración: 1 fila con la constraint UNIQUE

-- ── 13. CHECK constraint en pago_eventos_pendientes ──────────────────────────
SELECT constraint_name, check_clause
FROM information_schema.check_constraints cc
JOIN information_schema.table_constraints tc
  ON cc.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public' AND tc.table_name = 'pago_eventos_pendientes';
-- Esperado: check (estado IN ('pendiente','procesando','completado','fallido'))


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN D — IDEMPOTENCIA DE NOTIFICACIONES (BLOQUE 2 — obligatorio)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 14. notificaciones.clave_idempotencia ───────────────────────────────────
-- OBLIGATORIO para eventos Cubo. Sin esta columna, los eventos
-- notificar_pago_cliente y notificar_pago_restaurante no pueden completarse.
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'notificaciones'
    AND column_name = 'clave_idempotencia'
) AS notificaciones_tiene_clave_idempotencia;
-- Pre-migración: false. Post-migración: true (BLOQUE 2 lo agrega).

-- Verificar también el índice único parcial:
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'notificaciones'
  AND indexname = 'idx_notificaciones_clave_idempotencia';
-- 0 filas = migración pendiente. 1 fila = migración ejecutada.


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN E — PRECONDICIONES PARA ÍNDICE UNIQUE
-- ════════════════════════════════════════════════════════════════════════════

-- ── 15. Duplicados en cubo_payment_intent_token ──────────────────────────────
-- La migración crea un UNIQUE INDEX en este campo.
-- Si hay duplicados, el índice fallará. Resolver antes de ejecutar.
-- Resultado esperado: 0 filas.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pedidos'
      AND column_name = 'cubo_payment_intent_token'
  ) THEN
    RAISE NOTICE 'cubo_payment_intent_token existe — verificando duplicados...';
  ELSE
    RAISE NOTICE 'cubo_payment_intent_token no existe aún — sin duplicados posibles';
  END IF;
END $$;

SELECT
  cubo_payment_intent_token,
  COUNT(*) AS veces,
  array_agg(id ORDER BY id) AS pedido_ids
FROM pedidos
WHERE cubo_payment_intent_token IS NOT NULL
GROUP BY cubo_payment_intent_token
HAVING COUNT(*) > 1;
-- Sin filas = seguro crear el índice UNIQUE.


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN F — ÍNDICES Y PERMISOS (verificación post-migración)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 16. Todos los índices de las tablas de interés ──────────────────────────
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'pedidos', 'notificaciones',
    'pago_eventos_pendientes', 'movimientos_puntos'
  )
ORDER BY tablename, indexname;
-- Post-migración esperado (parcial):
--   pedidos:                   idx_pedidos_cubo_token_unique (UNIQUE, parcial)
--   notificaciones:            idx_notificaciones_clave_idempotencia (UNIQUE, parcial)
--   pago_eventos_pendientes:   idx_pago_eventos_pendiente (WHERE estado='pendiente')
--                              idx_pago_eventos_procesando (WHERE estado='procesando')
--   movimientos_puntos:        idx_movimientos_puntos_usuario

-- ── 17. Permisos de funciones Cubo ──────────────────────────────────────────
-- Post-migración esperado: solo service_role tiene EXECUTE.
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN (
    'confirmar_pago_cubo',
    'sumar_puntos',
    'sumar_puntos_idempotente'
  )
ORDER BY routine_name, grantee;
-- Filas con grantee=PUBLIC o anon o authenticated → REVOKE no se ejecutó.

-- ── 18. configuracion: puntos_por_pedido ────────────────────────────────────
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';
-- Esperado post-migración: 1 fila con valor '10'
