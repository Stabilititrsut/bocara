# Bocara — Ciclo de vida de publicaciones (BACK-1)

Aplica a toda fila de `bolsas`: `tipo = 'bolsa'` (**Tiempo limitado**) y
`tipo = 'cupon'` (**Promoción**). La regla vive en un solo lugar:
`backend/services/publicaciones.js`.

```
crear ─────────────► pendiente ──aprobar──► aprobado ──(visible si activa, vigente y con unidades)
                        │  ▲                   │
                  rechazar │ reenviar          │ cambio relevante del restaurante
                        ▼  │                   ▼
                     rechazado              pendiente (deja de verse hasta re-aprobar)
```

## 1. Reglas

| Acción | Quién | Resultado |
|---|---|---|
| Crear | restaurante | `estado_aprobacion = 'pendiente'`, `activo = true`. No visible. (Un admin crea directo en `aprobado`). |
| Editar en revisión inicial (pendiente sin motivo) | restaurante | **409**: el admin puede estar revisándola. |
| Aprobar | admin | `aprobado`, `motivo_rechazo = null`. **No toca `activo`** (es el switch del restaurante). Responde si quedó visible (ver §3). |
| Rechazar | admin | `rechazado`, `activo = false`, `motivo_rechazo` **siempre presente** (si no se manda, uno por defecto). Nunca visible. |
| Pedir cambios | admin | sigue `pendiente`, con `motivo_rechazo`. El restaurante puede editar. |
| Guardar una **rechazada** | restaurante | Reenvío: `pendiente`, `motivo_rechazo = null` y **`activo = true`** (deshace la desactivación que impuso el rechazo), salvo que mande `activo: false` explícito. |
| Guardar una **aprobada** con cambio relevante | restaurante | Vuelve a `pendiente`; deja de verse hasta que el admin apruebe la versión nueva. |
| Guardar una aprobada cambiando solo `cantidad_disponible` y/o `activo` | restaurante | Sigue `aprobado` (reponer unidades u ocultar no altera la oferta revisada). |
| Guardar el formulario sin cambios reales | restaurante | Sin efecto en la revisión (`'120'` = `120`, `'08:00'` = `'08:00:00'`). |
| Guardar respondiendo a "pedir cambios" | restaurante | Sigue `pendiente`, `motivo_rechazo = null`. |

**Campos relevantes** (vuelven a revisión): todo lo editable por `PUT /bolsas/:id`
excepto `activo` y `cantidad_disponible` — nombre, descripción, código
(`contenido`), precios, `tipo`, `categoria`, imagen, horario, `fecha_caducidad`,
categoría de alimento/menú, banderas de menú, peso, `permite_envio`.

### Visibilidad para el cliente

Una publicación aparece si y solo si **todas**:

1. `estado_aprobacion = 'aprobado'` (o `null`, filas anteriores a la columna);
2. `activo = true`;
3. `cantidad_disponible > 0` (y, en el feed, disponibilidad real descontando reservas vigentes);
4. no vencida en hora de Guatemala (`fecha_caducidad` + `hora_recogida_fin`, ver `STATE_MACHINE_Y_CONTRATOS.md` §4);
5. su negocio está `activo` y `estado_verificacion` aprobado (o `null`).

La misma función (`filtrarVisiblesParaCliente`) se aplica **después** de la
consulta en todos los endpoints públicos: `GET /api/bolsas` (feed, pestaña
Promociones `?tipo=cupon`, tienda `?negocio_id=`), `GET /api/negocios/feed`
(Home/Tiendas), `GET /api/negocios/:id`, `/:id/detalle` y `/:id/bolsas`. Los
fallbacks que relajan filtros SQL ante un error **fallan cerrado**. El detalle
`GET /api/bolsas/:id` usa la misma regla salvo la 3 (una agotada sigue
consultable y la app muestra "agotado").

Las versiones viejas nunca interfieren: cada fila se evalúa por sí misma. Una
rechazada no bloquea crear otra con el mismo nombre (el control de duplicados
solo mira publicaciones `activo = true`), y nada en las consultas públicas
depende del id o del estado de otra publicación.

## 2. Tipos

`tipo` es el único campo que decide Promoción vs Tiempo limitado. Valores
válidos: `'bolsa'` y `'cupon'` (sin `tipo` al crear → `'bolsa'`). Otro valor →
**400**. Las banderas de menú (`es_promocion`, `es_tiempo_limitado`, …) no
cambian el tipo.

## 3. Cambios de contrato de API

Todos son **aditivos** salvo el 400 por tipo inválido.

| Endpoint | Cambio |
|---|---|
| `PUT /api/admin/bolsas/:id/aprobar` | La respuesta (la fila) agrega `visible_cliente: boolean` y `motivos_no_visible: string[]` con valores `no_aprobada`, `inactiva`, `sin_unidades`, `vencida`, `negocio_no_disponible`. Aprobar algo ya aprobado es idempotente (no re-notifica ni re-audita). La notificación al restaurante dice si quedó visible o qué falta; a favoritos solo se notifica si es visible. |
| `PUT /api/admin/bolsas/:id/rechazar` | `motivo_rechazo` siempre se escribe (motivo recibido, o uno por defecto). Antes, sin motivo quedaba el de una revisión anterior. |
| `PUT /api/bolsas/:id` | Reenviar una rechazada la reactiva (`activo = true`). Cambiar solo `cantidad_disponible` en una aprobada ya no la manda a revisión. Guardar sin cambios reales tampoco. `tipo` fuera de `bolsa`/`cupon` → 400. |
| `POST /api/bolsas` | `tipo` fuera de `bolsa`/`cupon` → 400. |
| `GET` públicos | Sin cambio de forma. El fallback de `GET /api/bolsas` ahora respeta `?tipo=`. |

Auditoría (`eventos_dominio`, ver `EVENTOS_NOTIFICACIONES.md`): nuevo evento
`publicacion.reenviada_revision` con `motivo_anterior`, y `aprobada`/`rechazada`
llevan discriminador por instante, así que cada decisión de cada vuelta queda
registrada. El historial nunca se borra.

## 4. Caso Ola Azul — causa raíz

Secuencia reportada: promoción A (2x1) mal creada → rechazada → como "modificar
no funcionaba", se creó B correcta → aprobada → B no apareció al cliente.

**Backend (reproducido en `backend/test/publicacionesCiclo.test.js`):**

1. `PUT /admin/bolsas/:id/rechazar` pone `activo = false`.
2. Al corregir la rechazada, `PUT /bolsas/:id` la devolvía a `pendiente` **sin
   restaurar `activo`**.
3. `PUT /admin/bolsas/:id/aprobar` no toca `activo` (a propósito) y respondía
   éxito → la corregida quedaba **aprobada pero invisible** en todas las
   superficies. Ese es el "modificar no funciona".
4. Aprobar nunca decía si el resultado era visible: con `activo = false`, un
   horario ya vencido (las promociones traen por defecto "Válido hasta 20:00")
   o sin unidades, el admin veía "aprobado" y el cliente nada.
5. Los fallbacks de los endpoints públicos no filtraban `estado_aprobacion`
   (podían mostrar pendientes/rechazadas) y el de `GET /bolsas` perdía `?tipo=`.

**Frontend:**

6. Home, Tiendas y Promociones (pestañas, quedan montadas) y la tienda solo
   pedían datos al montarse: una publicación aprobada después no aparecía hasta
   un pull-to-refresh manual o reiniciar la app.
7. La pantalla de Promociones del restaurante (`restaurante/cupones.tsx`) no
   mostraba estado ni motivo de rechazo y no tenía forma de reactivar: el
   restaurante no podía saber por qué ni corregir la visibilidad → recreó.

Con el backend actual, B (nueva, creada bien y aprobada) **sí** se sirve en
todos los endpoints si está activa y vigente (probado). Por eso lo que ocultó B
en producción solo puede ser 6 (app abierta sin refrescar) o un dato de la
propia fila (horario vencido / `activo = false`). Confirmarlo requiere mirar la
fila real con el SQL de abajo (solo lectura).

### SQL de diagnóstico (SOLO LECTURA — Supabase → SQL Editor)

```sql
-- Todas las versiones de Ola Azul, con lo que decide su visibilidad
SELECT b.id, b.nombre, b.tipo, b.estado_aprobacion, b.motivo_rechazo,
       b.activo, b.inactivo_desde, b.cantidad_disponible,
       b.hora_recogida_inicio, b.hora_recogida_fin, b.fecha_caducidad, b.created_at,
       n.activo AS negocio_activo, n.estado_verificacion
FROM bolsas b
JOIN negocios n ON n.id = b.negocio_id
WHERE n.nombre ILIKE '%ola azul%'
ORDER BY b.created_at;

-- Aprobadas que hoy nadie ve por estar inactivas (candidatas al bug del rechazo)
SELECT b.id, n.nombre AS negocio, b.nombre, b.tipo, b.inactivo_desde, b.motivo_rechazo
FROM bolsas b JOIN negocios n ON n.id = b.negocio_id
WHERE b.estado_aprobacion = 'aprobado' AND b.activo = false
ORDER BY b.inactivo_desde DESC NULLS LAST;

-- Historial de decisiones de una publicación
SELECT event_type, payload, created_at
FROM eventos_dominio
WHERE aggregate_type = 'bolsa' AND aggregate_id = '<id>'
ORDER BY created_at;
```

Las filas que ya quedaron "aprobadas pero inactivas" por el bug no se tocan
automáticamente (ninguna migración de datos): el restaurante las activa desde su
panel (switch en Disponibles o el nuevo botón **Activar** en Promociones).

## 5. Pruebas

- `backend/test/publicacionesCiclo.test.js` — ciclo completo por HTTP con los
  routers reales sobre Supabase en memoria (`test/helpers/`): nueva, rechazo,
  corrección, Ola Azul exacto (por recreación y por edición), dos versiones,
  modificación de aprobada, matriz de estados, tipos, fallbacks y regresión
  (stock real, horario, unidades, negocio, filtros, CO₂).
- `backend/test/publicaciones.test.js` — reglas puras del servicio.
- `bocara-mobile/scripts/test-ciclo-publicaciones.cjs` — refetch al foco en
  Home/Tiendas/Promociones, estados y acciones en Promociones del restaurante,
  aviso de visibilidad en el panel admin.

## 6. Guía de pruebas manuales

Usar un negocio de prueba (no Ola Azul real) en el entorno de pruebas. Horario
amplio (p. ej. 08:00–23:00) salvo donde se indique.

**PM1 — Ola Azul (recrear).** 1) Comercio: Promociones → + Nueva → "2x1
Ceviche", precio original 120, con descuento 110 (mal) → Guardar → mensaje
"enviada a revisión" y tarjeta **En revisión**. 2) Admin: Contenido pendiente →
Rechazar con motivo "Un 2x1 de Q120 cuesta Q60". 3) Comercio: la tarjeta muestra
**✕ Rechazada** y el motivo. 4) Crear otra "2x1 Ceviche" con descuento 60 →
Guardar (no debe dar error de duplicado). 5) Admin: Aprobar → aviso "aprobado y
visible para clientes". 6) Cliente (app ya abierta): ir a Home, Tiendas y
Promociones **sin** pull-to-refresh → aparece Ola Azul y la promo de Q60.
7) Abrir la tienda y el detalle: comercio, texto, horario, unidades y etiqueta
**Promoción** correctos. **Esperado:** la aprobada aparece en todas; la
rechazada en ninguna.

**PM2 — Corregir la rechazada.** Rechazar una promo → comercio pulsa
**Corregir**, cambia el precio y guarda → mensaje "volvió a revisión", tarjeta
**En revisión** → Admin aprueba → aviso "visible" → cliente la ve (Home,
Tiendas, Promociones, tienda, detalle) con el precio nuevo.

**PM3 — Modificar una aprobada.** a) Cambiar el precio → pasa a **En
revisión** y desaparece del cliente hasta que el admin la apruebe de nuevo.
b) Cambiar solo la cantidad disponible → sigue **Visible**, sin pasar por
revisión. c) Desactivar → desaparece; Activar → reaparece, sin revisión.

**PM4 — Estados.** Confirmar que no aparecen al cliente: una pendiente, una
rechazada, una con "Válido hasta" ya pasado hoy (o `fecha_caducidad` de ayer),
una desactivada y una con 0 unidades (esta última sí abre su detalle con
"agotado" desde un enlace directo). Al aprobar la vencida, el admin ve "NO es
visible para clientes: su horario o fecha ya venció".

**PM5 — Dos versiones.** Tener del mismo comercio una versión rechazada y otra
aprobada del mismo producto (mismo nombre) → el cliente solo ve la aprobada en
todas las superficies; el comercio ve ambas en su panel.
