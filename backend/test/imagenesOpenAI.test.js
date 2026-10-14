// Proveedor OpenAI GPT Image (services/imagenes/proveedorOpenAI.js) dentro del
// pipeline real. Sin red y sin costo:
//   · OAI-SDK usa el SDK oficial `openai` con globalThis.fetch reemplazado:
//     verifica la petición HTTP real (endpoint, multipart, nombres de campos);
//   · el resto inyecta un cliente { images: { edit } } que devuelve un retoque
//     real de la imagen recibida;
//   · una guardia cuenta cualquier fetch a api.openai.com no simulado (OAI-11).
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const { escena, PLATO, OTRO_PLATO } = require('./helpers/escenaComida');
const pipeline = require('../services/imagenes/pipeline');
const {
  crearProveedorOpenAI, elegirTamano, prepararLienzo, MODELO_POR_DEFECTO,
} = require('../services/imagenes/proveedorOpenAI');
const { obtenerProveedor } = require('../services/imagenes/proveedores');
const { PROMPT_FOTO_COMIDA } = require('../services/imagenes/prompts');

const { ESTADOS } = pipeline;
const HOST = 'proyecto.supabase.co';
const ORIGINAL = `https://${HOST}/storage/v1/object/public/bocara-images/bolsas/n1_foto.jpg`;

// ── Guardia de red: nada sale a OpenAI de verdad ────────────────────────────
const fetchOriginal = globalThis.fetch;
let fetchSimulado = null;
let llamadasNoSimuladas = 0;
globalThis.fetch = async (url, init) => {
  if (/api\.openai\.com/.test(String(url))) {
    if (fetchSimulado) return fetchSimulado(url, init);
    llamadasNoSimuladas += 1;
    throw new Error('llamada REAL a OpenAI bloqueada en pruebas');
  }
  return fetchOriginal(url, init);
};
test.after(() => { globalThis.fetch = fetchOriginal; });

const silenciar = async (fn) => {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};

// Cliente falso de OpenAI: devuelve un retoque REAL de lo que recibió (más
// luz y color, mismo contenido), en el tamaño pedido.
function openaiFalso({ respuesta, fallo } = {}) {
  const llamadas = [];
  return {
    llamadas,
    cliente: { images: { async edit(params) {
      llamadas.push(params);
      if (fallo) throw fallo;
      if (respuesta) return respuesta(params);
      const entrada = Buffer.from(await params.image.arrayBuffer());
      const [w, h] = params.size.split('x').map(Number);
      const png = await sharp(entrada).resize(w, h, { fit: 'fill' }).modulate({ brightness: 1.15, saturation: 1.12 }).png().toBuffer();
      return { created: 1, data: [{ b64_json: png.toString('base64') }], size: params.size, quality: params.quality };
    } } },
  };
}

async function entorno({ imagen, falso = openaiFalso(), fila = {} } = {}) {
  const foto = imagen || await escena(PLATO);
  const cliente = crearFakeSupabase({ bolsas: [{ id: 'b1', imagen_url: ORIGINAL, imagen_intentos: 0, ...fila }] });
  const subidas = [];
  const proveedor = crearProveedorOpenAI({ cliente: falso.cliente });
  const opts = {
    cliente, proveedor, hosts: new Set([HOST]),
    descargar: async () => ({ buffer: foto, contentType: 'image/jpeg' }),
    almacenamiento: { subir: async (ruta, buffer) => { subidas.push({ ruta, buffer }); return `https://${HOST}/storage/v1/object/public/bocara-images/${ruta}`; } },
  };
  await pipeline.solicitarMejora('bolsas', 'b1', ORIGINAL, { cliente });
  const procesar = () => silenciar(() => pipeline.procesarFila('bolsas', 'b1', opts));
  return { cliente, opts, falso, subidas, foto, procesar, fila: () => cliente.tabla('bolsas')[0] };
}

// ── Modelo y petición ───────────────────────────────────────────────────────

test('OAI-1: modelo por defecto gpt-image-1-mini y parámetros reales de images.edit', async () => {
  const env = await entorno();
  await env.procesar();
  assert.equal(MODELO_POR_DEFECTO, 'gpt-image-1-mini');
  const [p] = env.falso.llamadas;
  assert.equal(p.model, 'gpt-image-1-mini');
  assert.equal(p.size, '1536x1024', '4:3 → el tamaño estándar más cercano (3:2)');
  assert.equal(p.quality, 'medium');
  assert.equal(p.output_format, 'png');
  assert.equal(p.n, 1);
  assert.equal(p.prompt, PROMPT_FOTO_COMIDA);
  assert.equal(p.image.type, 'image/jpeg');
  assert.ok(!('input_fidelity' in p), 'gpt-image-1-mini solo admite "low": no se envía');
  assert.ok(!('response_format' in p), 'no aplica a modelos GPT Image');
});

test('OAI-SDK: con el SDK oficial la petición va a POST /v1/images/edits en multipart con los campos correctos', async () => {
  let peticion = null;
  const foto = await escena(PLATO);
  fetchSimulado = async (url, init) => {
    const req = new Request(url, init);
    peticion = { url: String(url), metodo: req.method, auth: req.headers.get('authorization'), form: await req.formData() };
    const png = await sharp(foto).resize(1536, 1024, { fit: 'fill' }).modulate({ brightness: 1.15 }).png().toBuffer();
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const p = crearProveedorOpenAI({ apiKey: 'sk-test-no-real' });
    const r = await p.mejorar({ buffer: foto });
    assert.equal(peticion.url, 'https://api.openai.com/v1/images/edits');
    assert.equal(peticion.metodo, 'POST');
    assert.equal(peticion.auth, 'Bearer sk-test-no-real');
    assert.equal(peticion.form.get('model'), 'gpt-image-1-mini');
    assert.equal(peticion.form.get('size'), '1536x1024');
    assert.equal(peticion.form.get('quality'), 'medium');
    assert.equal(peticion.form.get('output_format'), 'png');
    // multipart/form-data normaliza los saltos de línea a CRLF (estándar HTML).
    assert.equal(peticion.form.get('prompt').replace(/\r\n/g, '\n'), PROMPT_FOTO_COMIDA);
    const imagen = peticion.form.get('image');
    assert.equal(imagen.type, 'image/jpeg');
    assert.ok(imagen.size > 1000);
    assert.equal((await sharp(r.buffer).metadata()).format, 'webp');
  } finally { fetchSimulado = null; }
});

test('OAI-2: elección de tamaño por proporción (sin recortar ni deformar)', () => {
  assert.equal(elegirTamano(1000, 1000).size, '1024x1024');
  assert.equal(elegirTamano(4000, 3000).size, '1536x1024');
  assert.equal(elegirTamano(3000, 4000).size, '1024x1536');
  assert.equal(elegirTamano(1920, 1080).size, '1536x1024');
  assert.equal(elegirTamano(1080, 1920).size, '1024x1536');
});

test('OAI-3: la foto entra COMPLETA con relleno desenfocado y la salida se recorta a la proporción original', async () => {
  const foto = await escena(PLATO, { ancho: 1200, alto: 900 }); // 4:3
  const { lienzo, tamano, rect } = await prepararLienzo(foto);
  const m = await sharp(lienzo).metadata();
  assert.deepEqual([m.width, m.height], [1536, 1024]);
  assert.ok(Math.abs(rect.width / rect.height - 4 / 3) < 0.01, 'la foto no se deforma');
  assert.equal(rect.height, 1024);
  assert.equal(tamano.size, '1536x1024');

  const env = await entorno({ imagen: foto });
  await env.procesar();
  const f = env.fila();
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.COMPLETADA, f.error_procesamiento_imagen);
  const mejorada = await sharp(env.subidas[0].buffer).metadata();
  assert.ok(Math.abs(mejorada.width / mejorada.height - 4 / 3) < 0.02, 'misma proporción que la original');
  assert.equal(f.imagen_procesamiento_meta.relleno, true);
});

// ── Pipeline con OpenAI ─────────────────────────────────────────────────────

test('OAI-4: mejora válida → completada; imagen_url = mejorada (archivo nuevo); original intacta; trazabilidad', async () => {
  const env = await entorno();
  await env.procesar();
  const f = env.fila();
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.COMPLETADA);
  assert.equal(f.imagen_original_url, ORIGINAL);
  assert.match(f.imagen_mejorada_url, /\/mejoradas\/bolsas\/b1\/\d+\.webp$/);
  assert.equal(f.imagen_url, f.imagen_mejorada_url);
  assert.equal(f.proveedor_imagen_ia, 'openai');
  assert.equal(f.imagen_procesamiento_meta.modelo, 'gpt-image-1-mini');
  assert.equal(f.imagen_procesamiento_meta.ia, true);
  assert.ok(f.imagen_procesamiento_meta.similitud >= 0.9);
  assert.deepEqual(env.subidas.map(s => s.ruta.split('/')[0]), ['mejoradas'], 'OpenAI recibe bytes: no se sube copia preparada');
});

test('OAI-5: foto con rotación EXIF → OpenAI la recibe derecha, sin subir copias, y el original no se toca', async () => {
  const girada = await sharp(await escena(PLATO)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const env = await entorno({ imagen: girada });
  await env.procesar();
  const recibida = await sharp(Buffer.from(await env.falso.llamadas[0].image.arrayBuffer())).metadata();
  assert.equal(env.falso.llamadas[0].size, '1024x1536', 'vertical tras aplicar EXIF');
  assert.ok(!recibida.orientation || recibida.orientation === 1);
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.COMPLETADA, env.fila().error_procesamiento_imagen);
  assert.equal(env.fila().imagen_original_url, ORIGINAL);
});

test('OAI-6: fallos transitorios (timeout, 5xx, 429 rate limit) → pendiente para reintento; la original sigue visible', async () => {
  for (const fallo of [
    Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }),
    Object.assign(new Error('Server error'), { status: 503 }),
    Object.assign(new Error('Rate limit'), { status: 429, code: 'rate_limit_exceeded' }),
  ]) {
    const env = await entorno({ falso: openaiFalso({ fallo }) });
    await env.procesar();
    assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.PENDIENTE, fallo.message);
    assert.equal(env.fila().imagen_url, ORIGINAL);
    assert.equal(env.fila().imagen_intentos, 1);
  }
});

test('OAI-7: fallos definitivos (contenido bloqueado 400, clave inválida 401, sin saldo 429) → fallida sin reintentos inútiles', async () => {
  for (const fallo of [
    Object.assign(new Error('Your request was rejected by the safety system'), { status: 400, code: 'moderation_blocked' }),
    Object.assign(new Error('Incorrect API key'), { status: 401, code: 'invalid_api_key' }),
    Object.assign(new Error('You exceeded your current quota'), { status: 429, code: 'insufficient_quota' }),
  ]) {
    const env = await entorno({ falso: openaiFalso({ fallo }) });
    await env.procesar();
    const f = env.fila();
    assert.equal(f.estado_procesamiento_imagen, ESTADOS.FALLIDA, fallo.code);
    assert.equal(f.imagen_url, ORIGINAL);
    assert.match(f.error_procesamiento_imagen, new RegExp(fallo.code));
  }
});

test('OAI-8: reintento automático hasta 3 intentos y luego fallida (original visible todo el tiempo)', async () => {
  const fallo = Object.assign(new Error('Server error'), { status: 500 });
  const env = await entorno({ falso: openaiFalso({ fallo }) });
  for (let i = 1; i <= pipeline.MAX_INTENTOS; i++) {
    await env.procesar();
    assert.equal(env.fila().imagen_url, ORIGINAL);
  }
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.FALLIDA);
  assert.equal(env.falso.llamadas.length, pipeline.MAX_INTENTOS);
});

test('OAI-9: resultado inválido (vacío, no-imagen, otro plato, sobresaturado) → no sustituye la original', async () => {
  const base = await escena(PLATO);
  const png = async (img, w = 1536, h = 1024) => ({ data: [{ b64_json: (await sharp(img).resize(w, h, { fit: 'fill' }).png().toBuffer()).toString('base64') }] });
  const casos = {
    vacio: { respuesta: async () => ({ data: [] }), estado: ESTADOS.PENDIENTE },
    noImagen: { respuesta: async () => ({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] }), estado: ESTADOS.FALLIDA },
    otroPlato: { respuesta: async () => png(await escena(OTRO_PLATO, { semilla: 5 })), estado: ESTADOS.FALLIDA },
    sobresaturado: { respuesta: async () => png(await sharp(base).modulate({ saturation: 2.5 }).toBuffer()), estado: ESTADOS.FALLIDA },
  };
  for (const [nombre, c] of Object.entries(casos)) {
    const env = await entorno({ imagen: base, falso: openaiFalso({ respuesta: c.respuesta }) });
    await env.procesar();
    const f = env.fila();
    assert.equal(f.estado_procesamiento_imagen, c.estado, `${nombre}: ${f.error_procesamiento_imagen}`);
    assert.equal(f.imagen_url, ORIGINAL, nombre);
    assert.equal(f.imagen_mejorada_url, null, nombre);
    assert.equal(env.subidas.length, 0, `${nombre}: nada se sube`);
  }
});

test('OAI-10: el restaurante cambia la foto mientras OpenAI procesa → el resultado viejo se descarta', async () => {
  const NUEVA = `https://${HOST}/storage/v1/object/public/bocara-images/bolsas/n1_nueva.jpg`;
  let env;
  const base = openaiFalso();
  const falso = { llamadas: base.llamadas, cliente: { images: { async edit(p) {
    const fila = env.cliente.tabla('bolsas')[0];
    fila.imagen_url = NUEVA;
    await pipeline.solicitarMejora('bolsas', 'b1', NUEVA, { cliente: env.cliente });
    return base.cliente.images.edit(p);
  } } } };
  env = await entorno({ falso });
  await env.procesar();
  const f = env.fila();
  assert.equal(f.imagen_url, NUEVA);
  assert.equal(f.imagen_original_url, NUEVA);
  assert.equal(f.imagen_mejorada_url, null);
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.PENDIENTE);
});

// ── Configuración ───────────────────────────────────────────────────────────

test('OAI-11: selección — OPENAI_API_KEY → openai (IA); openai sin clave → ajuste local (no IA); ninguna llamada real', async () => {
  const antes = { p: process.env.IMAGE_AI_PROVIDER, k: process.env.OPENAI_API_KEY, r: process.env.REPLICATE_API_TOKEN };
  try {
    delete process.env.IMAGE_AI_PROVIDER; delete process.env.REPLICATE_API_TOKEN;
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(obtenerProveedor().nombre, 'openai', 'con clave y sin variable: OpenAI');
    assert.equal(obtenerProveedor().ia, true);
    process.env.REPLICATE_API_TOKEN = 'r8_x';
    assert.equal(obtenerProveedor().nombre, 'openai', 'OpenAI tiene prioridad sobre Replicate');
    process.env.IMAGE_AI_PROVIDER = 'replicate';
    assert.equal(obtenerProveedor().nombre, 'replicate', 'replicate sigue disponible como opcional');
    process.env.IMAGE_AI_PROVIDER = 'openai'; delete process.env.OPENAI_API_KEY;
    const p = await silenciar(async () => obtenerProveedor());
    assert.equal(p.nombre, 'local');
    assert.equal(p.ia, false, 'sin clave nunca se presenta como IA');
    assert.throws(() => crearProveedorOpenAI({ apiKey: '' }), /OPENAI_API_KEY/);
    assert.throws(() => crearProveedorOpenAI({ apiKey: 'x', calidad: 'ultra' }), /OPENAI_IMAGE_QUALITY/);
  } finally {
    for (const [k, v] of [['IMAGE_AI_PROVIDER', antes.p], ['OPENAI_API_KEY', antes.k], ['REPLICATE_API_TOKEN', antes.r]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.equal(llamadasNoSimuladas, 0, 'ninguna prueba llamó a OpenAI de verdad');
});

test('OAI-12: el prompt exige mismo producto y prohíbe inventar; la clave nunca se guarda en la fila', async () => {
  for (const frase of [
    /same ingredients, same quantities and portion size/, /same arrangement and positions, same camera angle/,
    /logo, label, brand and written text exactly as it is/, /Keep the original aspect ratio/,
    /white balance/, /appetizing but true-to-life color/, /cleaner, less distracting surrounding/,
    /Do not add or remove any ingredient/, /Do not change quantities/, /Do not add steam/,
    /Do not alter, invent or translate any text, logo/, /Do not warp, stretch or distort/,
    /no oversaturated colors/, /no overly smooth AI look/,
  ]) assert.match(PROMPT_FOTO_COMIDA, frase);
  const env = await entorno();
  await env.procesar();
  assert.ok(!JSON.stringify(env.fila()).match(/sk-/), 'sin secretos en la fila');
});

test('OAI-COM: encuadre comercial — prompt comercial, lienzo COMPLETO ≥ 1024 px, región de la original y margen si viene cortada', async () => {
  const { PROMPT_COMERCIAL } = require('../services/imagenes/prompts');
  const falso = openaiFalso();
  const proveedor = crearProveedorOpenAI({ cliente: falso.cliente });
  const panoramica = await sharp(await escena(PLATO)).extract({ left: 0, top: 250, width: 900, height: 300 }).jpeg().toBuffer();
  const r = await silenciar(() => proveedor.mejorar({ buffer: panoramica, contexto: { encuadre: 'comercial', problemas: ['proporcion'] } }));
  const p = falso.llamadas[0];
  assert.ok(p.prompt.startsWith(PROMPT_COMERCIAL), 'prompt comercial');
  assert.match(p.prompt, /extend the background and surface/);
  const meta = await sharp(r.buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [1536, 1024], 'lienzo completo, no recortado');
  assert.equal(r.meta.encuadre, 'comercial');
  assert.ok(r.meta.region.height < 1 && r.meta.region.width === 1, JSON.stringify(r.meta.region));

  // Cortada / muy cerrada → entra con margen para recomponer.
  const falso2 = openaiFalso();
  const plato = await escena(PLATO);
  const r2 = await silenciar(() => crearProveedorOpenAI({ cliente: falso2.cliente }).mejorar({ buffer: plato, contexto: { encuadre: 'comercial', problemas: ['recortada'] } }));
  assert.ok(r2.meta.region.width < 0.9 && r2.meta.region.height < 0.9, JSON.stringify(r2.meta.region));
  assert.match(falso2.llamadas[0].prompt, /never the food itself/);

  // Sin encuadre comercial (fotos de negocio): igual que antes, recorta a la original.
  const falso3 = openaiFalso();
  const r3 = await silenciar(() => crearProveedorOpenAI({ cliente: falso3.cliente }).mejorar({ buffer: panoramica }));
  assert.equal(falso3.llamadas[0].prompt, PROMPT_FOTO_COMIDA);
  assert.equal(r3.meta.region, null);
  const m3 = await sharp(r3.buffer).metadata();
  assert.ok(Math.abs(m3.width / m3.height - 3) < 0.05, 'conserva la proporción 3:1');
});

test('OAI-COM: el prompt comercial prohíbe inventar comida en el fondo extendido y conserva el close-up', () => {
  const { PROMPT_COMERCIAL } = require('../services/imagenes/prompts');
  for (const frase of [
    /Never place food, extra pieces, ingredients, garnishes, sauces, utensils, logos, labels or packaging in the extended area/,
    /Keep the food inside the original rectangle exactly where it is/,
    /leave it as a close-up/,
    /A tight close-up of food is acceptable/,
    /Do not add or remove any ingredient/,
  ]) assert.match(PROMPT_COMERCIAL, frase);
  assert.doesNotMatch(PROMPT_COMERCIAL, /do not crop, zoom, rotate or reframe/);
});

test('OAI-FID: input_fidelity "high" con modelos que lo admiten (gpt-image-1.5); nunca con *-mini; configurable', async () => {
  const foto = await escena(PLATO);
  const f1 = openaiFalso();
  await silenciar(() => crearProveedorOpenAI({ cliente: f1.cliente, modelo: 'gpt-image-1.5' }).mejorar({ buffer: foto }));
  assert.equal(f1.llamadas[0].input_fidelity, 'high');
  const f2 = openaiFalso();
  await silenciar(() => crearProveedorOpenAI({ cliente: f2.cliente, modelo: 'gpt-image-1-mini' }).mejorar({ buffer: foto }));
  assert.ok(!('input_fidelity' in f2.llamadas[0]));
  const f3 = openaiFalso();
  await silenciar(() => crearProveedorOpenAI({ cliente: f3.cliente, modelo: 'gpt-image-1.5', fidelidad: 'low' }).mejorar({ buffer: foto }));
  assert.equal(f3.llamadas[0].input_fidelity, 'low');
});
