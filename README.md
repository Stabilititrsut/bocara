# Bocara

Repositorio de la aplicación Bocara. El código productivo está separado por responsabilidad para que cada cambio tenga un alcance claro.

## Estructura

```text
.
├── backend/        API Node.js, pruebas, scripts y migraciones SQL
├── bocara-mobile/  aplicación Expo/React Native y versión web
├── docs/           documentación operativa
├── .github/        integración continua
└── render.yaml     despliegue del backend en Render
```

`bocara-mobile` es el único frontend vigente. El nombre se conserva porque Vercel y Expo ya lo usan.

## Desarrollo local

Backend:

```bash
cd backend
cp .env.example .env
npm ci
npm run check
npm test
npm start
```

Frontend:

```bash
cd bocara-mobile
npm ci
npm run lint
npx tsc --noEmit
npm run build:web
```

Las variables privadas se configuran en `.env` local o en el proveedor de despliegue; nunca se guardan en Git.

## Despliegue

- Render lee `render.yaml` desde la raíz y ejecuta el servicio dentro de `backend/`.
- Vercel mantiene `bocara-mobile/` como directorio raíz del frontend.
- GitHub Actions valida ambos proyectos antes de integrar cambios a `main`.

Las migraciones no se ejecutan automáticamente durante el despliegue. Deben revisarse y aplicarse de forma explícita siguiendo la documentación de `docs/`.
