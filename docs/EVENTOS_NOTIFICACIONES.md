# Eventos y notificaciones

Catálogo canónico: `pedido.creado`, `pedido.pago_confirmado`, `pedido.pago_rechazado`, `pedido.en_preparacion`, `pedido.listo`, `pedido.completado`, `pedido.cancelado`, `reserva.expirada`, `publicacion.creada`, `publicacion.aprobada`, `publicacion.rechazada`, `publicacion.reenviada_revision`, `publicacion.visible`, `promocion.publicada`.

`eventos_dominio` es una cola durable PostgreSQL (`backend/services/eventosDominio.js`). Cada fila tiene `event_type`, agregado, `idempotency_key`, payload mínimo, estado, intentos, error y marcas temporales. La clave es determinista: `pedido:{id}:pedido.pago_confirmado:{token}` (o `aggregate:id:event_type` cuando no hay discriminador de transacción, p. ej. `publicacion.creada`). La restricción UNIQUE descarta duplicados. Estados: pendiente → procesando → procesado, o pendiente/fallido con máximo cinco intentos. El procesador existente `pago_eventos_pendientes` (`services/pagoEventos.js`) sigue siendo el único que dispara push/email/puntos tras un pago Cubo — `eventos_dominio` es el registro de auditoría adicional, no lo reemplaza.

## Puntos de emisión reales (`enqueueEventBestEffort`)

| Evento | Dónde se emite | Discriminador |
|---|---|---|
| `pedido.creado` | `routes/pagos.js` — al insertar el pedido en `/cubopago` y `/preparar` | — |
| `pedido.pago_confirmado` | `services/cuboWebhook.js` — rama `procesado` de `confirmar_pago_cubo` | `paymentIntentToken` |
| `pedido.pago_rechazado` | `services/cuboWebhook.js` — rama `REJECTED/FAILED/DECLINED` | `paymentIntentToken` |
| `pedido.en_preparacion` / `pedido.listo` / `pedido.completado` | `routes/pedidos.js` — `PUT /:id/estado`, solo tras ganar el CAS de estado | — (una vez por pedido) |
| `pedido.cancelado` | `services/stock.js` — `liberarInventarioPedido`, el único choke point de cancelación (usuario, restaurante, admin, rechazo de webhook) | `canceladoPor` |
| `reserva.expirada` | `server.js` — cron `cerrarReservasVencidas`, uno por pedido expirado | — |
| `publicacion.creada` / `promocion.publicada` | `routes/bolsas.js` — `POST /` al crear la bolsa | — |
| `publicacion.aprobada` / `publicacion.rechazada` | `routes/admin.js` — `PUT /bolsas/:id/aprobar` y `/rechazar`, solo cuando el estado cambia de verdad (repetir la misma decisión no emite nada) | instante ISO de la decisión — una publicación puede aprobarse/rechazarse varias veces en su vida; sin discriminador la clave descartaba toda decisión posterior a la primera |
| `publicacion.reenviada_revision` | `routes/bolsas.js` — `PUT /:id` del restaurante que devuelve la publicación a la cola del admin (corrección de una rechazada, cambio relevante en una aprobada, respuesta a "pedir cambios"). Payload: `estado_anterior`, `motivo_anterior`, `campos_cambiados` | instante ISO del reenvío |
| `publicacion.visible` | `routes/admin.js` (aprobar, si ya es visible), `routes/bolsas.js` (`POST` por admin; `PUT` que la vuelve visible: reactivar, reponer unidades) y el barrido `emitirPublicacionesQueInician` (`server.js`, cada 5 min) | `fecha_disponible` (= ciclo) |

La emisión es **best-effort** (`enqueueEventBestEffort` nunca lanza ni bloquea la respuesta): un fallo al escribir en `eventos_dominio` jamás puede tumbar un pago, una cancelación o una moderación. `enqueueEvent`, `processEvent`, `markProcessed` y `markFailed` aceptan un `cliente` inyectable (mismo patrón que `services/stock.js`) para pruebas deterministas sin tocar Supabase real — ver `test/eventosDominio.test.js` (duplicado, reintento, error dentro y fuera del límite, dos workers reclamando el mismo evento, y el caso de "reinicio a mitad de proceso": el evento sigue `pendiente` en la fila durable y se retoma sin pérdida).

No registrar cuerpos de Cubo, tokens, correo, teléfono ni payloads completos en logs.

## Avisos de Promoción / Tiempo limitado cercanos (Semana 2, PR #24)

`publicacion.visible` es hoy el único evento con **consumidor**: `services/despachadorEventos.js` (cron de 30 s) reclama con CAS (`pendiente → procesando`) solo los event_type con handler y ejecuta `services/notificacionesCercania.js#manejarPublicacionVisible`. El resto de `eventos_dominio` sigue siendo bitácora.

| | |
|---|---|
| **Evento** | `publicacion.visible` — clave `bolsa:<id>:publicacion.visible:<fecha_disponible>` (UNIQUE: emitirlo dos veces colapsa) |
| **Cuándo se emite** | Solo cuando la publicación es visible al cliente (`services/publicaciones.js#motivosNoVisible` = []): aprobada, activa, no eliminada, vigente, ya iniciada, con unidades y negocio activo/aprobado. Pendiente → no. Fecha futura → no al aprobar; la emite el barrido `emitirPublicacionesQueInician` cuando llega su día (`fecha_disponible` es por día; ventana hoy/ayer por si el proceso estuvo caído a medianoche). |
| **Revalidación** | El handler vuelve a aplicar `motivosNoVisible` + foto obligatoria antes de avisar: un evento procesado tarde de algo eliminado, agotado o de un negocio suspendido se cierra sin envío. |
| **Audiencia** | Unión de (a) **radio**: clientes a ≤ 10 km devueltos por la RPC `usuarios_en_radio` y (b) **favoritos**: `favoritos.tipo='negocio' AND referencia_id=<negocio>`. Solo `rol='cliente'`, `activo`, con `expo_push_token` y sin opt-out (`usuarios.notif_promociones=false`). |
| **Radio** | 10 km, inclusivo (≤). La RPC lo acota con `LEAST(p_radio_km, 10)` y el backend vuelve a descartar cualquier fila > 10 km (defensa en profundidad). Cliente sin ubicación o con ubicación de más de 30 días (`MAX_EDAD_UBICACION_DIAS`) → fuera del radio. Negocio sin coordenadas válidas → no se llama la RPC (sin campaña por radio); los favoritos sí reciben. |
| **Cálculo** | Caja delimitadora sobre el **índice B-tree compuesto** `usuarios_geo_idx (latitud, longitud)` (parcial: con ubicación y token) → Haversine exacta (R = 6371 km) en SQL. **No es PostGIS ni un índice espacial**; no se agregó PostGIS para esto. |
| **Seguridad RPC** | `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE EXECUTE` a PUBLIC/anon/authenticated, `GRANT` solo a `service_role`. La app nunca decide si está dentro del radio ni ve coordenadas de otros. |
| **Dedup** | `notificaciones.clave_idempotencia = geo:<bolsaId>:<ciclo>:<usuarioId>` con índice UNIQUE (la migración solo lo crea si no hay ya un UNIQUE sobre esa columna, p. ej. `idx_notificaciones_clave_idempotencia` de `sql/cubo-pago-schema.sql`). Primero se inserta la fila; **solo si el INSERT gana** se manda push. Favorito + radio = una entrada (la clave no depende de la razón). Reintentos, doble aprobación, barrido repetido, reinicio y dos workers → una fila y un push por usuario y ciclo. Re-aprobar con la misma `fecha_disponible` no re-notifica; republicar con otra fecha sí (ciclo nuevo). |
| **Copy** | Promoción (`tipo='cupon'`): "🏷️ Nueva promoción cerca de ti". Tiempo limitado (`tipo='bolsa'`): "⏱️ Tiempo limitado cerca de ti". Si el cliente entró solo como favorito (fuera del radio): "… en <Negocio>". Nunca "bolsa" para una Promoción. |
| **Push** | Expo Push en lotes de 100 (`enviarPushEnLotes`), `sound: 'default'`, `priority: 'high'`, ticket por mensaje; `DeviceNotRegistered` → `expo_push_token = NULL` de ese token. Un fallo de Expo no lanza: la fila de bandeja ya existe y el evento se cierra (no hay reintento de push para no duplicar). La aprobación nunca espera a Expo (solo encola). |
| **Canal Android** | `default` hasta que la app con canales esté adoptada; `PUSH_CANAL_CERCANIA=promociones` lo cambia sin tocar código. Un `channelId` desconocido cae a `default` (Android no muestra canales que el dispositivo no creó). |
| **Payload / deep link** | `data = { tipo: 'promocion' \| 'tiempo_limitado', bolsaId, negocioId }` → `resolverRutaNotificacion` → `/producto/<bolsaId>` (solo si es UUID). Pedidos: `{ pedidoId }` → `/(tabs)/pedidos?pedidoId=<uuid>` (la pantalla resalta y hace scroll a esa tarjeta). `route`/`screen` del payload nunca se usan como ruta; un id que no es UUID cae al fallback del rol. |
| **App abierta / cerrada** | Cerrada o en background: push del SO y tap → deep link (también cold start, con dedup por id). Abierta: el handler muestra banner + lista con sonido; no navega solo. La bandeja de la app se actualiza por el polling existente — Supabase Realtime sigue bloqueado por RLS (ver `src/services/realtime.ts`). Push y bandeja son la misma fila, así que no hay duplicado lógico. |

### Tokens

`POST /api/notificaciones/token` valida el formato `Expo(nent)PushToken[…]` y **quita el mismo token de cualquier otra cuenta** antes de asignarlo (mismo teléfono, otra sesión). `DELETE /api/notificaciones/token` (logout, antes de borrar el JWT) borra solo si el token enviado sigue siendo el vigente, así cerrar sesión en un teléfono viejo no le quita el push al nuevo. La app re-registra el token en cada login y cuando FCM/APNs lo rotan (`addPushTokenListener`).

### Canales, sonido y branding (qué controlamos y qué no)

- **Canales Android** (`app/_layout.tsx`, creados ANTES de pedir permiso — Android 13+ no muestra el diálogo sin canal): `default` (HIGH, sonido), `pedidos` (HIGH, sonido, vibración), `promociones` (DEFAULT, sonido).
- **Sonido**: pedimos `sound: 'default'` y `shouldPlaySound: true`. Si el usuario silenció la app, el canal o el teléfono (modo silencio / No molestar / Focus), **manda el SO** y no suena; no se fuerza nada. Tras crearse un canal, su importancia y sonido solo los cambia el usuario en Ajustes.
- **Nombre**: el SO muestra el nombre de la app (`expo.name` = **Bocara**; antes era "bocara-mobile"). Requiere un build nativo nuevo.
- **Icono Android de notificación**: `assets/images/notification-icon.png` (96×96, silueta blanca del símbolo de Bocara sobre transparente, derivada de `logo.png`), color de acento `#2C4A2E`. Android solo usa el canal alfa; con el icono a color anterior se veía un cuadrado.
- **iOS**: iOS siempre usa el icono de la app en la notificación; no hay icono de notificación aparte.
- **Pendiente de diseño**: el icono de la app (`icon.png`, `android-icon-*`) sigue siendo el de la plantilla de Expo, no el de Bocara, y es el que aparece como icono grande en Android y en iOS. Cambiarlo requiere assets de diseño (icono cuadrado + adaptive foreground/monochrome con márgenes de seguridad) y un build nativo.

### Contrato de liquidaciones

Sin eventos reales todavía (el bloque financiero va aparte). Hoy solo existe el aviso manual del admin (`tipo: 'liquidacion'`). Cuando existan, deben emitirse con clave idempotente por liquidación y `data: { liquidacionId }`; el resolver de rutas tendrá que mapearlos a la sección de liquidaciones del restaurante.
