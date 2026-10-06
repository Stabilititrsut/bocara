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
  proveedorLocal, crearProveedorReplicate, obtenerProveedor, PROMPT_COMIDA, LADO_MAX,
} = require('../services/imagenes/proveedores');

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
    proveedor: proveedor || { nombre: 'mock', mejorar: async ({ buffer }) => ({ buffer: await sharp(buffer).webp().toBuffer(), contentType: 'image/webp', meta: { mock: true } }) },
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

// ── Proveedores ─────────────────────────────────────────────────────────────

test('IMG-P1: proveedor local (gratis) devuelve WebP mejorado, misma proporción, ≤ 1600 px', async () => {
  const entrada = await fotoJpeg(2400, 1800);
  const r = await proveedorLocal.mejorar({ buffer: entrada });
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(r.contentType, 'image/webp');
  assert.ok(meta.width <= LADO_MAX && meta.height <= LADO_MAX);
  assert.ok(Math.abs(meta.width / meta.height - 4 / 3) < 0.01, 'no recorta ni deforma');
  assert.equal(r.meta.preset, 'comida_comercial_v1');
});

test('IMG-P2: el prompt de IA prioriza fidelidad (mismo producto, sin agregar/quitar, texto intacto)', () => {
  for (const frase of [/same food/i, /Do not add, remove or replace/i, /text and logos/i, /Photorealistic/i, /no exaggeration/i]) {
    assert.match(PROMPT_COMIDA, frase);
  }
});

test('IMG-P3: adapter Replicate — crea predicción con prompt + imagen original, espera y guarda la salida', async () => {
  const llamadas = [];
  const salida = await sharp(await fotoJpeg(1024, 768)).png().toBuffer();
  const http = {
    post: async (url, body, cfg) => { llamadas.push({ url, body, cfg }); return { data: { id: 'p1', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } } }; },
    get: async (url) => (url.includes('/predictions/')
      ? { data: { id: 'p1', status: 'succeeded', output: 'https://replicate.delivery/x.png' } }
      : { data: salida }),
  };
  const p = crearProveedorReplicate({ token: 't', http, dormir: async () => {} });
  const r = await p.mejorar({ urlOriginal: ORIGINAL });
  assert.match(llamadas[0].url, /models\/black-forest-labs\/flux-kontext-pro\/predictions$/);
  assert.equal(llamadas[0].body.input.input_image, ORIGINAL);
  assert.equal(llamadas[0].body.input.prompt, PROMPT_COMIDA);
  assert.equal(llamadas[0].body.input.aspect_ratio, 'match_input_image');
  assert.equal(llamadas[0].cfg.headers.Authorization, 'Bearer t');
  assert.equal((await sharp(r.buffer).metadata()).format, 'webp');
  assert.equal(r.meta.prediccion, 'p1');
});

test('IMG-P4: Replicate fallido o sin token → error / cae al proveedor local gratis', async () => {
  const http = { post: async () => ({ data: { status: 'failed', error: 'NSFW' } }), get: async () => ({}) };
  await assert.rejects(crearProveedorReplicate({ token: 't', http }).mejorar({ urlOriginal: ORIGINAL }), /failed NSFW/);
  const antes = { ...process.env };
  process.env.IMAGE_AI_PROVIDER = 'replicate'; delete process.env.REPLICATE_API_TOKEN;
  assert.equal((await silenciar(async () => obtenerProveedor())).nombre, 'local');
  process.env.REPLICATE_API_TOKEN = 'x';
  assert.equal(obtenerProveedor().nombre, 'replicate');
  process.env.IMAGE_AI_PROVIDER = 'none';
  assert.equal(obtenerProveedor().nombre, 'none');
  process.env = antes;
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
