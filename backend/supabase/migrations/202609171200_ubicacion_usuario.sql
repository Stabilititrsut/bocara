-- Semana 1 (cierre Sábado): persistencia de ubicación del cliente.
-- Aditivo: columnas nuevas, nullable, sin backfill y sin tocar filas existentes.
BEGIN;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitud numeric(9,6);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitud numeric(9,6);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ubicacion_actualizada_at timestamptz;

-- NOT VALID: no escanea ni bloquea la tabla completa para validar filas
-- existentes (todas son NULL hoy, así que no hay nada que violarla, pero se
-- deja NOT VALID por el mismo motivo que pedidos_tipo_financiero_valido en
-- 202609161200 — coherencia y costo cero en tablas grandes).
ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_latitud_rango
  CHECK (latitud IS NULL OR (latitud >= -90 AND latitud <= 90)) NOT VALID;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_longitud_rango
  CHECK (longitud IS NULL OR (longitud >= -180 AND longitud <= 180)) NOT VALID;

COMMENT ON COLUMN usuarios.latitud IS
  'Última ubicación que el cliente compartió explícitamente vía PATCH /api/auth/ubicacion. NULL = nunca la compartió; no se infiere ni se geocodifica.';
COMMENT ON COLUMN usuarios.longitud IS
  'Ver comentario de usuarios.latitud.';

COMMIT;
