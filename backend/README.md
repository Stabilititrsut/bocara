# Backend de Bocara

API Express de Bocara.

## Directorios

- `config/`: clientes y configuración de infraestructura.
- `middleware/`: autenticación, autorización y límites de solicitudes.
- `routes/`: endpoints HTTP.
- `services/`: reglas de negocio e integraciones.
- `scripts/`: verificaciones y tareas administrativas manuales.
- `test/`: pruebas automatizadas.
- `sql/`: diagnósticos y SQL operativo.
- `supabase/migrations/`: migraciones versionadas de Supabase.
- `utils/`: utilidades compartidas.

## Comandos

```bash
npm ci
npm run check
npm test
npm start
```

Antes de iniciar localmente, copia `.env.example` a `.env` y completa únicamente tus credenciales locales. Los scripts administrativos y las migraciones nunca deben ejecutarse contra producción sin una revisión y un respaldo previos.
