# Imagen con IA obligatoria para publicar

Ninguna **Promoción** ni **Tiempo limitado** se publica sin una foto que haya pasado por el análisis de calidad, la mejora con IA y la validación del resultado. La foto original del restaurante se conserva siempre.

> Antes (rama `feat/image-pipeline`) la mejora corría **después** de guardar, en segundo plano y sin bloquear nada: sin migración ni clave no hacía nada, en silencio, y se podía publicar cualquier foto. Este documento describe el flujo que lo reemplaza para publicaciones. Las fotos del **negocio** (registro, perfil, portada) **no pasan por IA**: se guardan tal como las sube el restaurante.

## 1. Flujo

```
Restaurante elige foto ──► /api/uploads/base64 (Storage)  →  "Subiendo imagen…"
                       └─► POST /api/imagenes/trabajos     →  trabajo en "subida"
                                 │  (procesa en el acto; la app consulta cada 1.5 s)
                                 ▼
  analizando   🔍 Analizando imagen…   ¿hay información visual suficiente para una foto comercial FIEL?
     │  ✗ SOLO extremos ──► rechazada  ❌ Imagen rechazada: no se puede usar esta foto  → Cambiar foto
     │     (archivo dañado / no es imagen, < 200 px o producto irreconocible, no es comida, captura o collage)
     │  oscura, borrosa, pequeña (400–599 px), mal proporcionada, cortada, close-up, desordenada, ruido…
     │     ──► NO se rechaza: pasa a la IA con la lista de qué corregir
     ▼
  mejorando    ✨ Mejorando tamaño, calidad y presentación con IA…
     │     OpenAI GPT Image en encuadre COMERCIAL: lienzo estándar 1024×1024 / 1536×1024 / 1024×1536,
     │     foto ampliada si es pequeña, fondo extendido para recomponer (con margen si venía cortada),
     │     sin mover ni inventar comida
     │  ✗ ──► fallida    ⚠️ motivo exacto (sin créditos, clave inválida, modelo, caída)  → Reintentar / Cambiar foto
     ▼
  validando    🔍 Validando resultado…
     │     1. la comida (región de la foto original) sigue siendo la misma (similitud)
     │     2. calidad y resolución publicables (lado menor ≥ 1024 px)
     │     3. revisión IA con ORIGINAL + RESULTADO: mismo producto, sin ingredientes/cantidades
     │        inventados, presentable. Un close-up o comida que sale del cuadro NO es defecto.
     │  no se parece / no llega / cambió el producto ──► fallida (reintentable: genera otra versión)
     │     …salvo que la ORIGINAL ya cumpliera todo: lista con la original (usa_original, fallback seguro)
     │  fiel pero no presentable ──► rechazada  ❌ Esta imagen no cumple la calidad mínima para Bocara (+ motivos)
     ▼
  lista        ✅ Imagen optimizada y lista para publicar   "La IA mejoró iluminación, nitidez y encuadre."
```

Mientras procesa, la app muestra los pasos y "Procesando imagen con IA, espera un momento…". Mientras el trabajo no esté en `lista`, el botón **Guardar** del formulario se ve bloqueado (🔒) con el motivo en una franja visible; tocarlo explica el motivo y lleva a la foto. El backend aplica la misma regla, así que no se puede saltar desde otra app o con la API.

| Archivo | Rol |
|---|---|
| `backend/services/imagenes/calidad.js` | métricas técnicas reales y umbrales |
| `backend/services/imagenes/revisionIA.js` | revisión con visión (OpenAI Responses + Structured Outputs) |
| `backend/services/imagenes/trabajos.js` | el flujo, la regla de publicación y el job de recuperación |
| `backend/services/imagenes/proveedorOpenAI.js` | mejora con GPT Image (sin cambios) |
| `backend/services/imagenes/validacion.js` | similitud original↔mejorada (sin cambios) |
| `backend/services/iaEstado.js` | diagnóstico: qué falta (claves, migraciones) |
| `backend/routes/imagenes.js` | `/api/imagenes/trabajos` |
| `backend/routes/bolsas.js`, `routes/admin.js` | la regla de publicación |
| `bocara-mobile/src/utils/procesoImagen.ts` | estados, textos, bloqueo de Guardar, sondeo |
| `bocara-mobile/hooks/use-trabajo-imagen.ts` | hook del sondeo |
| `bocara-mobile/components/EstadoProcesoImagen.tsx` | pasos visibles + Reintentar / Cambiar foto |
| `bocara-mobile/app/restaurante/bolsas.tsx` | formulario (crear y editar, ambos tipos) |

## 2. Calidad mínima (real, no simulada)

**Técnica** (`calidad.js`, sharp, sobre la foto reducida a ≤ 512 px):

| Métrica | En la original: problema a corregir con IA si | Exige en la mejorada |
|---|---|---|
| Resolución (lado menor) | < 600 px (< 200 px = irreconocible, se rechaza) | ≥ 1024 px (`IMAGE_QUALITY_PUBLICABLE_MIN_LADO`) |
| Proporción (lado mayor / menor) | > 2.0 (se corrige: lienzo estándar con fondo extendido) | ≤ 2.0 |
| Brillo medio (0–255) | < 35 (muy oscura) o > 235 (quemada) | 70–225 |
| Contraste (desv. estándar) | < 15 (lavada) | ≥ 28 |
| Nitidez (varianza del laplaciano) | < 25 (borrosa/movida) | ≥ 45 |
| Píxeles casi negros / casi blancos | > 60 % / > 45 % | ≤ 35 % / ≤ 25 % |

La original solo se rechaza por lo que la IA **no** puede arreglar (`analizarRecuperable`): archivo ilegible, lado menor < `IMAGE_QUALITY_MIN_LADO_ABSOLUTO` (256 px) o proporción > 2:1. Todo lo demás (oscura, borrosa, quemada, lavada, < 600 px) pasa a la mejora y se le indica al modelo qué corregir (`prompts.js`, `CORRECCIONES`); si el resultado sigue sin ser publicable, no se acepta. Medido sobre la escena de prueba: nítida 572 de nitidez, desenfoque leve 18, muy oscura 31 de brillo, recorte 3:1 → 3.0. Todos los umbrales son variables `IMAGE_QUALITY_*`; calibrar con fotos reales:

```bash
cd backend && node scripts/probar-calidad-imagen.js ruta/a/carpeta-con-fotos
```

**Revisión con IA** (`revisionIA.js`): `gpt-6-luna` (configurable con `OPENAI_VISION_MODEL`) recibe la foto y responde un JSON estricto `{ apta, problemas[], resumen }`. Corre dos veces: sobre la **original** (modo `original`), donde solo `no_es_comida` y `captura_o_collage` frenan el flujo y el resto se anota como problema a corregir; y sobre el **resultado** (modo `resultado`), donde cualquier problema (cortado, borroso, descuidado, aspecto artificial…) bloquea la publicación con su motivo.

**Validación del resultado**: la mejorada debe conservar la estructura de la original (similitud ≥ 0.55), no sobresaturarse, tener un cambio visible y pasar el nivel *publicable*. Si no, `fallida` (reintentable): nunca se publica una versión que no representa el producto. **Fallback seguro**: si la original ya era publicable y sin problemas, se usa la original (`usa_original: true`, la publicación queda con `estado_procesamiento_imagen = descartada`). Si OpenAI falla (sin créditos, clave inválida, caída) el trabajo queda `fallida` con `error_codigo` `proveedor_sin_credito` / `proveedor_clave` / `proveedor_modelo` / `proveedor` y un mensaje que lo dice; la original nunca se pierde.

## 3. Regla de publicación (backend)

| Acción | Requisito |
|---|---|
| `POST /api/bolsas` | `imagen_trabajo_id` de un trabajo `lista` del mismo negocio, no usado por otra publicación. Se guarda `imagen_url` = mejorada, `imagen_original_url` = original, `estado_procesamiento_imagen = 'completada'`. El `imagen_url` del body se ignora. |
| `PUT /api/bolsas/:id` con foto nueva | igual que crear; vuelve a revisión del admin. |
| `PUT` sin foto nueva | si la foto de la publicación nunca pasó la IA (heredada), solo se puede **ocultar** o **ajustar unidades**; cualquier cambio de contenido o reactivación → 409 `IMAGEN_SIN_VALIDAR`. |
| `PUT /api/admin/bolsas/:id/aprobar` | la foto debe estar validada (`completada` o `descartada`) → si no, 409 `IMAGEN_SIN_VALIDAR`. |
| `POST /api/imagenes/publicacion/:id/reintentar` | 409: la foto de una publicación se reprocesa cambiándola en el formulario. |

`descartada` = el restaurante eligió su original en la tarjeta ("Usar mi original"). Es publicable porque esa original ya superó el análisis técnico y la revisión IA.

Códigos de error que ve la app: `IMAGEN_NO_PROCESADA` (400), `IMAGEN_EN_PROCESO` (409), `IMAGEN_RECHAZADA` (422), `IMAGEN_FALLIDA` (422), `IMAGEN_YA_USADA` (409), `IMAGEN_SIN_VALIDAR` (409), `MIGRACION_PENDIENTE` (503).

Las publicaciones **ya publicadas** antes de este cambio siguen visibles (no se ocultan en retroactivo), pero no pueden editarse ni reactivarse sin cambiar la foto. En su tarjeta aparece "⚠️ Foto sin validar por IA · cámbiala al editar para volver a publicar".

## 4. Sin claves o sin migraciones: nada ambiguo

- Al arrancar, el backend imprime una línea por pieza: `[IA] Texto: …`, `[IA] Imagen: …`, `[IA] Migraciones: …` con lo que falta.
- `GET /api/ia/estado` (restaurante/admin) devuelve el mismo diagnóstico (nombres de variables y migraciones, nunca valores).
- Al abrir el formulario, si la IA de imagen o las migraciones no están, aparece un aviso rojo; en desarrollo dice exactamente qué falta.
- Un trabajo sin IA configurada termina en `fallida` con `error_codigo = 'ia_no_configurada'`; en desarrollo se muestra el detalle ("falta OPENAI_API_KEY…"). No se "aprueba" la foto ni se aparenta una mejora. `IMAGE_AI_PROVIDER=local` (ajuste con sharp) no es IA y **no** sirve para publicar.
- Sin la migración de trabajos, crear un trabajo responde 503 nombrando `20261014100000_trabajos_imagen.sql`; sin la de columnas, guardar responde 503 nombrando `20261006100000_pipeline_imagenes.sql`.

## 5. Configuración

```
IMAGE_AI_PROVIDER=openai
OPENAI_API_KEY=                       # solo backend
OPENAI_IMAGE_MODEL=gpt-image-1-mini   # mejora
OPENAI_VISION_MODEL=gpt-6-luna        # revisión (opcional, es el valor por defecto)
```

Opcionales: `OPENAI_IMAGE_QUALITY` (low/medium/high), `IMAGE_AI_MAX_TRABAJOS_POR_HORA` (20), `IMAGE_AI_MAX_TRABAJOS_POR_DIA` (60), `IMAGE_QUALITY_*` (sección 2).

**Migraciones** (Supabase → SQL Editor, en este orden; ambas aditivas e idempotentes):

1. `backend/supabase/migrations/20261006100000_pipeline_imagenes.sql` — columnas de imagen en `bolsas` y `negocios`.
2. `backend/supabase/migrations/20261014100000_trabajos_imagen.sql` — tabla `trabajos_imagen`.

## 6. Costos

| Paso | Modelo | Costo aprox. por foto |
|---|---|---|
| Revisión | `gpt-6-luna` (US$0.10 / 0.50 por M tokens; imagen en detalle bajo) | < US$0.001 |
| Mejora | `gpt-image-1-mini`, calidad medium | US$0.011–0.015 |
| Rechazada por calidad técnica | ninguno | US$0 (no se llama a la IA) |

≈ US$1.5 por cada 100 fotos aceptadas. El límite de 20 fotos/hora y 60/día por restaurante acota abusos.

## 7. Probar localmente, paso a paso

1. Aplicar las dos migraciones (sección 5) en el proyecto de Supabase de desarrollo.
2. En `backend/.env`: `IMAGE_AI_PROVIDER=openai`, `OPENAI_API_KEY=…`, `TEXT_AI_PROVIDER=gemini`, `GEMINI_API_KEY=…`.
3. `cd backend && node scripts/verificar-ia.js` → `Gemini texto: OK`, `OpenAI imagen: OK`, `Migraciones: OK` (prueba en vivo con el motivo exacto si algo falla, p. ej. "la cuenta de OpenAI no tiene créditos"). Con `--imagen` recorre además el flujo completo real (analizar → mejorar → validar, ≈ US$0.015) y guarda `verificacion-mejorada.webp`.
4. `npm start` → en el log: `[IA] Imagen: OPERATIVA`, `[IA] Texto: OPERATIVA`, `[IA] Migraciones: OK`. Con el backend arriba: `GET http://localhost:3000/api/ia/status?probar=1` (sin login en desarrollo; solo admin en producción) devuelve el mismo diagnóstico en JSON. Cada foto deja en consola líneas `[IMAGEN_IA] <id> …` por paso (subida, análisis, llamada a OpenAI, validación, resultado o fallo).
5. `cd bocara-mobile && npx expo start --web` → entrar como restaurante → Mis publicaciones → Nueva.
6. Elegir una foto: se ven "Subiendo imagen…", luego los pasos (Analizando calidad → Mejorando con IA → Validando resultado) y el 🔒 en Guardar con el motivo.
7. Al llegar a "✅ Imagen lista para publicar", la vista previa cambia a la mejorada y Guardar se habilita.
8. Probar el bloqueo: subir una foto muy oscura o borrosa → "❌ Esta imagen no cumple la calidad mínima…" con el motivo; Guardar sigue bloqueado; "Cambiar foto".
9. Probar sin clave: quitar `OPENAI_API_KEY` y reiniciar → aviso rojo en el formulario y, al subir, "⚠️ No se pudo mejorar la imagen" con el detalle (en desarrollo). No se puede publicar.

## 8. Tests (sin red)

```bash
cd backend && node --test test/trabajosImagen.test.js     # 34: calidad real, revisión, flujo, regla de publicación, endpoints, diagnóstico
cd bocara-mobile && node scripts/test-proceso-imagen.cjs   # 15: textos, pasos, bloqueo, sondeo, componente, pantalla real
```

OpenAI se simula siempre (cliente inyectado); las fotos son escenas sintéticas medidas con sharp de verdad.
