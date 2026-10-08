-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: 03 · Indicadores y Embudo — marcas de tiempo, intentos de pago,
--            analítica de sesiones, inversión publicitaria y KPIs canónicos
-- Archivo   : supabase/migrations/202610070900_indicadores_embudo_y_analitica.sql
-- Fuente    : Bocara_Guia_Visual_y_Requerimientos_Ingenieria.docx, sección 2
--             ("Indicadores y definiciones para programar").
--
-- Idempotente: SÍ — ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION / TRIGGER (PG14+) y políticas creadas solo si no
-- existen. Ejecutarla dos veces no cambia nada.
--
-- 100% aditiva: no hay DROP ni UPDATE de datos existentes. Los pedidos
-- históricos quedan con las marcas nuevas en NULL: no se reconstruyen tiempos
-- que nunca se midieron (la guía exige "Sin datos", nunca un cero inventado).
--
-- PIEZAS:
--   A. pedidos.{aceptado_en, listo_en, completado_en} + trigger que las sella
--      al cambiar `estado`. cancelado_at y cancelado_por ya existen en
--      producción (sql/cancelacion-auditoria.sql); se aseguran igualmente.
--   B. intentos_pago: un registro por intento contra Cubo (pagos fallidos /
--      abandono de pago se miden por intento, no por pedido).
--   C. eventos_analitica: embudo visita → vista de oferta → carrito → inicio de
--      pago → compra. Append-only y desacoplada de eventos_dominio (outbox).
--   D. inversion_publicitaria: inversión Meta Ads que Admin ingresa (CAC híbrido).
--   E. es_venta_valida(), venta_productos_pedido() y RPC obtener_kpis_admin().
--
-- DECISIÓN SOBRE aceptado_en:
--   confirmar_pago_cubo escribe estado='confirmado' en el MISMO UPDATE que
--   pagado_en. 'confirmado' significa "pagado", no "aceptado por el
--   restaurante": la aceptación real es confirmado → en_preparacion
--   (docs/STATE_MACHINE_Y_CONTRATOS.md). Sellar aceptado_en en 'confirmado'
--   dejaría la mediana recibido→aceptado siempre en ~0 min. Por eso aceptado_en
--   se sella SOLO al entrar a 'en_preparacion'.
--
-- PRERREQUISITOS (presentes en producción según introspección):
--   pedidos(id, usuario_id, negocio_id, bolsa_id, estado, estado_pago,
--     created_at, pagado_en, cubo_payment_intent_token, cubo_identifier,
--     snapshot_financiero, total, propina, costo_envio, comision_bocara,
--     comision_pasarela, monto_neto_restaurante, descuento_cupon, precio_bolsa,
--     cantidad), pedido_items(pedido_id, bolsa_id), bolsas(id, tipo),
--   negocios(id, zona), usuarios(id), roles anon/authenticated/service_role.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE A — pedidos: marcas de tiempo por estado
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aceptado_en   timestamptz;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS listo_en      timestamptz;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS completado_en timestamptz;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_at  timestamptz;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelado_por text;

COMMENT ON COLUMN pedidos.aceptado_en IS
  'Primera entrada a en_preparacion (el restaurante aceptó). Sellada por trigger. NULL en pedidos previos a 2026-10-07.';
COMMENT ON COLUMN pedidos.listo_en IS
  'Primera entrada a listo. Sellada por trigger.';
COMMENT ON COLUMN pedidos.completado_en IS
  'Primera entrada a completado (o recogido, legacy). Sellada por trigger.';

-- Sella la PRIMERA vez que el pedido entra a cada estado. COALESCE conserva un
-- valor ya presente: el que escribe el backend en el mismo UPDATE (stock.js
-- manda cancelado_at explícito) o el de una entrada anterior, así que un
-- reintento idempotente no mueve la marca. cancelado_por no se infiere aquí:
-- el trigger no sabe quién actuó y no se inventa el actor.
CREATE OR REPLACE FUNCTION pedidos_sellar_marcas_estado()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.estado IS NOT DISTINCT FROM OLD.estado THEN
    RETURN NEW;
  END IF;

  CASE NEW.estado
    WHEN 'en_preparacion' THEN
      NEW.aceptado_en := COALESCE(NEW.aceptado_en, now());
    WHEN 'listo' THEN
      NEW.listo_en := COALESCE(NEW.listo_en, now());
    WHEN 'completado', 'recogido' THEN
      NEW.completado_en := COALESCE(NEW.completado_en, now());
    WHEN 'cancelado' THEN
      NEW.cancelado_at := COALESCE(NEW.cancelado_at, now());
    ELSE
      NULL;
  END CASE;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pedidos_sellar_marcas_estado
  BEFORE UPDATE OF estado ON pedidos
  FOR EACH ROW
  EXECUTE FUNCTION pedidos_sellar_marcas_estado();


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE B — intentos_pago
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS intentos_pago (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id            uuid        REFERENCES pedidos(id),
  payment_intent_token text        UNIQUE,
  iniciado_en          timestamptz NOT NULL DEFAULT now(),
  resultado            text        NOT NULL DEFAULT 'pendiente'
                         CONSTRAINT intentos_pago_resultado_valido
                         CHECK (resultado IN ('pendiente', 'aprobado', 'fallido', 'expirado')),
  finalizado_en        timestamptz,
  status_raw           text,
  -- Un intento con resultado final tiene hora de cierre y uno pendiente no.
  CONSTRAINT intentos_pago_finalizado_coherente
    CHECK ((resultado = 'pendiente') = (finalizado_en IS NULL))
);

COMMENT ON TABLE intentos_pago IS
  'Un registro por intento de pago contra Cubo. Varios intentos pueden corresponder a un solo pedido: pagos fallidos se mide por intento, pedidos afectados por pedido_id distinto.';
COMMENT ON COLUMN intentos_pago.status_raw IS
  'Estado literal devuelto por Cubo (SUCCEEDED, REJECTED, FAILED, DECLINED...), para auditar el mapeo a `resultado`.';

CREATE INDEX IF NOT EXISTS intentos_pago_pedido_idx
  ON intentos_pago (pedido_id);
CREATE INDEX IF NOT EXISTS intentos_pago_resultado_iniciado_idx
  ON intentos_pago (resultado, iniciado_en);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE C — eventos_analitica (append-only)
-- ════════════════════════════════════════════════════════════════════════════
-- Sin FKs a propósito: un evento de navegación no debe fallar ni bloquear filas
-- operativas porque la oferta se eliminó o el usuario aún no existe. Las
-- compras pagadas para KPIs se leen de pedidos (es_venta_valida), nunca del
-- evento 'purchase' que manda el cliente.

CREATE TABLE IF NOT EXISTS eventos_analitica (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id text        UNIQUE,
  anon_id         text        NOT NULL,
  sesion_id       text        NOT NULL,
  usuario_id      uuid,
  evento          text        NOT NULL
                    CONSTRAINT eventos_analitica_evento_valido
                    CHECK (evento IN ('session_start', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase')),
  bolsa_id        uuid,
  negocio_id      uuid,
  pedido_id       uuid,
  ocurrido_en     timestamptz NOT NULL,
  recibido_en     timestamptz NOT NULL DEFAULT now(),
  utm_source      text,
  utm_campaign    text
);

COMMENT ON TABLE eventos_analitica IS
  'Embudo de compra (nombres de evento GA4 ecommerce). Append-only: UPDATE/DELETE bloqueados por trigger. client_event_id deduplica reintentos del cliente.';
COMMENT ON COLUMN eventos_analitica.ocurrido_en IS
  'Hora del dispositivo al ocurrir el evento. recibido_en es la hora del servidor; comparar ambas detecta relojes desfasados.';

CREATE INDEX IF NOT EXISTS eventos_analitica_sesion_idx
  ON eventos_analitica (sesion_id);
CREATE INDEX IF NOT EXISTS eventos_analitica_evento_ocurrido_idx
  ON eventos_analitica (evento, ocurrido_en);
CREATE INDEX IF NOT EXISTS eventos_analitica_negocio_idx
  ON eventos_analitica (negocio_id);

CREATE OR REPLACE FUNCTION eventos_analitica_solo_insercion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'eventos_analitica es append-only: % no permitido', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE TRIGGER eventos_analitica_solo_insercion
  BEFORE UPDATE OR DELETE ON eventos_analitica
  FOR EACH ROW
  EXECUTE FUNCTION eventos_analitica_solo_insercion();


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE D — inversion_publicitaria (CAC híbrido Meta Ads)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inversion_publicitaria (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  canal        text          NOT NULL DEFAULT 'meta_ads',
  campana      text,
  fecha_inicio date          NOT NULL,
  fecha_fin    date          NOT NULL,
  monto        numeric(12,2) NOT NULL
                 CONSTRAINT inversion_publicitaria_monto_no_negativo CHECK (monto >= 0),
  creado_por   uuid          REFERENCES usuarios(id),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT inversion_publicitaria_rango_valido CHECK (fecha_fin >= fecha_inicio)
);

COMMENT ON TABLE inversion_publicitaria IS
  'Inversión externa ingresada por Admin. Fechas en calendario de Guatemala, ambos extremos inclusivos. Conservar histórico: corregir con una fila nueva, no editando.';

CREATE INDEX IF NOT EXISTS inversion_publicitaria_rango_idx
  ON inversion_publicitaria (fecha_inicio, fecha_fin);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE RLS — mismas reglas que 202607301400_rls_lockdown_tablas_sensibles:
-- solo el backend (service_role, que ignora RLS) lee y escribe.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tabla text;
BEGIN
  FOREACH tabla IN ARRAY ARRAY['intentos_pago', 'eventos_analitica', 'inversion_publicitaria']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabla);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tabla);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tabla
        AND policyname = 'deny_all_client_access'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY "deny_all_client_access" ON public.%I
          FOR ALL
          TO anon, authenticated
          USING (false)
          WITH CHECK (false)
      $f$, tabla);
    END IF;
  END LOOP;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE E — Funciones canónicas y RPC de KPIs
-- ════════════════════════════════════════════════════════════════════════════

-- Venta válida: la ÚNICA definición que deben usar paneles, KPIs y
-- exportaciones. estado_pago='pagado' por sí solo no prueba cobro (PayU legacy
-- y /pedidos/crear lo escribían sin verificar): hacen falta los dos tokens de
-- Cubo, que solo escribe confirmar_pago_cubo tras verificar SUCCEEDED.
CREATE OR REPLACE FUNCTION es_venta_valida(p_pedido pedidos)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    p_pedido.estado_pago = 'pagado'
    AND p_pedido.estado IS DISTINCT FROM 'cancelado'
    AND p_pedido.cubo_payment_intent_token IS NOT NULL
    AND p_pedido.cubo_identifier IS NOT NULL,
    false
  );
$$;

COMMENT ON FUNCTION es_venta_valida(pedidos) IS
  'Venta válida = estado_pago pagado + estado distinto de cancelado + cubo_payment_intent_token y cubo_identifier presentes. Fuente única para KPIs.';

-- Venta de productos sin propina, envío, cargo de plataforma ni descuentos
-- financiados por Bocara. Espejo de services/liquidaciones.js#montosPedido
-- (snapshot primero) con los respaldos de services/finanzas.js
-- #obtenerSubtotalProductos para pedidos previos al snapshot.
CREATE OR REPLACE FUNCTION venta_productos_pedido(p_pedido pedidos)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT GREATEST(0, round(COALESCE(
    CASE WHEN jsonb_typeof(p_pedido.snapshot_financiero -> 'subtotal_productos') = 'number'
      THEN (p_pedido.snapshot_financiero ->> 'subtotal_productos')::numeric END,
    CASE WHEN p_pedido.monto_neto_restaurante IS NOT NULL AND p_pedido.comision_bocara IS NOT NULL
      THEN p_pedido.monto_neto_restaurante - COALESCE(p_pedido.propina, 0)
           - COALESCE(p_pedido.costo_envio, 0) + p_pedido.comision_bocara END,
    CASE WHEN p_pedido.total IS NOT NULL
      THEN p_pedido.total - COALESCE(p_pedido.propina, 0) - COALESCE(p_pedido.costo_envio, 0)
           - COALESCE(p_pedido.comision_pasarela, 0) + COALESCE(p_pedido.descuento_cupon, 0) END,
    COALESCE(p_pedido.precio_bolsa, 0) * GREATEST(1, COALESCE(p_pedido.cantidad, 1))
  ), 2));
$$;

-- Bloque estándar de un KPI de cociente. La guía exige exponer fórmula, unidad,
-- numerador y denominador; denominador cero → 'no_aplica' con valor NULL.
CREATE OR REPLACE FUNCTION kpi_cociente(
  p_formula     text,
  p_unidad      text,
  p_numerador   numeric,
  p_denominador numeric,
  p_escala      numeric DEFAULT 1
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'formula',     p_formula,
    'unidad',      p_unidad,
    'numerador',   COALESCE(p_numerador, 0),
    'denominador', COALESCE(p_denominador, 0),
    'valor',       CASE WHEN COALESCE(p_denominador, 0) = 0 THEN NULL
                        ELSE round(p_numerador / p_denominador * p_escala, 2) END,
    'estado',      CASE WHEN COALESCE(p_denominador, 0) = 0 THEN 'no_aplica' ELSE 'ok' END
  );
$$;

-- Mediana en minutos. Sin muestras no es "denominador cero" sino medición
-- ausente (pedidos anteriores a las marcas) → 'sin_datos', según la guía.
CREATE OR REPLACE FUNCTION kpi_mediana_minutos(p_formula text, p_mediana double precision, p_muestras bigint)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'formula',  p_formula,
    'unidad',   'minutos',
    'muestras', COALESCE(p_muestras, 0),
    'valor',    CASE WHEN COALESCE(p_muestras, 0) = 0 THEN NULL
                     ELSE round(p_mediana::numeric, 1) END,
    'estado',   CASE WHEN COALESCE(p_muestras, 0) = 0 THEN 'sin_datos' ELSE 'ok' END
  );
$$;

-- KPIs operativos para Admin sobre el periodo [p_desde, p_hasta).
--
-- Filtros (todos opcionales, se aplican igual a todos los KPIs):
--   p_negocio_id → pedidos.negocio_id
--   p_zona       → negocios.zona (sin distinguir mayúsculas ni espacios extremos)
--   p_tipo       → bolsas.tipo de cualquier item del pedido: 'bolsa' (tiempo
--                  limitado) o 'cupon' (promoción). Un pedido mixto entra en ambos.
--
-- Fechas de referencia:
--   cohorte de pedidos (completados, tiempos) → pedidos.created_at
--   venta (ticket, recompra)                  → COALESCE(pagado_en, created_at),
--                                               mismo criterio que liquidaciones.
CREATE OR REPLACE FUNCTION obtener_kpis_admin(
  p_desde      timestamptz,
  p_hasta      timestamptz,
  p_negocio_id uuid DEFAULT NULL,
  p_zona       text DEFAULT NULL,
  p_tipo       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_resultado jsonb;
BEGIN
  IF p_desde IS NULL OR p_hasta IS NULL OR p_desde >= p_hasta THEN
    RAISE EXCEPTION 'periodo_invalido: se requiere p_desde < p_hasta'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_tipo IS NOT NULL AND p_tipo NOT IN ('bolsa', 'cupon') THEN
    RAISE EXCEPTION 'tipo_invalido: p_tipo debe ser bolsa o cupon'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH base AS (
    SELECT
      p.id,
      p.usuario_id,
      p.estado,
      p.cancelado_por,
      p.created_at,
      p.pagado_en,
      p.aceptado_en,
      p.listo_en,
      p.completado_en,
      COALESCE(p.pagado_en, p.created_at) AS fecha_venta,
      es_venta_valida(p)                  AS venta_valida,
      -- Pedido creado válido: el pago se verificó con Cubo, aunque después se
      -- cancelara. Excluye borradores y links de pago nunca cobrados.
      (p.cubo_payment_intent_token IS NOT NULL
        AND p.cubo_identifier IS NOT NULL)  AS pago_verificado,
      venta_productos_pedido(p)           AS venta_productos
    FROM pedidos p
    LEFT JOIN negocios n ON n.id = p.negocio_id
    WHERE p.created_at < p_hasta
      AND (p_negocio_id IS NULL OR p.negocio_id = p_negocio_id)
      AND (p_zona IS NULL OR lower(btrim(n.zona)) = lower(btrim(p_zona)))
      AND (p_tipo IS NULL OR EXISTS (
            SELECT 1 FROM bolsas b
            WHERE b.tipo = p_tipo
              AND (b.id = p.bolsa_id
                   OR b.id IN (SELECT pi.bolsa_id FROM pedido_items pi WHERE pi.pedido_id = p.id))
          ))
  ),
  cohorte AS (
    SELECT * FROM base
    WHERE pago_verificado AND created_at >= p_desde
  ),
  ventas_periodo AS (
    SELECT * FROM base
    WHERE venta_valida AND fecha_venta >= p_desde AND fecha_venta < p_hasta
  ),
  compradores AS (
    SELECT
      v.usuario_id,
      (SELECT count(*) FROM base h
        WHERE h.usuario_id = v.usuario_id
          AND h.venta_valida
          AND h.fecha_venta < p_hasta) AS compras_validas
    FROM (SELECT DISTINCT usuario_id FROM ventas_periodo WHERE usuario_id IS NOT NULL) v
  ),
  agg_cohorte AS (
    SELECT
      count(*)                                                        AS creados,
      count(*) FILTER (WHERE estado IN ('completado', 'recogido'))    AS completados,
      count(*) FILTER (WHERE estado = 'cancelado')                    AS cancelados,
      count(*) FILTER (WHERE estado = 'cancelado'
                         AND cancelado_por = 'restaurante')           AS rechazados_restaurante,
      count(*) FILTER (WHERE estado NOT IN ('completado', 'recogido', 'cancelado')) AS en_curso,

      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM aceptado_en - pagado_en) / 60)
        FILTER (WHERE aceptado_en IS NOT NULL AND pagado_en IS NOT NULL)  AS med_recibido_aceptado,
      count(*) FILTER (WHERE aceptado_en IS NOT NULL AND pagado_en IS NOT NULL) AS n_recibido_aceptado,

      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM listo_en - aceptado_en) / 60)
        FILTER (WHERE listo_en IS NOT NULL AND aceptado_en IS NOT NULL)   AS med_aceptado_listo,
      count(*) FILTER (WHERE listo_en IS NOT NULL AND aceptado_en IS NOT NULL) AS n_aceptado_listo,

      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completado_en - listo_en) / 60)
        FILTER (WHERE completado_en IS NOT NULL AND listo_en IS NOT NULL) AS med_listo_completado,
      count(*) FILTER (WHERE completado_en IS NOT NULL AND listo_en IS NOT NULL) AS n_listo_completado
    FROM cohorte
  ),
  agg_ventas AS (
    SELECT count(*) AS pedidos, COALESCE(sum(venta_productos), 0) AS venta_productos
    FROM ventas_periodo
  ),
  agg_recompra AS (
    SELECT count(*)                                  AS compradores,
           count(*) FILTER (WHERE compras_validas >= 2) AS recurrentes
    FROM compradores
  )
  SELECT jsonb_build_object(
    'periodo',  jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'hasta_exclusivo', true),
    'filtros',  jsonb_build_object('negocio_id', p_negocio_id, 'zona', p_zona, 'tipo', p_tipo),
    'generado_en', now(),
    'kpis', jsonb_build_object(
      'pedidos_completados',
        kpi_cociente(
          'Pedidos completados / pedidos creados válidos de la cohorte × 100',
          '%', c.completados, c.creados, 100)
        || jsonb_build_object(
          'cohorte',     'Pedidos con pago verificado por Cubo creados en el periodo (created_at)',
          'exclusiones', 'Borradores y pedidos sin pago verificado',
          'desglose',    jsonb_build_object(
            'completados',            c.completados,
            'en_curso',               c.en_curso,
            'cancelados',             c.cancelados,
            'rechazados_restaurante', c.rechazados_restaurante),
          'periodo_abierto', p_hasta > now()),
      'recompra',
        kpi_cociente(
          'Compradores del periodo con ≥2 compras válidas acumuladas / compradores únicos del periodo × 100',
          '%', r.recurrentes, r.compradores, 100)
        || jsonb_build_object(
          'cohorte',     'Usuarios con ≥1 venta válida en el periodo; historial acumulado hasta el fin del periodo',
          'exclusiones', 'Pedidos que no cumplen es_venta_valida'),
      'ticket_promedio',
        kpi_cociente(
          'Venta de productos de pedidos pagados válidos / número de esos pedidos',
          'GTQ', v.venta_productos, v.pedidos, 1)
        || jsonb_build_object(
          'cohorte',     'Ventas válidas por fecha de pago (pagado_en, o created_at si falta)',
          'exclusiones', 'Propina, envío, cargo de plataforma y descuentos financiados por Bocara'),
      'tiempo_recibido_aceptado',
        kpi_mediana_minutos('Mediana de aceptado_en − pagado_en', c.med_recibido_aceptado, c.n_recibido_aceptado),
      'tiempo_aceptado_listo',
        kpi_mediana_minutos('Mediana de listo_en − aceptado_en (preparación)', c.med_aceptado_listo, c.n_aceptado_listo),
      'tiempo_listo_completado',
        kpi_mediana_minutos('Mediana de completado_en − listo_en (espera de recogida)', c.med_listo_completado, c.n_listo_completado)
    )
  )
  INTO v_resultado
  FROM agg_cohorte c, agg_ventas v, agg_recompra r;

  RETURN v_resultado;
END;
$$;

COMMENT ON FUNCTION obtener_kpis_admin(timestamptz, timestamptz, uuid, text, text) IS
  'KPIs operativos de Admin sobre [p_desde, p_hasta). Cada KPI expone fórmula, unidad, numerador, denominador, valor y estado (ok | no_aplica | sin_datos).';


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE F — Permisos: solo el backend (service_role) ejecuta estas funciones
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION es_venta_valida(pedidos) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION es_venta_valida(pedidos) FROM anon;
REVOKE EXECUTE ON FUNCTION es_venta_valida(pedidos) FROM authenticated;
GRANT  EXECUTE ON FUNCTION es_venta_valida(pedidos) TO service_role;

REVOKE EXECUTE ON FUNCTION venta_productos_pedido(pedidos) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION venta_productos_pedido(pedidos) FROM anon;
REVOKE EXECUTE ON FUNCTION venta_productos_pedido(pedidos) FROM authenticated;
GRANT  EXECUTE ON FUNCTION venta_productos_pedido(pedidos) TO service_role;

REVOKE EXECUTE ON FUNCTION kpi_cociente(text, text, numeric, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kpi_cociente(text, text, numeric, numeric, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION kpi_cociente(text, text, numeric, numeric, numeric) FROM authenticated;
GRANT  EXECUTE ON FUNCTION kpi_cociente(text, text, numeric, numeric, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION kpi_mediana_minutos(text, double precision, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kpi_mediana_minutos(text, double precision, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION kpi_mediana_minutos(text, double precision, bigint) FROM authenticated;
GRANT  EXECUTE ON FUNCTION kpi_mediana_minutos(text, double precision, bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION obtener_kpis_admin(timestamptz, timestamptz, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION obtener_kpis_admin(timestamptz, timestamptz, uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION obtener_kpis_admin(timestamptz, timestamptz, uuid, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION obtener_kpis_admin(timestamptz, timestamptz, uuid, text, text) TO service_role;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- Verificación manual tras aplicar
-- ════════════════════════════════════════════════════════════════════════════
--
-- SELECT obtener_kpis_admin(now() - interval '30 days', now());
-- SELECT tgname FROM pg_trigger WHERE tgname IN
--   ('pedidos_sellar_marcas_estado', 'eventos_analitica_solo_insercion');
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename IN ('intentos_pago', 'eventos_analitica', 'inversion_publicitaria');
