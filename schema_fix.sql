-- =====================================================
-- BOCARA - Fix del schema de Supabase
-- Ejecutar en: https://supabase.com/dashboard/project/tbbjrethcgjxkfazntaa/editor
-- =====================================================

-- ── tabla: usuarios ─────────────────────────────────
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol         text        NOT NULL DEFAULT 'cliente';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apellido    text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url  text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos      integer     NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_co2_salvado_kg decimal(10,2) NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();

-- ── tabla: negocios ─────────────────────────────────
-- email y password_hash eran requeridos en el schema original (negocios como tabla de auth)
-- con el modelo actual (auth via usuarios) estas columnas son opcionales
ALTER TABLE negocios ALTER COLUMN email        DROP NOT NULL;
ALTER TABLE negocios ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE negocios ADD COLUMN IF NOT EXISTS propietario_id        uuid        REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS descripcion           text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_url            text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS logo_url              text;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS calificacion_promedio decimal(3,2) NOT NULL DEFAULT 0;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS total_bolsas_vendidas integer     NOT NULL DEFAULT 0;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS created_at            timestamptz NOT NULL DEFAULT now();

-- ── tabla: bolsas ───────────────────────────────────
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS descripcion      text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS contenido        text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS tipo             text        NOT NULL DEFAULT 'bolsa';
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS categoria        text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS imagen_url       text;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS fecha_disponible date;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS activo           boolean     NOT NULL DEFAULT true;
ALTER TABLE bolsas ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now();

-- ── tabla: pedidos ──────────────────────────────────
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_inicio text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_fin    text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS created_at           timestamptz NOT NULL DEFAULT now();

-- ── tabla: resenas ──────────────────────────────────
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- ── función: sumar_puntos (usada al completar pedidos) ──
CREATE OR REPLACE FUNCTION sumar_puntos(user_id uuid, puntos int)
RETURNS void AS $$
BEGIN
  UPDATE usuarios
  SET    puntos             = usuarios.puntos + $2,
         total_bolsas_salvadas = total_bolsas_salvadas + 1
  WHERE  id = $1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── verificar resultados ─────────────────────────────
SELECT column_name, data_type, column_default
FROM   information_schema.columns
WHERE  table_name IN ('usuarios','negocios','bolsas','pedidos','resenas')
  AND  table_schema = 'public'
ORDER  BY table_name, ordinal_position;
