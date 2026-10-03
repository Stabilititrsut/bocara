# Bocara — Entorno local (Windows)

Backend en `http://localhost:3000`, app web en `http://localhost:8082` (8083 si
8082 está ocupado). Pagos deshabilitados y tareas en segundo plano apagadas.

## Primera vez

```powershell
cd C:\Users\javib\bocara
.\scripts\setup-local-env.cmd
notepad backend\.env      # pegar SUPABASE_SERVICE_KEY=...
```

`setup-local-env` crea `backend/.env` desde `backend/.env.local.template`,
completa `SUPABASE_URL` (pública, ya está en la app), genera un `JWT_SECRET`
local y crea `bocara-mobile/.env.development.local` con
`EXPO_PUBLIC_API_URL=http://localhost:3000/api`. Nunca imprime valores. Si
`backend/.env` ya tiene valores propios, no los pisa.

## Día a día

```powershell
.\scripts\start-local.cmd            # abre backend y frontend en dos ventanas
# o, por separado:
.\scripts\start-local-backend.cmd
.\scripts\start-local-frontend.cmd
.\scripts\check-local.cmd            # diagnóstico: LOCAL ENV READY: YES/NO
```

Los `.cmd` ejecutan el `.ps1` del mismo nombre con `-ExecutionPolicy Bypass`
solo para ese proceso, así que funcionan aunque Windows tenga los scripts
bloqueados, sin cambiar la configuración del sistema.

## Variables

| Variable | Para qué | Local |
|---|---|---|
| `SUPABASE_URL` | `config/supabase.js` — sin ella no arranca | automática (pública) |
| `SUPABASE_SERVICE_KEY` | `config/supabase.js` — sin ella no arranca | **pegar a mano** |
| `JWT_SECRET` | login y rutas autenticadas (restaurante, admin, cliente) | generada local |
| `BOCARA_DISABLE_JOBS=true` | apaga recordatorios push, reintentos post-pago y barridos de pedidos/reservas de `server.js` | en la plantilla |
| `CUBO_PAYMENTS_ENABLED=false` | corta el flujo de pago de Cubo | en la plantilla |
| `PORT`, `NODE_ENV` | 3000 / development | en la plantilla |

No hacen falta para probar publicaciones: Cubo (`CUBO_*`), Stripe, PayU,
Guatex, Forza, EasyPost (no se leen en el código actual), `RESEND_API_KEY`
(emails), `EXPO_ACCESS_TOKEN` (push), `TWILIO_*` (OTP por SMS),
`ADMIN_SETUP_SECRET`, `FRONTEND_URL`, `DELIVERY_*`.

## Importante: la base es la de producción

Solo existe un proyecto Supabase. Con su `service_role`, el backend local lee y
**escribe datos reales**: usa un negocio y usuarios de prueba, nunca negocios
reales. Por eso `BOCARA_DISABLE_JOBS=true` no es opcional en local: sin él, este
proceso mandaría push duplicados a clientes reales (el recordatorio de recogida
deduplica solo en memoria) y procesaría pagos en paralelo con Render.

`bocara-mobile/.env.development.local` solo lo lee `expo start`; el build de
producción (`npm run build:web` / Vercel) sigue apuntando a
`https://bocara.onrender.com/api`.

## Pruebas desde otra máquina de la misma red (LAN)

Abrir la app web desde otra laptop/celular de la red, apuntando a la IP de la
máquina que corre `expo start --web` (ej. `http://192.168.1.50:8082`), en vez
de `localhost`:

- **API del backend**: `src/services/api.ts` deriva la URL del backend del
  origen con el que el navegador cargó la página (`window.location`), no del
  valor horneado en `EXPO_PUBLIC_API_URL` — así que funciona automáticamente
  por LAN sin configurar nada aparte, en cualquier puerto. Esto solo se activa
  cuando el origen es `localhost`/`127.0.0.1` o una IP literal; nunca en un
  build de producción (`bocarafood.com`, `*.vercel.app`), que siempre son
  nombres de dominio, no IPs.
- **CORS del backend**: `middleware/cors.js` acepta cualquier IP privada
  RFC1918 (`10.x`, `172.16-31.x`, `192.168.x.x`) en cualquier puerto, mientras
  `NODE_ENV` no sea `production`. Si tu IP de LAN no cae en esos rangos (ej.
  una `198.168.x.x`, que es pública, no privada — probablemente valga la pena
  confirmar que no sea un error de tecleo por `192.168.x.x`), agrégala a mano
  en `backend/.env`: `CORS_EXTRA_ORIGINS=http://tu-ip:puerto`.
- **Login con Google (OAuth)**: el `redirectTo` ya se calcula en tiempo de
  ejecución desde `window.location.origin` (`app/login.tsx`), pero Supabase
  solo permite redirigir a una URL que esté en su propio allowlist del
  proyecto. Si no está, Supabase cae a la `Site URL` configurada (producción)
  en vez de volver a tu máquina. Hay que agregar los orígenes locales/LAN que
  vayas a usar en **Supabase Dashboard → Authentication → URL Configuration →
  Redirect URLs** (ej. `http://localhost:8082/auth/callback`,
  `http://192.168.1.50:8082/auth/callback`, o con comodín
  `http://192.168.1.50:8082/**` si tu plan de Supabase lo soporta) — sin
  quitar ni cambiar la `Site URL` ni las URLs de producción existentes. Login
  con correo/contraseña, registro, recuperación de contraseña y verificación
  por código NO pasan por este mecanismo (son llamadas directas al backend
  propio): no se ven afectados y nunca terminan en `bocarafood.com`.
