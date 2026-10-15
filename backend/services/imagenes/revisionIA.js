// Revisión con IA (visión) de una foto de publicación. Dos modos:
//   · 'original'  → antes de mejorar. Solo IRREPARABLES (no es comida, captura
//                   o collage) frenan el flujo; el resto de problemas se anota
//                   y la foto pasa igual a la mejora con IA.
//   · 'resultado' → la foto YA mejorada: ¿se puede publicar tal cual? Aquí sí
//                   cualquier problema bloquea la publicación (con su motivo).
// Cubre lo que las métricas técnicas (calidad.js) no ven: que no sea
// comida/producto, producto cortado, presentación descuidada, capturas, etc.
// `uso` 'perfil' / 'portada' (imágenes del restaurante) cambia las
// instrucciones: un logo con letras es válido, lo irreparable es que no tenga
// relación con el negocio o sea una captura, y en el resultado la fidelidad
// es a la MARCA (logo, textos, colores) y a no inventar elementos.
//
// OpenAI Responses API con entrada de imagen y Structured Outputs (json_schema
// estricto). Modelo: OPENAI_VISION_MODEL, por defecto `gpt-6-luna` (ID según
// developers.openai.com/api/docs/models/gpt-6-luna, verificado 2026-10-14:
// entrada texto+imagen, Structured Outputs, endpoint v1/responses,
// US$0.10 / US$0.50 por millón de tokens). No se hardcodea en otro lugar.
const { ErrorProveedor } = require('./errores');
const { clasificarError } = require('./proveedorOpenAI');

function sharp() { return require('sharp'); }

const MODELO_VISION_POR_DEFECTO = 'gpt-6-luna';
const LADO_REVISION = 768;

const PROBLEMAS = Object.freeze({
  no_es_comida: 'La foto no muestra un producto de comida o bebida.',
  captura_o_collage: 'Parece una captura de pantalla, un collage o una imagen con texto encima. Sube una foto real del producto.',
  irreconocible: 'No se alcanza a reconocer el producto en la foto. Sube una foto donde se vea qué es.',
  recortada: 'El producto está cortado o mal encuadrado.',
  borrosa: 'La foto está borrosa o fuera de foco.',
  muy_oscura: 'La foto está tan oscura que no se distingue el producto.',
  desordenada: 'La presentación se ve descuidada (fondo desordenado o empaques abiertos).',
  manos_o_personas: 'Las manos o personas ocupan gran parte de la foto. El protagonista debe ser el producto.',
  baja_calidad: 'La foto no tiene la calidad mínima para mostrarse en Bocara.',
  aspecto_artificial: 'La versión mejorada se ve artificial (aspecto de render, plástico o ilustración).',
  producto_distinto: 'La versión mejorada ya no muestra el mismo producto que tu foto.',
  ingrediente_inventado: 'La versión mejorada agregó o quitó ingredientes, guarniciones u objetos de tu producto.',
  cantidad_alterada: 'La versión mejorada cambió la cantidad o el tamaño de la porción.',
  // Foto de perfil y portada del restaurante.
  no_relacionada: 'La imagen no parece de tu negocio. Usa tu logo, tu local, tus platos o tu equipo.',
  captura_pantalla: 'Parece una captura de pantalla o un collage. Sube la imagen original de tu logo o de tu negocio.',
  marca_alterada: 'La versión con IA cambió tu logo, un texto o un elemento de tu marca, así que no la usamos.',
  elemento_inventado: 'La versión con IA agregó o quitó elementos (comida, letreros, objetos o personas) que no estaban en tu imagen.',
});

// Problemas que ninguna mejora de imagen arregla: con ellos ni se intenta.
const IRREPARABLES = Object.freeze(new Set(['no_es_comida', 'captura_o_collage', 'irreconocible']));
const IRREPARABLES_NEGOCIO = Object.freeze(new Set(['no_relacionada', 'captura_pantalla', 'irreconocible']));
// La IA cambió el producto (o la marca): el resultado no es fiel a la imagen del restaurante.
const INFIDELIDAD = Object.freeze(new Set(['producto_distinto', 'ingrediente_inventado', 'cantidad_alterada', 'marca_alterada', 'elemento_inventado']));
// Usos: 'publicacion' (foto de producto), 'perfil' y 'portada' (del restaurante).
const USOS = Object.freeze(['publicacion', 'perfil', 'portada']);
const irreparablesDe = (uso) => (uso === 'perfil' || uso === 'portada' ? IRREPARABLES_NEGOCIO : IRREPARABLES);
// Un close-up o un plato que sale del cuadro NO es motivo para no publicar.
const IGNORAR_EN_RESULTADO = Object.freeze(new Set(['recortada']));

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['apta', 'problemas', 'resumen'],
  properties: {
    apta: { type: 'boolean', description: 'Ver instrucciones: depende del modo de revisión.' },
    problemas: { type: 'array', items: { type: 'string', enum: Object.keys(PROBLEMAS) } },
    resumen: { type: 'string', description: 'Una frase en español, máximo 160 caracteres.' },
  },
};

// La pregunta NO es "¿la foto ya está perfecta?" sino "¿hay información
// visual suficiente para convertirla en una foto comercial fiel?".
const INSTRUCCIONES_ORIGINAL = [
  'Eres revisor de fotos de Bocara, un marketplace de comida en Guatemala.',
  'Una IA de edición va a convertir esta foto de celular en una fotografía comercial: puede corregir iluminación, exposición, balance de blancos, contraste, nitidez moderada, ruido y poca resolución, extender el fondo para recomponer el encuadre y ordenar el entorno. No puede inventar comida.',
  'Decide si hay información visual suficiente para hacerlo de forma FIEL.',
  'Marca apta=false SOLO si: no muestra comida, bebida ni un producto de restaurante (no_es_comida); es una captura de pantalla, collage, menú o imagen con texto encima en lugar de una foto (captura_o_collage); o el producto no se reconoce en absoluto (irreconocible).',
  'En cualquier otro caso apta=true, y lista en problemas lo que la edición debe corregir: muy_oscura, borrosa, recortada (producto cortado o encuadre muy cerrado), desordenada, manos_o_personas, baja_calidad.',
  'Una foto oscura, algo movida, pequeña, mal encuadrada o un close-up de comida NO es motivo para apta=false.',
].join('\n');

const INSTRUCCIONES_RESULTADO = [
  'Eres revisor de fotos de Bocara, un marketplace de comida en Guatemala.',
  'Recibes DOS imágenes: la PRIMERA es la foto original del restaurante; la SEGUNDA es la versión editada con IA que se publicaría.',
  'Decide si la SEGUNDA puede publicarse como fotografía comercial FIEL al producto de la primera.',
  'Fidelidad (lo más importante): marca producto_distinto si ya no es reconociblemente el mismo producto; ingrediente_inventado si agregó o quitó ingredientes, guarniciones, salsas, piezas, utensilios, logos o empaques; cantidad_alterada si cambió sustancialmente la cantidad o el tamaño de la porción. Extender la mesa, la superficie o el fondo alrededor NO es un cambio del producto.',
  'Calidad: marca borrosa, muy_oscura, desordenada, manos_o_personas, aspecto_artificial (render, plástico, ilustración) o baja_calidad si la segunda no sirve como foto comercial.',
  'NO marques problemas porque sea un close-up, porque el plato completo no aparezca o porque la comida salga del cuadro.',
  'apta=true si es fiel y presentable. Sé estricto con la fidelidad y justo con el resto.',
].join('\n');
const INSTRUCCIONES = Object.freeze({ original: INSTRUCCIONES_ORIGINAL, resultado: INSTRUCCIONES_RESULTADO });

// Perfil y portada: la imagen representa al restaurante (logo, local, platos,
// equipo). Un logo con letras NO es una "imagen con texto encima".
const QUE_ES = {
  perfil: 'la FOTO DE PERFIL del restaurante (se muestra pequeña, dentro de un círculo): normalmente su logo, su fachada o un plato insignia',
  portada: 'la PORTADA del restaurante (banner horizontal en su página): normalmente su local, su ambiente, su equipo o sus platos',
};
const instruccionesNegocio = (uso) => Object.freeze({
  original: [
    'Eres revisor de imágenes de Bocara, un marketplace de comida en Guatemala.',
    `Esta imagen será ${QUE_ES[uso]}.`,
    'Una IA de edición va a mejorar su nitidez, iluminación, resolución y presentación, y a extender SOLO el fondo para adaptar el formato. No puede inventar logos, textos, comida ni elementos de marca.',
    'Marca apta=false SOLO si: no tiene relación con un negocio de comida o bebida, o es inapropiada (no_relacionada); es una captura de pantalla de un teléfono o computadora, o un collage de varias imágenes (captura_pantalla); o no se reconoce qué muestra (irreconocible).',
    'Un logo, un nombre o un letrero del negocio son válidos y esperados: NO son captura_pantalla.',
    'En cualquier otro caso apta=true, y lista en problemas lo que la edición debe corregir: muy_oscura, borrosa, recortada, desordenada, baja_calidad.',
  ].join('\n'),
  resultado: [
    'Eres revisor de imágenes de Bocara, un marketplace de comida en Guatemala.',
    `Recibes DOS imágenes de ${QUE_ES[uso]}: la PRIMERA es la original del restaurante; la SEGUNDA es la versión editada con IA que se publicaría.`,
    'Fidelidad (lo más importante): marca marca_alterada si cambió, redibujó, borró o deformó el logo, el nombre, cualquier letra o texto, o los colores de la marca; elemento_inventado si agregó o quitó comida, platos, letreros, objetos, decoraciones o personas. Extender el fondo (pared, superficie, cielo, color liso) NO es un cambio.',
    'Calidad: marca borrosa, muy_oscura, desordenada, aspecto_artificial (render, plástico, ilustración) o baja_calidad si la segunda no sirve para el perfil de un negocio.',
    'apta=true si es fiel y presentable. Sé estricto con la fidelidad de la marca y justo con el resto.',
  ].join('\n'),
});
const INSTRUCCIONES_USO = Object.freeze({
  publicacion: INSTRUCCIONES, perfil: instruccionesNegocio('perfil'), portada: instruccionesNegocio('portada'),
});

function crearRevisorIA({
  apiKey = process.env.OPENAI_API_KEY,
  modelo = process.env.OPENAI_VISION_MODEL || MODELO_VISION_POR_DEFECTO,
  timeoutMs = Number(process.env.IMAGE_AI_REVIEW_TIMEOUT_MS) || 45000,
  cliente, // inyectable en pruebas: { responses: { create } }
} = {}) {
  if (!cliente && !apiKey) throw new Error('OPENAI_API_KEY no configurada');
  let sdk = cliente;
  const obtener = () => {
    if (!sdk) {
      const { OpenAI } = require('openai');
      sdk = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    }
    return sdk;
  };

  return {
    modelo,
    // → { apta, irreparable, infiel, problemas: [{ codigo, mensaje }], resumen, uso }. Lanza ErrorProveedor.
    //   irreparable: algún problema que la mejora no puede arreglar (modo original).
    //   infiel: la versión editada cambió el producto (modo resultado, con `original`).
    async revisar(buffer, { modo = 'original', original = null, uso = 'publicacion' } = {}) {
      if (!INSTRUCCIONES_USO[uso]) throw new Error(`uso de revisión desconocido: ${uso}`);
      if (!INSTRUCCIONES[modo]) throw new Error(`modo de revisión desconocido: ${modo}`);
      const irreparables = irreparablesDe(uso);
      const inicio = Date.now();
      const aJpeg = async (img) => (await sharp()(img, { failOn: 'none' }).rotate()
        .resize({ width: LADO_REVISION, height: LADO_REVISION, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 }).toBuffer()).toString('base64');
      // Resultado: original primero, editada después (para juzgar fidelidad).
      const imagenes = modo === 'resultado' && original ? [await aJpeg(original), await aJpeg(buffer)] : [await aJpeg(buffer)];
      const detalle = imagenes.length > 1 ? 'high' : 'low';
      console.log('[IMAGEN_IA] OpenAI revisión (%s, %s) → modelo=%s', uso, modo, modelo);
      let r;
      try {
        r = await obtener().responses.create({
          model: modelo,
          reasoning: { effort: 'low' },
          max_output_tokens: 600,
          instructions: INSTRUCCIONES_USO[uso][modo],
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: imagenes.length > 1 ? 'Primera: foto original. Segunda: versión editada con IA.' : uso === 'publicacion' ? 'Revisa esta foto de una publicación.' : `Revisa esta imagen (${uso} del restaurante).` },
              ...imagenes.map((b64) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${b64}`, detail: detalle })),
            ],
          }],
          text: { format: { type: 'json_schema', name: 'revision_foto', schema: ESQUEMA, strict: true } },
        });
      } catch (err) {
        const e = clasificarError(err);
        console.error('[IMAGEN_IA] OpenAI revisión (%s) FALLÓ en %d ms (motivo=%s): %s', modo, Date.now() - inicio, e.motivo, e.message);
        throw e;
      }
      let datos;
      try { datos = JSON.parse(r?.output_text || ''); } catch {
        throw new ErrorProveedor('revisión IA: respuesta sin JSON válido', { reintentable: true });
      }
      if (typeof datos?.apta !== 'boolean' || !Array.isArray(datos.problemas)) {
        throw new ErrorProveedor('revisión IA: respuesta incompleta', { reintentable: true });
      }
      let codigos = [...new Set(datos.problemas.filter((p) => p in PROBLEMAS))];
      // apta=false sin un problema reconocible → "baja_calidad" (nunca rechazo mudo).
      if (!datos.apta && !codigos.length) codigos.push('baja_calidad');
      if (modo === 'resultado') codigos = codigos.filter((c) => !IGNORAR_EN_RESULTADO.has(c));
      // Original: apta solo dice "hay información suficiente"; los problemas son lo que hay que corregir.
      const apta = modo === 'original' ? !codigos.some((c) => irreparables.has(c)) : codigos.length === 0;
      console.log('[IMAGEN_IA] OpenAI revisión (%s) en %d ms: apta=%s problemas=[%s]', modo, Date.now() - inicio, apta, codigos.join(','));
      return {
        apta,
        irreparable: codigos.some((c) => irreparables.has(c)),
        infiel: codigos.some((c) => INFIDELIDAD.has(c)),
        problemas: codigos.map((codigo) => ({ codigo, mensaje: PROBLEMAS[codigo] })),
        resumen: String(datos.resumen || '').slice(0, 200),
        uso: r.usage || null,
      };
    },
  };
}

module.exports = {
  MODELO_VISION_POR_DEFECTO, PROBLEMAS, IRREPARABLES, IRREPARABLES_NEGOCIO, INFIDELIDAD, USOS, ESQUEMA, INSTRUCCIONES, INSTRUCCIONES_USO,
  irreparablesDe, crearRevisorIA,
};
