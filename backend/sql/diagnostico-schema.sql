-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Diagnóstico del modelo híbrido pedido_items                  ║
-- ║                                                                        ║
-- ║  SOLO LECTURA. No modifica ningún dato.                                ║
-- ║                                                                        ║
-- ║  Ejecutar en Supabase → SQL Editor para entender el estado real del   ║
-- ║  modelo de pedidos antes de ejecutar cubo-pago-schema.sql v5.         ║
-- ║                                                                        ║
-- ║  Contexto (jun 2026):                                                  ║
-- ║  · pedido_items: 36 filas, 8 pedidos con múltiples bolsas             ║
-- ║  · 15 pedidos sin pedido_items (legacy: efectivo/PayU)                ║
-- ║  · pedidos.cantidad = primera bolsa del carrito (no suma total)       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- 1. Resumen general del modelo híbrido
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  COUNT(*)                                                    AS total_pedidos,
  COUNT(*) FILTER (WHERE pi.pedido_id IS NOT NULL)           AS con_pedido_items,
  COUNT(*) FILTER (WHERE pi.pedido_id IS NULL)               AS sin_pedido_items,
  COUNT(DISTINCT pi.pedido_id)
    FILTER (WHERE cnt.n_bolsas > 1)                          AS multiitem_varios_bolsas,
  MIN(p.created_at)                                          AS pedido_mas_antiguo,
  MAX(p.created_at)                                          AS pedido_mas_reciente
FROM pedidos p
LEFT JOIN (
  SELECT pedido_id FROM pedido_items GROUP BY pedido_id
) pi ON pi.pedido_id = p.id
LEFT JOIN (
  SELECT pedido_id, COUNT(DISTINCT bolsa_id) AS n_bolsas
  FROM pedido_items GROUP BY pedido_id
) cnt ON cnt.pedido_id = p.id;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. Esquema real de pedido_items (columnas exactas en producción)
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  column_name,
  data_type,
  character_maximum_length,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedido_items'
ORDER BY ordinal_position;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. Naturaleza de los 15 pedidos sin pedido_items
--    (estado, estado_pago, antigüedad, tipo_entrega)
--    Hipótesis: son pedidos de efectivo (POST /api/pedidos/crear)
--               o PayU (POST /api/pagos/crear-intent)
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  p.id,
  p.estado,
  p.estado_pago,
  p.tipo_entrega,
  p.total,
  p.created_at,
  NOW() - p.created_at                  AS antiguedad,
  p.bolsa_id IS NOT NULL                AS tiene_bolsa_id,
  p.cantidad                            AS pedidos_cantidad,
  p.cubo_payment_intent_token IS NOT NULL AS tiene_token_cubo
FROM pedidos p
WHERE NOT EXISTS (
  SELECT 1 FROM pedido_items pi WHERE pi.pedido_id = p.id
)
ORDER BY p.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. Últimos 20 pedidos con conteo de items
--    ¿Los pedidos recientes siempre tienen pedido_items?
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  p.id,
  p.estado_pago,
  p.estado,
  p.created_at,
  COUNT(pi.id)                          AS n_items,
  COUNT(DISTINCT pi.bolsa_id)           AS n_bolsas_distintas,
  p.cantidad                            AS pedidos_cantidad,
  COALESCE(SUM(pi.cantidad), 0)         AS suma_items_cantidad,
  p.cubo_payment_intent_token IS NOT NULL AS es_cubo
FROM pedidos p
LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.estado_pago, p.estado, p.created_at, p.cantidad,
         p.cubo_payment_intent_token
ORDER BY p.created_at DESC
LIMIT 20;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. Pedidos con items donde pedidos.cantidad != SUM(pedido_items.cantidad)
--    Confirma que pedidos.cantidad es solo la primera bolsa, no la suma total.
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  p.id,
  p.cantidad                    AS pedidos_cantidad,
  SUM(pi.cantidad)              AS suma_items,
  p.cantidad - SUM(pi.cantidad) AS diferencia,
  COUNT(pi.id)                  AS n_filas_items,
  COUNT(DISTINCT pi.bolsa_id)   AS n_bolsas
FROM pedidos p
JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.cantidad
HAVING p.cantidad IS DISTINCT FROM SUM(pi.cantidad)
ORDER BY diferencia;

-- Total de discrepancias (debería ser ~23 según introspección)
SELECT COUNT(*) AS total_discrepancias
FROM (
  SELECT p.id
  FROM pedidos p
  JOIN pedido_items pi ON pi.pedido_id = p.id
  GROUP BY p.id, p.cantidad
  HAVING p.cantidad IS DISTINCT FROM SUM(pi.cantidad)
) t;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. ¿pedidos.bolsa_id coincide con algún item?
--    Hipótesis: siempre coincide (es bolsas[0] del carrito, primer ítem).
-- ════════════════════════════════════════════════════════════════════════════

-- Pedidos con items donde bolsa_id SÍ coincide con algún item (esperado: todos)
SELECT COUNT(*) AS pedidos_bolsa_id_en_items
FROM pedidos p
WHERE EXISTS (SELECT 1 FROM pedido_items pi WHERE pi.pedido_id = p.id)
  AND EXISTS (SELECT 1 FROM pedido_items pi
              WHERE pi.pedido_id = p.id AND pi.bolsa_id = p.bolsa_id);

-- Pedidos con items donde bolsa_id NO coincide con ningún item (esperado: 0)
SELECT
  p.id,
  p.bolsa_id                 AS pedidos_bolsa_id,
  array_agg(DISTINCT pi.bolsa_id ORDER BY pi.bolsa_id) AS item_bolsa_ids
FROM pedidos p
JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.bolsa_id
HAVING p.bolsa_id NOT IN (
  SELECT pi2.bolsa_id FROM pedido_items pi2 WHERE pi2.pedido_id = p.id
)
ORDER BY p.id;
-- 0 filas = pedidos.bolsa_id siempre es el primer ítem (comportamiento esperado)


-- ════════════════════════════════════════════════════════════════════════════
-- 7. Pedidos multi-ítem con múltiples bolsas distintas
--    ¿Cuántas bolsas distintas por pedido?
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  p.id,
  p.estado_pago,
  p.created_at,
  COUNT(DISTINCT pi.bolsa_id)   AS n_bolsas_distintas,
  COUNT(pi.id)                  AS n_filas_items,
  SUM(pi.cantidad)              AS suma_cantidades,
  array_agg(pi.bolsa_id ORDER BY pi.bolsa_id) AS bolsa_ids
FROM pedidos p
JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.estado_pago, p.created_at
HAVING COUNT(DISTINCT pi.bolsa_id) > 1
ORDER BY n_bolsas_distintas DESC, p.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- 8. Items con la misma bolsa repetida en el mismo pedido
--    (misma bolsa, mismo pedido — requiere agrupación en la RPC)
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  pi.pedido_id,
  pi.bolsa_id,
  COUNT(*)          AS n_filas,
  SUM(pi.cantidad)  AS cantidad_total
FROM pedido_items pi
GROUP BY pi.pedido_id, pi.bolsa_id
HAVING COUNT(*) > 1
ORDER BY pi.pedido_id, pi.bolsa_id;
-- Si hay filas: la RPC debe agrupar SUM(cantidad) por bolsa_id antes de hacer FOR UPDATE


-- ════════════════════════════════════════════════════════════════════════════
-- 9. Consistencia stock: bolsas con items de pedidos pendientes
--    ¿Las bolsas tienen stock suficiente para los pedidos Cubo pendientes?
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  b.id                                                   AS bolsa_id,
  b.nombre,
  b.cantidad_disponible,
  COALESCE(SUM(pi.cantidad)
    FILTER (WHERE p.estado_pago IN ('pendiente')), 0)   AS reservado_items_pendientes,
  b.cantidad_disponible - COALESCE(SUM(pi.cantidad)
    FILTER (WHERE p.estado_pago IN ('pendiente')), 0)   AS stock_real_disponible
FROM bolsas b
LEFT JOIN pedido_items pi ON pi.bolsa_id = b.id
LEFT JOIN pedidos p ON p.id = pi.pedido_id
GROUP BY b.id, b.nombre, b.cantidad_disponible
HAVING COALESCE(SUM(pi.cantidad) FILTER (WHERE p.estado_pago = 'pendiente'), 0) > 0
ORDER BY stock_real_disponible ASC;


-- ════════════════════════════════════════════════════════════════════════════
-- 10. Tokens Cubo y montos — integridad de datos para la migración
--     ¿Hay pedidos con token pero sin monto? ¿Duplicados?
-- ════════════════════════════════════════════════════════════════════════════

-- Pedidos con token Cubo pero sin monto_esperado_centavos
SELECT id, cubo_payment_intent_token, monto_esperado_centavos, estado_pago, created_at
FROM pedidos
WHERE cubo_payment_intent_token IS NOT NULL
  AND monto_esperado_centavos IS NULL
ORDER BY created_at DESC;

-- Tokens duplicados (no debería haber ninguno — precheck de la migración lo verifica)
SELECT
  cubo_payment_intent_token,
  COUNT(*) AS veces,
  array_agg(id ORDER BY id) AS pedido_ids
FROM pedidos
WHERE cubo_payment_intent_token IS NOT NULL
GROUP BY cubo_payment_intent_token
HAVING COUNT(*) > 1;
-- 0 filas = seguro ejecutar la migración (BLOQUE 5 creará el índice UNIQUE)
