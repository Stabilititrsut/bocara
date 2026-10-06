# Pipeline de imágenes

Mejora automática de las fotos que suben los restaurantes (Promoción, Tiempo limitado y foto del negocio), **sin perder nunca la original**.

## 1. Decisión técnica

- **Proveedor por defecto: `local` (gratis).** Ajuste fotográfico con [`sharp`](https://sharp.pixelplumbing.com/) dentro del propio backend: orientación correcta, contraste suave, color un poco más vivo, nitidez moderada y tamaño web (máx. 1600 px, WebP). No usa ninguna API, no tiene costo ni límite de uso y **no puede inventar nada**: corrige la foto real. Es la opción gratuita seria; las APIs de IA "gratis" tienen cuotas mínimas, sin garantías ni SLA, y no sirven para producción.
- **Proveedor de IA (de pago, opcional): `replicate`.** Usa un modelo de edición por instrucción (por defecto `black-forest-labs/flux-kontext-pro`), que retoca la foto conservando el producto. Se activa con dos variables y no necesita cambios de código. El costo es por imagen (al escribir esto, del orden de centavos de dólar; confirmar en replicate.com/pricing antes de activarlo).
- **Adapter:** `backend/services/imagenes/proveedores.js`. Agregar otro proveedor (Cloudinary, Photoroom, etc.) es implementar `mejorar({ buffer, urlOriginal }) → { buffer, contentType, meta }` y registrarlo en `obtenerProveedor`.
- **Asíncrono, sin cola nueva:** el estado vive en la misma fila (`bolsas` / `negocios`). Al guardar se dispara la mejora en segundo plano; un job cada minuto retoma reintentos y procesos interrumpidos. Guardar una publicación nunca espera ni falla por la IA.

### ¿Por qué `imagen_url` pasa a mostrar la mejorada?

`imagen_url` se usa en 83 lugares de la app (feed, detalle, tienda, carrito, admin…). En lugar de cambiar todas esas pantallas, la columna significa ahora **"la imagen que se muestra"** y el pipeline guarda la foto del restaurante en `imagen_original_url`. Así el cliente ve la mejor versión en toda la app sin tocar las pantallas ni los endpoints públicos, y el original sigue intacto:

- `imagen_original_url` solo se escribe al subir una foto nueva; el pipeline nunca la cambia;
- el archivo original en Storage nunca se toca: la mejorada es un archivo nuevo (`mejoradas/<tabla>/<id>/<ts>.webp`);
- con "Usar mi original" el restaurante vuelve a su foto en un toque (la mejorada se conserva).

## 2. Modelo de datos

Migración aditiva `backend/supabase/migrations/20261006100000_pipeline_imagenes.sql` (mismas columnas en `bolsas` y `negocios`):

| Columna | Uso |
|---|---|
| `imagen_url` | (existente) la imagen que se muestra: la mejorada si está completada; si no, la original |
| `imagen_original_url` | la foto tal como la subió el restaurante |
| `imagen_mejorada_url` | resultado del proveedor |
| `estado_procesamiento_imagen` | `NULL` sin procesar · `pendiente` · `procesando` · `completada` · `fallida` · `descartada` (el restaurante eligió su original) |
| `proveedor_imagen_ia` | `local` / `replicate` / … |
| `error_procesamiento_imagen` | último error legible |
| `imagen_procesamiento_meta` | jsonb: dimensiones, bytes, preset/modelo, id de predicción, ruta |
| `imagen_intentos` | intentos del ciclo actual |
| `imagen_solicitada_at`, `imagen_procesamiento_iniciado_at`, `imagen_procesada_at` | timestamps |

Las filas existentes quedan en `NULL` (sin procesar) y se siguen viendo igual que antes. Para mejorarlas, ejecuta por lotes `node scripts/encolar-imagenes-existentes.js --aplicar --limite 50` (sin `--aplicar` es solo simulacro).

## 3. Flujo

```
Restaurante sube foto ──► POST /api/uploads/base64 (Storage, sin cambios)
        │
        ▼
POST/PUT publicación o negocio ──► se guarda imagen_url (= original) ──► respuesta inmediata
        │
        └─► programarMejora (en segundo plano)
              solicitar: original fijada, estado = pendiente
              reclamar (CAS pendiente → procesando; nunca dos workers a la vez)
              descargar la original (solo de nuestro Storage: anti-SSRF, máx. 10 MB)
              proveedor.mejorar
              validar fidelidad (misma proporción ±12 %, tamaño mínimo)
              subir la mejorada como archivo NUEVO
              publicar (CAS: solo si la foto no cambió mientras tanto)
                  imagen_url = mejorada · estado = completada
Job cada minuto (server.js): reintentos con espera de 2 min, recupera "procesando" de más de 10 min
```

- **Foto nueva en una edición** → reinicia el ciclo (mejorada anterior descartada, estado `pendiente`). Si el formulario reenvía la misma foto (original o mejorada), no cuenta como cambio: no reinicia la mejora ni manda la publicación a revisión.
- **Cambio de foto durante el proceso** → el resultado viejo se descarta y nunca pisa la foto nueva.
- **Fallo del proveedor** (caída, timeout, error) → se reintenta hasta 3 veces con 2 min de espera; después queda `fallida`. **Durante todo ese tiempo se muestra la original.**
- **Resultado sospechoso** (cambió la proporción = posible imagen distinta) → se descarta (`fallida`) y se muestra la original.
- **Migración sin aplicar** → el pipeline solo registra un aviso; publicar y editar siguen funcionando igual que hoy.

### Calidad visual / prompt

- `local`: preset `comida_comercial_v1`, conservador a propósito (mejor quedarse corto que sobreprocesar).
- `replicate`: prompt `PROMPT_COMIDA` en `proveedores.js` (reemplazable con `IMAGE_AI_PROMPT`). Pide luz natural, color realista y vivo, nitidez sin exceso, fondo limpio y buen encuadre, y prohíbe explícitamente cambiar, agregar o quitar comida u objetos, alterar textos o logos y usar estilos ilustrados o exagerados.

## 4. Variables de entorno (backend)

| Variable | Default | Uso |
|---|---|---|
| `IMAGE_AI_PROVIDER` | `local` | `local` (gratis) · `replicate` (IA de pago) · `none` (apagado) |
| `REPLICATE_API_TOKEN` | — | obligatoria con `replicate`; sin ella se usa `local` con aviso en el log |
| `REPLICATE_IMAGE_MODEL` | `black-forest-labs/flux-kontext-pro` | modelo de Replicate |
| `IMAGE_AI_PROMPT` | prompt interno | reemplaza el prompt |
| `IMAGE_AI_TIMEOUT_MS` | `120000` | tiempo máximo por imagen con IA |
| `IMAGE_PIPELINE_ALLOWED_HOSTS` | — | hosts extra (separados por coma) desde los que se puede descargar el original; `SUPABASE_URL` siempre está permitido |

Ninguna clave va en el código ni en la app; el frontend no conoce al proveedor.

## 5. Qué ve cada uno

- **Restaurante** (panel → Disponibles y Perfil): debajo de cada foto, una línea: "⏳ Mejorando tu foto…", "✨ Foto mejorada automáticamente · Usar mi original", "⚠️ No se pudo mejorar · se muestra tu original · Reintentar" o "📷 Se muestra tu foto original · Usar mejorada". Mientras hay una mejora en curso, la lista se refresca sola cada 10 s. Las fotos anteriores al pipeline no muestran nada nuevo.
- **Cliente**: siempre la mejor versión disponible en todas las pantallas, sin cambios en la app. Nunca ve una imagen rota por culpa de la IA.
- **API de acciones**: `POST /api/imagenes/{publicacion|negocio}/:id/{reintentar|usar-original|usar-mejorada}` (solo el dueño o un admin).

## 6. Probar localmente

1. `cd backend && npm ci` (instala `sharp`, con binarios precompilados para Windows, macOS y Linux).
2. Aplica la migración en el Supabase de pruebas (SQL Editor).
3. `.env`: `IMAGE_AI_PROVIDER=local` (no hace falta ninguna clave). Con `BOCARA_DISABLE_JOBS=true` el job periódico no corre, pero el disparo inmediato al guardar sí.
4. Levanta el backend y la app, entra como restaurante y crea una Promoción con foto. En unos segundos la tarjeta pasa de "Mejorando tu foto…" a "Foto mejorada". En la BD, `imagen_original_url` es tu foto y `imagen_url` es `…/mejoradas/bolsas/<id>/<ts>.webp`.
5. Pruebas automáticas: `npm test` (backend, incluye `test/imagenesPipeline.test.js`) y `node scripts/test-estado-imagen.cjs` (app).
6. IA de pago: `IMAGE_AI_PROVIDER=replicate` + `REPLICATE_API_TOKEN` y repetir el paso 4. El log muestra `[IMAGENES] bolsas/<id> mejorada con replicate`.

## 7. Estado para producción

- **Listo:** pipeline, estados, reintentos, recuperación tras reinicio, anti-SSRF, validación de fidelidad, acciones del restaurante, proveedor gratuito operativo sin credenciales, adapter de Replicate probado con mocks.
- **Falta para usar la IA de pago:** crear la cuenta de Replicate, poner `REPLICATE_API_TOKEN` en Render y `IMAGE_AI_PROVIDER=replicate`, y validar la calidad con 10–20 fotos reales antes de activarla para todos.
- **Notas operativas:**
  - HEIC (iPhone) no lo decodifica el `sharp` precompilado: esas fotos quedan `fallida` y se muestra la original. En el teléfono no pasa (la app envía JPEG, `src/utils/pickImage.ts`); solo un HEIC subido desde la versión web.
  - Las mejoradas reemplazadas quedan como archivos huérfanos en Storage (limpieza futura opcional).
  - Si el admin aprobó la foto original, la mejorada se publica sin una nueva revisión. Con `local` no hay riesgo (es la misma foto); con IA generativa conviene revisar una muestra al activarla.
