-- Verificación de solo lectura (ningún UPDATE/DELETE) para correr en el SQL
-- Editor de Supabase DESPUÉS de aplicar:
--   1. 202609161200_finanzas_snapshot_y_eventos_dominio.sql
--   2. 202609171200_ubicacion_usuario.sql
-- Cada bloque corresponde a un punto de la lista de verificación del reporte.

-- 1-3. Columnas nuevas en pedidos
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pedidos'
  AND column_name IN ('snapshot_financiero', 'tipo_financiero', 'porcentaje_comision_aplicado');
-- Esperado: 3 filas.

-- 4-6. Tabla eventos_dominio, UNIQUE de idempotency_key, índices
SELECT to_regclass('public.eventos_dominio') AS tabla_existe;
-- Esperado: no NULL.

SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'eventos_dominio';
-- Esperado: eventos_dominio_idempotency_key_uq (UNIQUE) y eventos_dominio_pendientes_idx.

-- 7. Comisión de promoción configurada
SELECT clave, valor FROM configuracion WHERE clave = 'comision_promocion_porcentaje';
-- Esperado: 1 fila, valor = '20'.

-- Columnas nuevas en usuarios (persistencia de ubicación — cierre de Sábado)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'usuarios'
  AND column_name IN ('latitud', 'longitud', 'ubicacion_actualizada_at');
-- Esperado: 3 filas.

-- Constraints NOT VALID (deben existir, y no fallar aunque no se hayan
-- validado contra filas existentes — todas son NULL hoy)
SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'pedidos_tipo_financiero_valido', 'usuarios_latitud_rango', 'usuarios_longitud_rango'
);
-- Esperado: 3 filas, convalidated puede ser 'f' (NOT VALID) — es intencional.

-- ── Validación real de finanzas (Sección 7 del pedido) ──────────────────────
-- Después de crear un pedido de merma y uno de promoción en staging:
SELECT id, tipo_financiero, porcentaje_comision_aplicado,
       snapshot_financiero->>'subtotal_productos'      AS subtotal_productos,
       snapshot_financiero->>'comision_bocara'          AS comision_bocara,
       snapshot_financiero->>'comision_pasarela'        AS comision_pasarela,
       snapshot_financiero->>'propina'                  AS propina,
       snapshot_financiero->>'costo_envio'               AS costo_envio,
       snapshot_financiero->>'total_cliente'             AS total_cliente,
       snapshot_financiero->>'monto_neto_restaurante'    AS monto_neto_restaurante,
       created_at
FROM pedidos
WHERE snapshot_financiero IS NOT NULL
ORDER BY created_at DESC
LIMIT 10;
-- Esperado: merma → 0.25, promoción → 0.20; total_cliente = subtotal + envio + propina + comision_pasarela.

-- ── Validación real de eventos (Sección 8 del pedido) ───────────────────────
SELECT event_type, aggregate_id, idempotency_key, status, attempts, processed_at, created_at
FROM eventos_dominio
ORDER BY created_at DESC
LIMIT 50;
-- Esperado por cada acción real (checkout, webhook, cambio de estado,
-- cancelación, expiración de reserva, moderación de bolsa): UNA fila por
-- evento de negocio, sin duplicados aunque el webhook o el estado se hayan
-- reenviado/repetido — la columna idempotency_key es UNIQUE, así que un
-- reintento nunca produce una segunda fila lógica del mismo evento.

-- Confirmar cero duplicados lógicos (no debería devolver filas):
SELECT idempotency_key, COUNT(*) FROM eventos_dominio
GROUP BY idempotency_key HAVING COUNT(*) > 1;
