-- ════════════════════════════════════════════════════════════════════════════
-- Bocara — Renombrar estado 'recogido' → 'completado' en pedidos existentes
-- Ejecutar en Supabase SQL Editor (es idempotente — solo actualiza si existen)
-- ════════════════════════════════════════════════════════════════════════════

UPDATE pedidos SET estado = 'completado' WHERE estado = 'recogido';

-- Verificar resultado
DO $$
DECLARE
  cnt_recogido integer;
  cnt_completado integer;
BEGIN
  SELECT COUNT(*) INTO cnt_recogido   FROM pedidos WHERE estado = 'recogido';
  SELECT COUNT(*) INTO cnt_completado FROM pedidos WHERE estado = 'completado';
  RAISE NOTICE '✓ Estado "recogido" restantes: % | Estado "completado": %', cnt_recogido, cnt_completado;
END $$;
