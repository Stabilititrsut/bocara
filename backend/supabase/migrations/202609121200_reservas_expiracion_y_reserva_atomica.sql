-- ════════════════════════════════════════════════════════════════════════════
-- Bocara — Reservas con expiración determinista + reserva atómica de stock
--
-- Plan técnico Semana 1 (Miércoles / Ingeniero 1) — AC-03.
--
-- ── Problema 1: las reservas no caducaban ───────────────────────────────────
--
-- Un pedido en 'pendiente' es una RESERVA implícita: services/stock.js lo resta
-- de la disponibilidad aunque `bolsas.cantidad_disponible` no se haya tocado
-- (el descuento real ocurre en confirmar_pago_cubo). Hasta ahora esa resta no
-- tenía caducidad: un cliente que abría el link de Cubo y cerraba la pestaña
-- dejaba la unidad bloqueada para siempre. El cron de server.js solo barre
-- 'borrador', nunca 'pendiente'.
--
-- ── Problema 2: no había reloj para medir la reserva ────────────────────────
--
-- `created_at` no sirve como origen: el flujo /pagos/preparar crea el pedido en
-- 'borrador' y puede pasar a 'pendiente' mucho después. Medir desde created_at
-- caducaría reservas recién nacidas y provocaría sobreventa. Por eso se añade
-- `reservado_at`: el instante EXACTO en que el pedido pasó a 'pendiente'.
--
-- ── Problema 3: la reserva era un TOCTOU ────────────────────────────────────
--
-- Ambos flujos de checkout leían la disponibilidad en Node y después escribían
-- el pedido. Entre la lectura y la escritura no había nada: 10 clientes
-- simultáneos sobre 3 unidades leían "3 disponibles" los 10 y reservaban los
-- 10. El exceso solo se detectaba al pagar (confirmar_pago_cubo), o sea con el
-- dinero ya cobrado y un 409 de intervención manual.
--
-- reservar_stock_pedido cierra esa ventana: bloquea las bolsas con FOR UPDATE,
-- cuenta las reservas vigentes ya commiteadas y solo entonces marca el pedido
-- como 'pendiente'. Es el mismo patrón que confirmar_pago_cubo.
--
-- Idempotente: se puede ejecutar varias veces.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 1 — Columna reservado_at
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS reservado_at timestamptz;

COMMENT ON COLUMN pedidos.reservado_at IS
  'Instante en que el pedido pasó a estado pendiente (nació la reserva de stock). '
  'NULL en borradores y en pedidos anteriores a esta migración; el cálculo de '
  'disponibilidad cae entonces a created_at. Ver services/stock.js.';

-- Backfill conservador: para los 'pendiente' que ya existen, el mejor dato
-- disponible es created_at. Los que así queden fuera de la ventana de 15 min se
-- consideran expirados en el próximo cálculo — que es justamente lo que se
-- quiere: son reservas abandonadas que llevan bloqueando stock desde siempre.
UPDATE pedidos
SET reservado_at = created_at
WHERE estado = 'pendiente'
  AND reservado_at IS NULL;

-- El cálculo de disponibilidad filtra por estado + estado_pago y ordena por el
-- instante de reserva. Índice parcial: solo las reservas vivas, que son pocas.
CREATE INDEX IF NOT EXISTS idx_pedidos_reservas_vigentes
  ON pedidos (bolsa_id, reservado_at)
  WHERE estado = 'pendiente' AND estado_pago = 'pendiente';

-- pedido_items se recorre siempre por bolsa_id al calcular reservas.
CREATE INDEX IF NOT EXISTS idx_pedido_items_bolsa
  ON pedido_items (bolsa_id);


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 — reservas_vigentes_bolsa: LA fórmula, en un solo sitio
--
-- Modelo híbrido idéntico al de services/stock.js:
--   · fuente primaria  : pedido_items (carritos multi-bolsa)
--   · fuente heredada  : pedidos.bolsa_id, SOLO si el pedido no tiene items
--     (el NOT EXISTS evita contar dos veces el mismo pedido)
--
-- Una reserva cuenta si, y solo si:
--   estado = 'pendiente' AND estado_pago = 'pendiente'
--   AND COALESCE(reservado_at, created_at) > now() - ttl
--
-- Sin marca temporal (ambas NULL) la reserva cuenta como VIGENTE. Es la
-- decisión fail-closed: ante un dato incompleto se prefiere no vender de más.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reservas_vigentes_bolsa(
  p_bolsa_id        uuid,
  p_ttl_minutos     integer DEFAULT 15,
  p_excluir_pedido  uuid    DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH corte AS (
    SELECT now() - make_interval(mins => GREATEST(p_ttl_minutos, 0)) AS limite
  ),
  vigentes AS (
    SELECT p.id, p.bolsa_id, p.cantidad
    FROM pedidos p, corte c
    WHERE p.estado = 'pendiente'
      AND p.estado_pago = 'pendiente'
      AND (p_excluir_pedido IS NULL OR p.id <> p_excluir_pedido)
      AND (
        COALESCE(p.reservado_at, p.created_at) IS NULL
        OR COALESCE(p.reservado_at, p.created_at) > c.limite
      )
  ),
  por_items AS (
    SELECT COALESCE(SUM(pi.cantidad), 0)::integer AS n
    FROM pedido_items pi
    JOIN vigentes v ON v.id = pi.pedido_id
    WHERE pi.bolsa_id = p_bolsa_id
  ),
  heredados AS (
    SELECT COALESCE(SUM(COALESCE(v.cantidad, 1)), 0)::integer AS n
    FROM vigentes v
    WHERE v.bolsa_id = p_bolsa_id
      AND NOT EXISTS (SELECT 1 FROM pedido_items pi WHERE pi.pedido_id = v.id)
  )
  SELECT por_items.n + heredados.n FROM por_items, heredados;
$$;


CREATE OR REPLACE FUNCTION disponibilidad_real_bolsa(
  p_bolsa_id        uuid,
  p_ttl_minutos     integer DEFAULT 15,
  p_excluir_pedido  uuid    DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT GREATEST(
    0,
    COALESCE((SELECT b.cantidad_disponible FROM bolsas b WHERE b.id = p_bolsa_id), 0)
      - reservas_vigentes_bolsa(p_bolsa_id, p_ttl_minutos, p_excluir_pedido)
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 3 — reservar_stock_pedido: 'borrador' → 'pendiente', atómico
--
-- Punto de convergencia de los DOS flujos de checkout (POST /pagos/cubopago y
-- POST /pagos/generar-link). Antes cada uno hacía su propia comprobación en
-- Node y su propio UPDATE.
--
--   Paso 1 — bloquear el pedido (FOR UPDATE): serializa reintentos del mismo.
--   Paso 2 — idempotencia: si ya está 'pendiente', devolver 'ya_reservado'.
--   Paso 3 — agregar SUM(cantidad) por bolsa, ORDER BY bolsa_id.
--   Paso 4 — bloquear CADA bolsa (FOR UPDATE) y verificar disponibilidad real.
--            RETURN al primer fallo: no se ha escrito nada todavía.
--   Paso 5 — marcar 'pendiente' + reservado_at = now().
--
-- Por qué se bloquea `bolsas` si esta función no la modifica: la fila de la
-- bolsa es el mutex de su inventario. Las reservas viven en `pedidos`, así que
-- dos transacciones que reservan la misma bolsa no comparten ninguna fila y no
-- se verían entre sí. Tomando el lock de la bolsa se serializan, y gracias a
-- READ COMMITTED la segunda re-lee y ve el pedido que la primera commiteó.
-- Ese es exactamente el escenario AC-03 (10 clientes / 3 unidades).
--
-- El ORDER BY bolsa_id del Paso 3 fija un orden de bloqueo determinista y
-- evita deadlocks entre carritos que comparten bolsas en distinto orden — el
-- mismo criterio que confirmar_pago_cubo.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reservar_stock_pedido(
  p_pedido_id    uuid,
  p_ttl_minutos  integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pedido      pedidos%ROWTYPE;
  v_n_bolsas    integer;
  v_bolsa_ids   uuid[];
  v_cantidades  integer[];
  v_idx         integer;
  v_disponible  integer;
  v_existe      boolean;
BEGIN
  IF p_pedido_id IS NULL THEN
    RETURN jsonb_build_object('resultado', 'parametro_invalido', 'campo', 'p_pedido_id');
  END IF;

  -- ── 1. Bloquear el pedido ─────────────────────────────────────────────────
  SELECT * INTO v_pedido FROM pedidos WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_no_encontrado');
  END IF;

  -- ── 2. Idempotencia ───────────────────────────────────────────────────────
  IF v_pedido.estado = 'pendiente' THEN
    RETURN jsonb_build_object(
      'resultado',    'ya_reservado',
      'pedido_id',    v_pedido.id,
      'reservado_at', v_pedido.reservado_at
    );
  END IF;

  -- Solo un borrador puede convertirse en reserva. Cualquier otro estado
  -- (cancelado por el barrido, ya pagado, …) se rechaza sin tocar nada.
  IF v_pedido.estado <> 'borrador' THEN
    RETURN jsonb_build_object(
      'resultado', 'estado_invalido',
      'estado',    v_pedido.estado,
      'detalle',   'Solo un pedido en borrador puede reservar stock.'
    );
  END IF;

  -- ── 3. Agregar items por bolsa, ORDER BY bolsa_id ─────────────────────────
  SELECT
    COUNT(*)::integer,
    array_agg(bolsa_id       ORDER BY bolsa_id),
    array_agg(cantidad_total ORDER BY bolsa_id)
  INTO v_n_bolsas, v_bolsa_ids, v_cantidades
  FROM (
    SELECT bolsa_id, SUM(cantidad)::integer AS cantidad_total
    FROM pedido_items
    WHERE pedido_id = p_pedido_id
    GROUP BY bolsa_id
  ) agg;

  -- Sin items, el modelo híbrido cae a pedidos.bolsa_id (pedido heredado).
  IF v_n_bolsas = 0 OR v_n_bolsas IS NULL THEN
    IF v_pedido.bolsa_id IS NULL THEN
      RETURN jsonb_build_object('resultado', 'items_ausentes', 'pedido_id', p_pedido_id);
    END IF;
    v_n_bolsas   := 1;
    v_bolsa_ids  := ARRAY[v_pedido.bolsa_id];
    v_cantidades := ARRAY[COALESCE(v_pedido.cantidad, 1)];
  END IF;

  -- ── 4. Bloquear cada bolsa y verificar disponibilidad real ────────────────
  FOR v_idx IN 1..v_n_bolsas LOOP
    SELECT TRUE INTO v_existe FROM bolsas WHERE id = v_bolsa_ids[v_idx] FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('resultado', 'bolsa_no_encontrada', 'bolsa_id', v_bolsa_ids[v_idx]);
    END IF;

    -- El propio pedido se excluye del conteo: todavía es borrador y no reserva
    -- nada, pero excluirlo explícitamente hace la función segura ante reintentos.
    v_disponible := disponibilidad_real_bolsa(v_bolsa_ids[v_idx], p_ttl_minutos, p_pedido_id);

    IF v_disponible < v_cantidades[v_idx] THEN
      RETURN jsonb_build_object(
        'resultado',  'stock_insuficiente',
        'bolsa_id',   v_bolsa_ids[v_idx],
        'disponible', v_disponible,
        'solicitado', v_cantidades[v_idx]
      );
    END IF;
  END LOOP;

  -- ── 5. Nace la reserva ────────────────────────────────────────────────────
  UPDATE pedidos
  SET estado       = 'pendiente',
      reservado_at = now()
  WHERE id = p_pedido_id
    AND estado = 'borrador';

  IF NOT FOUND THEN
    -- Imposible con el lock del Paso 1, pero si la matriz de estados cambiara
    -- el CAS seguiría siendo la última palabra.
    RETURN jsonb_build_object('resultado', 'carrera', 'pedido_id', p_pedido_id);
  END IF;

  RETURN jsonb_build_object(
    'resultado',    'reservado',
    'pedido_id',    p_pedido_id,
    'ttl_minutos',  p_ttl_minutos,
    'bolsas',       to_jsonb(v_bolsa_ids)
  );
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- BLOQUE 4 — expirar_reservas_vencidas: barrido explícito (opcional)
--
-- El cálculo de disponibilidad ya ignora las reservas caducadas, así que el
-- stock se recupera SIN necesidad de este barrido — la expiración es de lectura,
-- no depende de que ningún cron corra a tiempo. Esta función solo pone la base
-- de datos al día para que el panel de pedidos no muestre reservas zombis.
--
-- No devuelve stock a `bolsas.cantidad_disponible`: un pedido 'pendiente' nunca
-- lo descontó (eso solo lo hace confirmar_pago_cubo). Ver
-- orderStateMachine.requiereDevolucionDeStock.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION expirar_reservas_vencidas(
  p_ttl_minutos integer DEFAULT 15,
  p_limite      integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids  uuid[];
BEGIN
  WITH candidatos AS (
    SELECT p.id
    FROM pedidos p
    WHERE p.estado = 'pendiente'
      AND p.estado_pago = 'pendiente'
      AND COALESCE(p.reservado_at, p.created_at) IS NOT NULL
      AND COALESCE(p.reservado_at, p.created_at)
          <= now() - make_interval(mins => GREATEST(p_ttl_minutos, 0))
    ORDER BY COALESCE(p.reservado_at, p.created_at)
    LIMIT GREATEST(p_limite, 0)
    FOR UPDATE SKIP LOCKED
  ),
  actualizados AS (
    UPDATE pedidos p
    SET estado      = 'cancelado',
        estado_pago = 'fallido'
    FROM candidatos c
    WHERE p.id = c.id
    RETURNING p.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_ids FROM actualizados;

  RETURN jsonb_build_object(
    'resultado',   'ok',
    'expirados',   COALESCE(array_length(v_ids, 1), 0),
    'pedido_ids',  to_jsonb(v_ids)
  );
END;
$$;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- Verificación manual tras aplicar
-- ════════════════════════════════════════════════════════════════════════════
--
--   -- ¿Cuánto stock estaba bloqueado por reservas zombis?
--   SELECT b.id, b.nombre, b.cantidad_disponible,
--          reservas_vigentes_bolsa(b.id, 15)  AS reservado_vigente,
--          disponibilidad_real_bolsa(b.id, 15) AS disponible_real
--   FROM bolsas b
--   WHERE b.activo = true
--   ORDER BY disponible_real ASC
--   LIMIT 20;
--
--   -- Reservas que la expiración acaba de liberar
--   SELECT id, estado, COALESCE(reservado_at, created_at) AS desde,
--          now() - COALESCE(reservado_at, created_at)     AS antiguedad
--   FROM pedidos
--   WHERE estado = 'pendiente' AND estado_pago = 'pendiente'
--     AND COALESCE(reservado_at, created_at) <= now() - interval '15 minutes';
