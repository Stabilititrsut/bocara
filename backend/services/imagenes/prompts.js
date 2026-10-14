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

function promptMejora() {
  return process.env.IMAGE_AI_PROMPT || PROMPT_FOTO_COMIDA;
}

module.exports = { PROMPT_FOTO_COMIDA, promptMejora, SECCIONES: { OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO } };
