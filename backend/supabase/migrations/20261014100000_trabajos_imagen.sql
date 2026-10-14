-- Bloque IA — trabajos de imagen previos a publicar.
--
-- REQUIERE antes: 20261006100000_pipeline_imagenes.sql (columnas de imagen en
-- bolsas/negocios). Aditiva e idempotente: CREATE ... IF NOT EXISTS.
--
-- Cada foto que el restaurante sube en el formulario de Promoción / Tiempo
-- limitado crea un trabajo que se procesa ANTES de guardar:
--   subida → analizando → mejorando → validando → lista
--                       ↘ rechazada (no cumple la calidad mínima)
--                                    ↘ fallida (error de IA o de validación; se puede reintentar)
-- POST/PUT /api/bolsas solo aceptan una foto con un trabajo 'lista' del mismo
-- negocio: la publicación guarda la mejorada como imagen_url y la original en
-- imagen_original_url. El archivo original nunca se modifica.
BEGIN;

CREATE TABLE IF NOT EXISTS trabajos_imagen (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        uuid NOT NULL,
  negocio_id        uuid NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
  original_url      text NOT NULL,
  mejorada_url      text,
  estado            text NOT NULL DEFAULT 'subida'
                    CHECK (estado IN ('subida', 'analizando', 'mejorando', 'validando', 'lista', 'rechazada', 'fallida')),
  motivos           jsonb,          -- [{ codigo, mensaje }] de un rechazo o de un resultado que no pasó
  error_codigo      text,           -- ia_no_configurada | proveedor | validacion | calidad_resultado | interrumpido | interno ...
  error             text,           -- detalle técnico (sin claves)
  calidad_original  jsonb,          -- métricas técnicas de la original
  revision_ia       jsonb,          -- veredicto de la revisión con visión
  calidad_resultado jsonb,          -- métricas técnicas + similitud de la mejorada
  proveedor         text,
  modelo            text,
  intentos          integer NOT NULL DEFAULT 0,
  bolsa_id          uuid,           -- publicación que la usó
  usada_at          timestamptz,
  iniciado_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trabajos_imagen_usuario_idx ON trabajos_imagen (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trabajos_imagen_activos_idx ON trabajos_imagen (estado, iniciado_at)
  WHERE estado IN ('subida', 'analizando', 'mejorando', 'validando');

-- Solo el backend (service role) lee y escribe esta tabla.
ALTER TABLE trabajos_imagen ENABLE ROW LEVEL SECURITY;

COMMIT;
