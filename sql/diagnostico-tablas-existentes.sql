-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Diagnóstico de tablas existentes pre-migración v5            ║
-- ║                                                                        ║
-- ║  Solo lectura. No modifica ningún dato.                                ║
-- ║                                                                        ║
-- ║  Ejecutar en Supabase → SQL Editor ANTES de cubo-pago-schema.sql v5   ║
-- ║  para confirmar la estructura real de las dos tablas que ya existen.   ║
-- ║                                                                        ║
-- ║  Contexto (introspección jun 2026):                                    ║
-- ║  · pago_eventos_pendientes: existe (migración previa)                  ║
-- ║  · movimientos_puntos: existe (migración previa)                       ║
-- ║  · confirmar_pago_cubo, sumar_puntos_idempotente: ausentes             ║
-- ║  · notificaciones.clave_idempotencia: ausente                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN A — pago_eventos_pendientes
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. Columnas actuales ────────────────────────────────────────────────────
-- Requeridas: id, pedido_id, tipo_evento, payload, estado, intentos,
--             procesando_desde, ultimo_intento_at, error_ultimo, created_at, completado_at
-- Columnas ausentes → BLOQUE 3 las agrega con ADD COLUMN IF NOT EXISTS.
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pago_eventos_pendientes'
ORDER BY ordinal_position;

-- ── A2. Constraints actuales ────────────────────────────────────────────────
-- Requeridos:
--   · UNIQUE(pedido_id, tipo_evento)
--   · CHECK (estado IN ('pendiente','procesando','completado','fallido'))
--   · PRIMARY KEY(id)
--   · FOREIGN KEY pedido_id → pedidos(id)
SELECT
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON  cc.constraint_name   = tc.constraint_name
  AND cc.constraint_schema = tc.constraint_schema
WHERE tc.table_schema = 'public' AND tc.table_name = 'pago_eventos_pendientes'
ORDER BY tc.constraint_type, tc.constraint_name;

-- ── A3. Claves foráneas ─────────────────────────────────────────────────────
SELECT
  kcu.column_name,
  ccu.table_name   AS references_table,
  ccu.column_name  AS references_column,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
JOIN information_schema.key_column_usage ccu
  ON  ccu.constraint_name = rc.unique_constraint_name
  AND ccu.table_schema    = tc.table_schema
WHERE tc.table_schema = 'public' AND tc.table_name = 'pago_eventos_pendientes'
  AND tc.constraint_type = 'FOREIGN KEY';

-- ── A4. Índices actuales ────────────────────────────────────────────────────
-- Requeridos post-migración:
--   idx_pago_eventos_pendiente   (WHERE estado = 'pendiente')
--   idx_pago_eventos_procesando  (WHERE estado = 'procesando')
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'pago_eventos_pendientes'
ORDER BY indexname;

-- ── A5. Conteo de filas ─────────────────────────────────────────────────────
-- 0 filas → si falta columna estado, DROP es seguro.
-- ≥1 fila y falta estado → BLOQUE 3 lanzará EXCEPTION: intervención manual requerida.
SELECT COUNT(*) AS filas_pago_eventos_pendientes FROM pago_eventos_pendientes;

-- ── A6. Duplicados (pedido_id, tipo_evento) ─────────────────────────────────
-- Resultado esperado: 0 filas.
-- ≥1 fila → BLOQUE 3 bloqueará la migración antes de crear UNIQUE.
SELECT
  pedido_id,
  tipo_evento,
  COUNT(*) AS veces,
  array_agg(id ORDER BY id) AS evento_ids
FROM pago_eventos_pendientes
GROUP BY pedido_id, tipo_evento
HAVING COUNT(*) > 1
ORDER BY veces DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN B — movimientos_puntos
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. Columnas actuales ────────────────────────────────────────────────────
-- Requeridas: id, usuario_id, pedido_id, concepto, puntos, created_at
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
ORDER BY ordinal_position;

-- ── B2. Constraints actuales ────────────────────────────────────────────────
-- Requeridos:
--   · UNIQUE(pedido_id, concepto)
--   · CHECK (puntos > 0)
--   · PRIMARY KEY(id)
--   · FOREIGN KEY usuario_id → usuarios(id)
--   · FOREIGN KEY pedido_id  → pedidos(id)
SELECT
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON  cc.constraint_name   = tc.constraint_name
  AND cc.constraint_schema = tc.constraint_schema
WHERE tc.table_schema = 'public' AND tc.table_name = 'movimientos_puntos'
ORDER BY tc.constraint_type, tc.constraint_name;

-- ── B3. Claves foráneas ─────────────────────────────────────────────────────
SELECT
  kcu.column_name,
  ccu.table_name   AS references_table,
  ccu.column_name  AS references_column,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
JOIN information_schema.key_column_usage ccu
  ON  ccu.constraint_name = rc.unique_constraint_name
  AND ccu.table_schema    = tc.table_schema
WHERE tc.table_schema = 'public' AND tc.table_name = 'movimientos_puntos'
  AND tc.constraint_type = 'FOREIGN KEY';

-- ── B4. Índices actuales ────────────────────────────────────────────────────
-- Requerido post-migración: idx_movimientos_puntos_usuario
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'movimientos_puntos'
ORDER BY indexname;

-- ── B5. Conteo de filas ─────────────────────────────────────────────────────
SELECT COUNT(*) AS filas_movimientos_puntos FROM movimientos_puntos;

-- ── B6. Duplicados (pedido_id, concepto) ────────────────────────────────────
-- Resultado esperado: 0 filas.
-- ≥1 fila → BLOQUE 4 bloqueará la migración antes de crear UNIQUE.
SELECT
  pedido_id,
  concepto,
  COUNT(*) AS veces,
  array_agg(id ORDER BY id) AS movimiento_ids
FROM movimientos_puntos
GROUP BY pedido_id, concepto
HAVING COUNT(*) > 1
ORDER BY veces DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN C — Resumen de compatibilidad con migración v5
-- ════════════════════════════════════════════════════════════════════════════

-- ── C1. ¿Qué hace la migración con cada tabla? ──────────────────────────────
-- Esta consulta NO ejecuta nada — solo muestra el estado esperado como guía.
SELECT
  'pago_eventos_pendientes'  AS tabla,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='pago_eventos_pendientes')
      THEN 'A: no existe → CREATE TABLE'
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='pago_eventos_pendientes'
                   AND column_name='estado')
      THEN 'B: existe con estado → ADD COLUMN IF NOT EXISTS + DO block (seguro)'
    WHEN (SELECT COUNT(*) FROM pago_eventos_pendientes) = 0
      THEN 'C: existe sin estado, 0 filas → DROP seguro + CREATE TABLE'
    ELSE 'D: existe sin estado, ≥1 fila → EXCEPTION: intervención manual requerida'
  END AS accion_bloque3

UNION ALL

SELECT
  'movimientos_puntos'       AS tabla,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='movimientos_puntos')
      THEN 'no existe → CREATE TABLE'
    ELSE 'existe → CREATE TABLE IF NOT EXISTS (no-op) + ADD COLUMN IF NOT EXISTS + DO block'
  END AS accion_bloque3;
