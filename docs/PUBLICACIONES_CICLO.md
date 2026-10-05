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
| Aprobar | admin | `aprobado`, `motivo_rechazo = null`. **No toca `activo`** (es el switch del restaurante). Responde si quedó visible (ver §3). 410 si está eliminada. |
| Rechazar | admin | `rechazado`, `activo = false`, `motivo_rechazo` **siempre presente** (si no se manda, uno por defecto). Nunca visible. 410 si está eliminada. |
| Guardar una **rechazada** | restaurante | Reenvío: `pendiente`, `motivo_rechazo = null` y **`activo = true`** (deshace la desactivación que impuso el rechazo), salvo que mande `activo: false` explícito. **Sigue sin ser visible**: `pendiente` nunca es pública, sin importar `activo` (ver §8). |
| Activar con el switch (`PUT` solo con `{ activo: true }`) | restaurante | **409** si la publicación no está `aprobado` (pendiente o rechazada) — ver §8. Funciona con normalidad sobre una aprobada. |
| Eliminar (`DELETE /api/bolsas/:id`) | restaurante o admin | `eliminado_en`/`eliminado_por`, `activo = false`. **Permanente**: desaparece de todo flujo (feed, detalle, panel del restaurante, cola del admin) y ningún endpoint puede revertirlo — ver §8. |
| Guardar una **aprobada** con cambio relevante | restaurante | Vuelve a `pendiente`; deja de verse hasta que el admin apruebe la versión nueva. |
| Guardar una aprobada cambiando solo `cantidad_disponible` y/o `activo` | restaurante | Sigue `aprobado` (reponer unidades u ocultar no altera la oferta revisada). |
| Guardar el formulario sin cambios reales | restaurante | Sin efecto en la revisión (`'120'` = `120`, `'08:00'` = `'08:00:00'`). |
| Guardar respondiendo a "pedir cambios" (legado) | restaurante | Sigue `pendiente`, `motivo_rechazo = null`. El botón "Cambios" del admin que generaba este estado (`PUT /admin/bolsas/:id/pedir-cambios`) se retiró — ver §8; esta fila sigue aplicando solo a filas que ya estaban así antes del retiro. |

**Campos relevantes** (vuelven a revisión): todo lo editable por `PUT /bolsas/:id`
excepto `activo` y `cantidad_disponible` — nombre, descripción, código
(`contenido`), precios, `tipo`, `categoria`, imagen, horario, `fecha_caducidad`,
categoría de alimento/menú, banderas de menú, peso, `permite_envio`.

### Visibilidad para el cliente

Una publicación aparece si y solo si **todas**:

0. `eliminado_en IS NULL` (no eliminada — ver §8; se evalúa primero y es definitivo);
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
| `PUT /api/admin/bolsas/:id/aprobar` | La respuesta (la fila) agrega `visible_cliente: boolean` y `motivos_no_visible: string[]` con valores `eliminada`, `no_aprobada`, `inactiva`, `sin_unidades`, `vencida`, `negocio_no_disponible`. Aprobar algo ya aprobado es idempotente (no re-notifica ni re-audita). 410 sobre una eliminada. La notificación al restaurante dice si quedó visible o qué falta; a favoritos solo se notifica si es visible. |
| `PUT /api/admin/bolsas/:id/rechazar` | `motivo_rechazo` siempre se escribe (motivo recibido, o uno por defecto). Antes, sin motivo quedaba el de una revisión anterior. 410 sobre una eliminada. |
| `PUT /api/admin/bolsas/:id/pedir-cambios` | **Retirado** (ver §8) — el botón "Cambios" del admin ya no existe. `pedirCambiosBolsa` tampoco en `adminAPI` (frontend). |
| `PUT /api/bolsas/:id` | Reenviar una rechazada la reactiva (`activo = true`), pero sigue sin ser visible (pendiente). Cambiar solo `cantidad_disponible` en una aprobada ya no la manda a revisión. Guardar sin cambios reales tampoco. `tipo` fuera de `bolsa`/`cupon` → 400. **409** si el único cambio es `activo: true` sobre una no aprobada (§8). **410** sobre una eliminada (ninguna edición posible, de nadie). |
| `DELETE /api/bolsas/:id` | Ahora es eliminación **lógica** (antes solo desactivaba) — ver §8. Responde `{ ok: true, tipo: 'eliminada' \| 'ya_eliminada' \| 'oculta_sin_migracion' }`. |
| `POST /api/bolsas` | `tipo` fuera de `bolsa`/`cupon` → 400. **`hora_recogida_inicio`/`hora_recogida_fin` ahora son obligatorios** → 400 si falta alguno (antes se completaban con 18:00/20:00 por defecto). |
| `GET` públicos | Sin cambio de forma. El fallback de `GET /api/bolsas` ahora respeta `?tipo=`. Una eliminada nunca aparece (§8). |

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
8. **"Modificar no funciona" también en el cliente del restaurante:** al abrir
   "Editar", el formulario cargaba la hora tal como la devuelve una columna
   `time` (`'18:00:00'`), y `normalizarHora` (que no acepta segundos, a
   propósito) la rechazaba: Guardar fallaba con "Hora de inicio inválida" sin
   llegar al backend. Corregido con `horaParaFormulario`
   (`src/utils/estadoPublicacion.ts`), que carga `'18:00'`.
9. En web, `restaurante/cupones.tsx` usaba `Alert.alert`, que en
   react-native-web no muestra nada: ni los errores del backend ni la
   confirmación de guardado se veían, y "Desactivar" no hacía nada.

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

## 5. Frontend (FRONT-1)

- **Restaurante** (`restaurante/bolsas.tsx` y `restaurante/cupones.tsx`): cada
  tarjeta muestra un estado — Pendiente, Pendiente · cambios solicitados,
  Rechazada, Aprobada, Inactiva, Vencida, Agotada — con qué hacer para que se
  vea, y el motivo del admin. Una rechazada ofrece **Corregir**, que edita la
  MISMA publicación (`PUT /bolsas/:id`, nunca una copia); al guardar, la
  tarjeta pasa a Pendiente al instante con la respuesta del backend. El
  formulario avisa qué pasará al guardar (reenvío a revisión, o "solo unidades
  no requiere revisión"). En una aprobada viajan **solo los campos que el
  usuario cambió**: el formulario completa valores derivados (p. ej.
  `es_descuento` a partir de los precios) que, enviados, el backend vería como
  cambios de contenido. El tipo se puede cambiar también al editar.
- **Admin** (`admin/contenido.tsx`): la tarjeta pendiente muestra exactamente
  dos botones — **Rechazar** (fondo rojo, texto blanco) y **Aprobar** (fondo
  verde, texto blanco). El botón "Cambios" se retiró por completo (§8). El
  aviso al aprobar usa `visible_cliente` y `motivos_no_visible`; el motivo de
  rechazo es **obligatorio** en la UI; la cola se recarga al recuperar el foco.
- **Restaurante — selector de hora** (`components/HoraPicker.tsx`): Hora
  inicio/fin en Crear/Editar (bolsa y cupón) usan un selector visual (hora +
  minuto, sin intervalos inventados) en vez de texto libre — ver §8.
- **Cliente**: Home, Tiendas, Promociones, tienda y ficha del negocio vuelven
  a pedir datos al recuperar el foco (sin realtime de publicaciones: no forma
  parte del contrato actual). El único filtro local es la vigencia horaria
  (`usePublicacionesVigentes`), la misma regla del backend aplicada al reloj,
  para que una lista abierta no muestre algo que venció mientras tanto; nunca
  oculta lo que el backend considera vigente (ante una hora que no entiende,
  muestra). El tipo sale siempre de `tipo` (`cupon` → Promoción, `bolsa` →
  Tiempo limitado), nunca de las banderas de menú.

## 6. Pruebas

- `backend/test/publicacionesCiclo.test.js` — ciclo completo por HTTP con los
  routers reales sobre Supabase en memoria (`test/helpers/`): nueva, rechazo,
  corrección, Ola Azul exacto (por recreación y por edición), dos versiones,
  modificación de aprobada, matriz de estados, tipos, fallbacks y regresión
  (stock real, horario, unidades, negocio, filtros, CO₂).
- `backend/test/publicaciones.test.js` — reglas puras del servicio, incluidas
  `estaEliminada` y `activarSinAprobacionEsInvalido` (§8).
- `backend/test/publicacionesGestion.test.js` — eliminación lógica
  (DELETE-1..4: sin historial, con `pedido_items` histórico, idempotencia,
  no-reactivación), el switch de visibilidad nunca activa una no aprobada
  (VIS-1..5) y horas obligatorias al crear (TIME-1/2).
- `bocara-mobile/scripts/test-ciclo-publicaciones.cjs` — pantallas reales:
  estados y acciones del restaurante (ver, Corregir, reenviar, solo unidades,
  error y doble submit), admin (aviso de visibilidad, motivo obligatorio, solo
  Rechazar/Aprobar — ADMIN-1/2/3), refetch al foco del cliente y tipos.
  Incluye **integración real**: las pantallas del restaurante, admin y cliente
  hablan por HTTP con los routers del backend (Ola Azul A/B, rechazada →
  corregida → aprobada → visible, matriz de estados y tipos). Si las
  dependencias del backend no están instaladas, esos tests salen SKIPPED
  (nunca PASS).

## 8. Eliminar, botón "Cambios" retirado, selector de hora y toggle bloqueado

Cuatro ajustes post-prueba-manual, todos en `fix/publication-lifecycle`.

**Eliminar (`DELETE /api/bolsas/:id`) — eliminación lógica, nunca física.**
`pedido_items.bolsa_id` es `NOT NULL REFERENCES bolsas(id)` sin
`ON DELETE CASCADE` (`sql/cubo-pago-schema.sql`): un `DELETE` físico sobre una
bolsa con pedidos históricos falla por integridad referencial, y aunque no los
tuviera, dejaría huérfanas las filas de `favoritos` (`referencia_id`, sin FK
real). Por eso se usa siempre `eliminado_en`/`eliminado_por`
(`supabase/migrations/20261003230000_bolsas_eliminacion_logica.sql`, aditiva):
nunca se borra la fila, solo se marca. `estaEliminada()` es la primera
comprobación de `motivosNoVisible` (precondición 0 de §1) y `PUT /bolsas/:id`
responde **410** a cualquier intento de modificar una eliminada — admin
incluido: no hay camino de API para deshacerlo. Repetir el `DELETE` es
idempotente (`tipo: 'ya_eliminada'`).

**Botón "Cambios" del admin, retirado.** `PUT /admin/bolsas/:id/pedir-cambios`
y `adminAPI.pedirCambiosBolsa` se eliminaron del código (no quedó handler,
modal ni estado muertos en `admin/contenido.tsx`) tras confirmar que ningún
otro flujo los usaba. La tarjeta pendiente queda con **Rechazar** (rojo) y
**Aprobar** (verde). Las filas que ya habían quedado `pendiente` con un
`motivo_rechazo` de un "pedir cambios" anterior al retiro siguen
mostrándose y siguen pudiendo corregirse con normalidad (ver fila "legado"
de §1) — el retiro es solo hacia adelante.

**Selector de hora (`components/HoraPicker.tsx`).** Hora inicio/fin en
Crear/Editar ya no son texto libre: un botón abre un selector de hora y
minuto (sin intervalos inventados — los 60 minutos están disponibles) que
entrega directamente el formato canónico `HH:MM`. `POST /api/bolsas` ahora
exige ambas horas explícitas (400 si falta alguna; antes se completaban con
18:00/20:00). `horaParaFormulario` (`src/utils/estadoPublicacion.ts`, ya
existente) sigue siendo lo que carga `'18:00:00'` de la BD como `'18:00'` al
editar — el componente no necesitó cambiar esa parte.

**El switch de visibilidad nunca activa una no aprobada — ni desde la UI ni
desde la API.** `activarSinAprobacionEsInvalido()` (`services/publicaciones.js`)
rechaza (**409**) una petición que solo manda `{ activo: true }` cuando la
publicación no está `aprobado` (pendiente o rechazada). Es intencionalmente
distinto del reenvío de una corrección (que sí restaura `activo = true` junto
con otros campos, como parte de volver a pendiente — ver fila "Guardar una
rechazada" de §1): ese camino cambia más que solo `activo`, así que no lo
bloquea esta regla, y de todos modos `pendiente` nunca es visible
(`esAprobada()` lo filtra en `motivosNoVisible`, independiente de `activo`).
En el frontend, `toggleVisibilidadBloqueado()` (mismo criterio) deja el switch
en **OFF y disabled** para pendiente y rechazada, con el texto "No visible"
explícito en rechazada (no "En revisión": ya hubo una decisión, y fue
negativa).

## 7. Guía de pruebas manuales

Usar un negocio de prueba (no Ola Azul real) en el entorno de pruebas. Horario
amplio (p. ej. 08:00–23:00) salvo donde se indique.

**PM1 — Ola Azul (recrear).** 1) Comercio: Promociones → + Nueva → "2x1
Ceviche", precio original 120, con descuento 110 (mal) → Guardar → mensaje
"enviada a revisión" y tarjeta **En revisión**. 2) Admin: Contenido pendiente →
Rechazar (sin motivo el botón no se habilita) con motivo "Un 2x1 de Q120 cuesta Q60". 3) Comercio: la tarjeta muestra
**✕ Rechazada** y el motivo. 4) Crear otra "2x1 Ceviche" con descuento 60 →
Guardar (no debe dar error de duplicado). 5) Admin: Aprobar → aviso "aprobado y
visible para clientes". 6) Cliente (app ya abierta): ir a Home, Tiendas y
Promociones **sin** pull-to-refresh → aparece Ola Azul y la promo de Q60.
7) Abrir la tienda y el detalle: comercio, texto, horario, unidades y etiqueta
**Promoción** correctos. **Esperado:** la aprobada aparece en todas; la
rechazada en ninguna.

**PM2 — Corregir la rechazada.** Rechazar una promo → comercio pulsa
**Corregir** (el formulario trae los datos y las horas sin segundos), cambia el precio y guarda → mensaje "volvió a revisión", tarjeta
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
