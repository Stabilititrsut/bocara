// Prompt de mejora de fotografía gastronómica, compartido por todos los
// proveedores de IA (OpenAI GPT Image, Replicate FLUX Kontext).
//
// Está armado por secciones para poder ajustar una sin reescribir las demás:
//   OBJETIVO  → qué es la imagen y para qué se usa
//   PRESERVAR → lo que tiene que quedar idéntico (la promesa al cliente)
//   MEJORAR   → lo único que se permite cambiar (presentación)
//   PROHIBIDO → errores típicos de los modelos de imagen con comida
//   ESTILO    → acabado final
// IMAGE_AI_PROMPT lo reemplaza completo (para pruebas A/B sin desplegar).

const OBJETIVO = [
  'This is a real photo of a dish or product taken by a restaurant with a phone.',
  'It will be shown to customers who buy exactly this product on a food marketplace.',
  'Retouch it like a professional food photographer would in post-production.',
];

const PRESERVAR = [
  'Keep exactly the same food or product: same ingredients, same quantities and portion size,',
  'same plate, bowl, cup, tray or packaging, same arrangement and positions, same camera angle and framing.',
  'Keep every logo, label, brand and written text exactly as it is and legible.',
  'Keep the original aspect ratio and composition; do not crop, zoom, rotate or reframe.',
];

const MEJORAR = [
  'Improve only the presentation:',
  'soft natural restaurant lighting, correct white balance (no yellow or blue cast),',
  'balanced exposure that opens dark shadows and recovers blown highlights,',
  'appetizing but true-to-life color, crisp detail and pleasant natural texture on the food,',
  'gentle contrast and natural depth,',
  'and a cleaner, less distracting surrounding (tidier table, softer clutter) without replacing the setting.',
];

const PROHIBIDO = [
  'Do not change, replace or restyle the dish.',
  'Do not add or remove any ingredient, topping, sauce, garnish, herb, utensil, prop or decoration.',
  'Do not change quantities or make portions look bigger.',
  'Do not add steam, smoke, splashes, sparkles or other effects that were not in the photo.',
  'Do not alter, invent or translate any text, logo, brand or packaging design.',
  'Do not warp, stretch or distort shapes.',
  'Soft blurred borders, if present, are only padding: leave them as plain blurred background.',
];

const ESTILO = [
  'The result must look like a real, honest photograph of the same product, shot by a professional:',
  'no artificial HDR look, no oversaturated colors, no plastic or waxy food, no overly smooth AI look,',
  'no illustration, painting or 3D render style.',
];

const PROMPT_FOTO_COMIDA = [OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO]
  .map((seccion) => seccion.join(' '))
  .join('\n');

// Encuadre COMERCIAL (fotos de publicaciones): el restaurante sube una foto
// normal de celular y Bocara la entrega en un formato comercial estándar.
// La foto va completa dentro del lienzo (proveedorOpenAI.prepararLienzo); el
// borde desenfocado es relleno que el modelo reemplaza por la continuación
// natural de la mesa / superficie / fondo. La comida se queda donde está.
const ENCUADRE_COMERCIAL = [
  'The original photo occupies a rectangle of this canvas; the soft blurred area around it is only padding.',
  'Replace that padding with a natural, seamless continuation of the same table, surface and background,',
  'so the result is one complete, well-composed commercial food photograph that fills the whole canvas.',
  'Keep the food inside the original rectangle exactly where it is, at the same size: do not move, zoom, crop or rotate it.',
  'Never place food, extra pieces, ingredients, garnishes, sauces, utensils, logos, labels or packaging in the extended area.',
  'If the food is cut by the edge of the original photo, you may complete only a small, obvious continuation of the plate, container or surface;',
  'if completing it would require inventing a substantial part of the food, leave it as a close-up and just extend the background.',
  'A tight close-up of food is acceptable and must stay a close-up.',
];
// Igual que PRESERVAR, pero sin "same framing" ni "keep the aspect ratio":
// aquí el encuadre sí se amplía (solo el fondo).
const PRESERVAR_COMERCIAL = [
  PRESERVAR[0],
  'same plate, bowl, cup, tray or packaging, same arrangement and positions, same camera angle.',
  PRESERVAR[2],
];
const PROHIBIDO_COMERCIAL = PROHIBIDO.filter((l) => !l.startsWith('Soft blurred borders'));

const PROMPT_COMERCIAL = [OBJETIVO, PRESERVAR_COMERCIAL, MEJORAR, ENCUADRE_COMERCIAL, PROHIBIDO_COMERCIAL, ESTILO]
  .map((seccion) => seccion.join(' '))
  .join('\n');

// Imágenes del RESTAURANTE (no de un producto): foto de perfil y portada.
// Aquí la IA es SOLO restauración técnica (resolución, nitidez, ruido, luz,
// contraste, balance de blancos, artefactos) y adaptación del formato
// extendiendo el fondo existente. Nada creativo: la prioridad es la
// FIDELIDAD a la marca. Si el resultado cambia letras, logo, colores o
// elementos, la validación lo rechaza y se conserva la original (trabajos.js).
const TECNICO_NEGOCIO = [
  'This is the real image of a restaurant or food business. Treat it as a technical photo restoration job, not a creative edit.',
  'The output must be the SAME image, pixel-faithful in content, only technically cleaner.',
];
const PRESERVAR_NEGOCIO = [
  'Preserve exactly: every letter, word, number and the business name (same font, spelling, size, spacing and position);',
  'every logo and symbol (same shapes, internal proportions, line weights and positions);',
  'the brand colors (same hues and saturation; do not recolor, shift, enrich or replace them);',
  'every product, dish, person, object and decoration, in the same place, size and appearance;',
  'the composition and the identity of the business.',
];
const PROHIBIDO_NEGOCIO = [
  'Strictly forbidden: redrawing, redesigning, vectorizing, retyping, restyling, simplifying, "cleaning up" or reinterpreting a logo, symbol or text;',
  'inventing or adding text, logos, signs, products, food, people, props or decorations;',
  'removing any element; changing colors other than correcting a global color cast; stretching, warping or changing proportions;',
  'beautifying, stylizing, adding effects, bokeh, glow, gradients or a new background design.',
  'If an improvement would require changing any of the above, do not make it: leave that part exactly as in the original.',
];
const ESTILO_NEGOCIO = [
  'Natural, true-to-original look: no HDR effect, no oversaturation, no plastic or AI-smooth texture, no illustration or 3D look.',
];

// Perfil (avatar): lienzo cuadrado; el logo completo, sin recortar nada.
const ENCUADRE_PERFIL = [
  'Allowed technical fixes only: increase resolution, sharpen existing edges, reduce noise, correct exposure and contrast, correct white balance of a global color cast, remove compression artifacts.',
  'Square format: the original image occupies a centered rectangle of this square canvas and must stay exactly there, at the same size, fully visible, never cropped.',
  'The soft blurred area around it is only padding: fill it with a plain, seamless continuation of the image’s own background color or texture, with nothing in it.',
];
// Portada (banner): lienzo horizontal; solo se extiende fondo o superficie.
const ENCUADRE_PORTADA = [
  'Allowed technical fixes only: increase resolution, sharpen, reduce noise, correct lighting, exposure and contrast, correct white balance of a global color cast.',
  'Horizontal format: the original image occupies a rectangle of this wide canvas and must stay exactly there, at the same size.',
  'The soft blurred area around it is only padding: fill it only with a plain, seamless continuation of the existing background, wall, sky, floor or surface, with no new objects, products, people, text or decorations.',
];

const PROMPT_PERFIL = [TECNICO_NEGOCIO, PRESERVAR_NEGOCIO, ENCUADRE_PERFIL, PROHIBIDO_NEGOCIO, ESTILO_NEGOCIO]
  .map((seccion) => seccion.join(' '))
  .join('\n');
const PROMPT_PORTADA = [TECNICO_NEGOCIO, PRESERVAR_NEGOCIO, ENCUADRE_PORTADA, PROHIBIDO_NEGOCIO, ESTILO_NEGOCIO]
  .map((seccion) => seccion.join(' '))
  .join('\n');

// Igual que CORRECCIONES, sin suponer que la imagen es comida y solo con
// correcciones técnicas (sin "ordenar" ni recomponer el contenido).
const CORRECCIONES_NEGOCIO = Object.freeze({
  oscura: 'The image is underexposed: raise the exposure and open the shadows.',
  muy_oscura: 'The image is underexposed: raise the exposure and open the shadows.',
  quemada: 'The image is overexposed: recover the blown highlights where detail exists.',
  sin_contraste: 'The image looks flat: restore natural contrast without changing any color.',
  borrosa: 'The image is soft: sharpen the existing edges only, without redrawing shapes or letters.',
  resolucion: 'The image is low resolution: upscale it faithfully, keeping every shape and letter identical.',
  baja_calidad: 'The image has noise and compression artifacts: remove them without altering any detail.',
  proporcion: 'Fill the canvas only by extending the existing background.',
  no_cuadrada: 'The original is not square: fill the square canvas only with the existing background color or texture.',
  no_horizontal: 'The original is not horizontal: fill the sides only with the existing background or surface.',
  recortada: 'The subject is tightly framed: leave the subject untouched and extend only the background around it.',
});

// Problemas detectados en el análisis de la original (calidad.js y
// revisionIA.js) → indicación concreta para el modelo. Sin entrada aquí, el
// problema no se menciona (el prompt base ya cubre la mejora general).
const CORRECCIONES = Object.freeze({
  oscura: 'The photo is underexposed: brighten it and open the shadows so the food is clearly visible.',
  muy_oscura: 'The photo is underexposed: brighten it and open the shadows so the food is clearly visible.',
  quemada: 'The photo is overexposed: recover the blown highlights and restore texture.',
  sin_contraste: 'The photo looks flat and washed out: restore natural contrast and color depth.',
  borrosa: 'The photo is soft or slightly out of focus: recover crisp, natural detail on the food without inventing new details.',
  resolucion: 'The photo is low resolution: restore clean, natural fine detail.',
  baja_calidad: 'The photo has low overall quality: clean up noise and compression artifacts.',
  desordenada: 'The surroundings look messy: make them cleaner and less distracting without replacing the setting.',
  recortada: 'The food is partly cut by the edges or tightly framed: give it a balanced commercial composition by extending only the background and surface, never the food itself.',
  proporcion: 'The original photo has an awkward aspect ratio: extend the background and surface so the canvas looks like a natural commercial photo.',
  manos_o_personas: 'Hands or people are visible: keep the food as the clear protagonist and make them less prominent without altering the food.',
});

// encuadre: 'original' (fotos de negocio: mismo encuadre y proporción),
// 'comercial' (publicaciones: lienzo estándar con el fondo extendido),
// 'perfil' (avatar cuadrado) o 'portada' (banner horizontal) del restaurante.
// IMAGE_AI_PROMPT solo reemplaza el prompt de comida: perfil y portada nunca
// deben recibir instrucciones pensadas para un plato.
function promptMejora({ problemas = [], encuadre = 'original' } = {}) {
  const negocio = encuadre === 'perfil' || encuadre === 'portada';
  if (process.env.IMAGE_AI_PROMPT && !negocio) return process.env.IMAGE_AI_PROMPT;
  const base = { comercial: PROMPT_COMERCIAL, perfil: PROMPT_PERFIL, portada: PROMPT_PORTADA }[encuadre] || PROMPT_FOTO_COMIDA;
  const tabla = negocio ? CORRECCIONES_NEGOCIO : CORRECCIONES;
  const extra = [...new Set(problemas.map((c) => tabla[c]).filter(Boolean))];
  return extra.length ? `${base}\nSpecific fixes for this photo: ${extra.join(' ')}` : base;
}

module.exports = {
  PROMPT_FOTO_COMIDA, PROMPT_COMERCIAL, PROMPT_PERFIL, PROMPT_PORTADA, CORRECCIONES, CORRECCIONES_NEGOCIO, promptMejora,
  SECCIONES: { OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO, ENCUADRE_COMERCIAL, ENCUADRE_PERFIL, ENCUADRE_PORTADA, PRESERVAR_NEGOCIO, PROHIBIDO_NEGOCIO },
};
