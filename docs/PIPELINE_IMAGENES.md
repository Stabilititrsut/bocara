# Pipeline de imágenes — mejora con IA

Mejora automática de las fotos que suben los restaurantes (Promoción, Tiempo limitado y foto del negocio) para que se vean más comerciales y apetitosas, **sin perder nunca la original** y sin cambiar el producto.

## 1. Proveedores

| `IMAGE_AI_PROVIDER` | Qué es | Uso |
|---|---|---|
| **`openai`** (principal) | **IA real**: OpenAI GPT Image, modelo `gpt-image-1-mini` por defecto, endpoint `images.edit` con el SDK oficial `openai` | producción |
| `replicate` (opcional) | IA real: FLUX.1 Kontext [pro] vía Replicate | alternativa |
| `local` | Ajuste técnico con `sharp`. **No es IA** | desarrollo sin costo, tests, respaldo |
| `none` | Pipeline apagado | emergencias |
| *(sin definir)* | `openai` si hay `OPENAI_API_KEY`; si no, `replicate` si hay `REPLICATE_API_TOKEN`; si no, `local` | |

Si se configura un proveedor de IA sin su credencial, **no usa IA**: registra un error en el log y aplica el ajuste local, que queda trazado como `proveedor_imagen_ia = 'local'` y la app lo muestra como "Foto ajustada automáticamente", nunca "con IA".

### Modelo: `gpt-image-1-mini`

- **Verificado en la documentación oficial** ([página del modelo](https://developers.openai.com/api/docs/models/gpt-image-1-mini), [referencia de `images.edit`](https://developers.openai.com/api/reference/python/resources/images/methods/edit)) y en los tipos del SDK `openai@7.28.0`:
  - el ID exacto es `gpt-image-1-mini`;
  - soporta `v1/images/edits`;
  - es el modelo de edición de imágenes más económico de OpenAI.
- **Parámetros que envía Bocara:** `model`, `image` (JPEG), `prompt`, `size`, `quality`, `output_format: 'png'`, `n: 1`.
- **Parámetros que no envía:**
  - `input_fidelity`: `gpt-image-1-mini` solo admite `low`, así que se omite;
  - `response_format`: no aplica a los modelos GPT Image.
- **Respuesta:** siempre en base64 (`data[0].b64_json`).
- Para más fidelidad (y más costo): `OPENAI_IMAGE_MODEL=gpt-image-1` o `gpt-image-1.5`.

### Proporción (sin recortar ni deformar)

GPT Image 1.x solo devuelve `1024x1024`, `1536x1024` o `1024x1536`. Bocara:

1. elige el tamaño más parecido a la proporción de la foto (4:3 → `1536x1024`, vertical → `1024x1536`);
2. coloca la foto **completa** centrada sobre un fondo hecho con ella misma ampliada y muy desenfocada (relleno neutro);
3. recorta del resultado exactamente el rectángulo de la foto.

La mejorada conserva la proporción y el encuadre de la original.

## 2. Prompt

`backend/services/imagenes/prompts.js`, compartido por OpenAI y Replicate y organizado por secciones:

| Sección | Contenido |
|---|---|
| **OBJETIVO** | Foto real de un producto que el cliente compra; retoque de fotógrafo profesional en postproducción. |
| **PRESERVAR** | Mismos ingredientes, cantidades, porciones, plato o empaque, disposición, ángulo y encuadre. Logos, etiquetas y textos idénticos. Misma proporción, sin recortar ni reencuadrar. |
| **MEJORAR** | Luz natural de restaurante, balance de blancos, exposición (sombras y luces), color apetitoso pero real, detalle y textura, contraste suave, profundidad natural, entorno más limpio sin reemplazarlo. |
| **PROHIBIDO** | Cambiar el plato; agregar o quitar ingredientes, salsas, guarniciones, props; agrandar porciones; vapor, humo o destellos; alterar, inventar o traducir textos o logos; deformar. Los bordes desenfocados son solo relleno. |
| **ESTILO** | Foto real y honesta: sin HDR artificial, sin sobresaturación, sin comida plástica, sin "look IA", sin ilustración ni 3D. |

`IMAGE_AI_PROMPT` lo reemplaza completo, para hacer pruebas A/B sin desplegar.

## 3. Flujo

```
Restaurante sube foto → Storage (archivo original; nunca se sobrescribe)
POST/PUT publicación o negocio → se guarda → respuesta inmediata (no espera a la IA)
  └─ en segundo plano (y un job cada minuto para reintentos y reinicios):
     pendiente → reclamo con CAS → procesando
     descargar ORIGINAL (solo de nuestro Storage, https, ≤ 10 MB, sin redirecciones)
     preparar con sharp (rotación EXIF, ≤ 2048 px)
     OpenAI images.edit (lienzo del tamaño estándar más cercano)
     recortar a la proporción original → WebP ≤ 1600 px
     validar (§4)
     subir como archivo NUEVO: mejoradas/<tabla>/<id>/<ts>.webp
     publicar con CAS (solo si la foto no cambió mientras tanto):
       imagen_mejorada_url · imagen_url = mejorada · completada
```

| Falla | Resultado |
|---|---|
| Timeout, 5xx, 429 por límite de velocidad, error de red | `pendiente`; se reintenta tras ≥ 2 min, hasta 3 intentos; luego `fallida` |
| 400 (p. ej. `moderation_blocked`), 401, 429 `insufficient_quota`, salida que no es imagen | `fallida` de inmediato (reintentar no lo arregla) |
| Resultado que no pasa la validación | `fallida`, con las métricas guardadas |

En todos los casos se sigue mostrando la original y el restaurante puede tocar **Reintentar**. Si la foto se cambia mientras se procesa, el resultado viejo se descarta y nunca pisa la foto nueva.

### Estados

`estado_procesamiento_imagen` usa nombres ya existentes; así se traducen a lo que pediste:

| Estado | Equivale a | Imagen visible | Texto en el panel |
|---|---|---|---|
| `NULL` | sin_procesar | original | (nada) |
| `pendiente` / `procesando` | procesando | original | "Mejorando tu foto…" |
| `completada` | mejorada / mostrando_mejorada | mejorada | "✨ Foto mejorada con IA · se muestra la mejorada" |
| `fallida` | fallida | original | "⚠️ No se pudo mejorar, se muestra tu original" + Reintentar |
| `descartada` | mostrando_original | original | "📷 Se muestra tu foto original" + Usar mejorada |

Con el ajuste local, el texto de `completada` es "Foto ajustada automáticamente", nunca "con IA".

## 4. Validación del resultado

`backend/services/imagenes/validacion.js`:

- **Imagen válida**, no vacía, ≥ 256 px.
- **Misma proporción** (±12 %; con el recorte de §1 coincide).
- **Similitud estructural** con la original ≥ 0.55. Un retoque da ~0.99; otro plato, una imagen espejada o rotada dan ~0.
- **Sin sobresaturación:** la saturación media no puede subir más de 0.20.
- **Cambio visible:** si el resultado es prácticamente idéntico, no se publica como mejorada.

> La validación reduce riesgos, pero **una IA generativa puede modificar detalles** (una hoja, un reflejo, una letra) que estas métricas globales no detectan. Por eso:
> - la original se conserva siempre;
> - el restaurante tiene **Comparar** y **Usar mi original**;
> - cada imagen guarda proveedor, modelo, calidad, tamaño y métricas en `imagen_procesamiento_meta`.

## 5. Configuración (solo backend)

| Variable | Default | Uso |
|---|---|---|
| `IMAGE_AI_PROVIDER` | (ver §1) | `openai` · `replicate` · `local` · `none` |
| `OPENAI_API_KEY` | — | clave de platform.openai.com. **Solo en el backend**; la app nunca llama a OpenAI |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1-mini` | modelo |
| `OPENAI_IMAGE_QUALITY` | `medium` | `low` · `medium` · `high` |
| `IMAGE_AI_TIMEOUT_MS` | `120000` | tiempo máximo por imagen (OpenAI indica hasta ~2 min en prompts complejos) |
| `IMAGE_AI_PROMPT` | `prompts.js` | reemplaza el prompt |
| `IMAGE_AI_MIN_SIMILITUD` / `IMAGE_AI_MAX_SUBIDA_SATURACION` | 0.55 / 0.20 | umbrales de validación |
| `REPLICATE_API_TOKEN`, `REPLICATE_IMAGE_MODEL` | — | solo para `replicate` |
| `IMAGE_PIPELINE_ALLOWED_HOSTS` | — | hosts extra desde los que se puede descargar el original |

- **Activar:** `IMAGE_AI_PROVIDER=openai` + `OPENAI_API_KEY`.
- **Desactivar la IA sin desplegar código:** `IMAGE_AI_PROVIDER=local` (ajuste técnico) o `none` (sin mejora).

## 6. Costos (precios oficiales de la página del modelo, consultados el 2026-10-05)

Precio por imagen de salida de `gpt-image-1-mini`:

| Calidad | 1024×1024 | 1536×1024 / 1024×1536 |
|---|---|---|
| low | US$0.005 | US$0.006 |
| **medium** (por defecto) | **US$0.011** | **US$0.015** |
| high | US$0.036 | US$0.052 |

A eso se suma un costo pequeño por la imagen de entrada (US$2.50 por millón de tokens de imagen) y por el texto del prompt (US$2 por millón). La mayoría de las fotos de celular son 4:3 o 3:4, así que caen en 1536×1024 o 1024×1536.

| Fotos | low | **medium** | high |
|---|---|---|---|
| 100 | ~US$0.60 | **~US$1.50–2** | ~US$5.20 |
| 1,000 | ~US$6 | **~US$15–20** | ~US$52 |
| 10,000 | ~US$60 | **~US$150–200** | ~US$520 |

Cada reintento o "Reintentar" es una llamada más. Confirmar los precios vigentes en la página del modelo antes de producción; ningún costo está escrito en el código.

## 7. Tests sin gastar dinero

`npm test`, `npm run check` y el CI nunca llaman a OpenAI ni a Replicate:

- `test/imagenesOpenAI.test.js`:
  - cliente OpenAI falso que devuelve un retoque real de la imagen recibida;
  - **OAI-SDK** ejecuta el **SDK oficial** con `fetch` simulado y verifica la petición real: `POST https://api.openai.com/v1/images/edits`, multipart, `model`, `size`, `quality`, `output_format`, `prompt`, `image`;
  - una guardia sobre `fetch` bloquea y cuenta cualquier llamada no simulada a `api.openai.com` (debe quedar en 0).
- `test/imagenesPipeline.test.js`: lo mismo para Replicate, con una guardia de axios.

## 8. Prueba manual

### a) Calidad con fotos reales (sin base de datos ni Storage)

```bash
cd backend
OPENAI_API_KEY=sk-... node scripts/probar-mejora-ia.js ~/fotos/plato1.jpg ... ~/fotos/plato10.jpg --salida ./prueba-ia
# abrir prueba-ia/index.html: ORIGINAL | MEJORADA, métricas y checklist
```

- Variantes: `--proveedor replicate` (FLUX) y `--local` (ajuste técnico, no IA).
- Usa 5–10 fotos reales de celular:
  - plato con salsa;
  - postre;
  - bebida;
  - empaque con logo;
  - panadería;
  - poca luz;
  - contraluz;
  - mesa desordenada;
  - foto vertical;
  - foto muy grande.
- **La prueba pasa si la foto se ve claramente mejor y el producto sigue siendo el mismo**, no porque la API respondió.

### b) De punta a punta en local

1. Aplicar en el Supabase de pruebas `backend/supabase/migrations/20261006100000_pipeline_imagenes.sql` (aditiva; ya contiene todas las columnas).
2. `backend/.env`: `IMAGE_AI_PROVIDER=openai`, `OPENAI_API_KEY=sk-...`.
3. Levantar backend y app: `scripts\start-local.cmd` (o `scripts\start-local-backend.cmd` + `scripts\start-local-frontend.cmd`).
4. Entrar como restaurante → **Disponibles** → crear una Promoción con una foto real de comida.
5. La tarjeta muestra **"⏳ Mejorando tu foto…"** (se refresca sola cada 10 s).
6. En ~15–60 s cambia a **"✨ Foto mejorada con IA · se muestra la mejorada"**. Tocar **Comparar** para verla junto a la original.
7. **Usar mi original** → "📷 Se muestra tu foto original". **Usar mejorada** → vuelve la mejorada.
8. Como cliente, la promoción muestra la mejorada.
9. En la BD:
   - `proveedor_imagen_ia = 'openai'`;
   - `imagen_procesamiento_meta.modelo = 'gpt-image-1-mini'`;
   - `imagen_original_url` es la foto subida;
   - `imagen_url` termina en `/mejoradas/…webp`.
10. Con una clave inválida → **"⚠️ No se pudo mejorar, se muestra tu original"** + **Reintentar**, y la publicación sigue funcionando.

## 9. Modelo de datos

Migración aditiva `20261006100000_pipeline_imagenes.sql`, con las mismas columnas en `bolsas` y `negocios`:

- `imagen_original_url`
- `imagen_mejorada_url`
- `estado_procesamiento_imagen`
- `proveedor_imagen_ia`
- `error_procesamiento_imagen`
- `imagen_procesamiento_meta` (modelo, calidad, tamaño, métricas, uso)
- `imagen_intentos`
- `imagen_solicitada_at`, `imagen_procesamiento_iniciado_at`, `imagen_procesada_at`

OpenAI no necesitó columnas nuevas. `imagen_url` sigue siendo la imagen visible, por lo que no cambia ninguna pantalla del cliente.

## 10. Pendiente para producción

- Poner `OPENAI_API_KEY` en Render (`IMAGE_AI_PROVIDER=openai` ya viene en `render.yaml`).
- Aplicar la migración.
- Validar 5–10 fotos reales con el script del §8a y ajustar `OPENAI_IMAGE_QUALITY` o el prompt si hace falta.
- Revisar una muestra de resultados en producción la primera semana.
