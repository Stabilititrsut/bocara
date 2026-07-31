-- ══════════════════════════════════════════════════════════════════════════════
-- Migración: Bloqueo de acceso directo a tablas sensibles vía anon key
-- Archivo   : supabase/migrations/202607301400_rls_lockdown_tablas_sensibles.sql
--
-- Idempotente  : SÍ — segura para ejecutar varias veces (DROP POLICY IF EXISTS
--                antes de recrear; ENABLE/FORCE ROW LEVEL SECURITY son idempotentes)
-- Pre-condición: ninguna — aplica a las tablas existentes tal como están hoy
-- Ejecutar en  : Supabase Dashboard → SQL Editor
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Problema (2026-07-30):                                               ║
-- ║  La clave pública (anon key) de Supabase está embebida en el código   ║
-- ║  del frontend (bocara-mobile/src/services/supabase.ts) — como es      ║
-- ║  normal y esperado para cualquier app cliente de Supabase. Pero si    ║
-- ║  Row Level Security (RLS) está desactivado o sin políticas en las     ║
-- ║  tablas, cualquier persona con esa clave puede leer o escribir        ║
-- ║  directamente contra REST de Supabase (ej. GET/POST                   ║
-- ║  https://tbbjrethcgjxkfazntaa.supabase.co/rest/v1/pedidos),           ║
-- ║  saltándose por completo el backend (Express) y su autenticación      ║
-- ║  JWT propia.                                                          ║
-- ║                                                                        ║
-- ║  Auditoría del código (no hay acceso directo a Postgres desde este    ║
-- ║  entorno — ejecutar la sección 1 primero para confirmar el estado     ║
-- ║  real antes de aplicar la sección 2):                                 ║
-- ║  · Ningún archivo de este repo (migrations/, sql/, backend/scripts)   ║
-- ║    contiene `ENABLE ROW LEVEL SECURITY` para las tablas de negocio.   ║
-- ║    Los únicos `CREATE POLICY` existentes son para storage.objects     ║
-- ║    (bucket de imágenes públicas), no para tablas de datos.            ║
-- ║  · El backend (config/supabase.js) usa SUPABASE_SERVICE_KEY para      ║
-- ║    TODAS las consultas — el service_role de Supabase ignora RLS por   ║
-- ║    diseño, así que activar RLS no rompe ningún endpoint existente.    ║
-- ║  · El frontend (bocara-mobile) usa el cliente Supabase con anon key   ║
-- ║    ÚNICAMENTE para el handshake de autenticación (OAuth de Google,    ║
-- ║    verificación de OTP por email vía supabase.auth.*) — no hay        ║
-- ║    ninguna llamada .from(...) directa a tablas desde el cliente en    ║
-- ║    todo el código de bocara-mobile. Confirmado por grep.              ║
-- ║                                                                        ║
-- ║  Por qué el bloqueo es "deny-all" y no reglas por auth.uid():         ║
-- ║  La identidad real de los usuarios de Bocara es un JWT propio,        ║
-- ║  firmado con JWT_SECRET (bcrypt + jsonwebtoken en routes/auth.js),    ║
-- ║  completamente independiente del sistema de Supabase Auth. El id de  ║
-- ║  `usuarios` NO se hace igual al id de `auth.users` ni en registro     ║
-- ║  normal ni en OAuth (ver routes/auth.js: POST /registro y             ║
-- ║  POST /oauth-complete — ambos hacen INSERT con id autogenerado).      ║
-- ║  Como PostgREST/Supabase solo reconoce sus propios JWT de Auth para   ║
-- ║  poblar auth.uid(), una política "auth.uid() = usuario_id" NUNCA      ║
-- ║  daría acceso real a un usuario legítimo de esta app (auth.uid()      ║
-- ║  jamás coincide con usuarios.id) — sería una falsa sensación de       ║
-- ║  seguridad granular. La política correcta y honesta, dado que TODA    ║
-- ║  la autorización real ya vive en el backend Express, es: nadie sin    ║
-- ║  service_role puede tocar estas tablas desde el cliente. Punto.       ║
-- ║                                                                        ║
-- ║  Si en el futuro se migra el login a Supabase Auth como fuente de     ║
-- ║  identidad (y se garantiza usuarios.id = auth.users.id), ahí sí       ║
-- ║  tiene sentido reemplazar el "deny all" por políticas por fila con    ║
-- ║  auth.uid(). Hasta entonces, esto sería falso.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- 1. DIAGNÓSTICO — ejecutar primero, solo lectura, no modifica nada
-- ════════════════════════════════════════════════════════════════════════════

-- 1a. ¿RLS activado en cada tabla sensible?
SELECT
  c.relname                                   AS tabla,
  c.relrowsecurity                            AS rls_activado,
  c.relforcerowsecurity                       AS rls_forzado_para_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'usuarios', 'negocios', 'bolsas', 'pedidos', 'pedido_items',
    'cupones', 'cupon_usos', 'cupon_reservas', 'liquidaciones',
    'configuracion', 'favoritos', 'notificaciones', 'resenas',
    'negocio_cambios_pendientes', 'factores_co2_alimentos',
    'pago_eventos_pendientes'
  )
ORDER BY c.relname;

-- 1b. Políticas existentes por tabla (vacío = sin ninguna política)
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 1c. Privilegios de tabla otorgados a anon/authenticated (independientes de RLS,
--     pero relevantes: si RLS está OFF, estos privilegios sí aplican tal cual)
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (
    'usuarios', 'negocios', 'bolsas', 'pedidos', 'pedido_items',
    'cupones', 'cupon_usos', 'cupon_reservas', 'liquidaciones',
    'configuracion', 'favoritos', 'notificaciones', 'resenas',
    'negocio_cambios_pendientes', 'factores_co2_alimentos',
    'pago_eventos_pendientes'
  )
ORDER BY table_name, grantee;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. LOCKDOWN — activar RLS + denegar explícitamente a anon/authenticated
--    en TODAS las tablas de negocio. El backend (service_role) sigue
--    funcionando sin cambios porque service_role ignora RLS por diseño.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tabla TEXT;
BEGIN
  FOREACH tabla IN ARRAY ARRAY[
    'usuarios', 'negocios', 'bolsas', 'pedidos', 'pedido_items',
    'cupones', 'cupon_usos', 'cupon_reservas', 'liquidaciones',
    'configuracion', 'favoritos', 'notificaciones', 'resenas',
    'negocio_cambios_pendientes', 'factores_co2_alimentos',
    'pago_eventos_pendientes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabla);
    -- FORCE: aplica RLS incluso si algún día una tabla queda de propiedad de un
    -- rol distinto a postgres/service_role (defensa adicional, no afecta al
    -- service_role usado por el backend, que siempre bypassea RLS).
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tabla);

    -- Elimina cualquier política previa con este nombre antes de recrearla,
    -- para que el script sea reejecutable sin error.
    EXECUTE format('DROP POLICY IF EXISTS "deny_all_client_access" ON public.%I', tabla);
    EXECUTE format($f$
      CREATE POLICY "deny_all_client_access" ON public.%I
        FOR ALL
        TO anon, authenticated
        USING (false)
        WITH CHECK (false)
    $f$, tabla);
  END LOOP;
END $$;

-- Nota: con RLS activado y sin ninguna política que otorgue acceso a
-- anon/authenticated, Postgres ya deniega todo por defecto — la política
-- "deny_all_client_access" de arriba es redundante a propósito: documenta
-- la decisión explícitamente en el esquema en vez de dejarla implícita.


-- ════════════════════════════════════════════════════════════════════════════
-- 3. VERIFICACIÓN — reejecutar el bloque 1a para confirmar rls_activado = true
--    en las 16 tablas y que aparecen las 16 políticas "deny_all_client_access"
--    en el bloque 1b.
-- ════════════════════════════════════════════════════════════════════════════
