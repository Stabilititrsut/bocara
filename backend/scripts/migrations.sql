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

-- 9. Aprobación de bolsas/cupones
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS estado_aprobacion TEXT DEFAULT 'aprobado';
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT;
UPDATE bolsas SET estado_aprobacion = 'aprobado' WHERE estado_aprobacion IS NULL;

-- 10. Peso del producto para cálculo automático de CO₂
--     Formula: co2_salvado_kg = peso_kg × factor_emision (kgCO₂e/kg)
--     Fuentes: Our World in Data, FAO (2013), EPA WARM Model
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS peso_kg NUMERIC(10,3) DEFAULT 0.5;

-- 11. Campo data en notificaciones (metadata adicional)
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS data JSONB;

-- 12. Factores de emisión CO₂ por categoría de negocio (configurables)
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_defecto','3.5')    ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_panaderia','1.0')  ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_restaurante','5.0') ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_cafeteria','3.0')  ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_supermercado','3.5') ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_sushi','5.5')      ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_pizza','2.5')      ON CONFLICT(clave) DO NOTHING;
INSERT INTO configuracion(clave,valor) VALUES('co2_factor_comida_tipica','5.0') ON CONFLICT(clave) DO NOTHING;

-- 13. Tabla de solicitudes de cambio de perfil de restaurante
CREATE TABLE IF NOT EXISTS negocio_cambios_pendientes (
  id               UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  negocio_id       UUID    REFERENCES negocios(id) ON DELETE CASCADE,
  datos_propuestos JSONB   NOT NULL,
  estado           TEXT    DEFAULT 'pendiente', -- pendiente | aprobado | rechazado
  motivo_rechazo   TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- 14. Tabla de factores de emisión CO₂ por categoría de alimento (configurable y versionada)
--     Alcance: emisiones potencialmente evitadas al rescatar alimento antes de convertirse en desperdicio.
--     Fuente principal: FAO (2013). "Food Wastage Footprint: Impacts on Natural Resources."
--     ISBN 978-92-5-107752-8. https://www.fao.org/3/i3347e/i3347e.pdf — Tabla A1.
--     Los factores NO incluyen Land Use Change (LUC) para mantener estimaciones conservadoras.
--     Mostrar siempre como "Impacto estimado" — no como medición exacta.
CREATE TABLE IF NOT EXISTS factores_co2_alimentos (
  id                    UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria             TEXT        UNIQUE NOT NULL,
  factor_kg_co2e_por_kg NUMERIC     NOT NULL CHECK (factor_kg_co2e_por_kg >= 0),
  fuente                TEXT        NOT NULL,
  version_fuente        TEXT,
  fecha_vigencia        DATE,
  notas                 TEXT,
  activo                BOOLEAN     DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Insertar factores documentados (idempotente — ON CONFLICT DO NOTHING)
-- Todos los valores provienen de FAO 2013 Tabla A1 salvo donde se indica.
INSERT INTO factores_co2_alimentos (categoria, factor_kg_co2e_por_kg, fuente, version_fuente, fecha_vigencia, notas) VALUES
  ('Panadería',     1.0, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Cereales y productos de panadería. Factor conservador sin LUC.'),
  ('Cafetería',     1.5, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Estimado: mezcla de cereales (1.0) y productos lácteos (2.0). Sin LUC.'),
  ('Supermercado',  2.5, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Mezcla conservadora de categorías para tiendas de abarrotes generales.'),
  ('Sushi',         2.4, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Pescados y mariscos según FAO 2013. Factor de producción sin transporte.'),
  ('Pizza',         2.0, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Cereales + ingredientes mixtos. Factor conservador basado en contenido mayoritario.'),
  ('Restaurante',   3.8, 'FAO 2013 + WRAP 2016', '2013/2016', '2016-01-01',
   'Comida preparada mixta. Estimado ponderado entre cereales, proteína animal y verduras.'),
  ('Comida Típica', 3.5, 'FAO 2013 Food Wastage Footprint Tabla A1', '2013', '2013-01-01',
   'Granos + proteína animal mixta (pollo, cerdo). Sin LUC.')
ON CONFLICT (categoria) DO NOTHING;

-- 16. Correcciones en negocio_cambios_pendientes
--     Agregar usuario_id si no existe
ALTER TABLE negocio_cambios_pendientes ADD COLUMN IF NOT EXISTS usuario_id UUID REFERENCES usuarios(id);
--     Renombrar datos_propuestos → cambios si aún existe con el nombre viejo
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'negocio_cambios_pendientes' AND column_name = 'datos_propuestos'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'negocio_cambios_pendientes' AND column_name = 'cambios'
  ) THEN
    ALTER TABLE negocio_cambios_pendientes RENAME COLUMN datos_propuestos TO cambios;
  END IF;
END $$;
--     Si la tabla se creó sin ninguna de las dos columnas, agregar cambios
ALTER TABLE negocio_cambios_pendientes ADD COLUMN IF NOT EXISTS cambios JSONB;

-- 15. SQL de diagnóstico para detectar duplicados reales en bolsas (solo lectura)
--     Ejecutar manualmente cuando se sospeche de duplicados:
/*
SELECT
  negocio_id,
  lower(trim(nombre)) AS nombre_normalizado,
  tipo,
  COUNT(*)            AS cantidad,
  array_agg(id)       AS ids,
  array_agg(created_at ORDER BY created_at) AS fechas
FROM bolsas
GROUP BY negocio_id, lower(trim(nombre)), tipo
HAVING COUNT(*) > 1
ORDER BY cantidad DESC;
*/
