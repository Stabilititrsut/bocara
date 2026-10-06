# Pruebas manuales — Notificaciones 10 km (Semana 2)

Requisitos previos:

- Migración `backend/supabase/migrations/202610051400_notificaciones_geofencing_y_preferencias.sql` aplicada.
- **Build nativo nuevo** (EAS / dev client) con este `app.json`: el nombre "Bocara", el icono de notificación y los canales Android no llegan por OTA ni a Expo Go.
- Backend con jobs activos (sin `BOCARA_DISABLE_JOBS=true`): el despachador corre cada 30 s y el barrido de publicaciones que inician cada 5 min.
- Dos teléfonos físicos (el simulador no recibe push), cada uno con su cuenta de cliente, con permiso de notificaciones y de ubicación, y habiendo abierto la app al menos una vez con sesión (así se guardan el token y la ubicación).
- Negocio de prueba aprobado y con coordenadas. Para fijar la distancia de un cliente sin moverse, ajustar `usuarios.latitud/longitud/ubicacion_actualizada_at` en el SQL Editor (entorno de pruebas).

| Caso | Pasos | Esperado | OK |
|---|---|---|---|
| **A** — cliente ≤ 10 km | 1. Restaurante crea una Promoción (con foto, fecha de hoy). 2. Confirmar que el cliente **no** recibe nada (está pendiente). 3. Admin aprueba. 4. Esperar ≤ 30 s. | Llega **una** notificación "🏷️ Nueva promoción cerca de ti", con nombre **Bocara**, icono del tazón en la barra de estado (Android) y sonido si el teléfono no está en silencio. Al tocarla abre `/producto/<id>` de esa promoción y se puede agregar al carrito y pagar. | ☐ |
| **A2** — Tiempo limitado | Igual que A con una publicación de Tiempo limitado. | "⏱️ Tiempo limitado cerca de ti" → abre su producto. | ☐ |
| **A3** — fecha futura | Crear y aprobar con `fecha_disponible` = mañana. | Hoy no llega nada. Mañana, en ≤ 5 min tras la medianoche de Guatemala (más ≤ 30 s del despachador), llega una sola. | ☐ |
| **B** — cliente > 10 km | Segundo cliente a ~11 km (o ubicación de más de 30 días). Repetir A. | No recibe nada, ni push ni fila en Notificaciones. | ☐ |
| **C** — favorito ≤ 10 km | El cliente de A marca el negocio como favorito. Publicar y aprobar otra Promoción. | Recibe **una sola** notificación (no dos). Un favorito a > 10 km recibe "… en <Negocio>". | ☐ |
| **D** — app abierta | Con la app en primer plano, aprobar otra publicación. | Banner + sonido; la app no navega sola. La lista de Notificaciones la muestra tras refrescar / en el siguiente polling, una sola vez. | ☐ |
| **E** — app cerrada | Cerrar la app por completo (swipe). Aprobar otra publicación. Tocar el push. | La app abre directo en el producto (cold start), no en el Home. | ☐ |
| **F** — logout / otra cuenta | 1. Cerrar sesión con la cuenta A en el teléfono 1. 2. Iniciar sesión con B en el mismo teléfono. 3. Generar un aviso para A (p. ej. cambiar el estado de un pedido de A). | El teléfono 1 **no** recibe el aviso de A. En BD, `usuarios.expo_push_token` de A quedó en NULL y el token del teléfono pertenece solo a B. | ☐ |
| **G** — permisos denegados | Negar notificaciones (o "no volver a preguntar"). | La app funciona normal, sin errores visibles; no se registra token. | ☐ |
| **H** — publicación retirada | Recibir un aviso, luego eliminar o agotar esa publicación, y tocar el aviso. | Pantalla controlada ("no se pudo cargar / no encontrada") con botón para volver; sin crash. | ☐ |

Comprobaciones en BD después de A–C:

```sql
-- Una fila por usuario y ciclo; nunca dos con la misma clave.
SELECT clave_idempotencia, count(*) FROM notificaciones
WHERE clave_idempotencia LIKE 'geo:%' GROUP BY 1 HAVING count(*) > 1;   -- esperado: 0 filas

-- El evento quedó procesado (o fallido con last_error si algo falló).
SELECT event_type, status, attempts, last_error FROM eventos_dominio
WHERE event_type = 'publicacion.visible' ORDER BY created_at DESC LIMIT 10;
```
