// IA de texto: descripción propuesta para Promoción / Tiempo limitado.
// Gemini se simula SIEMPRE con un fetch inyectado: ninguna prueba sale a la
// red (TXT-10 deja una trampa en globalThis.fetch que falla si alguien la usa).
//
//   TXT-1  Gemini recibe únicamente los datos permitidos
//   TXT-2  ningún secreto viaja en la URL ni en el body
//   TXT-3  la descripción generada vuelve al frontend (solo { descripcion })
//   TXT-5  fallo de Gemini → error claro, nada se guarda
//   TXT-6  timeout → 504 con el mismo mensaje, nada se guarda
//   TXT-7  rate limit por minuto, diario por usuario y global
//   TXT-8  sin token / cliente / admin no pueden usar el endpoint
//   TXT-9  validación de longitud y tamaño del body
//   TXT-10 las pruebas no llaman a Gemini real
//   TXT-11 salvaguarda: una cifra inventada descarta la propuesta
//   (TXT-4 "el usuario puede modificarla" se prueba en la app:
//    bocara-mobile/scripts/test-descripcion-ia.cjs)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { fake, IDS, datosBase } = require('./helpers/appPublicaciones');

const CLAVE_GEMINI = 'clave-gemini-de-prueba-NO-REAL';
process.env.GEMINI_API_KEY = CLAVE_GEMINI;
process.env.OPENAI_API_KEY = 'clave-openai-de-prueba-NO-REAL';
process.env.SUPABASE_SERVICE_KEY = 'clave-supabase-de-prueba-NO-REAL';

const textoIA = require('../services/text-ai');
const { crearProveedorGemini, MODELO_POR_DEFECTO } = require('../services/text-ai/providers/gemini');
const { crearLimites } = require('../services/text-ai/limites');
const { crearRouterIA, MENSAJE_FALLO } = require('../routes/ia');

// ── TXT-10: trampa. Si algo usa el fetch global (red real), la prueba falla.
const fetchOriginal = globalThis.fetch;
let llamadasFetchGlobal = 0;

// ── Gemini simulado ─────────────────────────────────────────────────────────
function respuestaGemini(texto, extra = {}) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: texto }] }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 310, candidatesTokenCount: 42, totalTokenCount: 352 },
  };
}
function fetchSimulado({ status = 200, cuerpo = respuestaGemini('Disfruta una hamburguesa acompañada de papas, disponible por tiempo limitado a precio Bocara.'), colgar = false } = {}) {
  const llamadas = [];
  const fn = async (url, opciones) => {
    llamadas.push({ url, opciones, body: JSON.parse(opciones.body) });
    if (colgar) {
      return new Promise((_, rechazar) => opciones.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rechazar(e);
      }));
    }
    return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
  };
  fn.llamadas = llamadas;
  return fn;
}

// ── App de prueba: router real + Supabase en memoria ────────────────────────
let servidor = null;
let base = null;
let generarActual = null;
let limitesActuales = null;

async function iniciar() {
  const app = express();
  // Igual que server.js: /api/ia antes del express.json global de 15 MB.
  app.use('/api/ia', (req, res, next) => routerActual(req, res, next));
  app.use(express.json({ limit: '15mb' }));
  await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}
let routerActual = null;
function montar({ fetchImpl = fetchSimulado(), limites = crearLimites({ porMinuto: 100, porDia: 100, globalPorDia: 1000 }), generar } = {}) {
  const proveedor = crearProveedorGemini({ apiKey: CLAVE_GEMINI, fetchImpl });
  generarActual = generar || ((datos, opts) => textoIA.generarDescripcion(datos, { ...opts, proveedor }));
  limitesActuales = limites;
  routerActual = crearRouterIA({ generar: generarActual, limites });
  return fetchImpl;
}

function token(id, rol) { return jwt.sign({ id, rol }, process.env.JWT_SECRET); }
async function pedir(body, { como = IDS.restaurante, rol = 'restaurante', crudo } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (como) headers.Authorization = `Bearer ${token(como, rol)}`;
  const r = await fetchOriginal(`${base}/api/ia/descripcion`, { method: 'POST', headers, body: crudo ?? JSON.stringify(body) });
  const t = await r.text();
  let json = null; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json, headers: r.headers };
}

const BASICO = { tipo: 'bolsa', nombre: 'Hamburguesa con papas' };
const COMPLETO = {
  tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'Hamburguesa con papas',
  contenido: 'Hamburguesa y papas fritas', categoria_alimento: 'carne_bovina',
  precio_original: '60', precio_descuento: '35',
  hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
  fecha_disponible: '2026-10-14', fecha_caducidad: '2026-10-15',
};

test.before(async () => {
  globalThis.fetch = async () => { llamadasFetchGlobal += 1; throw new Error('RED REAL BLOQUEADA EN PRUEBAS'); };
  await iniciar();
});
test.after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
});
test.beforeEach(() => {
  fake.reiniciar(datosBase());
  montar();
});

// ── TXT-1 / TXT-2 ───────────────────────────────────────────────────────────

test('TXT-1: Gemini recibe únicamente los datos permitidos del formulario (lista blanca)', async () => {
  const f = montar();
  const r = await pedir({
    ...COMPLETO,
    // Nada de esto debe salir hacia Gemini:
    negocio_id: IDS.olaAzul, propietario_id: IDS.restaurante, email: 'duena@olaazul.gt',
    telefono: '5555-1234', cantidad_disponible: 7, imagen_url: 'https://cdn/x.jpg', token: 'abc',
    usuario: { nombre: 'Dueña', nit: '1234567-8' }, categoria: '2x1',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(f.llamadas.length, 1);
  const enviado = f.llamadas[0].body;
  assert.deepEqual(Object.keys(enviado).sort(), ['contents', 'generationConfig', 'systemInstruction']);
  const textoUsuario = enviado.contents[0].parts[0].text;
  const hechos = JSON.parse(textoUsuario.replace(/^HECHOS:\n/, ''));
  assert.deepEqual(Object.keys(hechos).sort(), [
    'categoria_alimento', 'categoria_negocio', 'contenido', 'descripcion_actual', 'descuento', 'fecha',
    'horario_recogida', 'nombre', 'precio_bocara', 'precio_original', 'tipo',
  ]);
  assert.deepEqual(hechos, {
    tipo: 'Tiempo limitado', nombre: 'Hamburguesa con papas', descripcion_actual: 'Hamburguesa con papas',
    contenido: 'Hamburguesa y papas fritas', categoria_alimento: 'Carne bovina',
    precio_original: 'Q60.00', precio_bocara: 'Q35.00', descuento: '42%',
    horario_recogida: '18:00 a 20:00', fecha: 'del 14 de octubre al 15 de octubre', categoria_negocio: 'Restaurante',
  });
  const todo = JSON.stringify(enviado);
  for (const prohibido of [IDS.olaAzul, IDS.restaurante, 'duena@olaazul.gt', '5555-1234', 'cdn/x.jpg', '1234567-8', 'Dueña', '2x1', '"7"']) {
    assert.ok(!todo.includes(prohibido), `no debe enviarse: ${prohibido}`);
  }
});

test('TXT-1: Promoción → no se envía el código del cupón ni fecha fin; campos vacíos se omiten', async () => {
  const f = montar();
  const r = await pedir({ tipo: 'cupon', nombre: 'Descuento miércoles', contenido: 'BOCARA20', fecha_caducidad: '2026-12-01' });
  assert.equal(r.status, 200);
  const hechos = JSON.parse(f.llamadas[0].body.contents[0].parts[0].text.replace(/^HECHOS:\n/, ''));
  assert.deepEqual(hechos, { tipo: 'Promoción', nombre: 'Descuento miércoles', categoria_negocio: 'Restaurante' });
  assert.ok(!JSON.stringify(f.llamadas[0].body).includes('BOCARA20'));
});

test('TXT-1: datos de contacto escritos en el texto libre se eliminan antes de enviar', () => {
  const s = textoIA.sanear('Pide al 5107-7949 o +502 4444 5555, escribe a hola@ola.gt o visita https://ola.gt <b>ya</b>', 600);
  assert.doesNotMatch(s, /5107|7949|4444|hola@|https|<b>/);
  assert.match(s, /Pide al/);
});

test('TXT-2: la API key viaja solo en el header x-goog-api-key; ningún secreto en URL ni body', async () => {
  const f = montar();
  await pedir(COMPLETO);
  const { url, opciones } = f.llamadas[0];
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_POR_DEFECTO}:generateContent`);
  assert.equal(opciones.method, 'POST');
  assert.equal(opciones.headers['x-goog-api-key'], CLAVE_GEMINI);
  const secretos = [CLAVE_GEMINI, process.env.OPENAI_API_KEY, process.env.SUPABASE_SERVICE_KEY, process.env.JWT_SECRET];
  for (const s of secretos) {
    assert.ok(!url.includes(s), 'secreto en la URL');
    assert.ok(!opciones.body.includes(s), 'secreto en el body');
  }
  assert.doesNotMatch(url, /[?&]key=/);
});

test('TXT-2: los parámetros de generación son acotados (temperatura baja, tokens máximos, 1 candidato)', async () => {
  const f = montar();
  await pedir(BASICO);
  const g = f.llamadas[0].body.generationConfig;
  // Modelo por defecto (familia 3.x): razonamiento mínimo para responder rápido.
  assert.deepEqual(g, { temperature: 0.4, maxOutputTokens: 160, candidateCount: 1, thinkingConfig: { thinkingLevel: 'minimal' } });
  // Un modelo 2.x no acepta thinkingLevel: no se manda.
  const f2 = fetchSimulado();
  await crearProveedorGemini({ apiKey: CLAVE_GEMINI, modelo: 'gemini-2.5-flash', fetchImpl: f2 })
    .generar({ sistema: 's', usuario: 'u', temperatura: 0.4, maxTokens: 160, timeoutMs: 1000 });
  assert.equal(f2.llamadas[0].body.generationConfig.thinkingConfig, undefined);
  const sistema = f.llamadas[0].body.systemInstruction.parts[0].text;
  assert.match(sistema, /Use exclusively the supplied facts\. Never invent ingredients, quantities, brands, flavors, preparation methods or promotional conditions\. If a fact is not supplied, omit it\./);
  assert.match(sistema, /Guatemala/);
  assert.match(sistema, /Sin emojis/);
});

test('TXT-2: el modelo sale de GEMINI_TEXT_MODEL (no hardcodeado)', () => {
  const previo = process.env.GEMINI_TEXT_MODEL;
  process.env.GEMINI_TEXT_MODEL = 'gemini-9.9-flash-lite';
  try {
    assert.equal(crearProveedorGemini({ fetchImpl: fetchSimulado() }).modelo, 'gemini-9.9-flash-lite');
  } finally {
    if (previo === undefined) delete process.env.GEMINI_TEXT_MODEL; else process.env.GEMINI_TEXT_MODEL = previo;
  }
  assert.throws(() => crearProveedorGemini({ modelo: '../../otra-ruta', fetchImpl: fetchSimulado() }), /inválido/);
});

// ── TXT-3 ───────────────────────────────────────────────────────────────────

test('TXT-3: la propuesta vuelve al frontend como { descripcion } y no se guarda nada en BD', async () => {
  const antes = JSON.stringify(fake.tabla('bolsas'));
  const r = await pedir(BASICO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { descripcion: 'Disfruta una hamburguesa acompañada de papas, disponible por tiempo limitado a precio Bocara.' });
  assert.equal(JSON.stringify(fake.tabla('bolsas')), antes);
});

test('TXT-3: la salida se limpia (sin emojis, comillas, markdown ni prefijos)', async () => {
  montar({ fetchImpl: fetchSimulado({ cuerpo: respuestaGemini('Descripción: "**Disfruta** una hamburguesa con papas 🍔 a precio Bocara"') }) });
  const r = await pedir(BASICO);
  assert.equal(r.status, 200);
  assert.equal(r.body.descripcion, 'Disfruta una hamburguesa con papas a precio Bocara.');
});

test('TXT-3: respuesta cortada por MAX_TOKENS se recorta a la última frase completa', () => {
  const t = textoIA.limpiarSalida('Disfruta una hamburguesa acompañada de papas a precio Bocara. Disponible por tiempo lim', { finCorte: true });
  assert.equal(t, 'Disfruta una hamburguesa acompañada de papas a precio Bocara.');
});

// ── TXT-5 / TXT-6 ───────────────────────────────────────────────────────────

test('TXT-5: Gemini responde error → mensaje que dice POR QUÉ (modelo retirado, clave, cuota, error), código estable, nada se guarda', async () => {
  const casos = [
    [404, { status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash-lite is no longer available to new users.' }, 502, 'IA_TEXTO_MODELO_NO_DISPONIBLE', /ya no está disponible/],
    [400, { status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] }, 502, 'IA_TEXTO_CLAVE_INVALIDA', /clave de Gemini/],
    [403, { status: 'PERMISSION_DENIED', message: 'denied' }, 502, 'IA_TEXTO_CLAVE_INVALIDA', /clave de Gemini/],
    [429, { status: 'RESOURCE_EXHAUSTED', message: 'quota' }, 429, 'IA_TEXTO_CUOTA', /cuota de Gemini/],
    [500, { status: 'INTERNAL', message: 'detalle' }, 502, 'IA_TEXTO_PROVEEDOR', /Gemini devolvió un error/],
    [400, { status: 'INVALID_ARGUMENT', message: 'texto del prompt' }, 502, 'IA_TEXTO_PROVEEDOR', /Gemini devolvió un error/],
  ];
  for (const [status, error, http, codigo, re] of casos) {
    montar({ fetchImpl: fetchSimulado({ status, cuerpo: { error: { code: status, ...error } } }) });
    const antes = JSON.stringify(fake.tabla('bolsas'));
    const r = await pedir(BASICO);
    assert.equal(r.status, http, `${status} ${error.status}`);
    assert.equal(r.body.codigo, codigo);
    assert.match(r.body.error, re);
    assert.equal(JSON.stringify(fake.tabla('bolsas')), antes);
  }
  // En desarrollo, el detalle incluye el mensaje de Google (qué modelo y por qué)...
  montar({ fetchImpl: fetchSimulado({ status: 404, cuerpo: { error: { code: 404, status: 'NOT_FOUND', message: 'no longer available to new users' } } }) });
  assert.match((await pedir(BASICO)).body.detalle, /HTTP 404 NOT_FOUND — no longer available/);
  // ...pero un 400 genérico no lo copia (podría repetir el prompt).
  montar({ fetchImpl: fetchSimulado({ status: 400, cuerpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'texto del prompt' } } }) });
  assert.doesNotMatch((await pedir(BASICO)).body.detalle, /texto del prompt/);
  // ...y en producción no se expone el detalle técnico.
  const entornoPrevio = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    montar({ fetchImpl: fetchSimulado({ status: 500, cuerpo: { error: { code: 500, status: 'INTERNAL' } } }) });
    assert.equal((await pedir(BASICO)).body.detalle, undefined);
  } finally { if (entornoPrevio === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = entornoPrevio; }
});

test('TXT-5: bloqueo de seguridad, respuesta vacía o red caída → 502', async () => {
  const casos = [
    { cuerpo: { promptFeedback: { blockReason: 'SAFETY' } } },
    { cuerpo: respuestaGemini('texto', { finishReason: 'SAFETY' }) },
    { cuerpo: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } },
    { cuerpo: {} },
  ];
  for (const c of casos) {
    montar({ fetchImpl: fetchSimulado(c) });
    const r = await pedir(BASICO);
    assert.equal(r.status, 502, JSON.stringify(c.cuerpo));
  }
  montar({ fetchImpl: async () => { const e = new Error('ECONNRESET'); e.code = 'ECONNRESET'; throw e; } });
  assert.equal((await pedir(BASICO)).status, 502);
});

test('TXT-5: proveedor apagado (none / openai sin implementar / sin key) → 503, nunca llama a nadie', async () => {
  const previo = { p: process.env.TEXT_AI_PROVIDER, k: process.env.GEMINI_API_KEY };
  try {
    for (const p of ['none', 'openai', 'desconocido']) assert.equal(textoIA.obtenerProveedorTexto(p), null, p);
    delete process.env.GEMINI_API_KEY;
    assert.equal(textoIA.obtenerProveedorTexto('gemini'), null);
    assert.equal(textoIA.obtenerProveedorTexto(undefined), null);
    process.env.TEXT_AI_PROVIDER = 'gemini';
    routerActual = crearRouterIA({ generar: (d, o) => textoIA.generarDescripcion(d, { ...o, proveedor: null }), limites: crearLimites() });
    const r = await pedir(BASICO);
    assert.equal(r.status, 503);
    assert.equal(r.body.codigo, 'IA_TEXTO_NO_CONFIGURADA');
    assert.match(r.body.detalle, /GEMINI_API_KEY/, 'dice exactamente qué falta');
    assert.deepEqual(r.body.faltan, ['GEMINI_API_KEY']);
  } finally {
    process.env.GEMINI_API_KEY = previo.k;
    if (previo.p === undefined) delete process.env.TEXT_AI_PROVIDER; else process.env.TEXT_AI_PROVIDER = previo.p;
  }
  assert.equal(textoIA.obtenerProveedorTexto('gemini').nombre, 'gemini');
});

test('TXT-6: timeout del proveedor → aborta la petición y lanza ErrorTextoIA(timeout)', async () => {
  const f = fetchSimulado({ colgar: true });
  const proveedor = crearProveedorGemini({ apiKey: CLAVE_GEMINI, fetchImpl: f });
  const inicio = Date.now();
  await assert.rejects(
    proveedor.generar({ sistema: 's', usuario: 'u', temperatura: 0.4, maxTokens: 50, timeoutMs: 60 }),
    (e) => e.name === 'ErrorTextoIA' && e.codigo === 'timeout',
  );
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(f.llamadas[0].opciones.signal.aborted, true);
});

test('TXT-6: timeout por HTTP → 504 que dice que Gemini tardó, y nada se guarda', async () => {
  const f = fetchSimulado({ colgar: true });
  const proveedor = crearProveedorGemini({ apiKey: CLAVE_GEMINI, fetchImpl: f });
  montar({ generar: (d, o) => textoIA.generarDescripcion(d, { ...o, proveedor, config: { timeoutMs: 60, maxTokens: 160, temperatura: 0.4 } }) });
  const r = await pedir(BASICO);
  assert.equal(r.status, 504);
  assert.equal(r.body.codigo, 'IA_TEXTO_TIMEOUT');
  assert.match(r.body.error, /tardó demasiado/);
});

test('TXT-6: el timeout configurado está acotado (2–30 s, 20 s por defecto)', () => {
  const previo = process.env.TEXT_AI_TIMEOUT_MS;
  try {
    delete process.env.TEXT_AI_TIMEOUT_MS; assert.equal(textoIA.configuracion().timeoutMs, 20000);
    process.env.TEXT_AI_TIMEOUT_MS = '999999'; assert.equal(textoIA.configuracion().timeoutMs, 30000);
    process.env.TEXT_AI_TIMEOUT_MS = '1'; assert.equal(textoIA.configuracion().timeoutMs, 2000);
  } finally {
    if (previo === undefined) delete process.env.TEXT_AI_TIMEOUT_MS; else process.env.TEXT_AI_TIMEOUT_MS = previo;
  }
});

// ── TXT-7 ───────────────────────────────────────────────────────────────────

test('TXT-7: rate limit por minuto y usuario → 429 con Retry-After; otro restaurante no se ve afectado', async () => {
  const f = montar({ limites: crearLimites({ porMinuto: 3, porDia: 100, globalPorDia: 1000 }) });
  for (let i = 0; i < 3; i++) assert.equal((await pedir(BASICO)).status, 200);
  const r = await pedir(BASICO);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal(f.llamadas.length, 3, 'la 4ª no llega a Gemini');
  assert.equal((await pedir(BASICO, { como: IDS.otroRestaurante })).status, 200);
});

test('TXT-7: la ventana por minuto se libera al pasar el minuto', () => {
  let t = 0;
  const l = crearLimites({ porMinuto: 2, porDia: 100, globalPorDia: 100, ahora: () => t });
  assert.ok(l.permitirIntento('u').ok); assert.ok(l.permitirIntento('u').ok);
  assert.equal(l.permitirIntento('u').ok, false);
  t = 60 * 1000 + 1;
  assert.ok(l.permitirIntento('u').ok);
});

test('TXT-7: límite diario por usuario y global; se reinicia al cambiar el día de Guatemala', async () => {
  let dia = '2026-10-14';
  const l = crearLimites({ porMinuto: 100, porDia: 2, globalPorDia: 3, dia: () => dia });
  const f = montar({ limites: l });
  assert.equal((await pedir(BASICO)).status, 200);
  assert.equal((await pedir(BASICO)).status, 200);
  const r = await pedir(BASICO);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /límite diario/);
  assert.equal((await pedir(BASICO, { como: IDS.otroRestaurante })).status, 200);
  assert.equal((await pedir(BASICO, { como: IDS.otroRestaurante })).status, 429, 'tope global (3)');
  assert.equal(f.llamadas.length, 3);
  dia = '2026-10-15';
  assert.equal((await pedir(BASICO)).status, 200);
});

test('TXT-7: una petición inválida no consume el cupo diario', async () => {
  const l = crearLimites({ porMinuto: 100, porDia: 1, globalPorDia: 10 });
  montar({ limites: l });
  assert.equal((await pedir({ tipo: 'bolsa', nombre: '' })).status, 400);
  assert.equal((await pedir(BASICO)).status, 200);
});

// ── TXT-8 ───────────────────────────────────────────────────────────────────

test('TXT-8: sin token → 401; token inválido → 401; cliente o admin → 403; Gemini nunca se llama', async () => {
  const f = montar();
  assert.equal((await pedir(BASICO, { como: null })).status, 401);
  const r = await fetchOriginal(`${base}/api/ia/descripcion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer basura' }, body: JSON.stringify(BASICO),
  });
  assert.equal(r.status, 401);
  assert.equal((await pedir(BASICO, { como: IDS.cliente, rol: 'cliente' })).status, 403);
  assert.equal((await pedir(BASICO, { como: IDS.admin, rol: 'admin' })).status, 403);
  // JWT que dice "restaurante" para un usuario que en BD es cliente → 403.
  assert.equal((await pedir(BASICO, { como: IDS.cliente, rol: 'restaurante' })).status, 403);
  assert.equal(f.llamadas.length, 0);
});

// ── TXT-9 ───────────────────────────────────────────────────────────────────

test('TXT-9: nombre obligatorio (mín. 2) y límites de longitud → 400 sin llamar a Gemini', async () => {
  const f = montar();
  const casos = [
    [{ tipo: 'bolsa' }, /nombre del producto/],
    [{ tipo: 'bolsa', nombre: ' a ' }, /nombre del producto/],
    [{ tipo: 'bolsa', nombre: 'x'.repeat(121) }, /nombre admite máximo 120/],
    [{ ...BASICO, descripcion: 'x'.repeat(601) }, /descripcion admite máximo 600/],
    [{ ...BASICO, contenido: 'x'.repeat(401) }, /contenido admite máximo 400/],
    [{ nombre: 'Pan' }, /tipo debe ser/],
    [{ ...BASICO, tipo: 'otro' }, /tipo debe ser/],
    [{ ...BASICO, nombre: { $gt: '' } }, /nombre debe ser texto/],
    [{ ...BASICO, precio_original: -5 }, /precios/],
    [{ ...BASICO, precio_descuento: 'gratis' }, /precios/],
    [{ ...BASICO, categoria_alimento: 'veneno' }, /categoria_alimento/],
    [{ ...BASICO, hora_recogida_inicio: '25:00' }, /HH:MM/],
    [{ ...BASICO, fecha_disponible: 'mañana' }, /AAAA-MM-DD/],
  ];
  for (const [body, re] of casos) {
    const r = await pedir(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.body.error, re);
  }
  assert.equal(f.llamadas.length, 0);
});

test('TXT-9: body mayor a 8 KB → 413; JSON inválido → 400 (el límite global de 15 MB no aplica)', async () => {
  const f = montar();
  const grande = await pedir(null, { crudo: JSON.stringify({ ...BASICO, relleno: 'x'.repeat(9000) }) });
  assert.equal(grande.status, 413);
  const roto = await pedir(null, { crudo: '{"tipo":' });
  assert.equal(roto.status, 400);
  assert.equal(f.llamadas.length, 0);
});

// ── TXT-10 / TXT-11 ─────────────────────────────────────────────────────────

test('TXT-10: ninguna prueba usó la red real (fetch global intacto)', () => {
  assert.equal(llamadasFetchGlobal, 0);
});

test('TXT-11: si la IA inventa un precio, porcentaje o cantidad, la propuesta se descarta (502)', async () => {
  const inventadas = [
    'Disfruta una hamburguesa con papas por solo Q25 a precio Bocara.',
    'Hamburguesa con papas con 50% de descuento por tiempo limitado.',
    'Disfruta 2 hamburguesas con papas a precio Bocara.',
  ];
  for (const texto of inventadas) {
    montar({ fetchImpl: fetchSimulado({ cuerpo: respuestaGemini(texto) }) });
    const r = await pedir(COMPLETO);
    assert.equal(r.status, 502, texto);
  }
});

test('TXT-11: cifras que sí vienen en los datos (precio, %, horario, fecha) se aceptan', async () => {
  const texto = 'Disfruta una hamburguesa con papas a Q35.00 en lugar de Q60, un 42% menos. Recógela de 6 a 8 p. m., del 14 al 15 de octubre.';
  montar({ fetchImpl: fetchSimulado({ cuerpo: respuestaGemini(texto) }) });
  const r = await pedir(COMPLETO);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.descripcion, texto);
});

// ── TXT-12 ──────────────────────────────────────────────────────────────────

test('TXT-12: modelo principal saturado (503 / 404 / timeout) → reintenta UNA vez con el modelo de respaldo y responde', async () => {
  const ok = respuestaGemini('Disfruta una hamburguesa acompañada de papas, disponible por tiempo limitado a precio Bocara.');
  for (const fallo of [{ status: 503, cuerpo: { error: { code: 503, status: 'UNAVAILABLE' } } }, { status: 404, cuerpo: { error: { code: 404, status: 'NOT_FOUND' } } }, { colgar: true }]) {
    const llamadas = [];
    const fetchImpl = async (url, opciones) => {
      llamadas.push(url);
      if (url.includes('/models/principal:')) {
        if (fallo.colgar) return new Promise((_, rej) => opciones.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
        return { ok: false, status: fallo.status, json: async () => fallo.cuerpo };
      }
      return { ok: true, status: 200, json: async () => ok };
    };
    const proveedor = crearProveedorGemini({ apiKey: CLAVE_GEMINI, modelo: 'principal', respaldo: 'respaldo', fetchImpl });
    const r = await silenciarConsola(() => proveedor.generar({ sistema: 's', usuario: 'u', temperatura: 0.4, maxTokens: 160, timeoutMs: 6000 }));
    assert.equal(r.modelo, 'respaldo', JSON.stringify(fallo));
    assert.equal(llamadas.length, 2);
  }
});

test('TXT-12: clave inválida o salida bloqueada NO usan el respaldo; GEMINI_TEXT_MODEL_FALLBACK=none lo apaga', async () => {
  const f = fetchSimulado({ status: 400, cuerpo: { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } });
  const p = crearProveedorGemini({ apiKey: CLAVE_GEMINI, modelo: 'principal', respaldo: 'respaldo', fetchImpl: f });
  await assert.rejects(p.generar({ sistema: 's', usuario: 'u', temperatura: 0.4, maxTokens: 160, timeoutMs: 5000 }), (e) => e.motivo === 'clave_invalida');
  assert.equal(f.llamadas.length, 1);
  const f2 = fetchSimulado({ status: 503, cuerpo: { error: { code: 503, status: 'UNAVAILABLE' } } });
  const sin = crearProveedorGemini({ apiKey: CLAVE_GEMINI, modelo: 'principal', respaldo: 'none', fetchImpl: f2 });
  assert.equal(sin.respaldo, null);
  await assert.rejects(sin.generar({ sistema: 's', usuario: 'u', temperatura: 0.4, maxTokens: 160, timeoutMs: 5000 }));
  assert.equal(f2.llamadas.length, 1);
});

function silenciarConsola(fn) {
  const { warn } = console;
  console.warn = () => {};
  return Promise.resolve().then(fn).finally(() => { console.warn = warn; });
}
