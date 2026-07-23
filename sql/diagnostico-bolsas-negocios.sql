-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Diagnóstico de esquema real: bolsas, negocios,                ║
-- ║           negocio_cambios_pendientes                                    ║
-- ║                                                                          ║
-- ║  SOLO LECTURA. No modifica ningún dato ni estructura.                    ║
-- ║                                                                          ║
-- ║  Motivo: confirmar qué columnas de backend/scripts/migrations.sql       ║
-- ║  realmente llegaron a producción, ya que schema_fix.sql (el único       ║
-- ║  archivo con evidencia de haberse ejecutado manualmente) no las         ║
-- ║  incluye. peso_kg y categoria_alimento ya causan errores confirmados    ║
-- ║  en producción ("column does not exist" / "Could not find column in    ║
-- ║  schema cache") — este script revisa si hay más columnas en el mismo   ║
-- ║  caso antes de tocar código.                                            ║
-- ║                                                                          ║
-- ║  Ejecutar en: Supabase Dashboard → SQL Editor (proyecto tbbjrethcgjxk...)║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- R1. Columnas reales de bolsas, negocios y negocio_cambios_pendientes
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('bolsas', 'negocios', 'negocio_cambios_pendientes',
                      'usuarios', 'pedidos', 'notificaciones', 'configuracion',
                      'liquidaciones', 'factores_co2_alimentos', 'resenas')
ORDER BY table_name, ordinal_position;


-- ════════════════════════════════════════════════════════════════════════════
-- R2. Chequeo puntual de las columnas que el código de routes/bolsas.js,
--     routes/negocios.js y routes/admin.js asume que existen.
--     existe = false ⇒ columna referenciada en código pero ausente en BD real.
-- ════════════════════════════════════════════════════════════════════════════
WITH esperadas (tabla, columna) AS (
  VALUES
    -- bolsas — usadas en routes/bolsas.js y routes/admin.js
    ('bolsas','peso_kg'), ('bolsas','categoria_alimento'), ('bolsas','estado_aprobacion'),
    ('bolsas','motivo_rechazo'), ('bolsas','fecha_caducidad'), ('bolsas','categoria_menu'),
    ('bolsas','es_tiempo_limitado'), ('bolsas','es_promocion'), ('bolsas','es_descuento'),
    ('bolsas','es_destacado'), ('bolsas','es_mas_vendido'), ('bolsas','es_precio_bajo'),
    ('bolsas','co2_salvado_kg'), ('bolsas','peso_estimado_kg'), ('bolsas','activa'),
    ('bolsas','creado_en'),
    -- negocios — usadas en routes/negocios.js y routes/admin.js
    ('negocios','estado_verificacion'), ('negocios','nit'), ('negocios','dpi'),
    ('negocios','datos_bancarios'), ('negocios','horario_atencion'), ('negocios','motivo_rechazo'),
    ('negocios','dpi_foto_url'), ('negocios','imagen_url'), ('negocios','logo_url'),
    ('negocios','punto_referencia'), ('negocios','google_maps_url'), ('negocios','waze_url'),
    ('negocios','verificado'), ('negocios','activo'), ('negocios','propietario_id'),
    -- negocio_cambios_pendientes — usada en el flujo de "Mi negocio"
    ('negocio_cambios_pendientes','usuario_id'), ('negocio_cambios_pendientes','cambios'),
    ('negocio_cambios_pendientes','datos_propuestos'), ('negocio_cambios_pendientes','estado'),
    ('negocio_cambios_pendientes','motivo_rechazo'),
    -- pedidos — usadas en routes/negocios.js (ganancias) y routes/admin.js
    ('pedidos','precio_bolsa'), ('pedidos','comision_bocara'), ('pedidos','monto_neto_restaurante'),
    ('pedidos','codigo_recogida')
)
SELECT
  e.tabla,
  e.columna,
  (c.column_name IS NOT NULL) AS existe,
  c.data_type,
  c.is_nullable
FROM esperadas e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = e.tabla AND c.column_name = e.columna
ORDER BY existe ASC, e.tabla, e.columna;


-- ════════════════════════════════════════════════════════════════════════════
-- R3. Tablas completas esperadas por el código — ¿existen?
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  t.tabla,
  to_regclass('public.' || t.tabla) IS NOT NULL AS existe
FROM (VALUES
  ('bolsas'), ('negocios'), ('usuarios'), ('pedidos'),
  ('negocio_cambios_pendientes'), ('liquidaciones'), ('configuracion'),
  ('factores_co2_alimentos'), ('resenas'), ('notificaciones'), ('favoritos')
) AS t(tabla)
ORDER BY existe ASC, t.tabla;


-- ════════════════════════════════════════════════════════════════════════════
-- R4. CHECK constraints sobre estado_verificacion / estado_aprobacion / estado
--     Si hay un CHECK con una lista de valores permitidos, un update con un
--     valor fuera de esa lista falla en silencio en los endpoints que no
--     verifican el error de la segunda escritura (ver diagnóstico previo).
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  t.relname AS tabla,
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid, true) AS definicion
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN ('bolsas', 'negocios', 'negocio_cambios_pendientes')
  AND c.contype = 'c'
ORDER BY t.relname, c.conname;


-- ════════════════════════════════════════════════════════════════════════════
-- R5. Estado real de las filas — ¿hay negocios/solicitudes atascadas en
--     'pendiente' que ya deberían estar resueltas? (evidencia directa del
--     bug #4 / #5: segunda escritura que nunca se confirmó)
-- ════════════════════════════════════════════════════════════════════════════
SELECT id, nombre, verificado, activo, estado_verificacion, created_at
FROM negocios
ORDER BY created_at DESC
LIMIT 20;

SELECT id, negocio_id, estado, created_at, updated_at
FROM negocio_cambios_pendientes
ORDER BY created_at DESC
LIMIT 20;

-- Duplicados de bolsas por negocio+nombre (para confirmar/descartar la
-- hipótesis de filas duplicadas de reintentos fallidos de creación)
SELECT
  negocio_id,
  lower(trim(nombre)) AS nombre_normalizado,
  COUNT(*) AS cantidad,
  array_agg(id) AS ids,
  array_agg(activo) AS estados_activo,
  array_agg(created_at ORDER BY created_at) AS fechas
FROM bolsas
GROUP BY negocio_id, lower(trim(nombre))
HAVING COUNT(*) > 1
ORDER BY cantidad DESC;
