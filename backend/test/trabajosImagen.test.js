// Imagen obligatoria antes de publicar (Promoción / Tiempo limitado).
// Sin red: OpenAI (mejora y revisión) se simulan; las fotos son escenas
// sintéticas (helpers/escenaComida.js) medidas con sharp de verdad.
//
//   CAL-*   calidad técnica real: oscura, borrosa, baja resolución, mal recortada, quemada
//   REV-*   revisión con visión (Responses API, Structured Outputs)
//   FLU-*   flujo subida → analizando → mejorando → validando → lista | rechazada | fallida
//   PUB-*   regla de publicación: sin trabajo 'lista' no se crea, edita, reactiva ni aprueba
//   API-*   endpoints /api/imagenes/trabajos
//   CFG-*   sin claves ni migraciones queda dicho exactamente qué falta

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
const { fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala, trabajoListo } = require('./helpers/appPublicaciones');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const { escena, PLATO, OTRO_PLATO } = require('./helpers/escenaComida');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');
const { analizarCalidad } = require('../services/imagenes/calidad');
const { crearRevisorIA, MODELO_VISION_POR_DEFECTO, PROBLEMAS } = require('../services/imagenes/revisionIA');
const { ErrorProveedor } = require('../services/imagenes/errores');
const trabajos = require('../services/imagenes/trabajos');
const iaEstado = require('../services/iaEstado');

const HOST = 'proyecto.supabase.co';
const hosts = new Set([HOST]);
const urlFoto = (negocio = IDS.olaAzul, n = 1) => `https://${HOST}/storage/v1/object/public/bocara-images/bolsas/${negocio}_${n}.jpg`;

function silenciar(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(fn).finally(() => Object.assign(console, { log, warn, error }));
}

// Variantes reales de una misma foto.
const fotos = {};
test.before(async () => {
  const b = await escena(PLATO);
  Object.assign(fotos, {
    buena: b,
    otra: await escena(OTRO_PLATO),
    borrosa: await sharp(b).blur(3).jpeg().toBuffer(),
    oscura: await sharp(b).modulate({ brightness: 0.2 }).jpeg().toBuffer(),
    algoOscura: await sharp(b).modulate({ brightness: 0.55 }).jpeg().toBuffer(),
    pequena: await sharp(b).resize(400).jpeg().toBuffer(),
    panoramica: await sharp(b).extract({ left: 0, top: 250, width: 900, height: 300 }).jpeg().toBuffer(),
    quemada: await sharp(b).linear(1, 140).jpeg().toBuffer(),
    // "Mejora" verosímil: más luz y color, misma escena.
    mejorada: await sharp(b).modulate({ brightness: 1.08, saturation: 1.05 }).linear(1.1, -8).webp().toBuffer(),
  });
});

const codigos = (r) => r.motivos.map((m) => m.codigo);

// ── CAL ─────────────────────────────────────────────────────────────────────

test('CAL-1: una foto nítida, bien expuesta y bien proporcionada pasa ambos niveles', async () => {
  const o = await analizarCalidad(fotos.buena, { nivel: 'original' });
  assert.equal(o.ok, true, JSON.stringify(o.metricas));
  assert.equal((await analizarCalidad(fotos.mejorada, { nivel: 'publicable' })).ok, true);
});

test('CAL-2: rechaza muy oscura, borrosa, baja resolución, mal recortada y sobreexpuesta (con mensaje para el restaurante)', async () => {
  const casos = [['oscura', 'oscura'], ['borrosa', 'borrosa'], ['pequena', 'resolucion'], ['panoramica', 'proporcion'], ['quemada', 'quemada']];
  for (const [foto, codigo] of casos) {
    const r = await analizarCalidad(fotos[foto], { nivel: 'original' });
    assert.equal(r.ok, false, foto);
    assert.ok(codigos(r).includes(codigo), `${foto}: ${JSON.stringify(r.motivos)} ${JSON.stringify(r.metricas)}`);
    assert.ok(r.motivos.every((m) => m.mensaje.length > 20));
  }
});

test('CAL-3: algo oscura es recuperable (pasa "original") pero NO es publicable tal cual', async () => {
  assert.equal((await analizarCalidad(fotos.algoOscura, { nivel: 'original' })).ok, true);
  assert.equal((await analizarCalidad(fotos.algoOscura, { nivel: 'publicable' })).ok, false);
});

test('CAL-4: un archivo que no es imagen → "ilegible" (nunca lanza)', async () => {
  const r = await analizarCalidad(Buffer.from('no soy una imagen'));
  assert.deepEqual(codigos(r), ['ilegible']);
});

test('CAL-5: umbrales ajustables por variable de entorno', async () => {
  process.env.IMAGE_QUALITY_MIN_LADO = '1000';
  try {
    assert.ok(codigos(await analizarCalidad(fotos.buena)).includes('resolucion'));
  } finally { delete process.env.IMAGE_QUALITY_MIN_LADO; }
});

// ── REV ─────────────────────────────────────────────────────────────────────

function openaiFalso(respuesta) {
  const llamadas = [];
  return {
    llamadas,
    responses: {
      create: async (params) => {
        llamadas.push(params);
        if (respuesta instanceof Error) throw respuesta;
        return { output_text: JSON.stringify(respuesta), usage: { input_tokens: 90, output_tokens: 30 } };
      },
    },
  };
}

test('REV-1: manda la foto como input_image con Structured Outputs estricto y el modelo configurable', async () => {
  const c = openaiFalso({ apta: true, problemas: [], resumen: 'Plato bien encuadrado.' });
  const r = await crearRevisorIA({ cliente: c }).revisar(fotos.buena);
  assert.equal(r.apta, true);
  const p = c.llamadas[0];
  assert.equal(p.model, MODELO_VISION_POR_DEFECTO);
  assert.equal(MODELO_VISION_POR_DEFECTO, 'gpt-6-luna');
  assert.equal(p.text.format.type, 'json_schema');
  assert.equal(p.text.format.strict, true);
  const img = p.input[0].content.find((x) => x.type === 'input_image');
  assert.match(img.image_url, /^data:image\/jpeg;base64,/);
  process.env.OPENAI_VISION_MODEL = 'otro-modelo-vision';
  try { assert.equal(crearRevisorIA({ cliente: c }).modelo, 'otro-modelo-vision'); } finally { delete process.env.OPENAI_VISION_MODEL; }
});

test('REV-2: no apta → problemas traducidos; no apta sin problema reconocible → "baja_calidad" (nunca rechazo mudo)', async () => {
  const r = await crearRevisorIA({ cliente: openaiFalso({ apta: false, problemas: ['recortada', 'inventado'], resumen: 'x' }) }).revisar(fotos.buena);
  assert.equal(r.apta, false);
  assert.deepEqual(r.problemas, [{ codigo: 'recortada', mensaje: PROBLEMAS.recortada }]);
  const r2 = await crearRevisorIA({ cliente: openaiFalso({ apta: false, problemas: [], resumen: 'x' }) }).revisar(fotos.buena);
  assert.deepEqual(r2.problemas.map((p) => p.codigo), ['baja_calidad']);
});

test('REV-3: error de la API → ErrorProveedor (429/5xx reintentable, 401 no); JSON roto → reintentable', async () => {
  const e429 = Object.assign(new Error('rate'), { status: 429 });
  await assert.rejects(crearRevisorIA({ cliente: openaiFalso(e429) }).revisar(fotos.buena), (e) => e instanceof ErrorProveedor && e.reintentable);
  const e401 = Object.assign(new Error('auth'), { status: 401 });
  await assert.rejects(crearRevisorIA({ cliente: openaiFalso(e401) }).revisar(fotos.buena), (e) => e instanceof ErrorProveedor && !e.reintentable);
  const roto = { responses: { create: async () => ({ output_text: 'no json' }) } };
  await assert.rejects(crearRevisorIA({ cliente: roto }).revisar(fotos.buena), (e) => e.reintentable === true);
});

// ── FLU ─────────────────────────────────────────────────────────────────────

function entorno({ foto = 'buena', revision = { apta: true, problemas: [], resumen: 'ok' }, resultado = 'mejorada', proveedor, deps } = {}) {
  const cliente = crearFakeSupabase({
    trabajos_imagen: [{ id: 't1', usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul, original_url: urlFoto(), estado: 'subida', intentos: 0, updated_at: new Date().toISOString() }],
  });
  const estados = [];
  const desde = cliente.from.bind(cliente);
  cliente.from = (tabla) => {
    const q = desde(tabla);
    const update = q.update.bind(q);
    q.update = (cambios) => { if (tabla === 'trabajos_imagen' && cambios.estado) estados.push(cambios.estado); return update(cambios); };
    return q;
  };
  const llamadas = { proveedor: 0, revisor: 0, descargas: 0, subidas: [] };
  const prov = proveedor || {
    nombre: 'openai', ia: true, modelo: 'gpt-image-1-mini', necesitaUrl: false,
    mejorar: async () => { llamadas.proveedor += 1; return { buffer: fotos[resultado], contentType: 'image/webp', meta: { mock: true } }; },
  };
  const revisor = {
    modelo: 'gpt-6-luna',
    revisar: async () => {
      llamadas.revisor += 1;
      if (revision instanceof Error) throw revision;
      return { ...revision, problemas: (revision.problemas || []).map((c) => ({ codigo: c, mensaje: PROBLEMAS[c] })) };
    },
  };
  const opts = {
    cliente, hosts, dormir: async () => {},
    deps: deps || { proveedor: prov, revisor },
    descargar: async () => { llamadas.descargas += 1; return { buffer: fotos[foto], contentType: 'image/jpeg' }; },
    almacenamiento: { subir: async (ruta) => { llamadas.subidas.push(ruta); return `https://${HOST}/storage/v1/object/public/bocara-images/${ruta}`; } },
  };
  return { cliente, opts, estados, llamadas, fila: () => cliente.tabla('trabajos_imagen')[0] };
}

test('FLU-1: éxito → analizando → mejorando → validando → lista; mejorada en archivo nuevo, original intacta', async () => {
  const env = entorno();
  const final = await silenciar(() => trabajos.procesarTrabajo('t1', env.opts));
  assert.equal(final, 'lista');
  assert.deepEqual(env.estados, ['analizando', 'mejorando', 'validando', 'lista']);
  const t = env.fila();
  assert.equal(t.original_url, urlFoto());
  assert.match(t.mejorada_url, /\/mejoradas\/trabajos\/t1\/\d+\.webp$/);
  assert.equal(t.proveedor, 'openai');
  assert.equal(t.revision_ia.apta, true);
  assert.ok(t.calidad_resultado.similitud > 0.55);
  assert.equal(trabajos.serializar(t).mejorada_url, t.mejorada_url);
});

test('FLU-2: original muy oscura o borrosa → rechazada con motivos; ni revisión ni mejora (no se gasta IA)', async () => {
  for (const foto of ['oscura', 'borrosa', 'pequena']) {
    const env = entorno({ foto });
    assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'rechazada', foto);
    assert.equal(env.llamadas.revisor, 0);
    assert.equal(env.llamadas.proveedor, 0);
    assert.ok(env.fila().motivos.length > 0);
    assert.equal(trabajos.serializar(env.fila()).puede_reintentar, false, 'rechazada: hay que cambiar la foto');
  }
});

test('FLU-3: la revisión IA la declara no apta (producto cortado) → rechazada; la mejora no corre', async () => {
  const env = entorno({ revision: { apta: false, problemas: ['recortada'], resumen: 'cortado' } });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'rechazada');
  assert.equal(env.llamadas.proveedor, 0);
  assert.deepEqual(env.fila().motivos, [{ codigo: 'recortada', mensaje: PROBLEMAS.recortada }]);
});

test('FLU-4: proveedor caído (no reintentable) → fallida "proveedor" reintentable por el usuario; transitorio → reintenta solo y completa', async () => {
  const caido = { nombre: 'openai', ia: true, mejorar: async () => { throw new ErrorProveedor('openai 401', { reintentable: false }); } };
  const env = entorno({ proveedor: caido });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'fallida');
  const s = trabajos.serializar(env.fila(), { expone: true });
  assert.equal(s.error_codigo, 'proveedor');
  assert.equal(s.puede_reintentar, true);
  assert.match(s.detalle, /401/);
  assert.equal(trabajos.serializar(env.fila(), { expone: false }).detalle, null, 'en producción no se expone el detalle técnico');

  let n = 0;
  const intermitente = {
    nombre: 'openai', ia: true,
    mejorar: async () => { n += 1; if (n === 1) throw new ErrorProveedor('timeout'); return { buffer: fotos.mejorada, contentType: 'image/webp' }; },
  };
  const env2 = entorno({ proveedor: intermitente });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env2.opts)), 'lista');
  assert.equal(n, 2);
});

test('FLU-5: la IA devuelve otra escena → fallida "validacion" (no se publica algo que no es tu producto)', async () => {
  const env = entorno({ resultado: 'otra' });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'fallida');
  assert.equal(env.fila().error_codigo, 'validacion');
  assert.equal(env.fila().mejorada_url, undefined);
});

test('FLU-6: el resultado sigue sin la calidad publicable → fallida "calidad_resultado" con motivos', async () => {
  const env = entorno({ foto: 'algoOscura', resultado: 'algoOscura' });
  // Mismo archivo = sin mejora visible: también lo frena la validación. Se usa uno levemente distinto.
  env.opts.deps.proveedor.mejorar = async () => ({ buffer: await sharp(fotos.algoOscura).modulate({ brightness: 1.04 }).webp().toBuffer(), contentType: 'image/webp' });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'fallida');
  assert.equal(env.fila().error_codigo, 'calidad_resultado');
  assert.ok(env.fila().motivos.length > 0);
});

test('FLU-7: sin IA configurada → fallida "ia_no_configurada" con QUÉ falta; no descarga ni aparenta mejorar', async () => {
  const env = entorno({ deps: { configError: 'IA de imagen no configurada: falta OPENAI_API_KEY en backend/.env.' } });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'fallida');
  const s = trabajos.serializar(env.fila(), { expone: true });
  assert.equal(s.error_codigo, 'ia_no_configurada');
  assert.equal(s.error, 'La mejora con IA no está configurada en el servidor.');
  assert.match(s.detalle, /OPENAI_API_KEY/);
  assert.equal(env.llamadas.descargas, 0);

  // El ajuste local (sharp) no es IA: tampoco sirve para publicar.
  const env2 = entorno({ deps: { proveedor: { nombre: 'local', ia: false, mejorar: async () => ({}) }, revisor: { revisar: async () => ({}) } } });
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env2.opts)), 'fallida');
  assert.equal(env2.fila().error_codigo, 'ia_no_configurada');
});

test('FLU-8: foto fuera de nuestro Storage → fallida sin descargar (anti-SSRF)', async () => {
  const env = entorno();
  env.cliente._db.tablas.trabajos_imagen[0].original_url = 'https://atacante.example/x.jpg';
  assert.equal(await silenciar(() => trabajos.procesarTrabajo('t1', env.opts)), 'fallida');
  assert.equal(env.fila().error_codigo, 'descarga');
  assert.equal(env.llamadas.descargas, 0);
});

test('FLU-9: dos disparos a la vez → se procesa una sola vez', async () => {
  const env = entorno();
  const [a, b] = await silenciar(() => Promise.all([trabajos.procesarTrabajo('t1', env.opts), trabajos.procesarTrabajo('t1', env.opts)]));
  assert.deepEqual([a, b].filter(Boolean), ['lista']);
  assert.equal(env.llamadas.proveedor, 1);
});

test('FLU-10: reintentar solo desde fallida; una rechazada exige cambiar la foto', async () => {
  const env = entorno({ deps: { configError: 'falta OPENAI_API_KEY' } });
  await silenciar(() => trabajos.procesarTrabajo('t1', env.opts));
  const usuario = { id: IDS.restaurante, rol: 'restaurante' };
  const ok = await trabajos.reintentarTrabajo('t1', usuario, { cliente: env.cliente, procesar: false });
  assert.equal(ok.ok, true);
  assert.equal(env.fila().estado, 'subida');
  const env2 = entorno({ foto: 'oscura' });
  await silenciar(() => trabajos.procesarTrabajo('t1', env2.opts));
  const no = await trabajos.reintentarTrabajo('t1', usuario, { cliente: env2.cliente, procesar: false });
  assert.equal(no.status, 409);
  assert.match(no.error, /Cambia la foto/);
  const ajeno = await trabajos.reintentarTrabajo('t1', { id: IDS.otroRestaurante, rol: 'restaurante' }, { cliente: env.cliente, procesar: false });
  assert.equal(ajeno.status, 404);
});

test('FLU-11: job — lo que quedó a medias pasa a "interrumpido" (reintentable) y los huérfanos en "subida" se procesan', async () => {
  const env = entorno();
  const viejo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  env.cliente._db.tablas.trabajos_imagen.push({ id: 't2', estado: 'mejorando', iniciado_at: viejo, original_url: urlFoto() });
  env.cliente._db.tablas.trabajos_imagen[0].updated_at = new Date(Date.now() - 60 * 1000).toISOString();
  const r = await silenciar(() => trabajos.procesarTrabajosPendientes({ ...env.opts }));
  assert.equal(r.interrumpidos, 1);
  assert.equal(r.procesados, 1);
  assert.equal(env.cliente.tabla('trabajos_imagen').find((t) => t.id === 't2').error_codigo, 'interrumpido');
  assert.equal(env.fila().estado, 'lista');
});

test('FLU-12: trabajoParaPublicar — cada estado responde su código', async () => {
  const usuario = { id: IDS.restaurante, rol: 'restaurante' };
  const casos = [['subida', 'IMAGEN_EN_PROCESO', 409], ['analizando', 'IMAGEN_EN_PROCESO', 409], ['mejorando', 'IMAGEN_EN_PROCESO', 409],
    ['validando', 'IMAGEN_EN_PROCESO', 409], ['rechazada', 'IMAGEN_RECHAZADA', 422], ['fallida', 'IMAGEN_FALLIDA', 422]];
  for (const [estado, codigo, status] of casos) {
    const cliente = crearFakeSupabase({ trabajos_imagen: [{ id: 'x', estado, usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul }] });
    const r = await trabajos.trabajoParaPublicar('x', { usuario, negocioId: IDS.olaAzul }, { cliente });
    assert.deepEqual([r.codigo, r.status], [codigo, status], estado);
  }
  const cliente = crearFakeSupabase({ trabajos_imagen: [{ id: 'x', estado: 'lista', mejorada_url: 'm', usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul }] });
  assert.equal((await trabajos.trabajoParaPublicar('x', { usuario, negocioId: IDS.otroNegocio }, { cliente })).codigo, 'IMAGEN_NO_PROCESADA', 'otro negocio');
  assert.equal((await trabajos.trabajoParaPublicar('x', { usuario: { id: IDS.otroRestaurante, rol: 'restaurante' }, negocioId: IDS.olaAzul }, { cliente })).codigo, 'IMAGEN_NO_PROCESADA', 'otro usuario');
  assert.equal((await trabajos.trabajoParaPublicar(undefined, { usuario, negocioId: IDS.olaAzul }, { cliente })).codigo, 'IMAGEN_NO_PROCESADA');
  assert.equal((await trabajos.trabajoParaPublicar('x', { usuario, negocioId: IDS.olaAzul }, { cliente })).ok, true);
});

// ── PUB (rutas reales) ──────────────────────────────────────────────────────

const HOY = fechaGuatemala(0);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';
const promo = (extra = {}) => ({
  nombre: `Promo ${Math.random().toString(36).slice(2, 7)}`, contenido: 'X', tipo: 'cupon', categoria: '2x1',
  descripcion: 'd', precio_original: 100, precio_descuento: 50, cantidad_disponible: 5, imagen_url: FOTO,
  hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, ...extra,
});

let servidor, base;
test.before(async () => {
  await iniciar();
  const app = express();
  app.use(express.json());
  app.use('/api/imagenes', require('../routes/imagenes'));
  app.use('/api/ia', require('../routes/ia'));
  await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(async () => { await detener(); await new Promise((r) => servidor.close(r)); });
test.beforeEach(() => fake.reiniciar(datosBase()));

async function api(metodo, ruta, { como = IDS.restaurante, body } = {}) {
  const usuario = Object.entries(IDS).find(([, v]) => v === como)?.[0];
  const rol = { admin: 'admin', cliente: 'cliente' }[usuario] || 'restaurante';
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: como, rol }, process.env.JWT_SECRET)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const sembrarTrabajo = (estado, extra = {}) => {
  const t = { id: `t-${estado}-${Math.random().toString(16).slice(2)}`, estado, usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul, original_url: FOTO, ...extra };
  fake._db.tablas.trabajos_imagen.push(t);
  return t.id;
};

test('PUB-1: no se puede crear sin trabajo, con la foto en proceso, rechazada o fallida (mensaje y código claros)', async () => {
  const sinNada = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ imagen_url: null }), sinTrabajo: true }));
  assert.equal(sinNada.status, 400);
  assert.equal(sinNada.body.error, 'La foto es obligatoria');
  const casos = [['analizando', 409, 'IMAGEN_EN_PROCESO'], ['mejorando', 409, 'IMAGEN_EN_PROCESO'], ['validando', 409, 'IMAGEN_EN_PROCESO'],
    ['rechazada', 422, 'IMAGEN_RECHAZADA'], ['fallida', 422, 'IMAGEN_FALLIDA']];
  for (const [estado, status, codigo] of casos) {
    const id = sembrarTrabajo(estado);
    const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ imagen_trabajo_id: id }) }));
    assert.deepEqual([r.status, r.body.codigo], [status, codigo], estado);
    assert.ok(r.body.error.length > 20);
  }
  assert.equal(fake.tabla('bolsas').length, 0, 'nada se publicó');
});

test('PUB-2: el trabajo de OTRO negocio no sirve (no se puede reutilizar la foto validada ajena)', async () => {
  const ajeno = trabajoListo({ negocioId: IDS.otroNegocio, usuarioId: IDS.otroRestaurante, url: 'https://m/ajena.webp' });
  const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ imagen_trabajo_id: ajeno }) }));
  assert.equal(r.status, 400);
  assert.equal(r.body.codigo, 'IMAGEN_NO_PROCESADA');
});

test('PUB-3: publicación heredada sin foto validada: ocultar o ajustar unidades sí; editar contenido o reactivar NO', async () => {
  fake._db.tablas.bolsas.push({
    id: 'leg', negocio_id: IDS.olaAzul, nombre: 'Heredada', tipo: 'cupon', precio_original: 100, precio_descuento: 50,
    cantidad_disponible: 3, activo: true, estado_aprobacion: 'aprobado', imagen_url: FOTO, motivo_rechazo: null,
    hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, created_at: new Date().toISOString(),
  });
  const editar = (body) => silenciar(() => pedir('PUT', '/api/bolsas/leg', { como: IDS.restaurante, body }));
  assert.equal((await editar({ cantidad_disponible: 9 })).status, 200);
  assert.equal((await editar({ activo: false })).status, 200);
  const contenido = await editar({ nombre: 'Heredada v2' });
  assert.deepEqual([contenido.status, contenido.body.codigo], [409, 'IMAGEN_SIN_VALIDAR']);
  const reactivar = await editar({ activo: true });
  assert.equal(reactivar.status, 409);
  // Con una foto nueva validada sí puede volver (a revisión).
  const conFoto = await editar({ nombre: 'Heredada v2', imagen_url: 'https://cdn.bocara.test/nueva.jpg' });
  assert.equal(conFoto.status, 200, JSON.stringify(conFoto.body));
  assert.equal(fake.tabla('bolsas').find((b) => b.id === 'leg').estado_procesamiento_imagen, 'completada');
});

test('PUB-4: el admin no puede aprobar una publicación cuya foto no pasó la validación IA', async () => {
  fake._db.tablas.bolsas.push({
    id: 'pend', negocio_id: IDS.olaAzul, nombre: 'Pendiente', tipo: 'cupon', precio_original: 100, precio_descuento: 50,
    cantidad_disponible: 3, activo: true, estado_aprobacion: 'pendiente', imagen_url: FOTO, motivo_rechazo: null,
    hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, created_at: new Date().toISOString(),
  });
  const r = await silenciar(() => pedir('PUT', '/api/admin/bolsas/pend/aprobar', { como: IDS.admin }));
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'IMAGEN_SIN_VALIDAR');
  assert.equal(fake.tabla('bolsas')[0].estado_aprobacion, 'pendiente');
  fake.tabla('bolsas')[0].estado_procesamiento_imagen = 'completada';
  assert.equal((await silenciar(() => pedir('PUT', '/api/admin/bolsas/pend/aprobar', { como: IDS.admin }))).status, 200);
});

test('PUB-5: falta la migración de columnas de imagen → 503 explícito, no un 400 genérico', async () => {
  const id = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: 'https://m/x.webp' });
  const error = { message: 'column "estado_procesamiento_imagen" of relation "bolsas" does not exist' };
  // Primer insert, insert de respaldo: ambos fallan por la columna.
  const desde = fake.from.bind(fake);
  let insertos = 0;
  fake.from = (tabla) => {
    const q = desde(tabla);
    if (tabla === 'bolsas') {
      const ins = q.insert.bind(q);
      q.insert = (filas) => { insertos += 1; fake.inyectarError(error); return ins(filas); };
    }
    return q;
  };
  try {
    const r = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ imagen_trabajo_id: id }) }));
    assert.equal(r.status, 503);
    assert.equal(r.body.codigo, 'MIGRACION_PENDIENTE');
    assert.match(r.body.error, /20261006100000_pipeline_imagenes/);
    assert.ok(insertos >= 1);
  } finally { fake.from = desde; }
});

// ── API ─────────────────────────────────────────────────────────────────────

test('API-1: crear trabajo con foto de su carpeta → 202 en "subida" y se procesa solo; sin IA queda "fallida" diciendo qué falta', async () => {
  const previo = { k: process.env.OPENAI_API_KEY, p: process.env.IMAGE_AI_PROVIDER };
  delete process.env.OPENAI_API_KEY; process.env.IMAGE_AI_PROVIDER = 'openai';
  try {
    const r = await silenciar(() => api('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlFoto() } }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.trabajo.estado, 'subida');
    await silenciar(trabajos.esperarTrabajosEnCurso);
    const g = await api('GET', `/api/imagenes/trabajos/${r.body.trabajo.id}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.trabajo.estado, 'fallida');
    assert.equal(g.body.trabajo.error_codigo, 'ia_no_configurada');
    assert.match(g.body.trabajo.detalle, /OPENAI_API_KEY/);
    // Y con esa foto no se puede publicar.
    const pub = await silenciar(() => pedir('POST', '/api/bolsas', { como: IDS.restaurante, body: promo({ imagen_trabajo_id: r.body.trabajo.id }) }));
    assert.equal(pub.body.codigo, 'IMAGEN_FALLIDA');
  } finally {
    if (previo.k === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previo.k;
    if (previo.p === undefined) delete process.env.IMAGE_AI_PROVIDER; else process.env.IMAGE_AI_PROVIDER = previo.p;
  }
});

test('API-2: solo restaurante/admin; foto de otra carpeta o host → 400; trabajo ajeno → 404', async () => {
  assert.equal((await api('POST', '/api/imagenes/trabajos', { como: IDS.cliente, body: { imagen_url: urlFoto() } })).status, 403);
  assert.equal((await api('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlFoto(IDS.otroNegocio) } })).status, 400);
  assert.equal((await api('POST', '/api/imagenes/trabajos', { body: { imagen_url: 'https://otro.host/bocara-images/bolsas/x.jpg' } })).status, 400);
  const id = sembrarTrabajo('lista', { mejorada_url: 'm' });
  assert.equal((await api('GET', `/api/imagenes/trabajos/${id}`, { como: IDS.otroRestaurante })).status, 404);
  assert.equal((await api('GET', `/api/imagenes/trabajos/${id}`)).status, 200);
});

test('API-3: límite de fotos por hora → 429', async () => {
  process.env.IMAGE_AI_MAX_TRABAJOS_POR_HORA = '2';
  try {
    for (let i = 0; i < 2; i++) sembrarTrabajo('lista', { created_at: new Date().toISOString() });
    const r = await api('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlFoto() } });
    assert.equal(r.status, 429);
  } finally { delete process.env.IMAGE_AI_MAX_TRABAJOS_POR_HORA; }
});

test('API-4: tabla de trabajos inexistente (migración pendiente) → 503 que nombra la migración', async () => {
  const desde = fake.from.bind(fake);
  fake.from = (tabla) => {
    if (tabla !== 'trabajos_imagen') return desde(tabla);
    const q = desde(tabla);
    q.then = (ok) => Promise.resolve({ data: null, error: { message: 'relation "trabajos_imagen" does not exist' }, count: null }).then(ok);
    return q;
  };
  try {
    const r = await silenciar(() => api('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlFoto() } }));
    assert.equal(r.status, 503);
    assert.equal(r.body.codigo, 'MIGRACION_PENDIENTE');
    assert.match(r.body.error, /20261014100000_trabajos_imagen/);
  } finally { fake.from = desde; }
});

test('API-5: reintentar por HTTP solo desde fallida', async () => {
  const id = sembrarTrabajo('rechazada');
  assert.equal((await api('POST', `/api/imagenes/trabajos/${id}/reintentar`)).status, 409);
  const id2 = sembrarTrabajo('fallida', { error_codigo: 'proveedor' });
  const r = await silenciar(() => api('POST', `/api/imagenes/trabajos/${id2}/reintentar`));
  assert.equal(r.status, 202);
  await silenciar(trabajos.esperarTrabajosEnCurso);
});

// ── CFG ─────────────────────────────────────────────────────────────────────

function conEnv(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; }
  }
}

test('CFG-1: diagnóstico — sin claves dice exactamente cuáles faltan; con ellas, operativa', () => {
  conEnv({ TEXT_AI_PROVIDER: undefined, GEMINI_API_KEY: undefined, IMAGE_AI_PROVIDER: undefined, OPENAI_API_KEY: undefined, REPLICATE_API_TOKEN: undefined }, () => {
    const t = iaEstado.estadoIATexto();
    assert.equal(t.operativa, false);
    assert.deepEqual(t.faltan, ['TEXT_AI_PROVIDER', 'GEMINI_API_KEY']);
    const i = iaEstado.estadoIAImagen();
    assert.equal(i.operativa, false);
    assert.deepEqual(i.faltan, ['IMAGE_AI_PROVIDER', 'OPENAI_API_KEY']);
    assert.match(i.mensaje, /no se puede publicar/);
  });
  conEnv({ TEXT_AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'x', IMAGE_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'y', GEMINI_TEXT_MODEL: undefined, OPENAI_IMAGE_MODEL: undefined }, () => {
    const t = iaEstado.estadoIATexto();
    assert.equal(t.operativa, true);
    assert.equal(t.modelo, 'gemini-2.5-flash-lite');
    const i = iaEstado.estadoIAImagen();
    assert.equal(i.operativa, true);
    assert.equal(i.modelo, 'gpt-image-1-mini');
    assert.equal(i.modelo_revision, 'gpt-6-luna');
    assert.ok(!JSON.stringify([t, i]).includes('"x"') && !JSON.stringify([t, i]).includes('"y"'), 'nunca expone valores de claves');
  });
});

test('CFG-2: IMAGE_AI_PROVIDER=local (no IA) o none no cuentan como operativa', () => {
  for (const p of ['local', 'none']) {
    conEnv({ IMAGE_AI_PROVIDER: p, OPENAI_API_KEY: 'y' }, () => assert.equal(iaEstado.estadoIAImagen().operativa, false, p));
  }
});

test('CFG-3: migraciones — detecta cuál falta por nombre de archivo', async () => {
  const cliente = crearFakeSupabase({});
  cliente.inyectarError({ message: 'column bolsas.estado_procesamiento_imagen does not exist' });
  const m = await iaEstado.estadoMigraciones(cliente);
  assert.equal(m.ok, false);
  assert.deepEqual(m.pendientes.map((p) => p.archivo.split('/').pop()), ['20261006100000_pipeline_imagenes.sql']);
  assert.match(m.mensaje, /20261006100000_pipeline_imagenes\.sql/);
  assert.equal((await iaEstado.estadoMigraciones(crearFakeSupabase({}))).ok, true);
});

test('CFG-4: GET /api/ia/estado — restaurante/admin ven el diagnóstico; cliente no', async () => {
  const r = await api('GET', '/api/ia/estado');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['imagen', 'migraciones', 'texto']);
  assert.equal(typeof r.body.texto.operativa, 'boolean');
  assert.equal((await api('GET', '/api/ia/estado', { como: IDS.cliente })).status, 403);
});
