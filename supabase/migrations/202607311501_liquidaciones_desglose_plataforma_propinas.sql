-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: columnas de desglose en liquidaciones
-- Archivo   : supabase/migrations/202607311501_liquidaciones_desglose_plataforma_propinas.sql
--
-- Idempotente: SÍ — ADD COLUMN IF NOT EXISTS.
--
-- Hasta ahora `liquidaciones` solo guardaba `comision_bocara` (25%) y el `monto`
-- final pagado, sin registrar por separado cuánto de ese pago era propina ni
-- cuánto se quedó Bocara por el cargo de plataforma (3.5%). Sin estas columnas,
-- una liquidación ya pagada no se puede auditar después: no queda registro de
-- "de dónde salió cada quetzal", solo el total.
--
-- Esta migración agrega:
--   · comision_plataforma — cargo de plataforma (3.5%) correspondiente a los
--                           pedidos de esa liquidación. Ingreso de Bocara, no
--                           del restaurante.
--   · propinas            — propinas incluidas en esa liquidación. 100% del
--                           restaurante, nunca de Bocara.
--
-- Liquidaciones históricas (pagadas antes de esta migración) quedan con estas
-- columnas en 0 — no hay forma de reconstruir el desglose retroactivamente sin
-- volver a leer los pedidos originales, y esta migración no lo intenta.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS comision_plataforma NUMERIC(10,2) DEFAULT 0;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS propinas            NUMERIC(10,2) DEFAULT 0;

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'liquidaciones'
  AND column_name IN ('comision_plataforma', 'propinas')
ORDER BY column_name;
