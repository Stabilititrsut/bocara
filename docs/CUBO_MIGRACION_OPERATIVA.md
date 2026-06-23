# Bocara — Procedimiento operativo de migración Cubo Pago

**Commit auditado:** `a6b3c12d`
**Archivo de migración:** `sql/cubo-pago-schema.sql`
**Moneda:** GTQ (quetzales, confirmado por Cubo Pago Guatemala)
**Estado de pagos:** `CUBO_PAYMENTS_ENABLED=false` durante todo el proceso

---

## Archivo único de migración

```
C:\Users\Monica\bocara\sql\cubo-pago-schema.sql
```

Este es el único archivo que debe ejecutarse. No ejecutar ningún otro.

**No ejecutar bajo ninguna circunstancia:**
```
sql/cubo-pago-multi-item-opcional.sql
```

---

## Tres categorías de prueba

Este procedimiento distingue tres tipos de validación con alcances distintos:

### A. Validación de migración
Prechecks, ejecución del SQL, verificaciones post-migración y tests con `ROLLBACK`.
No requiere pagos habilitados. Se puede ejecutar ahora.

### B. Prueba del bloqueo de pagos
Con `CUBO_PAYMENTS_ENABLED=false`, verifica únicamente que el endpoint rechaza
la creación del pago antes de tocar la BD, el inventario o Cubo.
No valida el flujo funcional completo. Se puede ejecutar ahora.

### C. Prueba funcional controlada (fase posterior)
Requiere `CUBO_PAYMENTS_ENABLED=true` y autorización expresa.
Valida el flujo completo: pedido, items, monto GTQ, centavos, link, token,
webhook, RPC, inventario, puntos, notificaciones, idempotencia.
**No ejecutar ahora.**

---

## Parte A — Validación de migración

### A.1 Introspección previa (solo lectura)

1. Abrir `sql/introspect-schema.sql` en el editor de texto.
2. Copiar todo el contenido.
3. Supabase → SQL Editor → **New query**.
4. Pegar y ejecutar.

**Interpretar los resultados de las columnas Cubo en pedidos:**

Las seis columnas Cubo son:
```
cubo_identifier
cubo_authorization_code
pagado_en
cubo_payment_intent_token
monto_esperado_centavos
cubo_reference_id
```

| Columnas presentes | Interpretación |
|--------------------|----------------|
| 0 de 6 | Migración completamente pendiente. Continuar. |
| 1 a 5 de 6 | Estado parcial de una ejecución anterior. Verificar tipos, constraints e índices de las columnas presentes antes de continuar. La migración usa `ADD COLUMN IF NOT EXISTS` — las presentes no causan error, pero el esquema parcial debe revisarse. |
| 6 de 6 | Puede existir una migración previa. Verificar tablas, funciones, índices, permisos y constraints. Decidir si re-ejecutar o solo ejecutar los bloques faltantes. |

**Detener y consultar solo si:**
- El tipo de dato de una columna existente es incompatible con el esperado.
- Hay duplicados en `cubo_payment_intent_token` (la consulta de la sección E debe devolver 0 filas).
- Una constraint requerida entra en conflicto con datos existentes.
- Faltan tablas base: `pedidos`, `bolsas`, `usuarios`, `configuracion`, `notificaciones`.
- `pedido_items` o sus columnas (`cantidad`, `bolsa_id`, `precio_unitario`, `subtotal`) no existen.
- Hay permisos inseguros en funciones Cubo existentes.

La presencia parcial de columnas Cubo por sí sola **no es motivo de detención**.

### A.2 Ejecución de la migración

1. Abrir `sql/cubo-pago-schema.sql` en el editor de texto.
2. Copiar **todo** el contenido (Ctrl+A, Ctrl+C).
3. Supabase → SQL Editor → **New query** (pestaña nueva, separada de la de introspección).
4. Pegar el contenido completo (Ctrl+V).
5. Ejecutar.

### A.3 Resultados esperados durante la ejecución

**BLOQUE 0 — Prechecks:**
```
NOTICE: ✓ PRECHECKS: todas las verificaciones pasaron
        (incluyendo pedido_items, pedido_items.subtotal y pedidos.cantidad).
```
Si aparece `ERROR: PRECHECK FAILED: ...`, la migración se detiene sola. La base
queda intacta. Leer el mensaje, resolver la causa raíz, reiniciar desde A.1.

**BLOQUEs 1-8 — Transacción atómica (BEGIN … COMMIT):**
Los BLOQUEs 1-8 están dentro de una única transacción. Si falla cualquier
instrucción, PostgreSQL hace ROLLBACK automático de todo — la base queda
exactamente como estaba antes del BEGIN.

Resultado esperado al final del bloque atómico:
```
COMMIT
```

Si aparece `ERROR` dentro de la sección BEGIN…COMMIT: no se modificó nada.
Leer el error, no repetir la ejecución, consultar antes de continuar.

**BLOQUE 9 — Verificaciones post-migración:**
Produce resultados de SELECT. Revisarlos según la sección A.4.

**BLOQUE 10 — Tests con ROLLBACK (12 pruebas):**
```
NOTICE: ✓ Test 1: multi-item — bolsa_a=8 (10-2), bolsa_b=4 (5-1), 3 eventos registrados
NOTICE: ✓ Test 2: misma bolsa × 2 — agrupada correctamente, bolsa_a=6 (8-2)
...
NOTICE: ✓ Todos los tests v5 pasaron (12/12) — modelo híbrido pedido_items
ROLLBACK
```

El `ROLLBACK` final borra todos los datos de prueba. Nada persiste.
Los tests no crean cobros ni modifican pedidos históricos.
Si algún test falla, verás `FALLÓ:` con el detalle; consultar antes de continuar.

### A.4 Consultas post-migración (solo lectura)

Ejecutar en una pestaña nueva del SQL Editor después de que la migración termine.

```sql
-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-MIGRACIÓN — solo lectura
-- ════════════════════════════════════════════════════════════════

-- 1. Columnas Cubo en pedidos (esperado: 6 filas)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
  AND column_name IN (
    'cubo_identifier', 'cubo_authorization_code', 'pagado_en',
    'cubo_payment_intent_token', 'monto_esperado_centavos', 'cubo_reference_id'
  )
ORDER BY column_name;

-- 2. Tablas nuevas (esperado: 2 filas)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pago_eventos_pendientes', 'movimientos_puntos')
ORDER BY table_name;

-- 3. notificaciones.clave_idempotencia (esperado: true)
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'notificaciones'
    AND column_name = 'clave_idempotencia'
) AS clave_idempotencia_existe;

-- 4. Funciones SECURITY DEFINER + search_path (esperado: 3 filas)
-- Cada fila debe tener: security_definer=true, search_path_config no nulo
SELECT
  p.proname                                             AS funcion,
  p.prosecdef                                           AS security_definer,
  p.proconfig                                           AS search_path_config,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS firma
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente')
ORDER BY p.proname;

-- 5. Índices UNIQUE (esperado: 2 filas)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_pedidos_cubo_token_unique',
    'idx_notificaciones_clave_idempotencia'
  )
ORDER BY indexname;

-- 6. Índices en tablas nuevas (esperado: 4 filas)
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('pago_eventos_pendientes', 'movimientos_puntos')
ORDER BY tablename, indexname;

-- 7. CHECK constraint en pedidos (esperado: 1 fila)
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'chk_monto_esperado_centavos';

-- 8. Permisos de funciones (esperado: solo service_role — 3 filas)
-- Si aparece PUBLIC, anon o authenticated: el BLOQUE 8 no se ejecutó correctamente.
SELECT grantee, routine_name, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name IN (
    'confirmar_pago_cubo', 'sumar_puntos', 'sumar_puntos_idempotente'
  )
ORDER BY routine_name, grantee;

-- 9. configuracion: puntos_por_pedido (esperado: 1 fila con valor '10')
SELECT clave, valor FROM configuracion WHERE clave = 'puntos_por_pedido';

-- 10. UNIQUE constraint en movimientos_puntos (esperado: 1 fila)
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'public' AND table_name = 'movimientos_puntos'
  AND constraint_type = 'UNIQUE';

-- 11. pedido_items.subtotal (esperado: true)
SELECT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'pedido_items'
    AND column_name = 'subtotal'
) AS subtotal_existe;
```

**Tabla de resultados esperados:**

| Consulta | Esperado |
|----------|----------|
| 1. Columnas Cubo en pedidos | 6 filas |
| 2. Tablas nuevas | 2 filas |
| 3. clave_idempotencia | `true` |
| 4. Funciones | 3 filas — `security_definer=true`, `search_path_config` no nulo |
| 5. Índices UNIQUE | 2 filas |
| 6. Índices tablas nuevas | 4 filas |
| 7. CHECK constraint | 1 fila |
| 8. Permisos | Solo `service_role` — cualquier otro rol es un problema |
| 9. puntos_por_pedido | `'10'` |
| 10. UNIQUE movimientos_puntos | 1 fila |
| 11. subtotal existe | `true` |

---

## Parte B — Prueba del bloqueo de pagos

Esta prueba verifica únicamente que la variable `CUBO_PAYMENTS_ENABLED=false`
está siendo respetada. **No valida el flujo funcional completo.**

Con la variable en `false`, el endpoint se detiene en el primer guard antes de:
- crear ningún pedido
- insertar `pedido_items`
- calcular el total
- convertir GTQ a centavos
- llamar a Cubo
- recibir un `paymentIntentToken`
- guardar ningún token
- modificar el inventario

**Cómo ejecutarla:**

```bash
curl -X POST https://bocara.onrender.com/api/pagos/cubopago \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-de-usuario>" \
  -d '{"bolsa_id": "<uuid>", "tipo_entrega": "recogida"}'
```

**Resultado esperado — HTTP 503:**
```json
{ "error": "Pagos temporalmente deshabilitados" }
```

Esta respuesta confirma que:
1. `CUBO_PAYMENTS_ENABLED=false` está siendo respetado.
2. El endpoint devuelve HTTP 503.
3. No se crea ningún pedido Cubo.
4. No se llama a Cubo.
5. No se modifica el inventario.
6. No se guarda ningún token.

Una respuesta distinta a esta (por ejemplo, un intento de crear el pedido o un
error de BD) indica que la variable no está configurada correctamente en Render.

---

## Parte C — Prueba funcional controlada (fase posterior)

**No ejecutar ahora.**

Esta fase requiere autorización expresa y activar temporalmente
`CUBO_PAYMENTS_ENABLED=true` en Render.

Validará el flujo completo de extremo a extremo:
- Creación del pedido en estado `pendiente`.
- Inserción completa de `pedido_items`.
- Cálculo del total desde el servidor (nunca del cliente).
- Conversión del monto GTQ a centavos: `Math.round(total * 100)`.
- Creación del link de pago en Cubo (`POST /api/v1/links/one-use`).
- Recepción y almacenamiento del `paymentIntentToken`.
- Llegada del webhook Cubo con `status: SUCCEEDED`.
- Consulta independiente a Cubo (`GET /api/v1/transactions/:token`).
- Verificación de moneda (`GTQ`) y monto (centavos).
- Ejecución atómica de `confirmar_pago_cubo` (RPC).
- Descuento de inventario en `bolsas.cantidad_disponible`.
- Suma de puntos idempotente.
- Notificaciones idempotentes al cliente y al restaurante.
- Verificación de idempotencia ante webhook duplicado.

La activación solo ocurrirá cuando se confirme explícitamente que:
- La migración terminó sin errores.
- Los 12/12 tests del BLOQUE 10 pasaron.
- Las verificaciones post-migración de la parte A.4 son correctas.
- El backend muestra `pagos_habilitados: false`.
- El webhook URL está configurado en Cubo Admin.
- Cubo confirma que la cuenta está en GTQ.

---

## Validación del backend

Después de la migración, verificar que el backend responde correctamente:

```
GET https://bocara.onrender.com/api/admin/cubo-status
Authorization: Bearer <token-de-admin>
```

**Resultado esperado (sin cambios — la migración no toca la lógica de pagos):**
```json
{
  "ambiente": "production",
  "pagos_habilitados": false,
  "api_url_produccion": true,
  "api_key_configurada": true
}
```

`pagos_habilitados: false` debe permanecer en `false`.
Si aparece `true`, hay un problema de configuración en Render — no continuar.

---

## Plan de reversión

Si es necesario revertir la migración, el bloque comentado al final de
`sql/cubo-pago-schema.sql` contiene el SQL de rollback completo.
Ejecutar **solo si es necesario** — afecta datos reales.

---

## Checklist de ejecución

```
PARTE A — VALIDACIÓN DE MIGRACIÓN

[ ] 1.  Abrir sql/introspect-schema.sql
[ ] 2.  Copiar todo el contenido
[ ] 3.  Supabase → SQL Editor → New query
[ ] 4.  Pegar y ejecutar
[ ] 5.  Verificar: tablas base presentes (pedidos, bolsas, usuarios,
        configuracion, notificaciones)
[ ] 6.  Verificar: pedido_items presente (true)
[ ] 7.  Verificar: pedidos.cantidad presente (true)
[ ] 8.  Verificar columnas Cubo en pedidos e interpretar:
          0 filas     → migración pendiente, continuar
          1 a 5 filas → estado parcial, revisar tipos y constraints
          6 filas     → migración previa, revisar completitud
[ ] 9.  Verificar: duplicados en cubo_payment_intent_token = 0 filas
        (si hay duplicados → detener, resolver antes de continuar)
[ ] 10. Si tipos de columnas existentes son incompatibles → detener

[ ] 11. Abrir sql/cubo-pago-schema.sql (único archivo de migración)
[ ] 12. Copiar TODO el contenido del archivo (Ctrl+A, Ctrl+C)
[ ] 13. Supabase → SQL Editor → New query (pestaña nueva)
[ ] 14. Pegar el contenido completo
[ ] 15. Ejecutar
[ ] 16. Confirmar BLOQUE 0: "✓ PRECHECKS: todas las verificaciones pasaron"
        (si aparece PRECHECK FAILED → no se modificó nada, resolver y reiniciar)
[ ] 17. Confirmar BLOQUEs 1-8: ningún ERROR dentro del bloque BEGIN…COMMIT
[ ] 18. Confirmar: aparece COMMIT al final de los BLOQUEs 1-8
[ ] 19. Confirmar BLOQUE 10: "✓ Todos los tests v5 pasaron (12/12)"
[ ] 20. Confirmar: aparece ROLLBACK después de los tests
        (datos de prueba borrados, nada persiste)

[ ] 21. Supabase → SQL Editor → New query (pestaña nueva)
[ ] 22. Pegar y ejecutar las consultas de verificación de la sección A.4
[ ] 23. Confirmar: 6 columnas Cubo en pedidos
[ ] 24. Confirmar: 2 tablas nuevas creadas
[ ] 25. Confirmar: clave_idempotencia = true
[ ] 26. Confirmar: 3 funciones con security_definer=true y search_path configurado
[ ] 27. Confirmar: permisos = únicamente service_role (ningún otro rol)
        (si aparece PUBLIC, anon o authenticated → problema crítico de permisos)
[ ] 28. Confirmar: 2 índices UNIQUE, 4 índices en tablas nuevas
[ ] 29. Confirmar: CHECK constraint presente
[ ] 30. Confirmar: puntos_por_pedido = '10'
[ ] 31. Confirmar: subtotal_existe = true

VALIDACIÓN DEL BACKEND

[ ] 32. GET /api/admin/cubo-status con token de admin
[ ] 33. Confirmar: pagos_habilitados = false
[ ] 34. Confirmar: api_url_produccion = true, api_key_configurada = true

PARTE B — PRUEBA DEL BLOQUEO DE PAGOS

[ ] 35. Ejecutar POST /api/pagos/cubopago con CUBO_PAYMENTS_ENABLED=false
[ ] 36. Confirmar respuesta HTTP 503: {"error": "Pagos temporalmente deshabilitados"}
        (esta prueba NO valida el flujo funcional completo —
         solo confirma que el guard de pagos está activo)

[ ] 37. Reportar resultados de todos los pasos anteriores

NO EJECUTAR

[ ] ✗   No activar CUBO_PAYMENTS_ENABLED=true
[ ] ✗   No ejecutar sql/cubo-pago-multi-item-opcional.sql
[ ] ✗   No hacer transacciones reales con Cubo
[ ] ✗   No modificar datos históricos
[ ] ✗   No cambiar variables en Render sin autorización expresa
[ ] ✗   No ejecutar la Parte C (prueba funcional controlada) sin autorización
```

---

## Variables confirmadas

```env
CUBO_CURRENCY=GTQ           # moneda confirmada por Cubo Pago Guatemala
CUBO_PAYMENTS_ENABLED=false # no se activa hasta autorización expresa
```
