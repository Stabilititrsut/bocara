-- ════════════════════════════════════════════════════════════════════════════
-- Bocara — Columnas de auditoría para cancelación de pedidos
-- Ejecutar en Supabase SQL Editor (es idempotente — ADD COLUMN IF NOT EXISTS)
-- ════════════════════════════════════════════════════════════════════════════

-- Quién canceló el pedido: 'cliente' | 'restaurante' | 'sistema'
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_por text;

-- Motivo libre (para cancelaciones del sistema o soporte interno)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS motivo_cancelacion text;

-- Timestamp exacto de la cancelación
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_at timestamptz;

-- Índice parcial para consultas de cancelados recientes (admin / reportes)
CREATE INDEX IF NOT EXISTS idx_pedidos_cancelados
  ON pedidos (cancelado_at DESC)
  WHERE estado = 'cancelado' AND cancelado_at IS NOT NULL;

-- Verificar
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pedidos' AND column_name = 'cancelado_por'
  ) THEN
    RAISE NOTICE '✓ Columnas de auditoría de cancelación presentes en pedidos.';
  ELSE
    RAISE EXCEPTION 'FALLÓ: cancelado_por no existe en pedidos.';
  END IF;
END $$;
