-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: Sistema de cupones y referidos (v2)
-- Archivo   : supabase/migrations/202406241200_cupones_referidos.sql
--
-- Idempotente : SÍ — segura para ejecutar varias veces
-- Pre-condición: tablas `usuarios` y `pedidos` existentes
-- Cómo ejecutar: Supabase Dashboard → SQL Editor → pegar y ejecutar
--
-- IMPORTANTE: NO habilitar CUBO_PAYMENTS_ENABLED ni CUPONES_MIGRADO=true
--             hasta que esta migración haya sido ejecutada y validada.
--
-- DISEÑO DE ESTADOS DEL CUPÓN:
--   validado  → /cupones/validar devuelve ok (sin efecto en BD)
--   reservado → cupon_reservas.estado='activa' (creado en /pagos/preparar via RPC)
--   consumido → cupon_reservas.estado='consumida' + cupon_usos row (webhook SUCCEEDED)
--   liberado  → cupon_reservas.estado='liberada' (borrador vence/cancela/reemplaza)
--
-- NOTA: La tabla `cupones_usuarios` del diseño original NO se crea.
--       Se reemplaza por `cupon_reservas` (estado temporal) + `cupon_usos` (permanente).
--
-- ROLLBACK: ver bloque al final del archivo
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. TABLA cupones ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cupones (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo               text        NOT NULL UNIQUE,
  tipo                 text        NOT NULL CHECK (tipo IN ('porcentaje', 'monto_fijo', 'referido')),
  valor                numeric     NOT NULL CHECK (valor > 0),
  uso_maximo           integer     NOT NULL DEFAULT 1  CHECK (uso_maximo > 0),
  uso_por_usuario      integer     NOT NULL DEFAULT 1  CHECK (uso_por_usuario > 0),
  usos_actuales        integer     NOT NULL DEFAULT 0  CHECK (usos_actuales >= 0),
  activo               boolean     NOT NULL DEFAULT true,
  fecha_vencimiento    timestamptz,
  -- Opcional: restringe el cupón a un único usuario (ej. cupón de referido)
  usuario_id_exclusivo uuid        REFERENCES usuarios(id) ON DELETE SET NULL,
  descripcion          text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cupones_codigo
  ON cupones (codigo);
CREATE INDEX IF NOT EXISTS idx_cupones_activo_vigente
  ON cupones (activo, fecha_vencimiento)
  WHERE activo = true;

-- ── 2. TABLA cupon_reservas (estado 'reservado') ──────────────────────────────
-- Registra que un cupón está en uso en un pedido borrador/pendiente.
-- Se libera cuando el borrador vence, se cancela o es reemplazado.
-- Se convierte en 'consumida' cuando el pago es confirmado por webhook.
CREATE TABLE IF NOT EXISTS cupon_reservas (
  id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  cupon_id            uuid        NOT NULL REFERENCES cupones(id) ON DELETE CASCADE,
  usuario_id          uuid        NOT NULL,
  pedido_id           uuid        NOT NULL,
  descuento_aplicado  numeric     NOT NULL CHECK (descuento_aplicado >= 0),
  estado              text        NOT NULL DEFAULT 'activa'
                                    CHECK (estado IN ('activa', 'consumida', 'liberada')),
  expires_at          timestamptz NOT NULL,
  consumida_at        timestamptz,
  liberada_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cupon_reservas_pedido
  ON cupon_reservas (pedido_id);
CREATE INDEX IF NOT EXISTS idx_cupon_reservas_cupon_usuario
  ON cupon_reservas (cupon_id, usuario_id);
-- Índice parcial para búsquedas de reservas activas no vencidas
CREATE INDEX IF NOT EXISTS idx_cupon_reservas_activas
  ON cupon_reservas (estado, expires_at)
  WHERE estado = 'activa';

-- ── 3. TABLA cupon_usos (estado 'consumido') ──────────────────────────────────
-- Registro permanente tras confirmación de pago.
-- UNIQUE (pedido_id) garantiza idempotencia ante webhooks repetidos.
CREATE TABLE IF NOT EXISTS cupon_usos (
  id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  cupon_id            uuid        NOT NULL REFERENCES cupones(id),
  usuario_id          uuid        NOT NULL,
  pedido_id           uuid        NOT NULL UNIQUE,
  descuento_aplicado  numeric     NOT NULL CHECK (descuento_aplicado >= 0),
  reserva_id          uuid        REFERENCES cupon_reservas(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cupon_usos_cupon_usuario
  ON cupon_usos (cupon_id, usuario_id);

-- ── 4. COLUMNAS en tabla usuarios ─────────────────────────────────────────────
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_referido          text        UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referido_por             uuid        REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS credito_referido         numeric     NOT NULL DEFAULT 0 CHECK (credito_referido >= 0);
-- Timestamp de cuando el referidor fue recompensado por este usuario (idempotencia)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS referido_recompensado_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_usuarios_codigo_referido
  ON usuarios (codigo_referido)
  WHERE codigo_referido IS NOT NULL;

-- ── 5. COLUMNA descuento_cupon en pedidos ─────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS descuento_cupon numeric NOT NULL DEFAULT 0
  CHECK (descuento_cupon >= 0);

-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCIONES TRANSACCIONALES
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 6. reservar_cupon ─────────────────────────────────────────────────────────
-- Valida y reserva atómicamente un cupón para un pedido borrador.
-- Usa FOR UPDATE para eliminar condiciones de carrera entre solicitudes concurrentes.
--
-- Parámetros:
--   p_cupon_id      : id del cupón a reservar
--   p_usuario_id    : id del usuario que aplica el cupón
--   p_pedido_id     : id del pedido borrador
--   p_monto_pedido  : subtotal del pedido (sin descuento) para calcular el descuento
--
-- Retorna jsonb:
--   ok=true  → { ok, resultado:'reservado', reserva_id, descuento, mensaje }
--   ok=false → { ok, resultado: <codigo_error> }
--     códigos de error: cupon_no_encontrado | cupon_inactivo | cupon_vencido |
--                       cupon_exclusivo | limite_global_alcanzado | limite_usuario_alcanzado
CREATE OR REPLACE FUNCTION reservar_cupon(
  p_cupon_id     uuid,
  p_usuario_id   uuid,
  p_pedido_id    uuid,
  p_monto_pedido numeric
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_cupon         cupones%ROWTYPE;
  v_globales      bigint;
  v_por_usuario   bigint;
  v_descuento     numeric;
  v_reserva_id    uuid;
BEGIN
  -- Bloquear la fila del cupón — previene lecturas sucias en inserciones concurrentes
  SELECT * INTO v_cupon FROM cupones WHERE id = p_cupon_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_no_encontrado');
  END IF;

  IF NOT v_cupon.activo THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_inactivo');
  END IF;

  IF v_cupon.fecha_vencimiento IS NOT NULL AND v_cupon.fecha_vencimiento < now() THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_vencido');
  END IF;

  IF v_cupon.usuario_id_exclusivo IS NOT NULL
     AND v_cupon.usuario_id_exclusivo <> p_usuario_id THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'cupon_exclusivo');
  END IF;

  -- Reservas activas (no vencidas) + usos confirmados — conteo global
  SELECT
    (SELECT COUNT(*) FROM cupon_reservas
       WHERE cupon_id  = p_cupon_id
         AND estado    = 'activa'
         AND expires_at > now())
    +
    (SELECT COUNT(*) FROM cupon_usos WHERE cupon_id = p_cupon_id)
  INTO v_globales;

  IF v_globales >= v_cupon.uso_maximo THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'limite_global_alcanzado');
  END IF;

  -- Conteo por usuario
  SELECT
    (SELECT COUNT(*) FROM cupon_reservas
       WHERE cupon_id  = p_cupon_id
         AND usuario_id = p_usuario_id
         AND estado    = 'activa'
         AND expires_at > now())
    +
    (SELECT COUNT(*) FROM cupon_usos
       WHERE cupon_id  = p_cupon_id AND usuario_id = p_usuario_id)
  INTO v_por_usuario;

  IF v_por_usuario >= v_cupon.uso_por_usuario THEN
    RETURN jsonb_build_object('ok', false, 'resultado', 'limite_usuario_alcanzado');
  END IF;

  -- Calcular descuento
  IF v_cupon.tipo = 'porcentaje' THEN
    v_descuento := ROUND((p_monto_pedido * v_cupon.valor / 100.0)::numeric, 2);
  ELSE
    v_descuento := LEAST(v_cupon.valor::numeric, p_monto_pedido);
  END IF;
  v_descuento := GREATEST(0, ROUND(v_descuento, 2));

  -- Liberar reservas previas de este usuario para el mismo pedido (re-aplicación)
  UPDATE cupon_reservas
  SET estado = 'liberada', liberada_at = now()
  WHERE cupon_id   = p_cupon_id
    AND usuario_id = p_usuario_id
    AND pedido_id  = p_pedido_id
    AND estado     = 'activa';

  -- Insertar reserva con TTL de 2 horas
  INSERT INTO cupon_reservas (cupon_id, usuario_id, pedido_id, descuento_aplicado, expires_at)
  VALUES (p_cupon_id, p_usuario_id, p_pedido_id, v_descuento, now() + INTERVAL '2 hours')
  RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'resultado',  'reservado',
    'reserva_id', v_reserva_id,
    'descuento',  v_descuento,
    'mensaje',    CASE
      WHEN v_cupon.tipo = 'porcentaje'
        THEN v_cupon.valor::text || '% de descuento — ahorras Q' || v_descuento::text
      ELSE 'Descuento de Q' || v_descuento::text || ' aplicado'
    END
  );
END;
$$;

-- ── 7. liberar_reserva_cupon ──────────────────────────────────────────────────
-- Libera todas las reservas activas asociadas a un pedido.
-- Llamar cuando el pedido se cancela, vence o es reemplazado por uno nuevo.
CREATE OR REPLACE FUNCTION liberar_reserva_cupon(p_pedido_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE cupon_reservas
  SET estado = 'liberada', liberada_at = now()
  WHERE pedido_id = p_pedido_id AND estado = 'activa';
END;
$$;

-- ── 8. consumir_cupon_pedido ──────────────────────────────────────────────────
-- Convierte la reserva activa de un pedido en uso confirmado.
-- Llamar SOLO desde el procesador del webhook de pago confirmado.
-- Idempotente: ON CONFLICT DO NOTHING en cupon_usos.
CREATE OR REPLACE FUNCTION consumir_cupon_pedido(p_pedido_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_reserva cupon_reservas%ROWTYPE;
BEGIN
  SELECT * INTO v_reserva
  FROM cupon_reservas
  WHERE pedido_id = p_pedido_id
    AND estado    = 'activa'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN; -- Sin reserva activa: nada que consumir (idempotente)
  END IF;

  UPDATE cupon_reservas
  SET estado = 'consumida', consumida_at = now()
  WHERE id = v_reserva.id;

  -- UNIQUE (pedido_id) en cupon_usos garantiza idempotencia ante reintentos
  INSERT INTO cupon_usos (cupon_id, usuario_id, pedido_id, descuento_aplicado, reserva_id)
  VALUES (v_reserva.cupon_id, v_reserva.usuario_id, p_pedido_id,
          v_reserva.descuento_aplicado, v_reserva.id)
  ON CONFLICT (pedido_id) DO NOTHING;

  -- Incrementar usos_actuales de forma atómica (nunca desde Node.js)
  UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE id = v_reserva.cupon_id;
END;
$$;

-- ── 9. procesar_recompensa_referido ───────────────────────────────────────────
-- Otorga Q10 al referidor y crea cupón de bienvenida para el nuevo usuario
-- SOLO tras confirmar su primera compra válida y pagada.
--
-- Garantías:
--   · Se ejecuta solo una vez por usuario (referido_recompensado_at)
--   · Previene autorreferidos
--   · Cupón vinculado exclusivamente al nuevo usuario (usuario_id_exclusivo)
--   · Idempotente ante webhooks duplicados
--
-- Retorna: 'procesado' | 'ya_recompensado' | 'sin_referidor' |
--          'autorreferido' | 'usuario_no_encontrado'
CREATE OR REPLACE FUNCTION procesar_recompensa_referido(
  p_nuevo_usuario_id uuid,
  p_pedido_id        uuid
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_usuario      usuarios%ROWTYPE;
  v_codigo_cupon text;
BEGIN
  SELECT * INTO v_usuario FROM usuarios WHERE id = p_nuevo_usuario_id FOR UPDATE;

  IF NOT FOUND THEN RETURN 'usuario_no_encontrado'; END IF;

  IF v_usuario.referido_por IS NULL THEN RETURN 'sin_referidor'; END IF;

  IF v_usuario.referido_por = p_nuevo_usuario_id THEN RETURN 'autorreferido'; END IF;

  -- Idempotencia: ya se procesó en una ejecución anterior
  IF v_usuario.referido_recompensado_at IS NOT NULL THEN RETURN 'ya_recompensado'; END IF;

  -- Marcar primero para prevenir doble procesamiento ante reintentos concurrentes
  UPDATE usuarios SET referido_recompensado_at = now() WHERE id = p_nuevo_usuario_id;

  -- Acreditar Q10 al referidor
  UPDATE usuarios
  SET credito_referido = COALESCE(credito_referido, 0) + 10
  WHERE id = v_usuario.referido_por;

  -- Crear cupón de bienvenida vinculado exclusivamente al nuevo usuario
  v_codigo_cupon := 'REF-' || upper(substring(p_nuevo_usuario_id::text, 1, 8));
  INSERT INTO cupones (
    codigo, tipo, valor, uso_maximo, uso_por_usuario,
    activo, usuario_id_exclusivo, descripcion
  )
  VALUES (
    v_codigo_cupon, 'monto_fijo', 10, 1, 1,
    true, p_nuevo_usuario_id, 'Bienvenida por referido'
  )
  ON CONFLICT (codigo) DO NOTHING;

  RETURN 'procesado';
END;
$$;

-- ── 10. incrementar_credito ───────────────────────────────────────────────────
-- Mantiene la firma existente. Actualización segura (sin condición de carrera).
CREATE OR REPLACE FUNCTION incrementar_credito(usuario_id uuid, monto numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE usuarios
  SET credito_referido = COALESCE(credito_referido, 0) + monto
  WHERE id = usuario_id;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (solo si necesitas revertir esta migración)
-- ══════════════════════════════════════════════════════════════════════════════
--
-- DROP FUNCTION IF EXISTS procesar_recompensa_referido(uuid, uuid);
-- DROP FUNCTION IF EXISTS consumir_cupon_pedido(uuid);
-- DROP FUNCTION IF EXISTS liberar_reserva_cupon(uuid);
-- DROP FUNCTION IF EXISTS reservar_cupon(uuid, uuid, uuid, numeric);
-- DROP FUNCTION IF EXISTS incrementar_credito(uuid, numeric);
-- DROP TABLE IF EXISTS cupon_usos;
-- DROP TABLE IF EXISTS cupon_reservas;
-- DROP TABLE IF EXISTS cupones;
-- ALTER TABLE usuarios DROP COLUMN IF EXISTS referido_recompensado_at;
-- ALTER TABLE usuarios DROP COLUMN IF EXISTS credito_referido;
-- ALTER TABLE usuarios DROP COLUMN IF EXISTS referido_por;
-- ALTER TABLE usuarios DROP COLUMN IF EXISTS codigo_referido;
-- ALTER TABLE pedidos  DROP COLUMN IF EXISTS descuento_cupon;
