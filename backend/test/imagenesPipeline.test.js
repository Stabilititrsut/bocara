// Pipeline de imágenes (docs/PIPELINE_IMAGENES.md). Sin red ni Storage real:
// proveedor, descarga y almacenamiento inyectados; Supabase en memoria.
// IMG-* = servicio; HTTP-* = rutas reales (bolsas, negocios, imagenes).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const pipeline = require('../services/imagenes/pipeline');
const {
  proveedorLocal, crearProveedorReplicate, obtenerProveedor, PROMPT_COMIDA, LADO_MAX, MODELO_POR_DEFECTO,
} = require('../services/imagenes/proveedores');
const { escena, PLATO, OTRO_PLATO } = require('./helpers/escenaComida');

const { ESTADOS, MAX_INTENTOS } = pipeline;
const HOST = 'proyecto.supabase.co';
const ORIGINAL = `https://${HOST}/storage/v1/object/public/bocara-images/bolsas/n1_foto.jpg`;
const hosts = new Set([HOST]);

const silenciar = async (fn) => {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};

// Foto sintética "de comida" (degradado) en JPEG.
async function fotoJpeg(ancho = 800, alto = 600) {
  const raw = Buffer.alloc(ancho * alto * 3);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    const i = (y * ancho + x) * 3;
    raw[i] = 120 + (x % 80); raw[i + 1] = 80 + (y % 60); raw[i + 2] = 60;
  }
  return sharp(raw, { raw: { width: ancho, height: alto, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
}

function entorno({ fila = {}, proveedor } = {}) {
  const cliente = crearFakeSupabase({
    bolsas: [{ id: 'b1', imagen_url: ORIGINAL, imagen_intentos: 0, ...fila }],
  });
  const subidas = [];
  let descargas = 0;
  const opts = {
    cliente, hosts,
    proveedor: proveedor || { nombre: 'mock', ia: false, mejorar: async ({ buffer }) => ({ buffer: await sharp(buffer).modulate({ brightness: 1.12 }).webp().toBuffer(), contentType: 'image/webp', meta: { mock: true } }) },
    descargar: async () => { descargas += 1; return { buffer: await fotoJpeg(), contentType: 'image/jpeg' }; },
    almacenamiento: { subir: async (ruta, buffer) => { subidas.push({ ruta, bytes: buffer.length }); return `https://${HOST}/storage/v1/object/public/bocara-images/${ruta}`; } },
  };
  const fila_ = () => cliente.tabla('bolsas')[0];
  return { cliente, opts, subidas, fila: fila_, descargas: () => descargas };
}

async function encolar(env) {
  const r = await pipeline.solicitarMejora('bolsas', 'b1', ORIGINAL, { cliente: env.cliente });
  assert.equal(r.ok, true);
}

// ── Guardia: ninguna prueba llama a la API real de Replicate (AI-10) ────────
// Todas las llamadas HTTP del módulo axios pasan por este interceptor: si
// algo intentara salir a replicate.com / replicate.delivery, falla y se cuenta.
const axios = require('axios');
let llamadasReales = 0;
const interceptor = axios.interceptors.request.use((cfg) => {
  if (/replicate\.(com|delivery)/.test(String(cfg.url))) { llamadasReales += 1; throw new Error('llamada REAL a Replicate bloqueada en pruebas'); }
  return cfg;
});
test.after(() => axios.interceptors.request.eject(interceptor));

// Doble de la API HTTP de Replicate: registra cada llamada y devuelve como
// "resultado de la IA" un retoque real de la imagen de entrada (misma escena,
// más luz y color), o lo que la prueba indique.
function replicateFalso({ resultado, estadoFinal = 'succeeded', fallarPost, urlSalida = 'https://replicate.delivery/xezq/out.png' } = {}) {
  const llamadas = [];
  const http = {
    post: async (url, body, cfg) => {
      llamadas.push({ metodo: 'POST', url, body, cfg });
      if (fallarPost) throw fallarPost;
      return { data: { id: 'pred-123', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/pred-123' } } };
    },
    get: async (url) => {
      llamadas.push({ metodo: 'GET', url });
      if (url.includes('/v1/predictions/')) {
        return { data: { id: 'pred-123', status: estadoFinal, output: estadoFinal === 'succeeded' ? urlSalida : null, error: estadoFinal === 'failed' ? 'input flagged' : null } };
      }
      return { data: await resultado() };
    },
  };
  return { http, llamadas };
}

const retoqueIA = (base) => () => sharp(base).modulate({ brightness: 1.15, saturation: 1.15 }).linear(1.08, -6).png().toBuffer();

async function entornoIA({ base, fila = {}, ...opcionesFalso } = {}) {
  const env = entorno({ fila });
  const imagen = base || await escena(PLATO);
  const falso = replicateFalso({ resultado: retoqueIA(imagen), ...opcionesFalso });
  const proveedor = crearProveedorReplicate({ token: 'r8_prueba', http: falso.http, dormir: async () => {} });
  const opts = { ...env.opts, proveedor, descargar: async () => ({ buffer: imagen, contentType: 'image/jpeg' }) };
  return { ...env, opts, falso, imagen };
}

// ── IA real: Replicate / FLUX.1 Kontext [pro] (mockeado) ────────────────────

test('AI-1: Replicate recibe la foto ORIGINAL del restaurante como input_image (image-to-image)', async () => {
  const env = await entornoIA();
  await encolar(env);
  const r = await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(r.resultado, ESTADOS.COMPLETADA, JSON.stringify(r));
  const post = env.falso.llamadas.find(l => l.metodo === 'POST');
  assert.equal(post.body.input.input_image, ORIGINAL);
});

test('AI-1b: foto con rotación EXIF → Replicate recibe una COPIA preparada (archivo aparte); el original no se toca', async () => {
  const girada = await sharp(await escena(PLATO)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  // El Replicate real recibe la copia ya derecha y devuelve una imagen derecha.
  const env = await entornoIA({ base: girada, resultado: () => sharp(girada).rotate().modulate({ brightness: 1.15 }).png().toBuffer() });
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const post = env.falso.llamadas.find(l => l.metodo === 'POST');
  assert.match(post.body.input.input_image, /\/preparadas\/bolsas\/b1\/\d+\.jpg$/);
  assert.equal(env.fila().imagen_original_url, ORIGINAL);
  assert.deepEqual(env.fila().imagen_procesamiento_meta.entrada_preparada, ['orientación EXIF']);
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.COMPLETADA, env.fila().error_procesamiento_imagen);
});

test('AI-2: usa el modelo black-forest-labs/flux-kontext-pro y lo deja trazado (proveedor, modelo, predicción)', async () => {
  const env = await entornoIA();
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(MODELO_POR_DEFECTO, 'black-forest-labs/flux-kontext-pro');
  assert.equal(env.falso.llamadas[0].url, 'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions');
  assert.equal(env.falso.llamadas[0].cfg.headers.Authorization, 'Bearer r8_prueba');
  const f = env.fila();
  assert.equal(f.proveedor_imagen_ia, 'replicate');
  assert.equal(f.imagen_procesamiento_meta.modelo, 'black-forest-labs/flux-kontext-pro');
  assert.equal(f.imagen_procesamiento_meta.prediccion, 'pred-123');
  assert.equal(f.imagen_procesamiento_meta.ia, true);
  assert.ok(!JSON.stringify(f).includes('r8_prueba'), 'el token nunca se guarda');
});

test('AI-3: aspect_ratio = match_input_image y safety_tolerance ≤ 2 (límite con imagen de entrada)', async () => {
  const env = await entornoIA();
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const { input } = env.falso.llamadas[0].body;
  assert.equal(input.aspect_ratio, 'match_input_image');
  assert.ok(input.safety_tolerance <= 2);
  assert.equal(input.prompt_upsampling, false, 'sin reescritura automática del prompt (puede inventar)');
});

test('AI-4: el prompt exige fidelidad y prohíbe inventar', async () => {
  for (const frase of [
    /Preserve exactly the same food, ingredients, portions, packaging, plates, text, logos/,
    /Do not add, remove or replace any food item or ingredient/,
    /Do not change quantities/, /Do not invent garnishes/, /steam/, /Do not alter branding/,
    /Do not replace the background/, /faithful to the original product/,
    /Avoid artificial HDR, oversaturation, plastic-looking food/,
    /natural soft restaurant lighting/, /white balance/, /professional commercial food photography/,
  ]) assert.match(PROMPT_COMIDA, frase);
  for (const prohibido of [/add (some )?garnish/i, /bigger portion/i, /generate steam/i, /new background/i]) {
    assert.doesNotMatch(PROMPT_COMIDA.replace(/Do not [^.]*\./g, ''), prohibido);
  }
  const env = await entornoIA();
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(env.falso.llamadas[0].body.input.prompt, PROMPT_COMIDA);
});

test('AI-5: el resultado se guarda como archivo NUEVO (mejoradas/…webp) y pasa a ser la imagen visible', async () => {
  const env = await entornoIA();
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const f = env.fila();
  assert.match(f.imagen_mejorada_url, /\/mejoradas\/bolsas\/b1\/\d+\.webp$/);
  assert.equal(f.imagen_url, f.imagen_mejorada_url);
  assert.deepEqual(env.subidas.map(x => x.ruta.split('/')[0]), ['mejoradas']);
  assert.ok(f.imagen_procesamiento_meta.diferencia_media >= 1, 'hay un cambio visible');
  assert.ok(f.imagen_procesamiento_meta.similitud >= 0.9, 'sigue siendo la misma foto');
});

test('AI-6: el original nunca cambia (fila ni archivo) en éxito, fallo ni rechazo', async () => {
  for (const variante of [{}, { estadoFinal: 'failed' }, { resultado: async () => sharp(await escena(OTRO_PLATO, { semilla: 3 })).png().toBuffer() }]) {
    const env = await entornoIA(variante);
    await encolar(env);
    await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
    assert.equal(env.fila().imagen_original_url, ORIGINAL);
    assert.ok(!env.subidas.some(x => x.ruta.includes('n1_foto')), 'nunca se escribe sobre la ruta del original');
  }
});

test('AI-7: Replicate falla (failed / 4xx) → fallida sin reintentos inútiles; la original sigue visible', async () => {
  const env = await entornoIA({ estadoFinal: 'failed' });
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.FALLIDA);
  assert.equal(env.fila().imagen_url, ORIGINAL);
  assert.match(env.fila().error_procesamiento_imagen, /failed/);

  const env401 = await entornoIA({ fallarPost: Object.assign(new Error('Unauthorized'), { response: { status: 401, data: { detail: 'Invalid token' } } }) });
  await encolar(env401);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env401.opts));
  assert.equal(env401.fila().estado_procesamiento_imagen, ESTADOS.FALLIDA);
  assert.equal(env401.fila().imagen_url, ORIGINAL);
});

test('AI-8: timeout / 5xx de Replicate → queda pendiente para reintento y luego completa', async () => {
  const env = await entornoIA({ fallarPost: Object.assign(new Error('timeout of 75000ms exceeded'), { code: 'ECONNABORTED' }) });
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.PENDIENTE);
  assert.equal(env.fila().imagen_intentos, 1);
  assert.equal(env.fila().imagen_url, ORIGINAL);

  const ok = await entornoIA();
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', { ...ok.opts, cliente: env.cliente }));
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.COMPLETADA);
  assert.equal(env.fila().imagen_intentos, 2);
});

test('AI-9: resultado inválido (otro plato, sobresaturado, sin cambio, no-imagen, host ajeno) → no sustituye al original', async () => {
  const base = await escena(PLATO);
  const casos = {
    otroPlato: { resultado: async () => sharp(await escena(OTRO_PLATO, { semilla: 9 })).png().toBuffer(), error: /no se parece/ },
    sobresaturado: { resultado: async () => sharp(base).modulate({ saturation: 2.5 }).png().toBuffer(), error: /sobresaturado/ },
    sinCambio: { resultado: async () => base, error: /mejora visible/ },
    noImagen: { resultado: async () => Buffer.from('<html>error</html>'), error: /./ },
    hostAjeno: { urlSalida: 'https://evil.example.com/out.png', resultado: async () => base, error: /URL de salida inesperada/ },
  };
  for (const [nombre, c] of Object.entries(casos)) {
    const env = await entornoIA({ base, ...c });
    await encolar(env);
    await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
    const f = env.fila();
    assert.equal(f.estado_procesamiento_imagen, ESTADOS.FALLIDA, nombre);
    assert.equal(f.imagen_url, ORIGINAL, nombre);
    assert.equal(f.imagen_mejorada_url, null, nombre);
    assert.match(f.error_procesamiento_imagen, c.error, nombre);
    assert.equal(env.subidas.length, 0, `${nombre}: nada se sube`);
  }
});

test('AI-10: las pruebas nunca llaman a la API real (guardia de axios) y sin token nunca se elige Replicate', async () => {
  const antes = { p: process.env.IMAGE_AI_PROVIDER, t: process.env.REPLICATE_API_TOKEN };
  delete process.env.REPLICATE_API_TOKEN;
  delete process.env.IMAGE_AI_PROVIDER;
  assert.equal(obtenerProveedor().nombre, 'local');
  process.env.IMAGE_AI_PROVIDER = 'replicate';
  assert.equal((await silenciar(async () => obtenerProveedor())).nombre, 'local');
  assert.throws(() => crearProveedorReplicate({ token: '' }), /REPLICATE_API_TOKEN/);
  // Una llamada real quedaría bloqueada y contada:
  await assert.rejects(axios.post('https://api.replicate.com/v1/models/x/predictions', {}), /bloqueada/);
  llamadasReales -= 1; // la provocada a propósito en esta línea
  assert.equal(llamadasReales, 0, 'ninguna otra prueba intentó llamar a Replicate');
  if (antes.p === undefined) delete process.env.IMAGE_AI_PROVIDER; else process.env.IMAGE_AI_PROVIDER = antes.p;
  if (antes.t !== undefined) process.env.REPLICATE_API_TOKEN = antes.t;
});

test('AI-11: selección de proveedor — replicate con token, local explícito (no IA), none apaga', () => {
  const antes = { p: process.env.IMAGE_AI_PROVIDER, t: process.env.REPLICATE_API_TOKEN };
  process.env.REPLICATE_API_TOKEN = 'r8_x';
  delete process.env.IMAGE_AI_PROVIDER;
  assert.equal(obtenerProveedor().nombre, 'replicate', 'con token, sin variable: IA real');
  assert.equal(obtenerProveedor().ia, true);
  process.env.IMAGE_AI_PROVIDER = 'local';
  assert.equal(obtenerProveedor().nombre, 'local');
  assert.equal(obtenerProveedor().ia, false, 'local NO se presenta como IA');
  process.env.IMAGE_AI_PROVIDER = 'none';
  assert.equal(obtenerProveedor().nombre, 'none');
  if (antes.p === undefined) delete process.env.IMAGE_AI_PROVIDER; else process.env.IMAGE_AI_PROVIDER = antes.p;
  if (antes.t === undefined) delete process.env.REPLICATE_API_TOKEN; else process.env.REPLICATE_API_TOKEN = antes.t;
});

test('AI-12: ajuste local (desarrollo/respaldo) produce WebP ≤ 1600 px, misma proporción, marcado ia=false', async () => {
  const r = await proveedorLocal.mejorar({ buffer: await fotoJpeg(2400, 1800) });
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= LADO_MAX && meta.height <= LADO_MAX);
  assert.ok(Math.abs(meta.width / meta.height - 4 / 3) < 0.01);
  assert.equal(r.meta.ia, false);
});

// ── Pipeline ────────────────────────────────────────────────────────────────

test('IMG-1: solicitar mejora → pendiente, original fijada, imagen visible sin cambios', async () => {
  const env = entorno();
  await encolar(env);
  const f = env.fila();
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.PENDIENTE);
  assert.equal(f.imagen_original_url, ORIGINAL);
  assert.equal(f.imagen_url, ORIGINAL);
  assert.equal(f.imagen_mejorada_url, null);
});

test('IMG-2: éxito → completada; imagen_url = mejorada; la original NUNCA se toca', async () => {
  const env = entorno();
  await encolar(env);
  const r = await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const f = env.fila();
  assert.equal(r.resultado, ESTADOS.COMPLETADA);
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.COMPLETADA);
  assert.equal(f.imagen_original_url, ORIGINAL, 'original intacta');
  assert.match(f.imagen_mejorada_url, /mejoradas\/bolsas\/b1\/\d+\.webp$/);
  assert.equal(f.imagen_url, f.imagen_mejorada_url, 'el cliente ve la mejorada');
  assert.notEqual(f.imagen_mejorada_url, ORIGINAL, 'la mejorada es un archivo nuevo, no sobrescribe');
  assert.equal(f.proveedor_imagen_ia, 'mock');
  assert.equal(f.imagen_procesamiento_meta.mock, true);
  assert.ok(f.imagen_procesada_at);
  assert.equal(env.subidas.length, 1);
});

test('IMG-3: fallo transitorio → pendiente con error y reintento; al agotar intentos → fallida con la original visible', async () => {
  let llamadas = 0;
  const env = entorno({ proveedor: { nombre: 'mock', mejorar: async () => { llamadas += 1; throw new Error('timeout del proveedor'); } } });
  await encolar(env);
  for (let i = 1; i <= MAX_INTENTOS; i++) {
    await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
    const f = env.fila();
    assert.equal(f.imagen_intentos, i);
    assert.equal(f.imagen_url, ORIGINAL, 'la app sigue con la original');
    assert.equal(f.estado_procesamiento_imagen, i < MAX_INTENTOS ? ESTADOS.PENDIENTE : ESTADOS.FALLIDA);
    assert.match(f.error_procesamiento_imagen, /timeout del proveedor/);
  }
  assert.equal(llamadas, MAX_INTENTOS);
  const extra = await pipeline.procesarFila('bolsas', 'b1', env.opts);
  assert.equal(extra.reclamada, false, 'fallida no se reprocesa sola');
});

test('IMG-4: origen no permitido (URL ajena) → fallida sin descargar nada (anti-SSRF)', async () => {
  const env = entorno({ fila: { imagen_url: 'http://169.254.169.254/latest/meta-data' } });
  await pipeline.solicitarMejora('bolsas', 'b1', 'http://169.254.169.254/latest/meta-data', { cliente: env.cliente });
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.FALLIDA);
  assert.equal(env.descargas(), 0);
  assert.equal(pipeline.origenPermitido(ORIGINAL, hosts), true);
  assert.equal(pipeline.origenPermitido(`http://${HOST}/x.jpg`, hosts), false, 'solo https');
});

test('IMG-5: resultado que cambia la proporción (posible imagen "inventada") se descarta → fallida, original visible', async () => {
  const env = entorno({ proveedor: { nombre: 'ia', mejorar: async () => ({ buffer: await sharp(await fotoJpeg(600, 900)).webp().toBuffer(), contentType: 'image/webp' }) } });
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const f = env.fila();
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.FALLIDA);
  assert.match(f.error_procesamiento_imagen, /proporción/);
  assert.equal(f.imagen_url, ORIGINAL);
  assert.equal(env.subidas.length, 0, 'no se sube un resultado descartado');
});

test('IMG-6: dos workers a la vez (disparo inmediato + job) → el proveedor corre una sola vez', async () => {
  let llamadas = 0;
  const base = entorno();
  const proveedor = { nombre: 'mock', mejorar: async (a) => { llamadas += 1; return base.opts.proveedor.mejorar(a); } };
  await encolar(base);
  const [a, b] = await silenciar(() => Promise.all([
    pipeline.procesarFila('bolsas', 'b1', { ...base.opts, proveedor }),
    pipeline.procesarFila('bolsas', 'b1', { ...base.opts, proveedor }),
  ]));
  assert.equal(llamadas, 1);
  assert.equal([a, b].filter(r => r.reclamada).length, 1);
});

test('IMG-7: el restaurante cambia la foto mientras se procesa → el resultado viejo se descarta, la foto nueva queda intacta', async () => {
  const NUEVA = `https://${HOST}/storage/v1/object/public/bocara-images/bolsas/n1_nueva.jpg`;
  const env = entorno();
  const proveedor = {
    nombre: 'lento',
    mejorar: async (a) => {
      const f = env.cliente.tabla('bolsas')[0];
      f.imagen_url = NUEVA; // PUT del restaurante en medio del proceso
      await pipeline.solicitarMejora('bolsas', 'b1', NUEVA, { cliente: env.cliente });
      return env.opts.proveedor.mejorar(a);
    },
  };
  await encolar(env);
  const r = await silenciar(() => pipeline.procesarFila('bolsas', 'b1', { ...env.opts, proveedor }));
  const f = env.fila();
  assert.equal(r.resultado, 'obsoleta');
  assert.equal(f.imagen_url, NUEVA);
  assert.equal(f.imagen_original_url, NUEVA);
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.PENDIENTE, 'la foto nueva queda en cola para su propia mejora');
});

test('IMG-8: reintentar desde fallida vuelve a la cola desde cero y completa', async () => {
  const env = entorno({ fila: { estado_procesamiento_imagen: ESTADOS.FALLIDA, imagen_original_url: ORIGINAL, imagen_intentos: 3, error_procesamiento_imagen: 'x' } });
  const no = await pipeline.reintentar('bolsas', 'b1', { cliente: entorno({ fila: { estado_procesamiento_imagen: ESTADOS.COMPLETADA } }).cliente });
  assert.equal(no.status, 409, 'solo fallida o sin procesar');
  assert.deepEqual(await pipeline.reintentar('bolsas', 'b1', { cliente: env.cliente }), { ok: true });
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.PENDIENTE);
  assert.equal(env.fila().imagen_intentos, 0);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.COMPLETADA);
});

test('IMG-9: usar original / volver a la mejorada — ninguna de las dos se pierde', async () => {
  const env = entorno();
  await encolar(env);
  await silenciar(() => pipeline.procesarFila('bolsas', 'b1', env.opts));
  const mejorada = env.fila().imagen_mejorada_url;
  assert.deepEqual(await pipeline.usarOriginal('bolsas', 'b1', { cliente: env.cliente }), { ok: true });
  assert.equal(env.fila().imagen_url, ORIGINAL);
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.DESCARTADA);
  assert.equal(env.fila().imagen_mejorada_url, mejorada);
  assert.deepEqual(await pipeline.usarMejorada('bolsas', 'b1', { cliente: env.cliente }), { ok: true });
  assert.equal(env.fila().imagen_url, mejorada);
  assert.equal(env.fila().imagen_original_url, ORIGINAL);
});

test('IMG-10: job — recupera "procesando" abandonada y respeta la espera entre reintentos', async () => {
  const hace = (ms) => new Date(Date.now() - ms).toISOString();
  const env = entorno({ fila: {
    estado_procesamiento_imagen: ESTADOS.PROCESANDO, imagen_original_url: ORIGINAL, imagen_intentos: 1,
    imagen_procesamiento_iniciado_at: hace(pipeline.ABANDONO_MS + 1000), imagen_solicitada_at: hace(1e6),
  } });
  const r = await silenciar(() => pipeline.procesarPendientes({ ...env.opts }));
  assert.equal(r.completadas, 1);
  assert.equal(env.fila().estado_procesamiento_imagen, ESTADOS.COMPLETADA);

  const env2 = entorno({ fila: {
    estado_procesamiento_imagen: ESTADOS.PENDIENTE, imagen_original_url: ORIGINAL, imagen_intentos: 1,
    imagen_procesamiento_iniciado_at: hace(10 * 1000), imagen_solicitada_at: hace(20 * 1000),
  } });
  const r2 = await silenciar(() => pipeline.procesarPendientes({ ...env2.opts }));
  assert.equal(r2.procesadas, 0, 'un reintento reciente espera ESPERA_REINTENTO_MS');
});

test('IMG-11: sin migración aplicada (columna inexistente) → no lanza ni rompe el llamador', async () => {
  const cliente = crearFakeSupabase({ bolsas: [{ id: 'b1', imagen_url: ORIGINAL }] });
  cliente.inyectarError({ code: '42703', message: 'column bolsas.imagen_original_url does not exist' });
  const r = await silenciar(() => pipeline.solicitarMejora('bolsas', 'b1', ORIGINAL, { cliente }));
  assert.deepEqual(r, { ok: false, motivo: 'error_bd' });
  assert.equal(cliente.tabla('bolsas')[0].imagen_url, ORIGINAL);
});

test('IMG-12: IMAGE_AI_PROVIDER=none apaga el pipeline: nada se encola', async () => {
  const antes = process.env.IMAGE_AI_PROVIDER;
  process.env.IMAGE_AI_PROVIDER = 'none';
  const env = entorno();
  assert.deepEqual(await pipeline.solicitarMejora('bolsas', 'b1', ORIGINAL, { cliente: env.cliente }), { ok: false, motivo: 'desactivado' });
  assert.equal(env.fila().estado_procesamiento_imagen, undefined);
  if (antes === undefined) delete process.env.IMAGE_AI_PROVIDER; else process.env.IMAGE_AI_PROVIDER = antes;
});

test('IMG-13: esFotoNueva — la original o la mejorada de la foto actual no cuentan como foto nueva', () => {
  const fila = { imagen_url: 'm', imagen_original_url: 'o', imagen_mejorada_url: 'm' };
  assert.equal(pipeline.esFotoNueva('m', fila), false);
  assert.equal(pipeline.esFotoNueva('o', fila), false);
  assert.equal(pipeline.esFotoNueva('n', fila), true);
  assert.equal(pipeline.esFotoNueva('  ', fila), false);
});

// ── Rutas reales ────────────────────────────────────────────────────────────

const HOY = fechaGuatemala(0);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';
const promo = (extra = {}) => ({
  nombre: `Promo ${Math.random().toString(36).slice(2, 7)}`, contenido: 'X', tipo: 'cupon', categoria: '2x1',
  descripcion: 'd', precio_original: 100, precio_descuento: 50, cantidad_disponible: 5, imagen_url: FOTO,
  hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, ...extra,
});

let servidorImg, baseImg;
test.before(async () => {
  await iniciar();
  const app = express();
  app.use(express.json());
  app.use('/api/imagenes', require('../routes/imagenes'));
  await new Promise((r) => { servidorImg = app.listen(0, '127.0.0.1', r); });
  baseImg = `http://127.0.0.1:${servidorImg.address().port}`;
});
test.after(async () => { await detener(); await new Promise((r) => servidorImg.close(r)); });
test.beforeEach(() => fake.reiniciar(datosBase()));

const accion = async (tipo, id, nombre, como) => {
  const rol = como === IDS.admin ? 'admin' : como === IDS.cliente ? 'cliente' : 'restaurante';
  const r = await fetch(`${baseImg}/api/imagenes/${tipo}/${id}/${nombre}`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ id: como, rol }, process.env.JWT_SECRET)}` },
  });
  return { status: r.status, body: await r.json() };
};
const filaBolsa = (id) => fake.tabla('bolsas').find(b => b.id === id);

test('HTTP-1: crear publicación responde 201 sin esperar al pipeline; la original queda guardada y visible', async () => {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo() }));
  assert.equal(r.status, 201);
  assert.equal(r.body.imagen_url, FOTO);
  await silenciar(pipeline.esperarMejorasEnCurso);
  const f = filaBolsa(r.body.id);
  assert.equal(f.imagen_original_url, FOTO);
  assert.equal(f.imagen_url, FOTO);
  // En pruebas el host de FOTO no es Storage propio → fallida, y la app sigue con la original.
  assert.equal(f.estado_procesamiento_imagen, ESTADOS.FALLIDA);
});

test('HTTP-2: PUT que reenvía la mejorada o la original de la misma foto no reinicia la mejora ni manda a revisión', async () => {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.admin, body: { ...promo(), negocio_id: IDS.olaAzul } }));
  await silenciar(pipeline.esperarMejorasEnCurso);
  const f = filaBolsa(r.body.id);
  Object.assign(f, { estado_procesamiento_imagen: ESTADOS.COMPLETADA, imagen_mejorada_url: 'https://m/1.webp', imagen_url: 'https://m/1.webp' });
  for (const url of ['https://m/1.webp', FOTO]) {
    const ed = await silenciar(() => pedir('PUT', `/api/bolsas/${r.body.id}`, { como: IDS.restaurante, body: { imagen_url: url, precio_descuento: 50 } }));
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal(ed.body.estado_aprobacion, 'aprobado', 'no es un cambio de contenido');
    assert.equal(filaBolsa(r.body.id).imagen_url, 'https://m/1.webp');
    assert.equal(filaBolsa(r.body.id).estado_procesamiento_imagen, ESTADOS.COMPLETADA);
  }
});

test('HTTP-3: PUT con foto NUEVA reinicia el ciclo y conserva la nueva como original', async () => {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.admin, body: { ...promo(), negocio_id: IDS.olaAzul } }));
  await silenciar(pipeline.esperarMejorasEnCurso);
  Object.assign(filaBolsa(r.body.id), { estado_procesamiento_imagen: ESTADOS.COMPLETADA, imagen_mejorada_url: 'https://m/1.webp', imagen_url: 'https://m/1.webp' });
  const NUEVA = 'https://cdn.bocara.test/publicaciones/nueva.jpg';
  const ed = await silenciar(() => pedir('PUT', `/api/bolsas/${r.body.id}`, { como: IDS.restaurante, body: { imagen_url: NUEVA } }));
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.estado_aprobacion, 'pendiente', 'foto nueva vuelve a revisión (regla existente)');
  await silenciar(pipeline.esperarMejorasEnCurso);
  const f = filaBolsa(r.body.id);
  assert.equal(f.imagen_url, NUEVA);
  assert.equal(f.imagen_original_url, NUEVA);
  assert.equal(f.imagen_mejorada_url, null, 'la mejorada vieja no se mezcla con la foto nueva');
});

test('HTTP-4: acciones — solo el dueño o admin; reintentar/usar-original/usar-mejorada responden el estado', async () => {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.admin, body: { ...promo(), negocio_id: IDS.olaAzul } }));
  await silenciar(pipeline.esperarMejorasEnCurso);
  const id = r.body.id;
  assert.equal((await accion('publicacion', id, 'reintentar', IDS.otroRestaurante)).status, 403);
  assert.equal((await accion('publicacion', id, 'reintentar', IDS.cliente)).status, 403);
  assert.equal((await accion('publicacion', id, 'borrar-todo', IDS.restaurante)).status, 404);

  const re = await silenciar(() => accion('publicacion', id, 'reintentar', IDS.restaurante));
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.imagen.estado_procesamiento_imagen, ESTADOS.PENDIENTE);
  await new Promise((res) => setTimeout(res, 30));

  Object.assign(filaBolsa(id), { estado_procesamiento_imagen: ESTADOS.COMPLETADA, imagen_mejorada_url: 'https://m/2.webp', imagen_url: 'https://m/2.webp' });
  const uo = await accion('publicacion', id, 'usar-original', IDS.restaurante);
  assert.equal(uo.body.imagen.imagen_url, FOTO);
  const um = await accion('publicacion', id, 'usar-mejorada', IDS.admin);
  assert.equal(um.body.imagen.imagen_url, 'https://m/2.webp');
});

test('HTTP-5: el cliente ve la mejor versión en el feed y el detalle sin cambios en la app (imagen_url)', async () => {
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.admin, body: { ...promo(), negocio_id: IDS.olaAzul } }));
  await silenciar(pipeline.esperarMejorasEnCurso);
  Object.assign(filaBolsa(r.body.id), { estado_procesamiento_imagen: ESTADOS.COMPLETADA, imagen_mejorada_url: 'https://m/3.webp', imagen_url: 'https://m/3.webp' });
  const feed = await silenciar(() => pedir('GET', '/api/bolsas?tipo=cupon'));
  assert.equal(feed.body.find(b => b.id === r.body.id).imagen_url, 'https://m/3.webp');
  const det = await silenciar(() => pedir('GET', `/api/bolsas/${r.body.id}`));
  assert.equal(det.body.imagen_url, 'https://m/3.webp');
  assert.equal(filaBolsa(r.body.id).imagen_original_url, FOTO);
});
