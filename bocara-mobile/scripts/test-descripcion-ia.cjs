// Ejecutar: node scripts/test-descripcion-ia.cjs. Sin red ni dispositivo.
// "Mejorar descripción con IA" (Promoción / Tiempo limitado): qué datos salen
// de la app, que la propuesta queda editable, que un fallo o timeout conserva
// la descripción y que toques repetidos no duplican la petición.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function load(file) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj }, { filename: file });
  return exportsObj;
}
const {
  crearMejorador, payloadDescripcionIA, motivoNoMejorable, mensajeError,
  MENSAJE_FALLO_IA, MENSAJE_FALTA_NOMBRE, TEXTO_GENERANDO,
} = load('src/utils/descripcionIA.ts');

// Formulario completo tal como lo tiene bolsas.tsx (incluye campos que NO deben salir).
const FORM = {
  tipo_form: 'bolsa', nombre: ' Hamburguesa con papas ', descripcion: 'Hamburguesa con papas', contenido: 'Hamburguesa y papas',
  precio_original: '60', precio_descuento: '35', cantidad_disponible: '5',
  hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00', peso_estimado_kg: '0.5',
  imagen_url: 'https://cdn/x.jpg', activo: true, categoria: '2x1',
  fecha_disponible: '2026-10-14', fecha_caducidad: '2026-10-15',
  categoria_alimento: 'carne_bovina', categoria_menu: 'Combos', es_destacado: true,
};
// Objetos creados dentro de vm tienen otro prototipo: comparar como datos planos.
const plano = (o) => JSON.parse(JSON.stringify(o));
const PROPUESTA = 'Disfruta una hamburguesa acompañada de papas, disponible por tiempo limitado a precio Bocara.';

function diferido() {
  let resolver, rechazar;
  const promesa = new Promise((r, j) => { resolver = r; rechazar = j; });
  return { promesa, resolver, rechazar };
}

test('DESC-UI-1: solo salen los datos permitidos (Tiempo limitado)', () => {
  assert.deepEqual(plano(payloadDescripcionIA(FORM)), {
    tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'Hamburguesa con papas', contenido: 'Hamburguesa y papas',
    categoria_alimento: 'carne_bovina', precio_original: '60', precio_descuento: '35',
    hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00', fecha_disponible: '2026-10-14', fecha_caducidad: '2026-10-15',
  });
});

test('DESC-UI-1: Promoción → no envía el código del cupón (contenido) ni fecha fin; vacíos se omiten', () => {
  const p = payloadDescripcionIA({ ...FORM, tipo_form: 'cupon', contenido: 'BOCARA20', descripcion: '  ', precio_original: '' });
  assert.equal(p.tipo, 'cupon');
  assert.equal(p.contenido, undefined);
  assert.equal(p.fecha_caducidad, undefined);
  assert.equal(p.descripcion, undefined);
  assert.equal(p.precio_original, undefined);
  assert.ok(!JSON.stringify(p).includes('BOCARA20'));
});

test('DESC-UI-2: sin nombre no se llama a la API y se pide el nombre', async () => {
  let llamadas = 0;
  const m = crearMejorador(async () => { llamadas += 1; return { descripcion: PROPUESTA }; });
  for (const nombre of ['', ' ', 'a']) {
    const r = await m.mejorar({ ...FORM, nombre, descripcion: 'algo' });
    assert.equal(r.estado, 'error');
    assert.equal(r.error, MENSAJE_FALTA_NOMBRE);
    assert.equal(r.descripcion, 'algo');
  }
  assert.equal(llamadas, 0);
  assert.equal(motivoNoMejorable({ nombre: 'x'.repeat(121), descripcion: '', contenido: '' }), 'El nombre admite máximo 120 caracteres.');
  assert.match(motivoNoMejorable({ nombre: 'Pan', descripcion: 'x'.repeat(601), contenido: '' }), /600/);
});

test('DESC-UI-3: la propuesta vuelve al formulario (aun con descripción vacía)', async () => {
  const m = crearMejorador(async () => ({ descripcion: `  ${PROPUESTA} ` }));
  const r = await m.mejorar({ ...FORM, descripcion: '' });
  assert.deepEqual(plano(r), { estado: 'ok', descripcion: PROPUESTA, anterior: '' });
});

test('DESC-UI-4: el usuario puede modificar la propuesta antes de guardar', async () => {
  // Mismo setter que usa el TextInput al escribir: la propuesta queda como
  // texto normal del campo, editable y "Deshacer" recupera el anterior.
  let form = { ...FORM };
  const setDescripcion = (v) => { form = { ...form, descripcion: v }; };
  const m = crearMejorador(async () => ({ descripcion: PROPUESTA }));
  const r = await m.mejorar(form);
  setDescripcion(r.descripcion);
  assert.equal(form.descripcion, PROPUESTA);
  setDescripcion(`${form.descripcion} Pídela hoy.`);
  assert.equal(form.descripcion, `${PROPUESTA} Pídela hoy.`);
  setDescripcion(r.anterior);
  assert.equal(form.descripcion, 'Hamburguesa con papas');

  const pantalla = read('app/restaurante/bolsas.tsx');
  assert.match(pantalla, /onPropuesta=\{set\('descripcion'\)\}/, 'la propuesta usa el mismo setter que el TextInput');
  assert.match(pantalla, /onChange=\{set\('descripcion'\)\}/);
  assert.match(pantalla, /editable=\{!generandoDescripcion\}/, 'solo se bloquea mientras genera');
});

test('DESC-UI-5: fallo de la API conserva la descripción anterior y muestra el mensaje', async () => {
  for (const status of [502, 500, 401, undefined]) {
    const m = crearMejorador(async () => { const e = new Error('detalle técnico'); e.status = status; throw e; });
    const r = await m.mejorar(FORM);
    assert.deepEqual(plano(r), { estado: 'error', error: MENSAJE_FALLO_IA, descripcion: 'Hamburguesa con papas' }, String(status));
  }
  assert.equal(MENSAJE_FALLO_IA, 'No pudimos mejorar la descripción. Intenta nuevamente.');
  // Respuesta 200 sin texto útil → tampoco se toca el campo.
  const vacia = await crearMejorador(async () => ({ descripcion: '  ' })).mejorar(FORM);
  assert.equal(vacia.estado, 'error');
  assert.equal(vacia.descripcion, 'Hamburguesa con papas');
});

test('DESC-UI-6: timeout (504 o sin respuesta del servidor) conserva la descripción', async () => {
  const timeouts = [
    Object.assign(new Error('No pudimos mejorar la descripción. Intenta nuevamente.'), { status: 504 }),
    Object.assign(new Error('El servidor tardó demasiado en responder. Intenta de nuevo.'), { status: null }),
  ];
  for (const e of timeouts) {
    const r = await crearMejorador(async () => { throw e; }).mejorar(FORM);
    assert.equal(r.estado, 'error');
    assert.equal(r.error, MENSAJE_FALLO_IA);
    assert.equal(r.descripcion, 'Hamburguesa con papas');
  }
});

test('DESC-UI-7: límites y validación muestran el texto del backend', () => {
  assert.equal(mensajeError({ status: 429, message: 'Alcanzaste el límite diario de descripciones con IA. Intenta mañana.' }),
    'Alcanzaste el límite diario de descripciones con IA. Intenta mañana.');
  assert.equal(mensajeError({ status: 400, message: 'nombre admite máximo 120 caracteres' }), 'nombre admite máximo 120 caracteres');
  assert.equal(mensajeError({ status: 502, message: 'gemini: HTTP 500' }), MENSAJE_FALLO_IA);
});

test('DESC-UI-8: toques repetidos mientras procesa no duplican la petición', async () => {
  const d = diferido();
  let llamadas = 0;
  const m = crearMejorador(() => { llamadas += 1; return d.promesa; });
  const primera = m.mejorar(FORM);
  assert.equal(m.enCurso, true);
  const repetidas = await Promise.all([m.mejorar(FORM), m.mejorar(FORM), m.mejorar(FORM)]);
  for (const r of repetidas) assert.deepEqual(plano(r), { estado: 'ignorada' });
  d.resolver({ descripcion: PROPUESTA });
  assert.equal((await primera).estado, 'ok');
  assert.equal(llamadas, 1);
  assert.equal(m.enCurso, false);
  // Tras un fallo también se libera para reintentar.
  const m2 = crearMejorador(async () => { throw new Error('x'); });
  await m2.mejorar(FORM);
  assert.equal(m2.enCurso, false);
});

test('DESC-UI-9: botón con loading, deshabilitado mientras procesa y descarte si se cierra el formulario', () => {
  const c = read('components/BotonDescripcionIA.tsx');
  assert.match(c, /✨ Mejorar descripción con IA/);
  assert.equal(TEXTO_GENERANDO, 'Generando descripción…');
  assert.match(c, /procesando \? TEXTO_GENERANDO/);
  assert.match(c, /disabled=\{procesando\}/);
  assert.match(c, /if \(mejorador\.enCurso\) return;/);
  assert.match(c, /if \(!montado\.current\) return;/);
  assert.match(c, /Deshacer/);
});

test('DESC-UI-10: un solo componente para Promoción y Tiempo limitado, fuera de la rama por tipo', () => {
  const pantalla = read('app/restaurante/bolsas.tsx');
  assert.equal((pantalla.match(/<BotonDescripcionIA\b/g) || []).length, 1);
  const iBoton = pantalla.indexOf('<BotonDescripcionIA');
  const iRamaTipo = pantalla.search(/\{form\.tipo_form === 'cupon' \? \(\s*<>/);
  assert.ok(iBoton > 0 && iRamaTipo > iBoton, 'el botón va antes de los campos específicos por tipo (aplica a ambos)');
});

test('DESC-UI-11: la app no conoce claves ni el proveedor: solo llama a /ia/descripcion del backend', () => {
  const api = read('src/services/api.ts');
  assert.match(api, /'\/ia\/descripcion'/);
  const archivos = ['src/services/api.ts', 'src/utils/descripcionIA.ts', 'components/BotonDescripcionIA.tsx', 'app/restaurante/bolsas.tsx'];
  for (const f of archivos) {
    const t = read(f);
    assert.doesNotMatch(t, /GEMINI|generativelanguage|googleapis|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|OPENAI_API_KEY|sk-[A-Za-z0-9]{20,}/, f);
  }
});
