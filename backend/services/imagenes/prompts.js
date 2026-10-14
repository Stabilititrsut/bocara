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
});

function promptMejora({ problemas = [] } = {}) {
  if (process.env.IMAGE_AI_PROMPT) return process.env.IMAGE_AI_PROMPT;
  const extra = [...new Set(problemas.map((c) => CORRECCIONES[c]).filter(Boolean))];
  return extra.length ? `${PROMPT_FOTO_COMIDA}\nSpecific fixes for this photo: ${extra.join(' ')}` : PROMPT_FOTO_COMIDA;
}

module.exports = { PROMPT_FOTO_COMIDA, CORRECCIONES, promptMejora, SECCIONES: { OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO } };
