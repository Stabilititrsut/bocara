-- Migración correctiva: Valores predeterminados para evitar violación NOT NULL en eventos_dominio
ALTER TABLE eventos_dominio 
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN status SET DEFAULT 'pendiente',
  ALTER COLUMN attempts SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT now();