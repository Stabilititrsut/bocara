-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: liquidaciones mensuales atómicas + reseñas verificadas
-- Archivo   : supabase/migrations/202610061200_liquidaciones_mensuales_y_resenas.sql
--
-- Idempotente: SÍ — ADD COLUMN / CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION / TRIGGER (PG14+), constraints agregados solo si no existen e
-- INSERT ... ON CONFLICT para el bucket. Ejecutarla dos veces no cambia nada.
--
-- 100% aditiva: no hay DROP ni UPDATE de datos existentes (la única escritura es
-- el registro del bucket privado en storage.buckets). Los CHECK se agregan como
-- NOT VALID y solo se validan si ninguna fila histórica los viola, para que la
-- migración nunca falle por datos viejos.
--
-- PROBLEMAS QUE RESUELVE:
--   1. POST /admin/liquidaciones/:id/pagar inserta la liquidación y marca los
--      pedidos en dos llamadas separadas, sin guarda `liquidacion_id IS NULL`:
--      doble clic o dos admins = dos liquidaciones por los mismos pedidos.
--      → crear_liquidacion_mensual_atomica(): lock por negocio+mes, FOR UPDATE
--        sobre los pedidos e insert+update en la misma transacción, más el
--        índice único (negocio_id, mes) como última barrera.
--   2. No existía corte mensual: se liquidaba "todo lo pendiente" sin cierre.
--      → columna `mes` + periodo [periodo_inicio, periodo_fin) en hora de
--        Guatemala. Entra todo pedido pendiente pagado antes de periodo_fin
--        (pagado_en, o created_at en pedidos viejos sin pagado_en), incluidos
--        los arrastrados de meses anteriores entregados después de su corte.
--   3. routes/resenas.js recalcula el promedio leyendo y luego escribiendo desde
--      Node: dos reseñas simultáneas pueden pisarse el promedio.
--      → trigger que recalcula bajo lock de la fila del negocio, solo con
--        reseñas visibles (moderación).
--
-- PRERREQUISITOS (ya presentes en producción según introspección):
--   liquidaciones(id, negocio_id, monto, ventas_brutas, comision_bocara, estado,
--     datos_transferencia, total_pedidos, pagado_en, pagado_por, created_at,
--     comision_plataforma, propinas), pedidos.liquidacion_id, pedidos.pagado_en,
--   pedidos.snapshot_financiero, resenas(..., UNIQUE pedido_id).
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE A — liquidaciones: columnas, constraints e índices
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS mes                     text;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS periodo_inicio          timestamptz;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS periodo_fin             timestamptz;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS folio                   text;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS comprobante_path        text;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS comprobante_generado_en timestamptz;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS fecha_limite_pago       timestamptz;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS costo_envio             numeric(10,2) DEFAULT 0;
-- Quién generó la liquidación mensual (pagado_por se reserva para quien la paga).
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS creada_por              uuid REFERENCES usuarios(id);

COMMENT ON COLUMN liquidaciones.mes IS
  'Mes calendario liquidado, formato YYYY-MM (hora de Guatemala). NULL en liquidaciones previas al corte mensual.';
COMMENT ON COLUMN liquidaciones.periodo_inicio IS
  'Inicio INCLUSIVO del mes nominal: día 1 a las 00:00 America/Guatemala. La liquidación puede incluir pedidos anteriores arrastrados (pendientes entregados tras el corte de su mes).';
COMMENT ON COLUMN liquidaciones.periodo_fin IS
  'Fin EXCLUSIVO del periodo: día 1 del mes siguiente a las 00:00 America/Guatemala.';
COMMENT ON COLUMN liquidaciones.comprobante_path IS
  'Ruta del PDF dentro del bucket privado bocara-comprobantes (nunca una URL pública).';

-- CHECK de estado. NOT VALID primero (no escanea ni bloquea por filas viejas);
-- se valida solo si ninguna fila histórica lo viola.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'liquidaciones_estado_valido'
      AND conrelid = 'public.liquidaciones'::regclass
  ) THEN
    ALTER TABLE liquidaciones
      ADD CONSTRAINT liquidaciones_estado_valido
      CHECK (estado IN ('pendiente', 'pagado', 'liquidado', 'anulado')) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'liquidaciones_estado_valido'
      AND conrelid = 'public.liquidaciones'::regclass
      AND NOT convalidated
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM liquidaciones
      WHERE estado IS NOT NULL
        AND estado NOT IN ('pendiente', 'pagado', 'liquidado', 'anulado')
    ) THEN
      ALTER TABLE liquidaciones VALIDATE CONSTRAINT liquidaciones_estado_valido;
    ELSE
      RAISE NOTICE 'liquidaciones_estado_valido queda NOT VALID: hay filas históricas con estado fuera de catálogo (se exige solo en filas nuevas).';
    END IF;
  END IF;
END $$;

-- CHECK de formato de mes (todas las filas históricas tienen mes NULL → valida).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'liquidaciones_mes_formato'
      AND conrelid = 'public.liquidaciones'::regclass
  ) THEN
    ALTER TABLE liquidaciones
      ADD CONSTRAINT liquidaciones_mes_formato
      CHECK (mes IS NULL OR mes ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'liquidaciones_mes_formato'
      AND conrelid = 'public.liquidaciones'::regclass
      AND NOT convalidated
  ) AND NOT EXISTS (
    SELECT 1 FROM liquidaciones
    WHERE mes IS NOT NULL AND mes !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ) THEN
    ALTER TABLE liquidaciones VALIDATE CONSTRAINT liquidaciones_mes_formato;
  END IF;
END $$;

-- Una sola liquidación viva por negocio y mes. Las históricas (mes NULL) no
-- chocan entre sí: NULL nunca es igual a NULL en un índice único.
CREATE UNIQUE INDEX IF NOT EXISTS liquidaciones_negocio_mes_uq
  ON liquidaciones (negocio_id, mes)
  WHERE estado <> 'anulado';

CREATE UNIQUE INDEX IF NOT EXISTS liquidaciones_folio_uq
  ON liquidaciones (folio)
  WHERE folio IS NOT NULL;

-- Búsqueda de pedidos pendientes de liquidar por negocio (la RPC filtra por
-- esto) y detalle de los pedidos de una liquidación.
CREATE INDEX IF NOT EXISTS idx_pedidos_pendientes_liquidar
  ON pedidos (negocio_id)
  WHERE liquidacion_id IS NULL AND estado_pago = 'pagado';

CREATE INDEX IF NOT EXISTS idx_pedidos_liquidacion
  ON pedidos (liquidacion_id)
  WHERE liquidacion_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE B — RPC crear_liquidacion_mensual_atomica
--
-- Respuestas (jsonb, nunca excepción por reglas de negocio):
--   { ok:true,  resultado:'creada', liquidacion:{...}, pedidos_excluidos_sin_desglose:[...] }
--   { ok:false, resultado:'mes_invalido' | 'mes_en_curso' | 'no_autorizado'
--               | 'negocio_no_encontrado' | 'sin_pedidos_pendientes'
--               | 'mes_ya_liquidado' (incluye la liquidación existente) }
--
-- Concurrencia:
--   1. pg_advisory_xact_lock(negocio, mes) serializa llamadas para el mismo
--      negocio+mes: la segunda espera y luego ve 'mes_ya_liquidado'.
--   2. SELECT ... FOR UPDATE (ORDER BY id) bloquea los pedidos elegibles contra
--      cualquier otro escritor (p. ej. el endpoint legacy /pagar).
--   3. El UPDATE exige liquidacion_id IS NULL y compara el conteo: si otro
--      proceso se llevó un pedido, se aborta toda la transacción.
--   4. liquidaciones_negocio_mes_uq es la última barrera ante cualquier carrera
--      no prevista (unique_violation → 'mes_ya_liquidado').
--
-- Montos: se suman desde pedidos.snapshot_financiero (inmutable). Los pedidos
-- previos a Semana 1 tienen snapshot NULL; para ellos se usan las columnas que
-- se guardaron al confirmar el pago (mismo criterio que services/finanzas.js).
-- Un pedido sin monto_neto_restaurante en ninguna de las dos fuentes NO se
-- liquida: se reporta en pedidos_excluidos_sin_desglose y queda pendiente.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_liquidacion_mensual_atomica(
  p_negocio_id   uuid,
  p_mes          text,
  p_admin_id     uuid,
  p_fecha_limite timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ZONA CONSTANT text := 'America/Guatemala';
  v_dia           date;
  v_inicio        timestamptz;
  v_fin           timestamptz;
  v_existente     liquidaciones%ROWTYPE;
  v_liq           liquidaciones%ROWTYPE;
  v_liq_id        uuid := gen_random_uuid();
  v_ids           uuid[];
  v_sin_desglose  uuid[];
  v_n             integer;
  v_actualizados  integer;
  v_bruto         numeric;
  v_comision      numeric;
  v_plataforma    numeric;
  v_propinas      numeric;
  v_envio         numeric;
  v_neto          numeric;
BEGIN
  -- ── 1. Validaciones baratas ──────────────────────────────────────────────
  IF p_mes IS NULL OR p_mes !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'mes_invalido');
  END IF;

  v_dia    := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_inicio := (v_dia::timestamp) AT TIME ZONE ZONA;
  v_fin    := ((v_dia + interval '1 month')::timestamp) AT TIME ZONE ZONA;

  -- No se liquida un mes que no ha terminado: el índice único bloquearía el
  -- mes y las ventas de los días restantes quedarían sin liquidar.
  IF v_fin > now() THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'mes_en_curso',
      'periodo_fin', v_fin);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM usuarios WHERE id = p_admin_id AND rol = 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'no_autorizado');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM negocios WHERE id = p_negocio_id) THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'negocio_no_encontrado');
  END IF;

  -- ── 2. Serializar por negocio + mes ──────────────────────────────────────
  PERFORM pg_advisory_xact_lock(
    hashtextextended('liquidacion_mensual:' || p_negocio_id::text || ':' || p_mes, 0)
  );

  SELECT * INTO v_existente
  FROM liquidaciones
  WHERE negocio_id = p_negocio_id AND mes = p_mes AND estado <> 'anulado'
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'mes_ya_liquidado',
      'liquidacion', to_jsonb(v_existente));
  END IF;

  -- ── 3. Bloquear pedidos elegibles hasta el cierre del mes ────────────────
  -- Mismo filtro de elegibilidad que GET /admin/liquidaciones (pagado y
  -- verificado contra Cubo, entregado, sin liquidar) + pagado antes de v_fin.
  -- Sin límite inferior a propósito (arrastre): un pedido pagado en un mes ya
  -- liquidado pero entregado después del corte (p. ej. pagado 30-sep, recogido
  -- 2-oct, septiembre liquidado el 1-oct) entra en la siguiente liquidación en
  -- vez de quedar huérfano para siempre.
  WITH bloqueados AS (
    SELECT
      p.id,
      p.snapshot_financiero AS sf,
      COALESCE((p.snapshot_financiero->>'monto_neto_restaurante')::numeric, p.monto_neto_restaurante) AS neto,
      COALESCE((p.snapshot_financiero->>'comision_bocara')::numeric,        p.comision_bocara,   0)  AS comision,
      COALESCE((p.snapshot_financiero->>'comision_pasarela')::numeric,      p.comision_pasarela, 0)  AS plataforma,
      COALESCE((p.snapshot_financiero->>'propina')::numeric,                p.propina,           0)  AS propina,
      COALESCE((p.snapshot_financiero->>'costo_envio')::numeric,            p.costo_envio,       0)  AS envio
    FROM pedidos p
    WHERE p.negocio_id = p_negocio_id
      AND p.estado IN ('completado', 'recogido')
      AND p.estado_pago = 'pagado'
      AND p.cubo_payment_intent_token IS NOT NULL
      AND p.cubo_identifier IS NOT NULL
      AND p.liquidacion_id IS NULL
      AND COALESCE(p.pagado_en, p.created_at) < v_fin
    ORDER BY p.id
    FOR UPDATE OF p
  ), montos AS (
    SELECT b.*,
           COALESCE((b.sf->>'subtotal_productos')::numeric,
                    b.neto - b.propina - b.envio + b.comision) AS bruto
    FROM bloqueados b
  )
  SELECT
    array_agg(id ORDER BY id) FILTER (WHERE neto IS NOT NULL),
    array_agg(id ORDER BY id) FILTER (WHERE neto IS NULL),
    count(*) FILTER (WHERE neto IS NOT NULL),
    ROUND(COALESCE(sum(bruto)      FILTER (WHERE neto IS NOT NULL), 0), 2),
    ROUND(COALESCE(sum(comision)   FILTER (WHERE neto IS NOT NULL), 0), 2),
    ROUND(COALESCE(sum(plataforma) FILTER (WHERE neto IS NOT NULL), 0), 2),
    ROUND(COALESCE(sum(propina)    FILTER (WHERE neto IS NOT NULL), 0), 2),
    ROUND(COALESCE(sum(envio)      FILTER (WHERE neto IS NOT NULL), 0), 2),
    ROUND(COALESCE(sum(neto), 0), 2)
  INTO v_ids, v_sin_desglose, v_n, v_bruto, v_comision, v_plataforma, v_propinas, v_envio, v_neto
  FROM montos;

  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'sin_pedidos_pendientes',
      'pedidos_excluidos_sin_desglose', COALESCE(to_jsonb(v_sin_desglose), '[]'::jsonb));
  END IF;

  -- ── 4. Insertar liquidación + vincular pedidos (misma transacción) ───────
  BEGIN
    INSERT INTO liquidaciones (
      id, negocio_id, mes, periodo_inicio, periodo_fin, folio,
      monto, ventas_brutas, comision_bocara, comision_plataforma, propinas, costo_envio,
      estado, total_pedidos, fecha_limite_pago, creada_por
    ) VALUES (
      v_liq_id, p_negocio_id, p_mes, v_inicio, v_fin,
      'LIQ-' || replace(p_mes, '-', '') || '-' || upper(left(replace(v_liq_id::text, '-', ''), 8)),
      v_neto, v_bruto, v_comision, v_plataforma, v_propinas, v_envio,
      'pendiente', v_n, p_fecha_limite, p_admin_id
    )
    RETURNING * INTO v_liq;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existente
    FROM liquidaciones
    WHERE negocio_id = p_negocio_id AND mes = p_mes AND estado <> 'anulado'
    LIMIT 1;
    RETURN jsonb_build_object('ok', false, 'resultado', 'mes_ya_liquidado',
      'liquidacion', to_jsonb(v_existente));
  END;

  UPDATE pedidos
  SET liquidacion_id = v_liq_id
  WHERE id = ANY (v_ids) AND liquidacion_id IS NULL;
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  -- No debería ocurrir (las filas están bloqueadas), pero si ocurre se aborta
  -- TODO — liquidación incluida — en vez de dejar un monto que no cuadra.
  IF v_actualizados <> v_n THEN
    RAISE EXCEPTION 'crear_liquidacion_mensual_atomica: se esperaban % pedidos y se vincularon %',
      v_n, v_actualizados USING ERRCODE = 'serialization_failure';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'resultado', 'creada',
    'liquidacion', to_jsonb(v_liq),
    'pedidos_ids', to_jsonb(v_ids),
    'pedidos_excluidos_sin_desglose', COALESCE(to_jsonb(v_sin_desglose), '[]'::jsonb)
  );
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE C — resenas: columnas, constraints, índices y trigger de promedio
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE resenas ADD COLUMN IF NOT EXISTS visible               boolean DEFAULT true;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS moderada_por          uuid;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS moderada_en           timestamptz;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS motivo_moderacion     text;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS respuesta_restaurante text;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS respondida_en         timestamptz;
ALTER TABLE resenas ADD COLUMN IF NOT EXISTS updated_at            timestamptz DEFAULT now();

-- Columnas destino del trigger. Ya existen en producción (calificacion_promedio
-- vía sql/schema_fix.sql; total_resenas la escribe routes/resenas.js); se
-- aseguran para que el trigger nunca falle en un entorno nuevo.
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS calificacion_promedio decimal(3,2) NOT NULL DEFAULT 0;
ALTER TABLE negocios ADD COLUMN IF NOT EXISTS total_resenas         integer      NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'resenas_comentario_largo'
      AND conrelid = 'public.resenas'::regclass
  ) THEN
    ALTER TABLE resenas
      ADD CONSTRAINT resenas_comentario_largo
      CHECK (comentario IS NULL OR char_length(comentario) <= 500) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'resenas_comentario_largo'
      AND conrelid = 'public.resenas'::regclass
      AND NOT convalidated
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM resenas WHERE char_length(comentario) > 500) THEN
      ALTER TABLE resenas VALIDATE CONSTRAINT resenas_comentario_largo;
    ELSE
      RAISE NOTICE 'resenas_comentario_largo queda NOT VALID: hay reseñas históricas de más de 500 caracteres (se exige solo en filas nuevas).';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_resenas_usuario ON resenas (usuario_id);
CREATE INDEX IF NOT EXISTS idx_resenas_negocio_visibles
  ON resenas (negocio_id, created_at DESC)
  WHERE visible IS TRUE;

-- Recalcula promedio y total de UN negocio. Determinista bajo concurrencia:
-- primero toma el lock de la fila del negocio (espera a que termine cualquier
-- otra transacción que esté recalculando el mismo negocio) y DESPUÉS agrega.
-- En READ COMMITTED cada sentencia toma un snapshot nuevo, así que el agregado
-- ya ve las reseñas que la otra transacción acaba de confirmar. Hacerlo en un
-- solo UPDATE ... FROM (subconsulta) no sirve: el snapshot de la subconsulta se
-- toma antes de esperar el lock y puede perder la reseña concurrente.
--
-- El lock es FOR NO KEY UPDATE, no FOR UPDATE: el INSERT en resenas ya tomó
-- FOR KEY SHARE sobre el negocio al validar la FK, y FOR UPDATE choca con ese
-- lock → dos reseñas simultáneas se bloquean mutuamente (deadlock reproducido
-- con 40 conexiones). FOR NO KEY UPDATE serializa los recálculos entre sí sin
-- chocar con las FKs, y es el mismo lock que toma el UPDATE negocios de abajo.
CREATE OR REPLACE FUNCTION recalcular_calificacion_negocio(p_negocio_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_promedio numeric;
  v_total    integer;
BEGIN
  IF p_negocio_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM 1 FROM negocios WHERE id = p_negocio_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN; -- negocio borrado (ON DELETE CASCADE de resenas): nada que recalcular
  END IF;

  SELECT ROUND(AVG(calificacion)::numeric, 1), COUNT(*)
    INTO v_promedio, v_total
  FROM resenas
  WHERE negocio_id = p_negocio_id
    AND visible IS TRUE;

  UPDATE negocios
  SET calificacion_promedio = COALESCE(v_promedio, 0),
      total_resenas         = v_total
  WHERE id = p_negocio_id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_resenas_recalcular_calificacion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM recalcular_calificacion_negocio(NEW.negocio_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM recalcular_calificacion_negocio(OLD.negocio_id);
  ELSIF OLD.negocio_id IS DISTINCT FROM NEW.negocio_id THEN
    -- Orden fijo de locks para no generar deadlocks entre dos reasignaciones.
    PERFORM recalcular_calificacion_negocio(LEAST(OLD.negocio_id, NEW.negocio_id));
    PERFORM recalcular_calificacion_negocio(GREATEST(OLD.negocio_id, NEW.negocio_id));
  ELSE
    PERFORM recalcular_calificacion_negocio(NEW.negocio_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Solo columnas que afectan el promedio: responder o moderar el texto no recalcula.
CREATE OR REPLACE TRIGGER resenas_recalcular_calificacion
  AFTER INSERT OR DELETE OR UPDATE OF calificacion, visible, negocio_id
  ON resenas
  FOR EACH ROW
  EXECUTE FUNCTION trg_resenas_recalcular_calificacion();

CREATE OR REPLACE FUNCTION trg_resenas_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER resenas_updated_at
  BEFORE UPDATE ON resenas
  FOR EACH ROW
  EXECUTE FUNCTION trg_resenas_updated_at();


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE D — Bucket privado para comprobantes PDF
-- Solo existe en Supabase (schema storage); en otro Postgres se omite con aviso.
-- ON CONFLICT reafirma public=false: si alguien lo marcó público a mano, vuelve
-- a privado. Los PDFs se sirven solo con URLs firmadas desde el backend.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage.buckets no existe (no es Supabase): se omite el bucket bocara-comprobantes.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('bocara-comprobantes', 'bocara-comprobantes', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  -- Límites solo si la versión de storage tiene esas columnas.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 5242880 WHERE id = 'bocara-comprobantes'$q$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) THEN
    EXECUTE $q$UPDATE storage.buckets SET allowed_mime_types = ARRAY['application/pdf'] WHERE id = 'bocara-comprobantes'$q$;
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE E — Permisos: solo el backend (service_role) ejecuta estas funciones
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION crear_liquidacion_mensual_atomica(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION crear_liquidacion_mensual_atomica(uuid, text, uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION crear_liquidacion_mensual_atomica(uuid, text, uuid, timestamptz) FROM authenticated;
GRANT  EXECUTE ON FUNCTION crear_liquidacion_mensual_atomica(uuid, text, uuid, timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION recalcular_calificacion_negocio(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION recalcular_calificacion_negocio(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION recalcular_calificacion_negocio(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION recalcular_calificacion_negocio(uuid) TO service_role;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-MIGRACIÓN (solo lectura)
-- ════════════════════════════════════════════════════════════════════════════

SELECT table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'liquidaciones' AND column_name IN ('mes','periodo_inicio','periodo_fin','folio',
      'comprobante_path','comprobante_generado_en','fecha_limite_pago','costo_envio','creada_por'))
    OR (table_name = 'resenas' AND column_name IN ('visible','moderada_por','moderada_en',
      'motivo_moderacion','respuesta_restaurante','respondida_en','updated_at'))
  )
ORDER BY table_name, column_name;

SELECT conrelid::regclass AS tabla, conname, convalidated
FROM pg_constraint
WHERE conname IN ('liquidaciones_estado_valido', 'liquidaciones_mes_formato', 'resenas_comentario_largo');

SELECT tgname, tgrelid::regclass AS tabla
FROM pg_trigger
WHERE tgname IN ('resenas_recalcular_calificacion', 'resenas_updated_at');

-- ════════════════════════════════════════════════════════════════════════════
-- OPCIONAL — reconciliación única de promedios (NO se ejecuta automáticamente).
-- El trigger corrige cada negocio en su próxima reseña; si se quiere dejar todos
-- los promedios consistentes hoy (p. ej. si la carrera anterior dejó alguno
-- desfasado), revisar y ejecutar a mano:
--
--   SELECT recalcular_calificacion_negocio(id) FROM negocios;
-- ════════════════════════════════════════════════════════════════════════════
