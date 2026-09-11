# Matriz de pantallas V01

Cobertura: las 55 pantallas navegables inventariadas en `FRONTEND_ROUTE_MAP_V01.md`. Las rutas de layout (`_layout`) son infraestructura de navegación y no pantallas. Stock UI cuenta con 33 casos PASS del harness (`scripts/test-cart.cjs`) + 4 del harness de OAuth (`scripts/test-auth.cjs`). Push frontend tiene permisos/token/registro implementados, pero **no** tiene listener de foreground ni de tap en notificación (ver Día 1 abajo) — eso es un hueco de código, no solo pendiente de dispositivo físico. Entrega real, tap y estados background/killed además requieren MANUAL-REQUIRED en dispositivo físico.

|Pantalla|Ruta|Rol|API|Loading|Vacío|Error|Navegación|Stock|Pago|Push|Estado|Bloqueo|
|---|---|---|---|---|---|---|---|---|---|---|---|---|
|Acceso y registro|/login, /registro-cliente, /verificar-email, /registro-telefono, /forgot-password, /auth/callback|público|auth/supabase|Sí|N/A|Sí|login↔registro↔tabs|N/A|N/A|N/A|OK|OAuth nativo requiere URL autorizada|
|Onboarding|/onboarding|cliente|local|Sí|N/A|Sí|guard→tabs|N/A|N/A|N/A|OK|—|
|Inicio/tabs|/(tabs), /(tabs)/|cliente|negocios/notificaciones|Sí|Sí|Sí|tabs→catálogos|visual|N/A|polling|OK|Push: falta listener foreground/tap en código + físico|
|Catálogos|/(tabs)/buscar, /tiendas, /favoritos, /promociones|cliente|bolsas/favoritos/negocios|Sí|Sí|Sí|→producto/tienda|vencidos bloqueados|N/A|N/A|OK|—|
|Carrito|/(tabs)/carrito|cliente|local|hydration|Sí|Sí|→pago|30 casos PASS|revalida|N/A|OK|—|
|Pedidos cliente|/(tabs)/pedidos, /notificaciones, /perfil|cliente|pedidos/notificaciones/auth|Sí|Sí|Sí|→QR/editar|N/A|estado backend|polling|OK|Push: falta listener foreground/tap en código + físico|
|Detalles|/tienda/[id], /negocio/[id], /producto/[id]|cliente|negocios/bolsas|Sí|Sí|Sí|lista→carrito|0/null/vencido bloqueados|N/A|N/A|OK|—|
|Checkout|/pago|cliente|pagos/cupones|Sí|N/A|Sí|carrito→retorno|backend autoridad|link Cubo|N/A|OK|—|
|Retorno pago|/pago-retorno|cliente|pagos.estado|Sí|N/A|400/404/409/500/503|→éxito/pedidos|N/A|backend autoridad, timeout/reintento|N/A|OK|—|
|Resultado/QR|/pago-exitoso, /qr-recogida|cliente|pagos/pedidos|Sí|N/A|Sí|→QR/tabs|N/A|poll backend|N/A|OK|—|
|Cuenta|/editar-perfil, /configuracion, /cupones, /referidos, /soporte, /socios, /modal|mixto|usuarios/cupones/referidos|Sí|Sí|Sí|perfil↔detalle|N/A|cupón|N/A|PARCIAL|preferencias Push sin contrato backend; modal no usada|
|Restaurante|/restaurante, /bolsas, /cupones, /pedidos, /historial, /ganancias, /notificaciones, /perfil|restaurante|negocios/bolsas/cupones/pedidos/finanzas/notificaciones|Sí|Sí|Sí|tabs restaurante|publicación defensiva|estado backend|polling|OK|Push: falta listener foreground/tap en código + físico|
|Admin operación|/admin, /usuarios, /negocios, /restaurante-detalle, /verificacion, /cambios-perfil, /contenido, /cupones|admin|admin/bolsas/cupones|Sí|Sí|Sí|admin↔detalle|visual|N/A|backend notifica|OK|—|
|Admin finanzas|/admin/financiero, /liquidaciones, /config, /cubo-status, /datos-prueba|admin|admin/finanzas/liquidaciones/config|Sí|Sí|Sí|admin↔detalle|N/A|lectura Cubo|N/A|PARCIAL|datos-prueba requiere control operativo|

## Estados y evidencia

- **OK:** 49 pantallas; flujo implementado y/o cubierto por build, lint, TypeScript y harness disponible.
- **PARCIAL:** 6 pantallas: `/configuracion`, `/modal`, `/admin/datos-prueba` y sus dependencias agrupadas; no bloquean rutas de compra, pero tienen contrato o uso operativo incompleto.
- **BLOQUEADO:** 0 pantallas. Push no bloquea la app; sus pruebas físicas son MANUAL-REQUIRED.

## Pruebas manuales obligatorias

1. Dispositivo físico iOS/Android: permiso Push, token Expo, entrega foreground/background/killed y navegación al tocarla.
2. OAuth nativo: confirmar que Supabase autorice `bocara://auth/callback`; en web comprobar el origen activo más `/auth/callback`.
3. Pago con entorno sandbox: validar visualmente cada respuesta 400, 404, 409, 500 y 503 y el timeout, sin ejecutar compra real.
4. OAuth web con Google real: confirmar en el navegador que `/auth/callback` establece sesión sin el timeout de 8s (corregido por código/tests estáticos, no probado con una cuenta Google real en este pase).

## Día 1 — correcciones y evidencia (esta sesión)

- **OAuth web (timeout "no se recibió sesión en 8 segundos"):** causa raíz — el cliente Supabase usaba el flow implícito (tokens en `#hash`) sin `flowType` explícito; en Expo Router web el hash queda expuesto a que el router lo toque antes de que el código lo lea, y ya no hay nada determinista que lo recupere. Corrección: `flowType: 'pkce'` explícito en `src/services/supabase.ts` (el redirect ahora llega por `?code=`, que ya se demuestra estable porque es el mismo mecanismo que usa la confirmación por email) + se quitó el parseo manual del hash en `app/auth/callback.tsx`. Evidencia: `scripts/test-auth.cjs` (4/4 PASS) verifica que no se reintroduzca el flow implícito ni un redirect hardcodeado. Sigue pendiente de un login real con Google en el navegador (no hay credenciales de prueba en este entorno).
- **Publicaciones vencidas visibles en catálogo:** causa raíz — el backend (`backend/services/horarioGuatemala.js`) ya filtraba correctamente en hora de Guatemala, pero el filtro defensivo del frontend (`src/utils/horarioRecogida.ts`) calculaba "vencido" con `Date.setHours()` en la hora **local del dispositivo**, no en la de Guatemala. Se demostró el bug de forma reproducible: con `TZ=Asia/Tokyo`, una publicación que ya venció en Guatemala aparecía como "NO vencido". Corrección: el cálculo ahora usa `Intl.DateTimeFormat` con `timeZone: 'America/Guatemala'` (igual que el backend), sin importar el reloj/zona del navegador o teléfono. Evidencia: `scripts/test-cart.cjs` re-ejecutado y en PASS bajo `TZ=Asia/Tokyo` y `TZ=Pacific/Kiritimati` además del entorno por defecto.
- **Botones de volver inertes:** causa raíz — `router.back()` de expo-router es un no-op silencioso sin historial (entrada por URL directa/refresh/deep link); varias pantallas lo llamaban sin comprobarlo. Se auditaron todas las pantallas con botón de volver personalizado y se añadió `src/utils/backNavigation.ts` (`volver(router, fallback)`, con `router.canGoBack()`), aplicado en 15 pantallas. `modal.tsx` se dejó igual: no está registrado en `app/_layout.tsx` y es inalcanzable.
- **Stock UX:** el mensaje de límite de stock ahora muestra la cantidad real restante ("Solo quedan N unidades disponibles.") usando el dato que el carrito ya calculaba — sin llamadas nuevas.
- **Push:** se confirmó por código que no existe ningún `addNotificationReceivedListener`/`addNotificationResponseReceivedListener` en el proyecto — el tap en una notificación no dispara navegación. Esto no es un pendiente de dispositivo físico: es un hueco de implementación para una sesión futura.
