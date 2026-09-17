# Pruebas manuales Semana 1

1. Aplicar la migración listada abajo en Supabase SQL Editor y verificar que termina en `COMMIT`.
2. Crear una bolsa merma y una promoción; iniciar un checkout de cada una. Verificar en `pedidos.snapshot_financiero` 0.25 y 0.20 respectivamente.
3. Cambiar `comision_promocion_porcentaje` y comprobar que un pedido ya creado no cambia; uno nuevo sí usa la nueva configuración.
4. Reenviar el mismo webhook Cubo SUCCEEDED: comprobar un solo descuento de stock y una sola notificación persistente.
5. Consultar `/api/bolsas` con coordenadas de Ciudad de Guatemala y radio 10: incluir 9.99/10.00 km, excluir 10.01 km y bolsas sin coordenadas. Probar lat=91 y confirmar 422.
6. Simular error temporal de handler de eventos: confirmar que la fila queda pendiente, incrementa intentos y se reanuda al reintentar.
7. Aprobar y rechazar una bolsa desde `/api/admin/bolsas/:id/aprobar` y `/rechazar`: verificar una fila nueva en `eventos_dominio` (`publicacion.aprobada`/`publicacion.rechazada`) por cada acción, y ninguna duplicada al repetir la llamada con el mismo resultado.
8. Cancelar el mismo pedido dos veces seguidas (usuario, luego admin): confirmar `stock_devuelto: true` solo en la primera respuesta y una sola fila `pedido.cancelado` en `eventos_dominio`.
9. Revisar la respuesta de cualquier endpoint: debe traer el header `X-Request-Id`. Provocar una excepción no manejada (p. ej. apagar la BD a mitad de un request) y confirmar que el 500 incluye `request_id` y `code` sin perder el campo `error`.
10. Aplicar también `202609171200_ubicacion_usuario.sql`. Con un usuario autenticado: `PATCH /api/auth/ubicacion { latitud: 14.6349, longitud: -90.5069 }` → 200 con la ubicación normalizada. Repetir con `latitud: 91` → 422 `UBICACION_INVALIDA`.
11. Sin mandar `lat`/`lng`, `GET /api/bolsas` con el token del usuario del paso 10 en `Authorization`: debe filtrar por esa ubicación persistida (mismo resultado que mandarla explícita en el query). Sin `Authorization`, el feed debe comportarse exactamente igual que antes (sin fallback, sin error).
12. Enviar un OTP de email (`POST /api/auth/enviar-otp-email`) y revisar los logs de Render: el email debe aparecer enmascarado (`ja***@dominio.com`), nunca completo, y el código de 6 dígitos no debe aparecer en ningún log.
13. Generar un link de pago Cubo real (sandbox) y revisar los logs: no debe aparecer `paymentIntentToken` en texto plano en ninguna línea (antes de esta auditoría sí aparecía en `services/visaLink.js`).
