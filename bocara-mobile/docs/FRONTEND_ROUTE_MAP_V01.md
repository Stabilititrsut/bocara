# Mapa de rutas frontend V01

Inventario auditado de `app/` (55 pantallas navegables; `_layout` son contenedores). Estados: OK, PARCIAL, BLOQUEADO. `API` nombra únicamente servicios observados en `src/services/api.ts`.

Ver `MATRIZ_PANTALLAS_V01.md` → "Día 1 — correcciones y evidencia" para el detalle de las correcciones de OAuth, vencimientos por timezone y botones de volver aplicadas en esta sesión (afectan `/auth/callback`, `/tienda/[id]`, `/negocio/[id]`, `/(tabs)/buscar`, `/(tabs)/favoritos`, `/(tabs)/promociones`, `/producto/[id]`, `/pago`, y las pantallas con botón de volver personalizado).

|Ruta|Pantalla|Rol|Auth|API|Loading/Vacío/Error|Entrada → salida|Stock|Pago|Push|Estado|
|---|---|---|---|---|---|---|---|---|---|---|
|/login|Login|público|No|auth/supabase OAuth|loading/error|inicio → tabs/restaurante/admin|—|—|—|OK|
|/registro-cliente|Registro cliente|público|No|auth.checkEmail/enviarOtpEmail|loading/error|login → verificar-email|—|—|—|OK|
|/verificar-email|OTP email|público|No|auth.verificarOtpRegistro/enviarOtpEmail|loading/error/reenvío|registro → tabs|—|—|—|OK|
|/registro-restaurante|Registro negocio|público|No|auth/negocios|loading/error|login → restaurante|—|—|—|PARCIAL|
|/registro-telefono|OTP teléfono|público|No|auth.send/verifyPhoneOtp|loading/error|login → perfil|—|—|—|OK|
|/forgot-password|Recuperación|público|No|auth.forgotPassword|loading/error|login → login|—|—|—|OK|
|/auth/callback|OAuth/callback|público|No|supabase/auth.oauthComplete|loading/error|OAuth → registro o tabs|—|—|—|OK|
|/onboarding|Onboarding|cliente|Sí|local|loading|guard → tabs|—|—|—|OK|
|/(tabs)|Layout cliente|cliente|Sí|—|—|guard → tabs|—|—|—|OK|
|/(tabs)/|Inicio|cliente|Sí|negocios/notificaciones|loading/vacío/error|tabs → tienda/negocio|visual|—|badge/polling|OK|
|/(tabs)/buscar|Buscar|cliente|Sí|bolsas|loading/vacío/error|tabs → producto|visual|—|—|OK|
|/(tabs)/tiendas|Tiendas|cliente|Sí|negocios|loading/vacío/error|tabs → tienda|visual|—|—|OK|
|/(tabs)/favoritos|Favoritos|cliente|Sí|favoritos/bolsas|loading/vacío/error|tabs → producto|bloquea vencido|—|—|OK|
|/(tabs)/promociones|Promociones|cliente|Sí|bolsas|loading/vacío/error|tabs → producto|bloquea vencido|—|—|OK|
|/(tabs)/carrito|Carrito|cliente|Sí|local|hydration/vacío/error|tabs → pago|30 casos validados|revalida en pago|—|OK|
|/(tabs)/pedidos|Pedidos|cliente|Sí|pedidos|loading/vacío/error|tabs → QR|—|estado backend|polling|OK|
|/(tabs)/notificaciones|Notificaciones|cliente|Sí|notificaciones|loading/vacío/error|tabs → detalle|—|—|polling|OK|
|/(tabs)/perfil|Perfil|cliente|Sí|auth/usuarios|loading/error|tabs → editar/config|—|—|—|OK|
|/tienda/[id]|Tienda|cliente|Sí|negocios/bolsas|loading/vacío/error|lista → producto/carrito|bloquea vencido/0|—|—|OK|
|/negocio/[id]|Negocio|cliente|Sí|negocios/bolsas|loading/vacío/error|inicio → producto|filtra vencido|—|—|OK|
|/producto/[id]|Detalle producto|cliente|Sí|bolsas|loading/error|lista → carrito|0/inválido/vencido bloqueado|—|—|OK|
|/pago|Checkout|cliente|Sí|pagos/cupones|loading/error|carrito → retorno|revalida backend|genera link|—|OK|
|/pago-retorno|Retorno Cubo|cliente|Sí|pagos.estado|loading/timeout/HTTP error|browser → éxito/pedidos|—|backend autoridad; reintento|—|OK|
|/pago-exitoso|Resultado pago|cliente|Sí|pagos.estado|loading/error|retorno → QR/pedidos|—|poll backend|—|OK|
|/qr-recogida|QR retiro|cliente|Sí|pedidos|loading/error|pedido → tabs|—|confirmado backend|—|OK|
|/editar-perfil|Editar perfil|cliente|Sí|usuarios|loading/error|perfil → perfil|—|—|—|OK|
|/configuracion|Configuración|cliente|Sí|local|—|perfil → perfil|—|—|preferencias BLOCKED-BACKEND|PARCIAL|
|/cupones|Cupones|cliente|Sí|cupones|loading/vacío/error|perfil → pago|—|aplicación en pago|—|OK|
|/referidos|Referidos|cliente|Sí|referidos|loading/error|perfil → perfil|—|—|—|OK|
|/soporte|Soporte|cliente|Sí|—|—|perfil → externo|—|—|—|OK|
|/socios|Socios|público|No|—|—|login → registro|—|—|—|OK|
|/modal|Modal ejemplo|público|No|—|—|interno → atrás|—|—|—|NO USADA|
|/restaurante|Layout/inicio restaurante|restaurante|Sí|negocios/pedidos|loading/vacío/error|guard → tabs restaurante|—|—|notificaciones/polling|OK|
|/restaurante/bolsas|Bolsas restaurante|restaurante|Sí|bolsas|loading/vacío/error|tabs → editar|publicación defensiva|—|—|OK|
|/restaurante/cupones|Cupones restaurante|restaurante|Sí|cupones|loading/vacío/error|tabs → editar|—|—|—|OK|
|/restaurante/pedidos|Pedidos restaurante|restaurante|Sí|pedidos|loading/vacío/error|tabs → estado|—|estado backend|polling|OK|
|/restaurante/historial|Historial restaurante|restaurante|Sí|pedidos|loading/vacío/error|tabs → detalle|—|—|—|OK|
|/restaurante/ganancias|Ganancias|restaurante|Sí|finanzas|loading/vacío/error|tabs → atrás|—|—|—|OK|
|/restaurante/notificaciones|Notificaciones restaurante|restaurante|Sí|notificaciones|loading/vacío/error|tabs → pedido|—|—|provider/polling|OK|
|/restaurante/perfil|Perfil restaurante|restaurante|Sí|negocios|loading/error|tabs → editar|—|—|polling solicitud|OK|
|/admin|Layout/inicio admin|admin|Sí|admin|loading/error|guard → admin|—|—|—|OK|
|/admin/usuarios|Usuarios|admin|Sí|admin|loading/vacío/error|admin → detalle|—|—|—|OK|
|/admin/negocios|Negocios|admin|Sí|admin|loading/vacío/error|admin → detalle|—|—|—|OK|
|/admin/restaurante-detalle|Detalle restaurante|admin|Sí|admin|loading/error|negocios → atrás|—|—|—|OK|
|/admin/verificacion|Verificación|admin|Sí|admin|loading/vacío/error|admin → detalle|—|—|notifica backend|OK|
|/admin/cambios-perfil|Cambios perfil|admin|Sí|admin|loading/vacío/error|admin → atrás|—|—|notifica backend|OK|
|/admin/contenido|Contenido|admin|Sí|admin/bolsas|loading/vacío/error|admin → detalle|visual|—|—|OK|
|/admin/cupones|Cupones admin|admin|Sí|admin/cupones|loading/vacío/error|admin → atrás|—|—|—|OK|
|/admin/financiero|Finanzas|admin|Sí|admin/finanzas|loading/error|admin → atrás|—|—|—|OK|
|/admin/liquidaciones|Liquidaciones|admin|Sí|admin/liquidaciones|loading/vacío/error|admin → atrás|—|—|notifica backend|OK|
|/admin/config|Configuración admin|admin|Sí|admin/config|loading/error|admin → atrás|—|—|—|OK|
|/admin/cubo-status|Estado Cubo|admin|Sí|admin/cubo-status|loading/error|admin → atrás|—|lectura|—|OK|
|/admin/datos-prueba|Datos prueba|admin|Sí|admin|loading/error|admin → atrás|—|—|—|PARCIAL|
