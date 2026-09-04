# Guía operativa de Bocara

Esta guía describe la estructura vigente. No crea datos, no ejecuta migraciones y no modifica producción.

## Servicios

- Frontend web y aplicación Expo: `bocara-mobile/`.
- API Node.js: `backend/`.
- Base de datos: Supabase.
- Pagos: Cubo Pago.
- Correo transaccional: Resend.
- Backend productivo: Render.
- Frontend web: Vercel.

## Preparación local

Se requiere Node.js 20 o superior.

### Backend

```bash
cd backend
cp .env.example .env
npm ci
npm run check
npm test
npm start
```

Completa `backend/.env` con credenciales de desarrollo. No copies secretos de producción a archivos versionados.

### Frontend

```bash
cd bocara-mobile
npm ci
npm run lint
npx tsc --noEmit
npm run build:web
npx expo start
```

La URL de la API se configura mediante las variables públicas definidas por el frontend y debe apuntar al backend público vigente.

## Validación antes de integrar

1. Ejecutar las pruebas del backend.
2. Ejecutar lint, TypeScript y build web del frontend.
3. Abrir un pull request hacia `main`.
4. Esperar que GitHub Actions y la vista previa de Vercel terminen correctamente.
5. Revisar que el cambio no incluya `.env`, respaldos ni `node_modules`.

## Despliegue

`render.yaml`, ubicado en la raíz, configura `backend/` como el directorio raíz del servicio. Render instala dependencias con `npm ci` e inicia la API con `npm start`.

Vercel conserva `bocara-mobile/` como directorio raíz. No se debe renombrar esa carpeta sin cambiar primero la configuración del proyecto en Vercel.

Las migraciones de Supabase no se ejecutan automáticamente. Los archivos se encuentran en:

- `backend/supabase/migrations/`: migraciones versionadas.
- `backend/sql/`: SQL operativo, diagnósticos y procedimientos especiales.
- `backend/scripts/`: tareas administrativas manuales.

Antes de cualquier migración: crear respaldo, leer el archivo completo, confirmar el entorno y ejecutar primero los diagnósticos indicados. `docs/CUBO_MIGRACION_OPERATIVA.md` se conserva como referencia histórica; no debe repetirse sobre producción.

## Comprobación posterior al despliegue

- La raíz de la API responde correctamente.
- El frontend abre y permite iniciar sesión.
- Los paneles de cliente, restaurante y administrador cargan.
- Las promociones y los pedidos existentes siguen visibles.
- El historial financiero mantiene separados venta, comisión, tarifa al cliente y propina.
- No se registra una liquidación como pagada hasta realizar la transferencia real.

Las pruebas con cobros reales deben limitarse al negocio de prueba autorizado. No se deben crear, editar o cancelar pedidos de otros restaurantes.
