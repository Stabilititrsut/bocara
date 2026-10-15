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
// La identidad del negocio es lo que hay que preservar: logo, nombre, letras,
// colores de marca, fachada, local, platos y personas tal como son.
const PRESERVAR_NEGOCIO = [
  'This image represents a real restaurant or food business on a food marketplace.',
  'Keep its identity exactly: every logo, brand mark, name, letter, word, color of the brand, storefront, interior, dish and person must stay the same, in the same place and legible.',
  'Do not redraw, restyle, retype, translate, simplify or "clean up" a logo or any text.',
];
const PROHIBIDO_NEGOCIO = [
  'Never invent or add logos, text, signs, food, dishes, products, people, decorations or brand elements that were not in the image.',
  'Never remove existing logos, text or brand elements.',
  'Do not warp, stretch or distort shapes.',
  'The soft blurred area around the image is only padding: replace it with a plain, natural continuation of the existing background (same color, wall, surface or scene), never with new objects.',
];
const ESTILO_NEGOCIO = [
  'The result must look like the same real image, professionally retouched:',
  'no artificial HDR look, no oversaturated colors, no plastic or overly smooth AI look, no illustration or 3D render style.',
];

// Perfil (avatar): lienzo cuadrado, lo principal centrado y completo.
const ENCUADRE_PERFIL = [
  'Retouch it to work as a square profile picture shown inside a circle:',
  'the original image occupies a rectangle in the center of this square canvas; keep it exactly where it is, at the same size, fully visible and centered.',
  'Improve sharpness, clean edges, lighting, contrast and resolution; remove compression artifacts and noise.',
];
// Portada (banner): lienzo horizontal, el fondo puede extenderse.
const ENCUADRE_PORTADA = [
  'Retouch it to work as a wide horizontal cover banner for the business page:',
  'the original image occupies a rectangle of this horizontal canvas; keep it exactly where it is, at the same size.',
  'Extend only the existing background, walls, surfaces or scenery so the banner looks like one complete, well-composed photograph.',
  'Improve lighting, white balance, exposure, contrast, sharpness and resolution, and make the surroundings tidier without replacing the setting.',
];

const PROMPT_PERFIL = [PRESERVAR_NEGOCIO, ENCUADRE_PERFIL, PROHIBIDO_NEGOCIO, ESTILO_NEGOCIO]
  .map((seccion) => seccion.join(' '))
  .join('\n');
const PROMPT_PORTADA = [PRESERVAR_NEGOCIO, ENCUADRE_PORTADA, PROHIBIDO_NEGOCIO, ESTILO_NEGOCIO]
  .map((seccion) => seccion.join(' '))
  .join('\n');

// Igual que CORRECCIONES, sin suponer que la imagen es comida.
const CORRECCIONES_NEGOCIO = Object.freeze({
  oscura: 'The image is underexposed: brighten it and open the shadows.',
  muy_oscura: 'The image is underexposed: brighten it and open the shadows.',
  quemada: 'The image is overexposed: recover the blown highlights.',
  sin_contraste: 'The image looks flat and washed out: restore natural contrast and color depth.',
  borrosa: 'The image is soft or slightly out of focus: recover crisp edges and detail without inventing new details or changing any letter.',
  resolucion: 'The image is low resolution: restore clean, crisp detail and edges.',
  baja_calidad: 'The image has low overall quality: clean up noise and compression artifacts.',
  desordenada: 'The surroundings look messy: make them tidier and less distracting without replacing the setting.',
  proporcion: 'The original image has an awkward aspect ratio: extend only the existing background to fill the canvas.',
  no_cuadrada: 'The original image is not square: extend only the existing background to fill the square canvas.',
  no_horizontal: 'The original image is not horizontal: extend only the existing background to the sides to fill the wide canvas.',
  recortada: 'The main subject is tightly framed: extend only the background around it, never the subject itself.',
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
  SECCIONES: { OBJETIVO, PRESERVAR, MEJORAR, PROHIBIDO, ESTILO, ENCUADRE_COMERCIAL, ENCUADRE_PERFIL, ENCUADRE_PORTADA },
};
