-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Limpieza automática de bolsas rechazadas/inactivas — 5 días hábiles     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Ejecutar en Supabase Dashboard → SQL Editor. Idempotente (ADD COLUMN IF NOT
-- EXISTS) — se puede correr más de una vez sin efecto adicional.
--
-- inactivo_desde registra desde cuándo una bolsa está rechazada u oculta
-- (activo=false). Sin esta columna no hay forma de saber cuántos días lleva
-- así. El cron en server.js borra por completo (no soft-delete) las que
-- llevan más de 5 días hábiles con esta columna poblada.

ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS inactivo_desde TIMESTAMPTZ;
