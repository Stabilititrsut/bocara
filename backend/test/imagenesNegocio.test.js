// IA de imágenes para la foto de PERFIL y la PORTADA del restaurante.
// Reutiliza el pipeline de trabajos de las publicaciones (trabajos.js) con
// uso 'perfil' / 'portada'. Sin red: OpenAI (mejora y revisión) se simulan;
// las imágenes son sintéticas y se miden con sharp de verdad.
//
//   NCAL-*  calidad mínima de perfil (cuadrada, admite fondo blanco) y portada (horizontal)
//   NPRO-*  prompt y lienzo: no inventar logos/texto/comida, formato avatar y banner
//   NREV-*  revisión con visión según el uso (logo con letras es válido; marca alterada = infiel)
//   NFLU-*  flujo subida → analizando → mejorando → validando → lista | rechazada | fallida
//   NAPI-*  /api/imagenes/trabajos con uso y PUT /api/negocios/:id/imagen (el backend valida)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
const { fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala, trabajoListo } = require('./helpers/appPublicaciones');
const { crearFakeSupabase } = require('./helpers/fakeSupabase');
const { escena, PLATO } = require('./helpers/escenaComida');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');
const { analizarCalidad } = require('../services/imagenes/calidad');
const { promptMejora, PROMPT_PERFIL, PROMPT_PORTADA, PROMPT_COMERCIAL } = require('../services/imagenes/prompts');
const { prepararLienzo, crearProveedorOpenAI, TAMANO_FIJO } = require('../services/imagenes/proveedorOpenAI');
const { crearRevisorIA, PROBLEMAS, INFIDELIDAD, irreparablesDe } = require('../services/imagenes/revisionIA');
const trabajos = require('../services/imagenes/trabajos');

const HOST = 'proyecto.supabase.co';
const hosts = new Set([HOST]);
const STORAGE = `https://${HOST}/storage/v1/object/public/bocara-images`;
const urlPerfil = (negocio = IDS.olaAzul, n = 1) => `${STORAGE}/negocios/${negocio}/perfil_${n}.jpg`;
const urlPortada = (negocio = IDS.olaAzul, n = 1) => `${STORAGE}/negocios/${negocio}/portada_${n}.jpg`;
const urlPublicacion = (negocio = IDS.olaAzul, n = 1) => `${STORAGE}/bolsas/${negocio}_${n}.jpg`;

function silenciar(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  return Promise.resolve().then(fn).finally(() => Object.assign(console, { log, warn, error }));
}

// "Logo" sintético: fondo blanco liso con formas de color nítidas (como un
// logo real), un poco de ruido de cámara para que no sea un vector perfecto.
async function logo({ lado = 800, ancho = lado, alto = lado } = {}) {
  const raw = Buffer.alloc(ancho * alto * 3);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const formas = [
    { x: ancho * 0.5, y: alto * 0.42, r: Math.min(ancho, alto) * 0.28, c: [200, 40, 40] },
    { x: ancho * 0.5, y: alto * 0.42, r: Math.min(ancho, alto) * 0.16, c: [250, 200, 60] },
    { x: ancho * 0.36, y: alto * 0.8, r: Math.min(ancho, alto) * 0.06, c: [30, 30, 30] },
    { x: ancho * 0.64, y: alto * 0.8, r: Math.min(ancho, alto) * 0.06, c: [30, 30, 30] },
  ];
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 3;
      const n = (rnd() - 0.5) * 10;
      let c = [252, 252, 250];
      for (const f of formas) { const dx = x - f.x, dy = y - f.y; if (dx * dx + dy * dy < f.r * f.r) c = f.c; }
      // Franja de "letras": barras verticales finas (bordes duros como texto).
      if (y > alto * 0.62 && y < alto * 0.7 && x > ancho * 0.2 && x < ancho * 0.8 && Math.floor(x / 9) % 2 === 0) c = [30, 30, 30];
      raw[i] = Math.max(0, Math.min(255, c[0] + n)); raw[i + 1] = Math.max(0, Math.min(255, c[1] + n)); raw[i + 2] = Math.max(0, Math.min(255, c[2] + n));
    }
  }
  return sharp(raw, { raw: { width: ancho, height: alto, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

const img = {};
test.before(async () => {
  // Foto del local con contraste de cámara (la escena base es muy plana para portada).
  const local = await sharp(await escena(PLATO, { ancho: 1500, alto: 1000 })).linear(1.35, -45).jpeg().toBuffer();
  Object.assign(img, {
    logo: await logo(),
    logoAncho: await logo({ ancho: 1200, alto: 500 }),
    logoBorroso: await sharp(await logo()).blur(6).jpeg().toBuffer(),
    logoDiminuto: await sharp(await logo()).resize(300).jpeg().toBuffer(),
    local,
    localVertical: await escena(PLATO, { ancho: 700, alto: 1000 }),
    localOscuro: await sharp(local).modulate({ brightness: 0.45 }).jpeg().toBuffer(),
  });
});

const codigos = (r) => r.motivos.map((m) => m.codigo);

// ── NCAL ────────────────────────────────────────────────────────────────────

test('NCAL-1: perfil — un logo cuadrado sobre fondo blanco cumple (no es "quemada"); uno alargado → no_cuadrada; uno diminuto → resolucion', async () => {
  const ok = await analizarCalidad(img.logo, { nivel: 'perfil' });
  assert.equal(ok.ok, true, JSON.stringify({ m: ok.metricas, motivos: ok.motivos }));
  assert.equal((await analizarCalidad(img.logo, { nivel: 'publicable' })).ok, false, 'como foto de comida sí fallaría (fondo blanco)');
  assert.ok(codigos(await analizarCalidad(img.logoAncho, { nivel: 'perfil' })).includes('no_cuadrada'));
  assert.ok(codigos(await analizarCalidad(img.logoDiminuto, { nivel: 'perfil' })).includes('resolucion'));
});

test('NCAL-2: portada — horizontal 3:2 cumple; vertical → no_horizontal; oscura → oscura', async () => {
  const ok = await analizarCalidad(img.local, { nivel: 'portada' });
  assert.equal(ok.ok, true, JSON.stringify(ok.metricas));
  assert.ok(codigos(await analizarCalidad(img.localVertical, { nivel: 'portada' })).includes('no_horizontal'));
  assert.ok(codigos(await analizarCalidad(img.logo, { nivel: 'portada' })).includes('no_horizontal'), 'cuadrada tampoco es portada');
  assert.ok(codigos(await analizarCalidad(img.localOscuro, { nivel: 'portada' })).includes('oscura'));
  for (const m of [...(await analizarCalidad(img.localVertical, { nivel: 'portada' })).motivos, ...(await analizarCalidad(img.logoAncho, { nivel: 'perfil' })).motivos]) {
    assert.ok(m.mensaje.length > 20, m.codigo);
  }
});

// ── NPRO ────────────────────────────────────────────────────────────────────

test('NPRO-1: prompts de perfil y portada preservan la identidad y prohíben inventar logos, texto, comida o marca', () => {
  for (const [encuadre, base] of [['perfil', PROMPT_PERFIL], ['portada', PROMPT_PORTADA]]) {
    const p = promptMejora({ encuadre, problemas: ['borrosa', 'no_horizontal', 'no_cuadrada'] });
    assert.ok(p.startsWith(base), encuadre);
    assert.match(p, /Keep its identity exactly/);
    assert.match(p, /Never invent or add logos, text, signs, food/);
    assert.match(p, /Do not redraw, restyle, retype/);
    assert.doesNotMatch(p, /dish or product taken by a restaurant/, 'no usa el prompt de comida');
    assert.match(p, /without inventing new details or changing any letter/, 'corrección genérica (no de comida)');
  }
  assert.match(PROMPT_PERFIL, /square profile picture shown inside a circle/);
  assert.match(PROMPT_PORTADA, /wide horizontal cover banner/);
  // IMAGE_AI_PROMPT (A/B de comida) nunca reemplaza el de perfil/portada.
  process.env.IMAGE_AI_PROMPT = 'prompt de prueba';
  try {
    assert.equal(promptMejora({ encuadre: 'comercial' }), 'prompt de prueba');
    assert.ok(promptMejora({ encuadre: 'perfil' }).startsWith(PROMPT_PERFIL));
  } finally { delete process.env.IMAGE_AI_PROMPT; }
  assert.ok(promptMejora({ encuadre: 'comercial' }).startsWith(PROMPT_COMERCIAL), 'publicaciones sin cambios');
});

function clienteImagenes(salida) {
  const llamadas = [];
  return {
    llamadas,
    images: {
      edit: async (params) => {
        llamadas.push(params);
        const [ancho, alto] = params.size.split('x').map(Number);
        const b64 = (await sharp(salida).resize(ancho, alto, { fit: 'fill' }).png().toBuffer()).toString('base64');
        return { data: [{ b64_json: b64 }], usage: null };
      },
    },
  };
}

test('NPRO-2: OpenAI — perfil sale cuadrado 1024×1024 y portada horizontal 1536×1024, lienzo completo con la región de la original', async () => {
  const perfil = clienteImagenes(img.logo);
  const r1 = await silenciar(() => crearProveedorOpenAI({ cliente: perfil }).mejorar({ buffer: img.logoAncho, contexto: { encuadre: 'perfil', problemas: ['no_cuadrada'] } }));
  assert.equal(perfil.llamadas[0].size, '1024x1024', 'un logo alargado igual va a lienzo cuadrado');
  assert.ok(perfil.llamadas[0].prompt.startsWith(PROMPT_PERFIL));
  assert.deepEqual([r1.meta.ancho, r1.meta.alto, r1.meta.encuadre], [1024, 1024, 'perfil']);
  assert.ok(r1.meta.region && r1.meta.region.width === 1 && r1.meta.region.height < 1, 'el logo completo, centrado, con relleno arriba/abajo');

  const portada = clienteImagenes(img.local);
  const r2 = await silenciar(() => crearProveedorOpenAI({ cliente: portada }).mejorar({ buffer: img.localVertical, contexto: { encuadre: 'portada' } }));
  assert.equal(portada.llamadas[0].size, '1536x1024', 'una foto vertical igual va a banner horizontal');
  assert.ok(portada.llamadas[0].prompt.startsWith(PROMPT_PORTADA));
  assert.deepEqual([r2.meta.ancho, r2.meta.alto, r2.meta.encuadre], [1536, 1024, 'portada']);
  assert.ok(r2.meta.region.height === 1 && r2.meta.region.width < 1);

  const lienzo = await prepararLienzo(img.logoAncho, { tamano: TAMANO_FIJO.perfil });
  assert.equal(lienzo.tamano.size, '1024x1024');
});

// ── NREV ────────────────────────────────────────────────────────────────────

function openaiFalso(respuesta) {
  const llamadas = [];
  return {
    llamadas,
    responses: { create: async (params) => { llamadas.push(params); return { output_text: JSON.stringify(respuesta) }; } },
  };
}

test('NREV-1: uso perfil/portada — instrucciones propias (un logo con letras es válido); irreparable = no relacionada, captura o irreconocible; "no_es_comida" no aplica', async () => {
  for (const uso of ['perfil', 'portada']) {
    const c = openaiFalso({ apta: true, problemas: ['borrosa'], resumen: 'logo algo borroso' });
    const r = await silenciar(() => crearRevisorIA({ cliente: c }).revisar(img.logo, { uso }));
    assert.match(c.llamadas[0].instructions, /Un logo, un nombre o un letrero del negocio son válidos/);
    assert.match(c.llamadas[0].instructions, uso === 'perfil' ? /FOTO DE PERFIL/ : /PORTADA/);
    assert.equal(r.apta, true);
    for (const codigo of ['no_relacionada', 'captura_pantalla', 'irreconocible']) {
      const r2 = await silenciar(() => crearRevisorIA({ cliente: openaiFalso({ apta: false, problemas: [codigo], resumen: 'x' }) }).revisar(img.logo, { uso }));
      assert.equal(r2.irreparable, true, `${uso}/${codigo}`);
    }
    const comida = await silenciar(() => crearRevisorIA({ cliente: openaiFalso({ apta: false, problemas: ['no_es_comida'], resumen: 'es un logo' }) }).revisar(img.logo, { uso }));
    assert.equal(comida.irreparable, false, 'un logo no es comida y está bien');
  }
  // Publicaciones: sin cambios.
  const pub = openaiFalso({ apta: true, problemas: [], resumen: 'ok' });
  await crearRevisorIA({ cliente: pub }).revisar(img.local);
  assert.match(pub.llamadas[0].instructions, /marketplace de comida/);
  assert.doesNotMatch(pub.llamadas[0].instructions, /FOTO DE PERFIL/);
});

test('NREV-2: resultado de perfil/portada — marca o texto alterado, o elemento inventado → infiel (nunca se publica)', async () => {
  for (const codigo of ['marca_alterada', 'elemento_inventado']) {
    const c = openaiFalso({ apta: false, problemas: [codigo], resumen: 'cambió el logo' });
    const r = await silenciar(() => crearRevisorIA({ cliente: c }).revisar(img.logo, { modo: 'resultado', original: img.logo, uso: 'perfil' }));
    assert.equal(r.infiel, true, codigo);
    assert.match(c.llamadas[0].instructions, /marca_alterada si cambió, redibujó, borró o deformó el logo/);
    assert.equal(c.llamadas[0].input[0].content.filter((x) => x.type === 'input_image').length, 2);
  }
});

// ── NFLU ────────────────────────────────────────────────────────────────────

// Mejora "realista": mismo lienzo fijo que OpenAI, retoque de luz/contraste y
// el lienzo completo con meta.region.
function proveedorRealista(llamadas, { cambia = null } = {}) {
  return {
    nombre: 'openai', ia: true, modelo: 'gpt-image-1-mini', necesitaUrl: false, encuadres: new Set(['comercial', 'perfil', 'portada']),
    mejorar: async ({ buffer, contexto }) => {
      llamadas.proveedor += 1; llamadas.contextos.push(contexto);
      const { lienzo, tamano, rect } = await prepararLienzo(buffer, { tamano: TAMANO_FIJO[contexto.encuadre] });
      const salida = await sharp(cambia || lienzo).resize(tamano.ancho, tamano.alto, { fit: 'fill' })
        .modulate({ saturation: 1.08 }).linear(1.12, -14).sharpen().webp({ quality: 92 }).toBuffer();
      return {
        buffer: salida, contentType: 'image/webp',
        meta: { region: { left: rect.left / tamano.ancho, top: rect.top / tamano.alto, width: rect.width / tamano.ancho, height: rect.height / tamano.alto } },
      };
    },
  };
}

function entorno({ uso = 'perfil', foto = 'logo', revision = { problemas: [] }, revisionFinal = { problemas: [] }, proveedor, cambia } = {}) {
  const url = uso === 'perfil' ? urlPerfil() : urlPortada();
  const cliente = crearFakeSupabase({
    trabajos_imagen: [{ id: 't1', usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul, original_url: url, estado: 'subida', intentos: 0, updated_at: new Date().toISOString() }],
  });
  const estados = [];
  const desde = cliente.from.bind(cliente);
  cliente.from = (tabla) => {
    const q = desde(tabla);
    const update = q.update.bind(q);
    q.update = (cambios) => { if (tabla === 'trabajos_imagen' && cambios.estado) estados.push(cambios.estado); return update(cambios); };
    return q;
  };
  const llamadas = { proveedor: 0, contextos: [], usosRevision: [], subidas: [] };
  // Misma semántica que el revisor real (NREV-* lo prueba contra la API simulada).
  const revisor = {
    modelo: 'gpt-6-luna',
    revisar: async (_buffer, { modo = 'original', uso: u = 'publicacion' } = {}) => {
      llamadas.usosRevision.push(`${u}/${modo}`);
      const problemas = (modo === 'resultado' ? revisionFinal : revision).problemas.filter((c) => modo !== 'resultado' || c !== 'recortada');
      const irreparable = problemas.some((c) => irreparablesDe(u).has(c));
      return {
        resumen: 'x', apta: modo === 'original' ? !irreparable : problemas.length === 0,
        irreparable, infiel: problemas.some((c) => INFIDELIDAD.has(c)),
        problemas: problemas.map((c) => ({ codigo: c, mensaje: PROBLEMAS[c] })),
      };
    },
  };
  const opts = {
    cliente, hosts, dormir: async () => {},
    deps: { proveedor: proveedor || proveedorRealista(llamadas, { cambia }), revisor },
    descargar: async () => ({ buffer: img[foto], contentType: 'image/jpeg' }),
    almacenamiento: { subir: async (ruta) => { llamadas.subidas.push(ruta); return `${STORAGE}/${ruta}`; } },
  };
  return { opts, estados, llamadas, fila: () => cliente.tabla('trabajos_imagen')[0], url };
}
const procesar = (env) => silenciar(() => trabajos.procesarTrabajo('t1', env.opts));

test('NFLU-1: perfil — subida → analizando → mejorando → validando → lista; avatar cuadrado ≥ 1024, revisión con uso perfil, original intacta', async () => {
  const env = entorno({ uso: 'perfil', foto: 'logoAncho' });
  assert.equal(await procesar(env), 'lista', JSON.stringify(env.fila()));
  assert.deepEqual(env.estados, ['analizando', 'mejorando', 'validando', 'lista']);
  assert.equal(env.llamadas.contextos[0].encuadre, 'perfil');
  assert.equal(env.llamadas.contextos[0].uso, 'perfil');
  assert.deepEqual(env.llamadas.usosRevision, ['perfil/original', 'perfil/resultado']);
  const t = env.fila();
  assert.equal(t.original_url, env.url, 'la original no se toca');
  assert.match(t.mejorada_url, /\/mejoradas\/trabajos\/t1\/\d+\.webp$/, 'la mejorada es un archivo nuevo');
  assert.notEqual(t.mejorada_url, t.original_url);
  assert.deepEqual([t.calidad_resultado.ancho, t.calidad_resultado.alto], [1024, 1024]);
  const s = trabajos.serializar(t);
  assert.equal(s.uso, 'perfil');
  assert.equal(s.mejorada_url, t.mejorada_url);
});

test('NFLU-2: portada — una foto vertical sale como banner horizontal 1536×1024 y queda lista', async () => {
  const env = entorno({ uso: 'portada', foto: 'localVertical' });
  assert.equal(await procesar(env), 'lista', JSON.stringify(env.fila()));
  assert.equal(env.llamadas.contextos[0].encuadre, 'portada');
  assert.ok(env.llamadas.contextos[0].problemas.includes('no_horizontal'), 'la IA recibe que debe extender a los lados');
  assert.equal(env.fila().calidad_original.original_aceptable, false, 'una vertical no sirve como portada sin IA');
  assert.deepEqual([env.fila().calidad_resultado.ancho, env.fila().calidad_resultado.alto], [1536, 1024]);
  assert.equal(trabajos.serializar(env.fila()).uso, 'portada');
});

test('NFLU-3: proveedor sin soporte de perfil/portada (p. ej. Replicate) → fallida con motivo claro, sin gastar IA', async () => {
  const llamadas = { proveedor: 0 };
  const replicate = { nombre: 'replicate', ia: true, modelo: 'flux', mejorar: async () => { llamadas.proveedor += 1; } };
  const env = entorno({ uso: 'perfil', proveedor: replicate });
  assert.equal(await procesar(env), 'fallida');
  const s = trabajos.serializar(env.fila());
  assert.equal(s.error_codigo, 'proveedor_no_soporta');
  assert.match(s.error, /no admite fotos de perfil ni portada/);
  assert.equal(llamadas.proveedor, 0);
});

test('NFLU-4: la IA alteró la marca → fallida "fidelidad"; "usar original" solo si la original cumple la calidad mínima', async () => {
  const buena = entorno({ uso: 'perfil', foto: 'logo', revisionFinal: { problemas: ['marca_alterada'] } });
  // La original del logo ya cumplía todo: el fallback automático la deja lista con la original.
  assert.equal(await procesar(buena), 'lista');
  assert.equal(trabajos.serializar(buena.fila()).usa_original, true);

  const conProblemas = entorno({ uso: 'perfil', foto: 'logo', revision: { problemas: ['desordenada'] }, revisionFinal: { problemas: ['marca_alterada'] } });
  assert.equal(await procesar(conProblemas), 'fallida');
  const s = trabajos.serializar(conProblemas.fila());
  assert.equal(s.error_codigo, 'fidelidad');
  assert.equal(s.puede_reintentar, true);
  assert.equal(s.puede_usar_original, true, 'la original cumple el mínimo de perfil: se puede usar');

  const borrosa = entorno({ uso: 'perfil', foto: 'logoBorroso', revision: { problemas: ['borrosa'] }, revisionFinal: { problemas: ['marca_alterada'] } });
  assert.equal(await procesar(borrosa), 'fallida');
  assert.equal(trabajos.serializar(borrosa.fila()).puede_usar_original, false, 'una original borrosa no se puede usar sin IA');
});

test('NFLU-5: captura de pantalla o imagen no relacionada → rechazada antes de IA; no se puede usar la original', async () => {
  for (const codigo of ['captura_pantalla', 'no_relacionada']) {
    const env = entorno({ uso: 'portada', foto: 'local', revision: { problemas: [codigo] } });
    assert.equal(await procesar(env), 'rechazada', codigo);
    assert.equal(env.llamadas.proveedor, 0, 'no se gasta la IA de edición');
    const s = trabajos.serializar(env.fila());
    assert.deepEqual(s.motivos.map((m) => m.codigo), [codigo]);
    assert.equal(s.paso_error, 'analizando');
    assert.equal(s.puede_usar_original, false);
  }
});

test('NFLU-6: el uso sale de la ruta en Storage; las publicaciones siguen igual', () => {
  assert.equal(trabajos.usoDeUrl(urlPerfil()), 'perfil');
  assert.equal(trabajos.usoDeUrl(urlPortada()), 'portada');
  assert.equal(trabajos.usoDeUrl(urlPublicacion()), 'publicacion');
  assert.equal(trabajos.usoDeUrl(`${STORAGE}/negocios/${IDS.olaAzul}/imagen_1.jpg`), 'publicacion', 'legado: no es perfil ni portada');
  assert.equal(trabajos.usoDeUrl('no es url'), 'publicacion');
});

// ── NAPI ────────────────────────────────────────────────────────────────────

let servidor, base;
test.before(async () => {
  await iniciar();
  const app = express();
  app.use(express.json());
  app.use('/api/imagenes', require('../routes/imagenes'));
  await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(async () => { await detener(); await new Promise((r) => servidor.close(r)); });
test.beforeEach(() => fake.reiniciar(datosBase()));

async function apiImagenes(metodo, ruta, { como = IDS.restaurante, body } = {}) {
  const usuario = Object.entries(IDS).find(([, v]) => v === como)?.[0];
  const rol = { admin: 'admin', cliente: 'cliente' }[usuario] || 'restaurante';
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: como, rol }, process.env.JWT_SECRET)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const guardar = (body, como = IDS.restaurante, id = IDS.olaAzul) => silenciar(() => pedir('PUT', `/api/negocios/${id}/imagen`, { como, body }));
const negocio = () => fake.tabla('negocios').find((n) => n.id === IDS.olaAzul);
const sembrar = (estado, url, extra = {}) => {
  const t = { id: `t-${estado}-${Math.random().toString(16).slice(2)}`, estado, usuario_id: IDS.restaurante, negocio_id: IDS.olaAzul, original_url: url, ...extra };
  fake.tabla('trabajos_imagen').push(t);
  return t.id;
};

test('NAPI-1: crear trabajo con uso perfil/portada exige su carpeta del negocio', async () => {
  const sinIA = { k: process.env.OPENAI_API_KEY, p: process.env.IMAGE_AI_PROVIDER };
  delete process.env.OPENAI_API_KEY; process.env.IMAGE_AI_PROVIDER = 'openai';
  try {
    const p = await silenciar(() => apiImagenes('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlPerfil(), uso: 'perfil' } }));
    assert.equal(p.status, 202, JSON.stringify(p.body));
    assert.equal(p.body.trabajo.uso, 'perfil');
    assert.equal(p.body.trabajo.estado, 'subida');
    const q = await silenciar(() => apiImagenes('POST', '/api/imagenes/trabajos', { body: { imagen_url: urlPortada(), uso: 'portada' } }));
    assert.equal(q.status, 202);
    assert.equal(q.body.trabajo.uso, 'portada');
    await silenciar(trabajos.esperarTrabajosEnCurso);
  } finally {
    if (sinIA.k === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = sinIA.k;
    if (sinIA.p === undefined) delete process.env.IMAGE_AI_PROVIDER; else process.env.IMAGE_AI_PROVIDER = sinIA.p;
  }
  const casos = [
    [{ imagen_url: urlPublicacion(), uso: 'perfil' }, 'foto de publicación como perfil'],
    [{ imagen_url: urlPerfil(), uso: 'portada' }, 'perfil como portada'],
    [{ imagen_url: urlPerfil(), uso: 'publicacion' }, 'perfil como publicación'],
    [{ imagen_url: urlPerfil(IDS.otroNegocio), uso: 'perfil' }, 'carpeta de otro negocio'],
    [{ imagen_url: urlPerfil(), uso: 'banner' }, 'uso inválido'],
  ];
  for (const [body, caso] of casos) {
    assert.equal((await apiImagenes('POST', '/api/imagenes/trabajos', { body })).status, 400, caso);
  }
});

test('NAPI-2: guardar perfil con trabajo lista → logo_url = mejorada; la original sigue en el trabajo y en Storage', async () => {
  const id = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: `${STORAGE}/mejoradas/trabajos/x/1.webp`, original: urlPerfil() });
  const r = await guardar({ tipo: 'perfil', imagen_trabajo_id: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(negocio().logo_url, `${STORAGE}/mejoradas/trabajos/x/1.webp`);
  assert.equal(negocio().imagen_url, undefined, 'la portada no se toca');
  assert.equal(fake.tabla('trabajos_imagen').find((t) => t.id === id).original_url, urlPerfil());
});

test('NAPI-3: guardar portada → imagen_url = mejorada, original y estado guardados (compatibles con el pipeline)', async () => {
  const id = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: `${STORAGE}/mejoradas/trabajos/y/1.webp`, original: urlPortada() });
  const r = await guardar({ tipo: 'portada', imagen_trabajo_id: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = negocio();
  assert.equal(n.imagen_url, `${STORAGE}/mejoradas/trabajos/y/1.webp`);
  assert.equal(n.imagen_original_url, urlPortada());
  assert.equal(n.imagen_mejorada_url, `${STORAGE}/mejoradas/trabajos/y/1.webp`);
  assert.equal(n.estado_procesamiento_imagen, 'completada');
  assert.equal(n.imagen_procesamiento_meta.uso, 'portada');
  assert.equal(n.logo_url, undefined, 'el perfil no se toca');
});

test('NAPI-4: el backend bloquea guardar mientras procesa, rechazada, fallida, sin trabajo o con el trabajo de otro uso', async () => {
  const casos = [
    ['analizando', 409, 'IMAGEN_EN_PROCESO'], ['mejorando', 409, 'IMAGEN_EN_PROCESO'], ['validando', 409, 'IMAGEN_EN_PROCESO'],
    ['rechazada', 422, 'IMAGEN_RECHAZADA'], ['fallida', 422, 'IMAGEN_FALLIDA'],
  ];
  for (const [estado, status, codigo] of casos) {
    const r = await guardar({ tipo: 'perfil', imagen_trabajo_id: sembrar(estado, urlPerfil()) });
    assert.deepEqual([r.status, r.body.codigo], [status, codigo], estado);
    assert.ok(r.body.error.length > 20);
  }
  assert.equal((await guardar({ tipo: 'perfil' })).body.codigo, 'IMAGEN_NO_PROCESADA');
  const dePortada = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: 'https://m/p.webp', original: urlPortada() });
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: dePortada })).body.codigo, 'IMAGEN_NO_PROCESADA', 'portada no sirve como perfil');
  const dePublicacion = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: 'https://m/b.webp', original: urlPublicacion() });
  assert.equal((await guardar({ tipo: 'portada', imagen_trabajo_id: dePublicacion })).body.codigo, 'IMAGEN_NO_PROCESADA', 'publicación no sirve como portada');
  assert.equal((await guardar({ tipo: 'banner', imagen_trabajo_id: dePortada })).status, 400);
  assert.equal(negocio().logo_url, undefined);
  assert.equal(negocio().imagen_url, undefined);
});

test('NAPI-5: compatibilidad — un trabajo de perfil/portada nunca autoriza una publicación', async () => {
  const id = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: 'https://m/l.webp', original: urlPerfil() });
  const r = await silenciar(() => pedir('POST', '/api/bolsas', {
    como: IDS.restaurante,
    body: {
      nombre: 'Promo', contenido: 'X', tipo: 'cupon', categoria: '2x1', descripcion: 'd', precio_original: 100, precio_descuento: 50,
      cantidad_disponible: 5, imagen_url: 'https://m/l.webp', imagen_trabajo_id: id,
      hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: fechaGuatemala(0),
    },
  }));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.codigo, 'IMAGEN_NO_PROCESADA');
});

test('NAPI-6: "usar mi original" solo si cumple la calidad mínima (lo decide el backend)', async () => {
  const aceptable = sembrar('fallida', urlPerfil(), { error_codigo: 'fidelidad', calidad_original: { original_aceptable: true } });
  const ok = await guardar({ tipo: 'perfil', imagen_trabajo_id: aceptable, usar_original: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(negocio().logo_url, urlPerfil());

  const portada = sembrar('rechazada', urlPortada(), { calidad_original: { original_aceptable: true } });
  assert.equal((await guardar({ tipo: 'portada', imagen_trabajo_id: portada, usar_original: true })).status, 200);
  assert.equal(negocio().imagen_url, urlPortada());
  assert.equal(negocio().estado_procesamiento_imagen, 'descartada');
  assert.equal(negocio().imagen_mejorada_url, null);

  for (const extra of [{ calidad_original: { original_aceptable: false } }, { calidad_original: { brillo: 10 } }, {}]) {
    const id = sembrar('fallida', urlPerfil(2), extra);
    const r = await guardar({ tipo: 'perfil', imagen_trabajo_id: id, usar_original: true });
    assert.deepEqual([r.status, r.body.codigo], [422, 'ORIGINAL_NO_PERMITIDA'], JSON.stringify(extra));
  }
  const enCurso = sembrar('mejorando', urlPerfil(3), { calidad_original: { original_aceptable: true } });
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: enCurso, usar_original: true })).body.codigo, 'IMAGEN_EN_PROCESO');
  assert.equal(negocio().logo_url, urlPerfil(), 'nada de lo rechazado se guardó');
});

test('NAPI-7: solo el dueño o un admin; trabajo ajeno no sirve', async () => {
  const id = trabajoListo({ negocioId: IDS.olaAzul, usuarioId: IDS.restaurante, url: 'https://m/l.webp', original: urlPerfil() });
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: id }, IDS.otroRestaurante)).status, 403);
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: id }, IDS.cliente)).status, 403);
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: id }, IDS.restaurante, 'no-existe')).status, 404);
  const ajeno = trabajoListo({ negocioId: IDS.otroNegocio, usuarioId: IDS.otroRestaurante, url: 'https://m/o.webp', original: urlPerfil(IDS.otroNegocio) });
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: ajeno })).body.codigo, 'IMAGEN_NO_PROCESADA');
  assert.equal((await guardar({ tipo: 'perfil', imagen_trabajo_id: id }, IDS.admin)).status, 200);
});

test('NAPI-8: PUT /api/negocios/:id ya no cambia la portada de un negocio aprobado sin IA; el registro (pendiente) y el admin sí', async () => {
  const r = await silenciar(() => pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.restaurante, body: { imagen_url: urlPortada() } }));
  assert.deepEqual([r.status, r.body.codigo], [409, 'IMAGEN_NO_PROCESADA']);
  assert.equal(negocio().imagen_url, undefined);
  const datos = await silenciar(() => pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.restaurante, body: { descripcion: 'Mariscos' } }));
  assert.equal(datos.status, 200, 'el resto del perfil se edita igual');
  negocio().estado_verificacion = 'pendiente';
  assert.equal((await silenciar(() => pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.restaurante, body: { imagen_url: urlPortada() } }))).status, 200);
  negocio().estado_verificacion = 'aprobado';
  assert.equal((await silenciar(() => pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.admin, body: { imagen_url: urlPortada(2) } }))).status, 200);
});

test('NAPI-9: portada guardada con IA — volver a la original por la acción vieja solo si la original era aceptable', async () => {
  Object.assign(negocio(), {
    imagen_url: 'https://m/mej.webp', imagen_original_url: urlPortada(), imagen_mejorada_url: 'https://m/mej.webp',
    estado_procesamiento_imagen: 'completada', imagen_procesamiento_meta: { trabajo_id: 't', original_aceptable: false },
  });
  const r = await silenciar(() => apiImagenes('POST', `/api/imagenes/negocio/${IDS.olaAzul}/usar-original`));
  assert.deepEqual([r.status, r.body.codigo], [409, 'ORIGINAL_NO_PERMITIDA']);
  assert.equal(negocio().imagen_url, 'https://m/mej.webp');
  negocio().imagen_procesamiento_meta.original_aceptable = true;
  assert.equal((await silenciar(() => apiImagenes('POST', `/api/imagenes/negocio/${IDS.olaAzul}/usar-original`))).status, 200);
  assert.equal(negocio().imagen_url, urlPortada());
});
