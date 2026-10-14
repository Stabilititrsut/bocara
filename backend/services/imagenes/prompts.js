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

// encuadre: 'original' (fotos de negocio: mismo encuadre y proporción) o
// 'comercial' (publicaciones: lienzo estándar con el fondo extendido).
function promptMejora({ problemas = [], encuadre = 'original' } = {}) {
  if (process.env.IMAGE_AI_PROMPT) return process.env.IMAGE_AI_PROMPT;
  const base = encuadre === 'comercial' ? PROMPT_COMERCIAL : PROMPT_FOTO_COMIDA;
  const extra = [...new Set(problemas.map((c) => CORRECCIONES[c]).filter(Boolean))];
  return extra.length ? `${base}\nSpecific fixes for this photo: ${extra.join(' ')}` : base;
}

module.exports = {
  PROMPT_FOTO_COMIDA, PROMPT_COMERCIAL, CORRECCIONES, promptMejora,
  SECCIONES: { OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO, ENCUADRE_COMERCIAL },
};
