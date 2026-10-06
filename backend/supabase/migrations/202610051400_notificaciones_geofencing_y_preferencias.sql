-- ══════════════════════════════════════════════════════════════════════════════
-- Semana 2 · Fase A: base de datos para notificaciones por cercanía (10 km).
--
-- 100% aditiva: solo CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS y
-- CREATE OR REPLACE FUNCTION. Sin DROP, sin backfill, sin tocar filas.
-- Idempotente: se puede ejecutar varias veces.
-- Pre-condición recomendada: 202609171200_ubicacion_usuario.sql (aun así las
-- columnas se reafirman abajo con IF NOT EXISTS para que esta migración no
-- falle en un entorno nuevo).
-- Ejecutar en: Supabase Dashboard → SQL Editor.
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Columnas de usuarios que la RPC necesita ──────────────────────────────
-- Todas ya existen en producción (run-migrations.js / 202609171200); se
-- reafirman para que CREATE FUNCTION (LANGUAGE sql valida el cuerpo al crear)
-- no falle en un entorno que no las tenga.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS expo_push_token text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo boolean DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS latitud numeric(9,6);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS longitud numeric(9,6);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ubicacion_actualizada_at timestamptz;

-- Preferencia de promociones. Opt-out: NULL o true = recibe, solo false excluye.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS notif_promociones boolean DEFAULT true;

COMMENT ON COLUMN usuarios.notif_promociones IS
  'Recibir push de Promociones/Tiempo limitado de negocios cercanos. false = opt-out explícito; NULL se trata como true.';

-- ── 2. Índice B-tree compuesto (latitud, longitud), parcial ──────────────────
-- NO es un índice espacial (no hay PostGIS ni GiST): es un B-tree normal que
-- sirve al prefiltro de caja delimitadora de la RPC (rango en latitud); la
-- distancia exacta la decide Haversine. Solo filas notificables (con
-- ubicación y token); la RPC repite este predicado para que el planificador
-- pueda usar el índice.
CREATE INDEX IF NOT EXISTS usuarios_geo_idx
  ON usuarios (latitud, longitud)
  WHERE latitud IS NOT NULL AND expo_push_token IS NOT NULL;

-- ── 3. Tabla notificaciones e idempotencia ───────────────────────────────────
-- En producción la tabla ya existe: este CREATE es un no-op. Las columnas
-- siguen el esquema REAL que usa el código (`cuerpo`, `creado_en` — ver
-- services/notificaciones.js y routes/notificaciones.js), no `mensaje`/`created_at`.
CREATE TABLE IF NOT EXISTS notificaciones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id         uuid NOT NULL REFERENCES usuarios(id),
  tipo               text NOT NULL,
  titulo             text NOT NULL,
  cuerpo             text NOT NULL,
  data               jsonb DEFAULT '{}'::jsonb,
  leida              boolean DEFAULT false,
  clave_idempotencia text,
  creado_en          timestamptz DEFAULT now()
);

-- Si la tabla existía sin estas columnas (despliegues viejos), agregarlas.
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS data jsonb DEFAULT '{}'::jsonb;
ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS clave_idempotencia text;

-- Igual que el lockdown 202607301400: sin acceso directo vía anon/authenticated.
-- Idempotente; service_role (backend) tiene BYPASSRLS.
ALTER TABLE notificaciones ENABLE ROW LEVEL SECURITY;

-- Índice único de idempotencia. sql/cubo-pago-schema.sql ya crea
-- idx_notificaciones_clave_idempotencia con la misma definición; crear un
-- segundo índice idéntico solo duplicaría el costo de escritura, así que se
-- crea únicamente si no hay ya un índice UNIQUE sobre esa columna.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t     ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE n.nspname = 'public'
      AND t.relname = 'notificaciones'
      AND a.attname = 'clave_idempotencia'
      AND i.indisunique
      AND i.indnatts = 1
  ) THEN
    CREATE UNIQUE INDEX notificaciones_clave_idempotencia_uq
      ON notificaciones (clave_idempotencia)
      WHERE clave_idempotencia IS NOT NULL;
  END IF;
END
$$;

-- ── 4. RPC usuarios_en_radio ─────────────────────────────────────────────────
-- Clientes notificables a ≤ p_radio_km de un punto (el negocio).
--   1. Caja delimitadora sobre (latitud, longitud) → usa usuarios_geo_idx.
--   2. Haversine exacta (R = 6371 km) sobre los candidatos de la caja.
-- El radio se acota a 10 km, igual que el feed (routes/bolsas.js): ningún
-- caller puede ampliar la regla de negocio. Coordenadas o parámetros
-- inválidos devuelven 0 filas, nunca un error ni un barrido completo.
CREATE OR REPLACE FUNCTION usuarios_en_radio(
  p_lat            double precision,
  p_lng            double precision,
  p_radio_km       double precision DEFAULT 10,
  p_max_edad_dias  int              DEFAULT 30
)
RETURNS TABLE (usuario_id uuid, expo_push_token text, distancia_km double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH params AS (
    SELECT
      p_lat AS lat,
      p_lng AS lng,
      LEAST(p_radio_km, 10) AS radio,
      -- 1° de latitud ≈ 111.045 km; la longitud se encoge con cos(lat).
      -- GREATEST evita dividir entre ~0 cerca de los polos.
      LEAST(p_radio_km, 10) / 111.045 AS dlat,
      LEAST(p_radio_km, 10) / (111.045 * GREATEST(cos(radians(p_lat)), 0.01)) AS dlng
    WHERE p_lat BETWEEN -90 AND 90
      AND p_lng BETWEEN -180 AND 180
      AND p_radio_km > 0
      AND p_max_edad_dias > 0
  ),
  candidatos AS (
    SELECT
      u.id,
      u.expo_push_token,
      2 * 6371 * asin(LEAST(1, sqrt(
        sin(radians(u.latitud::double precision - p.lat) / 2) ^ 2
        + cos(radians(p.lat)) * cos(radians(u.latitud::double precision))
          * sin(radians(u.longitud::double precision - p.lng) / 2) ^ 2
      ))) AS distancia_km,
      p.radio
    FROM usuarios u
    CROSS JOIN params p
    WHERE u.latitud IS NOT NULL
      AND u.expo_push_token IS NOT NULL
      AND u.latitud  BETWEEN p.lat - p.dlat AND p.lat + p.dlat
      AND u.longitud BETWEEN p.lng - p.dlng AND p.lng + p.dlng
      AND u.longitud IS NOT NULL
      AND u.expo_push_token <> ''
      AND u.rol = 'cliente'
      AND COALESCE(u.activo, true)
      AND COALESCE(u.notif_promociones, true)
      AND u.ubicacion_actualizada_at >= now() - make_interval(days => p_max_edad_dias)
  )
  SELECT c.id, c.expo_push_token, c.distancia_km
  FROM candidatos c
  WHERE c.distancia_km <= c.radio
  ORDER BY c.distancia_km;
$$;

COMMENT ON FUNCTION usuarios_en_radio(double precision, double precision, double precision, int) IS
  'Clientes activos con push y notif_promociones a ≤ radio (máx 10 km) del punto, con ubicación de ≤ p_max_edad_dias días. Solo service_role.';

-- SECURITY DEFINER expone ids, tokens y cercanía: solo el backend puede llamarla.
REVOKE EXECUTE ON FUNCTION usuarios_en_radio(double precision, double precision, double precision, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usuarios_en_radio(double precision, double precision, double precision, int) FROM anon;
REVOKE EXECUTE ON FUNCTION usuarios_en_radio(double precision, double precision, double precision, int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION usuarios_en_radio(double precision, double precision, double precision, int) TO service_role;

COMMIT;
