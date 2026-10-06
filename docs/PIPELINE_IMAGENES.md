# Pipeline de imágenes — mejora con IA

Mejora automática de las fotos que suben los restaurantes (Promoción, Tiempo limitado y foto del negocio) para que se vean más comerciales y apetitosas, **sin perder nunca la original** y sin cambiar el producto.

## 1. Proveedor

| `IMAGE_AI_PROVIDER` | Qué es | Uso |
|---|---|---|
| **`replicate`** (principal) | **IA real de edición de imagen**: modelo [`black-forest-labs/flux-kontext-pro`](https://replicate.com/black-forest-labs/flux-kontext-pro) (FLUX.1 Kontext [pro]) vía Replicate, image-to-image sobre la foto original con `aspect_ratio: match_input_image` | producción y pruebas de calidad |
| `local` | Ajuste técnico con `sharp` (contraste, color, nitidez). **No es IA** y no logra un acabado comercial | desarrollo sin costo, tests, respaldo explícito |
| `none` | Pipeline apagado | emergencias |
| *(sin definir)* | `replicate` si hay `REPLICATE_API_TOKEN`; si no, `local` | |

`IMAGE_AI_PROVIDER=replicate` sin token **no** usa IA: registra un error en el log y aplica el ajuste local, que queda trazado como `proveedor_imagen_ia = 'local'` y la app lo muestra como "Foto ajustada automáticamente", nunca como "con IA".

`sharp` sigue en el pipeline solo para: preparar la entrada (rotación EXIF, ≤ 2048 px, formato), convertir la salida a WebP ≤ 1600 px, validar y como proveedor de respaldo.

### Por qué no alcanzaba con `sharp`

Un filtro global (contraste, saturación, nitidez) no puede reiluminar un plato, corregir una sombra dura, limpiar el entorno ni dar acabado de fotografía comercial. En fotos reales el cambio era casi imperceptible. FLUX Kontext es un modelo de **edición guiada por instrucción**: recibe la foto real y una instrucción, y devuelve la misma escena retocada.

## 2. Prompt (fidelidad)

`PROMPT_COMIDA` en `backend/services/imagenes/proveedores.js` (reemplazable con `IMAGE_AI_PROMPT`):

- **Pide mejorar solo la presentación:** luz natural de restaurante, balance de blancos, exposición equilibrada, color apetitoso pero real, claridad y textura, contraste sutil, entorno algo más limpio, profundidad natural y acabado de fotografía gastronómica profesional.
- **Prohíbe explícitamente:**
  - agregar, quitar o reemplazar comida o ingredientes;
  - cambiar cantidades o porciones;
  - inventar guarniciones, salsas, vapor, props o decoración;
  - alterar marcas, etiquetas o texto;
  - reemplazar el fondo;
  - HDR artificial, sobresaturación, comida "plástica", estilo ilustrado.
- Además: `prompt_upsampling: false` (que el modelo no reescriba la instrucción) y `safety_tolerance: 2` (el máximo permitido con imagen de entrada).

## 3. Flujo

```
Restaurante sube foto → Storage (original, ruta propia; nunca se sobrescribe)
POST/PUT publicación o negocio → se guarda → respuesta inmediata (no espera a la IA)
  └─ en segundo plano (y job cada minuto para reintentos):
     estado = pendiente → reclamo con CAS → procesando
     descargar ORIGINAL (solo de nuestro Storage, ≤ 10 MB, https, sin redirecciones)
     preparar con sharp si hace falta: EXIF / > 2048 px / formato → COPIA en preparadas/…jpg
     Replicate FLUX Kontext Pro: input_image = original (o su copia preparada), match_input_image
     descargar salida (solo https://*.replicate.delivery, ≤ 20 MB) → WebP ≤ 1600 px
     validar (ver §4)
     subir como archivo NUEVO: mejoradas/<tabla>/<id>/<ts>.webp
     publicar (CAS, solo si la foto no cambió): imagen_mejorada_url, imagen_url = mejorada, completada
```

| Falla | Resultado |
|---|---|
| Timeout, 5xx o 429 de Replicate, red | `pendiente`; reintento en ≥ 2 min, hasta 3 intentos → `fallida` |
| Predicción `failed` (filtro o entrada inválida), 4xx, salida que no es imagen o viene de un host ajeno | `fallida` de inmediato (reintentar no lo arregla) |
| Resultado que no pasa la validación | `fallida`, con las métricas guardadas para revisar |

En todos los casos de falla se sigue mostrando la original y el restaurante puede tocar **Reintentar**.

### Storage

```
bolsas/<negocio>_….jpg                  ← original (no lo toca el pipeline)
preparadas/<tabla>/<id>/<ts>.jpg        ← copia orientada/reducida para la IA (solo si hizo falta)
mejoradas/<tabla>/<id>/<ts>.webp        ← resultado
```

`imagen_procesamiento_meta` guarda: `ia`, `modelo`, `prediccion` (id de Replicate), `ms`, dimensiones, métricas de validación, `entrada_preparada`, `procesada_en` (o `fallo_en` + métricas si falló). Nunca guarda el token.

## 4. Validación de fidelidad — qué garantiza y qué no

`backend/services/imagenes/validacion.js`:

- **Imagen válida** y ≥ 256 px.
- **Misma proporción** (±12 %).
- **Similitud estructural:** correlación de luminancia 32×32 con la entrada, ≥ `IMAGE_AI_MIN_SIMILITUD` (0.55 por defecto). Calibrada con escenas de prueba: un retoque de luz o color da ~0.99; otro plato, una imagen espejada o rotada dan ~0.0.
- **Sobresaturación:** la saturación media no puede subir más de `IMAGE_AI_MAX_SUBIDA_SATURACION` (0.20). Los retoques reales suben entre 0.02 y 0.15.
- **Cambio visible:** si el resultado es prácticamente idéntico (diferencia media < 3/255), no se publica como "mejorada". Recomprimir la misma foto da ~1–2.

> **Importante:** la validación automática reduce riesgos, pero **una IA generativa puede modificar detalles** (una hoja, un reflejo, una letra de una etiqueta) que estas métricas globales no detectan. Una verificación semántica robusta requeriría otro modelo de pago, así que no se finge esa garantía. Por eso:
> - la original se conserva siempre;
> - el restaurante ve la comparación y vuelve a su foto con un toque;
> - cada imagen queda trazada con proveedor, modelo y predicción;
> - el admin puede revisar una muestra al activar la IA.

## 5. Qué ve cada uno

- **Restaurante** (Disponibles y Perfil), bajo cada foto:
  - "Mejorando tu foto…";
  - "✨ Foto mejorada con IA" (o "Foto ajustada automáticamente" si fue el ajuste local), con **Usar mi original** y **Comparar** (original y mejorada lado a lado);
  - "⚠️ No se pudo mejorar · se muestra tu original" con **Reintentar**;
  - "📷 Se muestra tu foto original" con **Usar mejorada**.
- **Cliente:** la mejor versión disponible (`imagen_url`) en toda la app, sin cambios en sus pantallas.

## 6. Costos (estimación — confirmar antes de producción)

No pude leer el precio en la página oficial del modelo (la carga con JavaScript). Las fuentes públicas consultadas el 2026-10-05 lo ubican en **~US$0.04 por imagen** generada, y alguna reporta ~US$0.055. **Confirmar el precio vigente en https://replicate.com/black-forest-labs/flux-kontext-pro antes de activarlo.** No hay costos en la lógica del código.

| Fotos procesadas | a US$0.04 | a US$0.055 |
|---|---|---|
| 100 | ~US$4 | ~US$5.50 |
| 1,000 | ~US$40 | ~US$55 |
| 10,000 | ~US$400 | ~US$550 |

Cada reintento o "Reintentar" es una ejecución más. Las fotos viejas no se procesan solas: se encolan por lotes con `node scripts/encolar-imagenes-existentes.js --aplicar --limite 50`.

## 7. Variables de entorno (solo backend)

| Variable | Default | Uso |
|---|---|---|
| `IMAGE_AI_PROVIDER` | (ver §1) | `replicate` · `local` · `none` |
| `REPLICATE_API_TOKEN` | — | token de replicate.com. **Solo en el backend**; la app nunca llama a Replicate |
| `REPLICATE_IMAGE_MODEL` | `black-forest-labs/flux-kontext-pro` | modelo |
| `IMAGE_AI_PROMPT` | `PROMPT_COMIDA` | reemplaza el prompt |
| `IMAGE_AI_TIMEOUT_MS` | `120000` | tiempo máximo por imagen |
| `IMAGE_AI_MIN_SIMILITUD` | `0.55` | umbral de similitud estructural |
| `IMAGE_AI_MAX_SUBIDA_SATURACION` | `0.20` | subida máxima de saturación |
| `IMAGE_PIPELINE_ALLOWED_HOSTS` | — | hosts extra desde los que se puede descargar el original (`SUPABASE_URL` siempre está permitido) |

## 8. Tests sin gastar dinero

`npm test`, `npm run check` y el CI de GitHub (`.github/workflows/quality.yml`) **nunca llaman a Replicate**:

- el adapter recibe un cliente HTTP falso que simula Replicate (`replicateFalso` en `test/imagenesPipeline.test.js`);
- un interceptor de axios hace fallar cualquier petición real a `replicate.com` o `replicate.delivery` y la prueba AI-10 verifica que el contador quedó en 0;
- sin `REPLICATE_API_TOKEN` (como en CI), el proveedor nunca es Replicate.

## 9. Prueba manual con Replicate real (5–10 fotos)

No toca la base de datos ni el Storage:

```bash
cd backend
REPLICATE_API_TOKEN=r8_... node scripts/probar-mejora-ia.js ~/fotos/plato1.jpg ~/fotos/plato2.jpg ... --salida ./prueba-ia
# abrir prueba-ia/index.html
```

- **Fotos recomendadas** (reales, de celular):
  - plato con salsa y guarnición;
  - postre con brillo o crema;
  - bebida en vaso;
  - empaque o caja con logo y texto;
  - bolsa sorpresa / panadería;
  - foto con poca luz;
  - foto contra ventana (contraluz);
  - plato sobre mesa desordenada;
  - foto vertical;
  - foto muy grande (> 4000 px).
- La página muestra ORIGINAL | MEJORADA, las métricas, el veredicto de la validación y una tabla para evaluar luz, color, nitidez, aspecto comercial, fidelidad, ingredientes, logos y textos, proporciones y naturalidad.
- **La prueba no pasa porque la API respondió.** Pasa si la foto se ve claramente mejor **y** el producto sigue siendo el mismo.
- Con `--local` corre el ajuste técnico gratuito (no IA), útil para comparar.
- Los archivos locales se envían como *data URI* (copia ≤ 1536 px). Si Replicate los rechazara por tamaño, pasa URLs https (por ejemplo, fotos ya subidas a Storage). El esquema de entrada del modelo (`input_image`, `aspect_ratio`, `output_format`, `safety_tolerance`, `prompt_upsampling`) se confirma en esta primera prueba real.

### De punta a punta en la app

1. Aplicar la migración `20261006100000_pipeline_imagenes.sql`.
2. `backend/.env`: `IMAGE_AI_PROVIDER=replicate` y `REPLICATE_API_TOKEN=…`.
3. Como restaurante, crear una Promoción con una foto real.
4. En ~10–40 s la tarjeta muestra "✨ Foto mejorada con IA". Revisar con **Comparar**.
5. En la BD:
   - `proveedor_imagen_ia = 'replicate'`;
   - `imagen_procesamiento_meta.prediccion` presente;
   - `imagen_original_url` es la foto subida;
   - `imagen_url` termina en `/mejoradas/…webp`.
6. **Usar mi original** → el cliente ve la original. **Usar mejorada** → vuelve la mejorada.
7. Poner un token inválido y crear otra publicación → "No se pudo mejorar · Reintentar", con la original visible.

## 10. Modelo de datos

Migración aditiva `backend/supabase/migrations/20261006100000_pipeline_imagenes.sql`, con las mismas columnas en `bolsas` y `negocios`: `imagen_original_url`, `imagen_mejorada_url`, `estado_procesamiento_imagen` (`pendiente` · `procesando` · `completada` · `fallida` · `descartada`), `proveedor_imagen_ia`, `error_procesamiento_imagen`, `imagen_procesamiento_meta`, `imagen_intentos`, `imagen_solicitada_at`, `imagen_procesamiento_iniciado_at`, `imagen_procesada_at`.

`imagen_url` (existente) es la imagen que se muestra. El original vive en `imagen_original_url` y en su propio archivo; la mejorada nunca lo sobrescribe. Sin la migración aplicada, publicar y editar siguen funcionando: el pipeline solo registra un aviso.

## 11. Pendiente para producción

- Crear la cuenta de Replicate y poner `REPLICATE_API_TOKEN` en Render (`IMAGE_AI_PROVIDER` ya viene en `replicate` en `render.yaml`).
- Hacer la prueba manual del §9 con fotos reales y ajustar el prompt o los umbrales si hace falta.
- Confirmar el precio.
- Opcional: limpieza de archivos `preparadas/` y de mejoradas reemplazadas.
