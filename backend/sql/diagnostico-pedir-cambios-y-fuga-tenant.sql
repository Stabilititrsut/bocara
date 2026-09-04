-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bocara — Diagnóstico: persistencia de "pedir cambios" +                ║
-- ║           posible fuga de datos entre restaurantes (bolsas)             ║
-- ║                                                                          ║
-- ║  SOLO LECTURA. No modifica ningún dato.                                  ║
-- ║  Ejecutar en: Supabase Dashboard → SQL Editor                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝


-- ════════════════════════════════════════════════════════════════════════════
-- D1. ¿"pedir cambios" guarda motivo_rechazo de verdad?
--     Busca "Papas prueba" y cualquier bolsa con motivo_rechazo no nulo.
--     Si motivo_rechazo aparece NULL en "Papas prueba" pese a haber usado
--     el botón "Modificar", la escritura del backend también está fallando
--     (no solo el problema de UI ya identificado).
-- ════════════════════════════════════════════════════════════════════════════
SELECT id, nombre, negocio_id, estado_aprobacion, motivo_rechazo, activo, created_at
FROM bolsas
WHERE nombre ILIKE '%papas prueba%'
   OR motivo_rechazo IS NOT NULL
ORDER BY created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- D2. Las bolsas sospechosas — ¿a qué negocio_id/nombre real pertenecen?
--     Esto por sí solo ya dice si son de OTRO restaurante o del mismo.
-- ════════════════════════════════════════════════════════════════════════════
SELECT b.id, b.nombre AS bolsa_nombre, b.negocio_id,
       n.nombre AS negocio_nombre, n.propietario_id,
       b.activo, b.estado_aprobacion, b.created_at
FROM bolsas b
LEFT JOIN negocios n ON n.id = b.negocio_id
WHERE b.nombre ILIKE '%cupon cafe gratis%'
   OR b.nombre ILIKE '%desayuno express%'
ORDER BY b.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- D3. Las 15 publicaciones completas de ESE restaurante — confirma si
--     todas comparten el mismo negocio_id (sin fuga) o no (fuga real).
--     Reemplaza <EMAIL_DEL_RESTAURANTE> por el email de la cuenta con la
--     que probaste "Disponibles" (usa el propietario_id/negocio_nombre
--     que salga en D2 si no tienes el email a la mano).
-- ════════════════════════════════════════════════════════════════════════════
SELECT b.id, b.nombre, b.negocio_id, n.nombre AS negocio_nombre,
       b.activo, b.estado_aprobacion, b.created_at
FROM bolsas b
JOIN negocios n ON n.id = b.negocio_id
WHERE n.propietario_id = (
  SELECT id FROM usuarios WHERE email = '<EMAIL_DEL_RESTAURANTE>'
)
ORDER BY b.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- D4. ¿Hay un mismo propietario_id con más de un negocio?
--     getNegocioIdParaUsuario() en el backend usa .single() — si un dueño
--     tiene 2+ negocios, esa consulta falla y el endpoint devuelve 404, no
--     una fuga. Pero confirma o descarta esta causa alterna.
-- ════════════════════════════════════════════════════════════════════════════
SELECT propietario_id, COUNT(*) AS cantidad_negocios,
       array_agg(id) AS negocio_ids, array_agg(nombre) AS nombres
FROM negocios
WHERE propietario_id IS NOT NULL
GROUP BY propietario_id
HAVING COUNT(*) > 1;


-- ════════════════════════════════════════════════════════════════════════════
-- D5. Bolsas con negocio_id NULL — no deberían poder aparecer en
--     mi_negocio=true (el filtro es .eq('negocio_id', nIdOwner), un NULL
--     nunca hace match con .eq()), pero se confirma que no hay ninguna
--     forma alterna de que se cuelen.
-- ════════════════════════════════════════════════════════════════════════════
SELECT id, nombre, negocio_id, activo, estado_aprobacion, created_at
FROM bolsas
WHERE negocio_id IS NULL;
