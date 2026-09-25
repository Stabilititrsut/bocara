-- Semana 1: cambios aditivos. No modifica ni reconstruye importes históricos.
BEGIN;

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS snapshot_financiero jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_financiero text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS porcentaje_comision_aplicado numeric(7,6);

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_tipo_financiero_valido
  CHECK (tipo_financiero IS NULL OR tipo_financiero IN ('merma', 'promocion', 'mixto')) NOT VALID;

COMMENT ON COLUMN pedidos.snapshot_financiero IS
  'Snapshot inmutable creado por backend: componentes, porcentajes y líneas al crear el pedido. Los pedidos previos quedan NULL porque no se puede reconstruir su tipo de forma confiable.';

INSERT INTO configuracion (clave, valor)
VALUES ('comision_promocion_porcentaje', '20')
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS eventos_dominio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pendiente',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_at timestamptz,
  CONSTRAINT eventos_dominio_status_valido CHECK (status IN ('pendiente','procesando','procesado','fallido')),
  CONSTRAINT eventos_dominio_intentos_no_negativos CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS eventos_dominio_idempotency_key_uq ON eventos_dominio (idempotency_key);
CREATE INDEX IF NOT EXISTS eventos_dominio_pendientes_idx ON eventos_dominio (status, created_at) WHERE status IN ('pendiente', 'procesando');

COMMIT;
