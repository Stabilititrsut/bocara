-- ============================================================
-- Bocara — SQL Migrations
-- Ejecutar en: Supabase Dashboard > SQL Editor
-- ============================================================

-- 1. Columnas nuevas en la tabla negocios
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS estado_verificacion TEXT DEFAULT 'pendiente';
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS nit                  TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS dpi                  TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS datos_bancarios      JSONB;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS horario_atencion     TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS motivo_rechazo       TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS dpi_foto_url         TEXT;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_url           TEXT;

-- 2. Normalizar estado de negocios existentes
UPDATE negocios
SET estado_verificacion = 'aprobado'
WHERE activo = TRUE AND verificado = TRUE AND estado_verificacion IS NULL;

UPDATE negocios
SET estado_verificacion = 'pendiente'
WHERE activo = FALSE AND verificado = FALSE AND estado_verificacion IS NULL;

-- 3. Tabla de liquidaciones
CREATE TABLE IF NOT EXISTS liquidaciones (
  id                UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  negocio_id        UUID    REFERENCES negocios(id) ON DELETE CASCADE,
  monto             NUMERIC(10,2) NOT NULL,
  ventas_brutas     NUMERIC(10,2) DEFAULT 0,
  comision_bocara   NUMERIC(10,2) DEFAULT 0,
  estado            TEXT    DEFAULT 'pagado',
  datos_transferencia JSONB,
  total_pedidos     INTEGER DEFAULT 0,
  pagado_en         TIMESTAMP WITH TIME ZONE,
  pagado_por        UUID    REFERENCES usuarios(id),
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- 4. Columna liquidacion_id en pedidos
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS liquidacion_id UUID REFERENCES liquidaciones(id);

-- 5. Tabla de configuración
CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- 6. Columnas opcionales en pedidos (por si no existen)
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS precio_bolsa           NUMERIC(10,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comision_bocara        NUMERIC(10,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_neto_restaurante NUMERIC(10,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_inicio   TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_fin      TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_recogida        TEXT;

-- 7. Columnas en usuarios
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS expo_push_token   TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url        TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apellido          TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos            INTEGER DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_bolsas_salvadas   INTEGER DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_co2_salvado_kg    NUMERIC(10,2) DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_ahorrado          NUMERIC(10,2) DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_co2_salvado       NUMERIC(10,2) DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo            BOOLEAN DEFAULT TRUE;

-- 8. Supabase Storage: crear bucket bocara-images (público)
-- Si el bucket no existe, créalo desde el Dashboard > Storage > New bucket
-- Nombre: bocara-images
-- Public bucket: activado (toggle ON)
-- Después agrega esta política RLS para permitir lectura pública:
/*
  CREATE POLICY "Public read" ON storage.objects
    FOR SELECT USING (bucket_id = 'bocara-images');

  CREATE POLICY "Auth upload" ON storage.objects
    FOR INSERT WITH CHECK (
      bucket_id = 'bocara-images'
      AND auth.role() IS NOT NULL
    );
*/
-- NOTA: Las políticas de Storage se manejan desde Supabase Dashboard > Storage > Policies
