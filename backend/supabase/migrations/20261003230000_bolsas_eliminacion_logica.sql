-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Eliminación lógica de publicaciones (bolsas)                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Ejecutar en Supabase Dashboard → SQL Editor. Idempotente (ADD COLUMN IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS) — se puede correr más de una vez sin
-- efecto adicional. Puramente aditiva: columnas nuevas y nullable, sin DROP,
-- sin renombrar nada. Los registros existentes quedan con eliminado_en = NULL
-- (= "no eliminada"), que es exactamente su estado actual.
--
-- Por qué eliminación lógica y no DELETE físico:
--   · pedido_items.bolsa_id es NOT NULL REFERENCES bolsas(id) SIN
--     ON DELETE CASCADE/SET NULL (ver sql/cubo-pago-schema.sql). Un DELETE
--     físico sobre una bolsa con al menos un pedido histórico falla por
--     integridad referencial — y si tuviera éxito (una bolsa sin pedidos),
--     dejaría huérfanas las filas de `favoritos` que la referencian por
--     `referencia_id` (relación de aplicación, sin FK real en ese campo).
--   · Mantener un único camino (siempre lógica, nunca física) evita la
--     complejidad y el riesgo de dos comportamientos distintos según si la
--     publicación "ya tuvo pedidos o no" en el momento exacto de eliminarla.
--
-- eliminado_en es independiente de inactivo_desde (sql/limpieza-automatica-
-- bolsas.sql): inactivo_desde marca "oculta temporalmente, candidata a una
-- futura limpieza automática"; eliminado_en marca "eliminada por el
-- restaurante/admin, de forma permanente y auditable". Un futuro cron de
-- limpieza por inactivo_desde no necesita tocar filas con eliminado_en: ya
-- están fuera de todo flujo operativo y público (backend/services/
-- publicaciones.js), y no vuelven a activarse por ningún camino de la API.

ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS eliminado_por UUID;

-- Acelera "excluir eliminadas" en los listados del restaurante y del admin.
CREATE INDEX IF NOT EXISTS idx_bolsas_eliminado_en ON bolsas(eliminado_en) WHERE eliminado_en IS NOT NULL;
