-- Bloque 2 — Pipeline de imágenes (mejora automática de fotos).
--
-- Aditiva e idempotente: solo ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS y CHECKs NOT VALID. Sin DROP, sin backfill, sin tocar filas.
-- Se aplica igual a `bolsas` (Promoción y Tiempo limitado) y `negocios`.
--
-- Modelo:
--   imagen_url            → la imagen que se MUESTRA (la mejor disponible).
--                           Columna existente; todo el código la sigue leyendo.
--   imagen_original_url   → la foto tal como la subió el restaurante. Se fija
--                           al pedir la mejora y nunca la sobrescribe el
--                           pipeline (el archivo original en Storage tampoco
--                           se toca: la mejorada es un archivo nuevo).
--   imagen_mejorada_url   → resultado del proveedor (archivo propio en Storage).
--   estado_procesamiento_imagen:
--     NULL        sin procesar (filas anteriores a este bloque)
--     pendiente   en cola (incluye reintento automático tras un fallo)
--     procesando  reclamada por un worker
--     completada  imagen_url = imagen_mejorada_url
--     fallida     agotó reintentos → imagen_url = original
--     descartada  el restaurante eligió su original → imagen_url = original
BEGIN;

ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_original_url text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_mejorada_url text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS estado_procesamiento_imagen text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS proveedor_imagen_ia text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS error_procesamiento_imagen text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_procesamiento_meta jsonb;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_intentos integer NOT NULL DEFAULT 0;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_solicitada_at timestamptz;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_procesamiento_iniciado_at timestamptz;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_procesada_at timestamptz;

ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_original_url text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_mejorada_url text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS estado_procesamiento_imagen text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS proveedor_imagen_ia text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS error_procesamiento_imagen text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_procesamiento_meta jsonb;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_intentos integer NOT NULL DEFAULT 0;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_solicitada_at timestamptz;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_procesamiento_iniciado_at timestamptz;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_procesada_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bolsas_estado_procesamiento_imagen_valido') THEN
    ALTER TABLE bolsas ADD CONSTRAINT bolsas_estado_procesamiento_imagen_valido
      CHECK (estado_procesamiento_imagen IS NULL OR estado_procesamiento_imagen IN
        ('pendiente', 'procesando', 'completada', 'fallida', 'descartada')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'negocios_estado_procesamiento_imagen_valido') THEN
    ALTER TABLE negocios ADD CONSTRAINT negocios_estado_procesamiento_imagen_valido
      CHECK (estado_procesamiento_imagen IS NULL OR estado_procesamiento_imagen IN
        ('pendiente', 'procesando', 'completada', 'fallida', 'descartada')) NOT VALID;
  END IF;
END
$$;

-- La cola del worker: solo filas en pendiente/procesando (índice parcial chico).
CREATE INDEX IF NOT EXISTS bolsas_imagen_cola_idx
  ON bolsas (estado_procesamiento_imagen, imagen_solicitada_at)
  WHERE estado_procesamiento_imagen IN ('pendiente', 'procesando');
CREATE INDEX IF NOT EXISTS negocios_imagen_cola_idx
  ON negocios (estado_procesamiento_imagen, imagen_solicitada_at)
  WHERE estado_procesamiento_imagen IN ('pendiente', 'procesando');

COMMIT;
