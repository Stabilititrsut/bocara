# API Backend V2 — suplemento Semana 1

`GET /api/bolsas?lat={lat}&lng={lng}&max_distancia={km}` valida latitud [-90,90], longitud [-180,180] y rechaza pares incompletos o NaN con 422. Para selección geográfica, el radio se limita a 10 km y negocios sin coordenadas quedan excluidos cuando se solicita radio. La distancia se calcula en backend con Haversine; el valor del cliente no es confiable.

Los errores nuevos de ubicación usan `{ error, code }` con `UBICACION_INVALIDA` o `RADIO_INVALIDO`, preservando el formato histórico de las rutas existentes.

`PATCH /api/auth/ubicacion` (requiere `Authorization`) — persiste la última ubicación del cliente autenticado. Body: `{ latitud, longitud }`. Escribe siempre en `usuarios.<id del JWT>` — ningún campo del payload puede apuntar la escritura a otra cuenta. Misma validación que `GET /api/bolsas` (`utils/geo.js#validarCoordenadasEntrada`): rechaza `null`/`undefined`/NaN/Infinity/string no numérica y rangos fuera de [-90,90]/[-180,180] con `422 UBICACION_INVALIDA`. Responde `{ latitud, longitud, actualizado_at }`. Requiere la migración `202609171200_ubicacion_usuario.sql` (columnas `usuarios.latitud/longitud/ubicacion_actualizada_at`); sin ella responde `503 BD_NO_DISPONIBLE`.

`GET /api/bolsas` sin `lat`/`lng` en el query, con un `Authorization` válido: usa como fallback la última ubicación que ese usuario haya guardado con el endpoint de arriba (`utils/geo.js#resolverCoordenadasCliente`). Un token ausente, inválido o expirado no es un error en este endpoint — el feed sigue siendo público y simplemente no aplica el fallback, igual que antes de esta migración. Las coordenadas explícitas del query siempre tienen prioridad sobre el fallback.
