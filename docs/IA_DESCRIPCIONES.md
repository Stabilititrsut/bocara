# IA de texto — "Mejorar descripción con IA"

Ayuda al restaurante a redactar la descripción de una **Promoción** o de un producto por **Tiempo limitado**. Es la segunda pieza del bloque de IA de Bocara; la primera es la mejora de fotos con OpenAI ([PIPELINE_IMAGENES.md](PIPELINE_IMAGENES.md)). Son independientes: cada una tiene su proveedor, su clave y su interruptor.

| | Fotos | Descripción |
|---|---|---|
| Proveedor | OpenAI (`IMAGE_AI_PROVIDER=openai`) | Gemini (`TEXT_AI_PROVIDER=gemini`) |
| Modelo | `OPENAI_IMAGE_MODEL=gpt-image-1-mini` | `GEMINI_TEXT_MODEL=gemini-2.5-flash-lite` |
| Cuándo corre | automático al guardar una foto nueva | solo cuando el restaurante toca el botón |
| Qué se guarda | original + mejorada | **nada**: la propuesta va al campo y el restaurante decide |

## 1. Experiencia del restaurante

En el formulario de crear/editar publicación (`bocara-mobile/app/restaurante/bolsas.tsx`), bajo el campo **Descripción**, está el botón **✨ Mejorar descripción con IA**. Es el mismo componente (`components/BotonDescripcionIA.tsx`) para Promoción y Tiempo limitado.

1. El restaurante llena al menos el **nombre** (sin nombre, el botón explica que hace falta y no llama a nadie).
2. Toca el botón → se deshabilita y muestra **✨ Mejorando descripción con IA…**. El campo Descripción se bloquea mientras tanto para que la propuesta no pise lo que esté escribiendo. Los toques repetidos se ignoran (una sola petición).
3. La propuesta **reemplaza** el texto del campo y queda **editable**. Aparece **✅ Descripción sugerida** con **Editar sugerencia** (lleva el cursor al campo) y, si había una descripción antes, **Deshacer** (la recupera).
4. Nada se guarda hasta que el restaurante toca **Guardar** (el flujo normal de `/api/bolsas`, con la revisión del admin de siempre).

Si algo falla (Gemini caído, timeout, respuesta bloqueada o con datos no verificables), **la descripción existente no se toca** y se muestra: *No pudimos mejorar la descripción. Intenta nuevamente.* Los límites (429) y la validación (400) muestran su propio mensaje. Si el formulario se cierra mientras genera, la respuesta tardía se descarta.

La IA **no se ejecuta sin consentimiento**: no hay generación automática.

## 2. Backend

```
POST /api/ia/descripcion          (routes/ia.js)
Authorization: Bearer <token de restaurante>
{ "tipo": "bolsa" | "cupon", "nombre": "...", ... }
→ 200 { "descripcion": "..." }
```

| Archivo | Qué hace |
|---|---|
| `services/text-ai/index.js` | servicio común: validación, lista blanca, saneamiento, elección de proveedor, limpieza y verificación de la salida |
| `services/text-ai/providers/gemini.js` | proveedor Gemini (REST `generateContent`) |
| `services/text-ai/prompts.js` | instrucción de sistema y formato de los hechos |
| `services/text-ai/limites.js` | rate limit por minuto, cupo diario por restaurante y global |
| `routes/ia.js` | endpoint autenticado |

El endpoint:

- requiere autenticación y **rol restaurante** (verificado contra la BD por `middleware/auth.js`; cliente y admin → 403);
- tiene su propio `express.json` de **8 KB** (montado antes del parser global de 15 MB) → 413 si se excede;
- valida tipos y longitudes (nombre 2–120, descripción ≤ 600, contenido ≤ 400, precios 0–100 000, horas `HH:MM`, fechas `AAAA-MM-DD`, categoría de alimento de la lista);
- **no guarda nada** en la BD y responde solo `{ descripcion }`.

| Status | Cuándo |
|---|---|
| 400 | validación |
| 401 / 403 | sin sesión / no es restaurante |
| 413 | body > 8 KB |
| 429 | rate limit por minuto (con `Retry-After`) o cupo diario |
| 502 | Gemini falló, bloqueó la respuesta o la propuesta traía cifras inventadas |
| 503 | IA de texto no configurada: `{ error, codigo: 'IA_TEXTO_NO_CONFIGURADA', detalle, faltan }`. `detalle` dice qué variable falta (en la app se muestra en desarrollo). No consume cupo. |
| 504 | timeout |

### Proveedores intercambiables

`TEXT_AI_PROVIDER=gemini | openai | none`. Para agregar uno (p. ej. OpenAI para texto) basta un archivo en `services/text-ai/providers/` con:

```js
{ nombre, modelo, async generar({ sistema, usuario, temperatura, maxTokens, timeoutMs }) → { texto, finCorte, uso } }
```

y una línea en `obtenerProveedorTexto()` (`services/text-ai/index.js`). La ruta, el prompt, los límites y la app no cambian. Hoy `openai` se trata como `none`.

### Gemini: contrato verificado (documentación oficial, 2026-10-14)

- Modelo: `gemini-2.5-flash-lite` (ID estable; entrada hasta 1 048 576 tokens, salida hasta 65 536). El razonamiento ("thinking") viene **apagado por defecto** en Flash-Lite, así que no se envía `thinkingConfig`.
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent`
- Autenticación: header `x-goog-api-key` (la clave **nunca** va en la URL).
- Body: `systemInstruction.parts[].text`, `contents[].role/parts[].text`, `generationConfig.{temperature, maxOutputTokens, candidateCount}`.
- Respuesta: `candidates[0].content.parts[].text`, `candidates[0].finishReason` (`STOP`, `MAX_TOKENS`, `SAFETY`, …), `promptFeedback.blockReason` (prompt bloqueado, sin candidatos), `usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}`.

Se usa `fetch` nativo (Node ≥ 20) en lugar del SDK: es una sola llamada y así no se suma una dependencia.

Referencias: [modelo](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite) · [generateContent](https://ai.google.dev/api/generate-content) · [precios](https://ai.google.dev/gemini-api/docs/pricing) · [límites](https://ai.google.dev/gemini-api/docs/rate-limits)

## 3. Qué datos se envían (y cuáles no)

Solo datos **públicos del producto** que ya están en el formulario, filtrados por lista blanca en la app (`src/utils/descripcionIA.ts`) **y** otra vez en el backend (`validarEntrada` / `construirHechos`):

| Se envía | Nota |
|---|---|
| tipo | "Promoción" / "Tiempo limitado" |
| nombre | |
| descripción actual | el borrador del restaurante |
| contenido | solo Tiempo limitado ("¿Qué puede contener?"). En Promoción ese campo es el **código del cupón** y no se envía |
| categoría del alimento | etiqueta legible |
| precio original y precio Bocara | `Q60.00` |
| % de descuento | lo calcula el backend, no se confía en el cliente |
| horario de recogida | `18:00 a 20:00` |
| fecha | inicio/fin de vigencia o fecha de publicación |
| categoría del negocio | la lee el backend del perfil del propio restaurante |

**No se envía**: ids, nombre/correo/teléfono del usuario o del negocio, dirección, enlaces, foto, stock, código de cupón, tipo de descuento, banderas de menú ni nada fuera de la lista. Además, del texto libre se eliminan HTML, caracteres invisibles, correos, URLs y números de teléfono antes de salir.

## 4. Prompt y salvaguardas contra datos inventados

`services/text-ai/prompts.js`:

- español neutro para Guatemala, 120–220 caracteres, una o dos frases, tono de marketplace/restaurante, sin emojis, sin superlativos no comprobables;
- regla explícita: *Use exclusively the supplied facts. Never invent ingredients, quantities, brands, flavors, preparation methods or promotional conditions. If a fact is not supplied, omit it.* (y lo mismo para tamaños, precios, porcentajes, horarios, fechas, disponibilidad);
- los hechos van como **JSON delimitado** en el mensaje del usuario y la instrucción de sistema dice que son datos, no órdenes (mitiga instrucciones escritas dentro del nombre o la descripción).

Después de la respuesta (`services/text-ai/index.js`):

- se limpian emojis, markdown, comillas y prefijos tipo "Descripción:"; si el modelo se cortó (`MAX_TOKENS`) o pasa de 300 caracteres, se recorta a la última frase completa;
- **verificación de cifras**: todo número de la propuesta debe existir en los hechos (precio, %, hora —también en formato de 12 h—, día). Si aparece un número nuevo ("Q25", "50 %", "2 hamburguesas") la propuesta se **descarta** (502) y el campo no cambia.

Ejemplo — entrada pobre `Hamburguesa con papas` → *Disfruta una hamburguesa acompañada de papas, disponible por tiempo limitado a precio Bocara.*

La verificación de cifras no detecta un ingrediente inventado sin números (p. ej. "con queso"); para eso están el prompt y, sobre todo, la **revisión del restaurante**: la propuesta siempre es editable y nunca se guarda sola.

## 5. Control de costos y abuso

| Control | Valor por defecto | Variable |
|---|---|---|
| Rate limit por restaurante | 5 por minuto | `TEXT_AI_MAX_PER_MINUTE` |
| Cupo diario por restaurante | 30 | `TEXT_AI_DAILY_LIMIT` |
| Cupo diario global | 500 | `TEXT_AI_GLOBAL_DAILY_LIMIT` |
| Tokens de salida máximos | 160 | `TEXT_AI_MAX_OUTPUT_TOKENS` (32–400) |
| Temperatura | 0.4 | `TEXT_AI_TEMPERATURE` (0–1) |
| Timeout | 10 s | `TEXT_AI_TIMEOUT_MS` (2–30 s) |
| Body | 8 KB | fijo en `routes/ia.js` |

- El minuto cuenta cada intento; el cupo diario solo se consume cuando la petición es válida y va a llamar al proveedor. El día es el calendario de Guatemala.
- Los contadores viven en memoria de la instancia (hoy hay una sola en Render). Si se escala a varias instancias, el tope real es N × límite: mover los contadores a la BD o a Redis.
- Logs: `[TEXTO_IA] ok proveedor=… modelo=… ms=… tokens=…/… chars=…` o `[TEXTO_IA] fallo codigo=…`. **Nunca** se registran la clave, los datos del formulario ni la propuesta.

## 6. Configuración

Solo en el backend (`backend/.env` en local, variables de entorno en Render):

```
TEXT_AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-2.5-flash-lite
```

`GEMINI_API_KEY` **nunca** va en la app (`bocara-mobile`), en variables `EXPO_PUBLIC_*` ni en git. La app solo conoce `POST /api/ia/descripcion`.

### Obtener la clave

1. Entrar a [Google AI Studio](https://aistudio.google.com/) con la cuenta de Bocara.
2. **Get API key** → crear una clave en un proyecto de Google Cloud dedicado a Bocara.
3. Copiarla en `GEMINI_API_KEY` de `backend/.env` (local) y en Render como variable secreta (`sync: false` en `render.yaml`).
4. En AI Studio, la página de límites del proyecto muestra la cuota vigente.

### Probar localmente

```bash
cd backend
# con GEMINI_API_KEY en .env
node scripts/probar-descripcion-ia.js                       # 3 ejemplos (Tiempo limitado y Promoción)
node scripts/probar-descripcion-ia.js '{"tipo":"bolsa","nombre":"Hamburguesa con papas"}'
npm start                                                    # luego, en la app: Mis publicaciones → Nueva → escribir nombre → ✨
```

Sin clave (o con `TEXT_AI_PROVIDER=none`) no se llama a nadie y nada queda ambiguo: el log de arranque dice `[IA] Texto: NO OPERATIVA — falta GEMINI_API_KEY…`, `GET /api/ia/estado` lo reporta, el botón muestra el aviso bajo él y, al tocarlo, "La mejora de descripción con IA no está configurada en el servidor." (en desarrollo, con el detalle de qué falta).

Verificación con la API real: `cd backend && node scripts/verificar-ia.js` (ver [IA_IMAGEN_PUBLICACIONES.md](IA_IMAGEN_PUBLICACIONES.md#7-probar-localmente-paso-a-paso)).

## 7. Free tier, privacidad y costos

- **Free tier**: Gemini 2.5 Flash-Lite figura como *Free of charge* para entrada y salida en el nivel gratuito ([precios](https://ai.google.dev/gemini-api/docs/pricing), consultado el 2026-10-14). La página oficial de límites no publica cifras fijas por modelo: dice que dependen del nivel y del proyecto y que **pueden cambiar**; la cuota real se ve en AI Studio. Guías de terceros citan ~30 RPM / ~1 000 RPD para Flash-Lite gratis, sin confirmación oficial. Los límites de Bocara (500 diarias globales) están pensados para quedar por debajo.
- **Privacidad**: en el nivel gratuito Google indica que el contenido **se usa para mejorar sus productos** ("Used to improve our products: Yes"); en el nivel pago, no. Por eso solo se envían datos públicos del producto (sección 3) y se eliminan correos/teléfonos/URLs del texto libre. **No** mandar información personal ni sensible del restaurante o de clientes. Si en algún momento se necesitara enviar algo más, pasar antes a nivel pago.
- **Costo en nivel pago** (si se activa facturación): US$0.10 por millón de tokens de entrada y US$0.40 por millón de salida. Una descripción usa ~450 tokens de entrada y ~60 de salida → ~US$0.00007 por descripción, **~US$0.07 por cada 1 000**. Con el tope global de 500/día, el máximo teórico es ~US$1 al mes.

## 8. Tests (sin red)

```bash
cd backend && node --test test/textoIA.test.js       # 25 pruebas, Gemini simulado con fetch inyectado
cd bocara-mobile && node scripts/test-descripcion-ia.cjs  # 12 pruebas de la lógica y el cableado de la UI
```

Cubren: lista blanca de datos, ausencia de secretos en URL/body, respuesta `{ descripcion }`, edición posterior, fallo y timeout sin tocar la descripción, rate limit / cupos, 401/403, validación de longitud y tamaño, cifras inventadas descartadas, y una trampa en `globalThis.fetch` que falla si algo intenta salir a la red.
