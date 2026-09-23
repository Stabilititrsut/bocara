# Eventos y notificaciones

Catálogo canónico: `pedido.creado`, `pedido.pago_confirmado`, `pedido.pago_rechazado`, `pedido.en_preparacion`, `pedido.listo`, `pedido.completado`, `pedido.cancelado`, `reserva.expirada`, `publicacion.creada`, `publicacion.aprobada`, `publicacion.rechazada`, `promocion.publicada`.

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
| `publicacion.aprobada` / `publicacion.rechazada` | `routes/admin.js` — `PUT /bolsas/:id/aprobar` y `/rechazar` | — |

La emisión es **best-effort** (`enqueueEventBestEffort` nunca lanza ni bloquea la respuesta): un fallo al escribir en `eventos_dominio` jamás puede tumbar un pago, una cancelación o una moderación. `enqueueEvent`, `processEvent`, `markProcessed` y `markFailed` aceptan un `cliente` inyectable (mismo patrón que `services/stock.js`) para pruebas deterministas sin tocar Supabase real — ver `test/eventosDominio.test.js` (duplicado, reintento, error dentro y fuera del límite, dos workers reclamando el mismo evento, y el caso de "reinicio a mitad de proceso": el evento sigue `pendiente` en la fila durable y se retoma sin pérdida).

No registrar cuerpos de Cubo, tokens, correo, teléfono ni payloads completos en logs.
