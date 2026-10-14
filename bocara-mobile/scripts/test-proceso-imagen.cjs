// Ejecutar: node scripts/test-proceso-imagen.cjs. Sin red ni dispositivo.
// Foto con IA obligatoria antes de publicar (Promoción / Tiempo limitado):
// estados visibles, motor de sondeo, componente y bloqueo real de Guardar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function load(file, mocks = {}, globals = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      if (name.endsWith('utils/analitica')) return { registrarEvento() {} };
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}
const plano = (o) => JSON.parse(JSON.stringify(o));
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

const P = load('src/utils/procesoImagen.ts');
const FOTO = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/bolsas/n1_1.jpg';
const MEJORADA = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/mejoradas/trabajos/t1/1.webp';
const trabajo = (estado, extra = {}) => ({
  id: 't1', estado, original_url: FOTO, mejorada_url: estado === 'lista' ? MEJORADA : null, motivos: [],
  error_codigo: null, error: null, detalle: null, puede_reintentar: estado === 'fallida', ...extra,
});

// ── Textos y pasos ──────────────────────────────────────────────────────────

test('IMG-FE-1: textos visibles exactos de cada estado', () => {
  assert.equal(P.resumenProceso(trabajo('mejorando')).titulo, '✨ Mejorando imagen con IA…');
  assert.equal(P.resumenProceso(trabajo('validando')).titulo, '🔍 Validando calidad de imagen…');
  assert.equal(P.resumenProceso(trabajo('analizando')).titulo, '🔍 Analizando calidad…');
  assert.equal(P.resumenProceso(trabajo('subida')).titulo, 'Imagen subida');
  assert.equal(P.resumenProceso(trabajo('lista')).titulo, '✅ Imagen lista para publicar');
  assert.equal(P.resumenProceso(trabajo('fallida', { error: 'x' })).titulo, '⚠️ No se pudo mejorar la imagen');
  // Rechazo tras mejorar y validar vs. rechazo de algo irreparable al analizar.
  assert.equal(P.resumenProceso(trabajo('rechazada', { paso_error: 'validando' })).titulo, '❌ Esta imagen no cumple la calidad mínima para Bocara');
  assert.equal(P.resumenProceso(trabajo('rechazada', { paso_error: 'analizando' })).titulo, '❌ Imagen rechazada: no se puede usar esta foto');
  // Mientras procesa: el mensaje pedido, explícito.
  for (const estado of ['subida', 'analizando', 'mejorando', 'validando']) {
    assert.equal(P.resumenProceso(trabajo(estado)).mensajes[0], 'Procesando imagen con IA, espera un momento…', estado);
  }
  assert.equal(P.BLOQUEOS.procesando, 'Procesando imagen con IA, espera un momento…');
  assert.equal(P.TEXTOS_IMAGEN.reintentar, 'Reintentar');
  assert.equal(P.TEXTOS_IMAGEN.cambiarFoto, 'Cambiar foto');
});

test('IMG-FE-2: pasos — avance, rechazo en "Analizando calidad" y fallo en el paso correspondiente', () => {
  const e = (t) => plano(P.pasosProceso(t)).map((p) => p.estado);
  assert.deepEqual(e(trabajo('analizando')), ['hecho', 'activo', 'pendiente', 'pendiente']);
  assert.deepEqual(e(trabajo('mejorando')), ['hecho', 'hecho', 'activo', 'pendiente']);
  assert.deepEqual(e(trabajo('validando')), ['hecho', 'hecho', 'hecho', 'activo']);
  assert.deepEqual(e(trabajo('lista')), ['hecho', 'hecho', 'hecho', 'hecho']);
  assert.deepEqual(e(trabajo('rechazada')), ['hecho', 'error', 'pendiente', 'pendiente']);
  assert.deepEqual(e(trabajo('fallida', { error_codigo: 'proveedor' })), ['hecho', 'hecho', 'error', 'pendiente']);
  assert.deepEqual(e(trabajo('fallida', { error_codigo: 'validacion' })), ['hecho', 'hecho', 'hecho', 'error']);
  // paso_error del backend manda: rechazo tras mejorar → ✗ en "Validando resultado".
  assert.deepEqual(e(trabajo('rechazada', { paso_error: 'validando' })), ['hecho', 'hecho', 'hecho', 'error']);
  assert.deepEqual(e(trabajo('fallida', { error_codigo: 'proveedor_sin_credito', paso_error: 'mejorando' })), ['hecho', 'hecho', 'error', 'pendiente']);
  assert.deepEqual(e(trabajo('fallida', { error_codigo: 'proveedor_sin_credito' })), ['hecho', 'hecho', 'error', 'pendiente']);
  assert.deepEqual(plano(P.pasosProceso(trabajo('mejorando'))).map((p) => p.texto),
    ['Imagen subida', 'Analizando calidad', 'Mejorando con IA', 'Validando resultado']);
});

test('IMG-FE-3: fallida ofrece Reintentar y Cambiar foto; rechazada solo Cambiar foto con los motivos; detalle técnico solo en desarrollo', () => {
  const f = trabajo('fallida', { error: 'La mejora con IA no está configurada en el servidor.', detalle: 'falta OPENAI_API_KEY' });
  const prod = plano(P.resumenProceso(f));
  assert.equal(prod.puedeReintentar, true);
  assert.equal(prod.puedeCambiar, true);
  assert.ok(!prod.mensajes.join(' ').includes('OPENAI_API_KEY'));
  assert.ok(plano(P.resumenProceso(f, { dev: true })).mensajes.join(' ').includes('Detalle técnico: falta OPENAI_API_KEY'));
  const r = plano(P.resumenProceso(trabajo('rechazada', { motivos: [{ codigo: 'borrosa', mensaje: 'La foto está borrosa o movida.' }] })));
  assert.equal(r.puedeReintentar, false);
  assert.deepEqual(r.mensajes, ['La foto está borrosa o movida.']);
});

// ── Regla de guardado ───────────────────────────────────────────────────────

test('IMG-FE-4: Guardar bloqueado mientras la foto no esté lista (nueva publicación)', () => {
  const b = (t, extra = {}) => P.bloqueoPorFoto({ esEdicion: false, url: FOTO, trabajo: t, ...extra });
  assert.equal(P.bloqueoPorFoto({ esEdicion: false, url: '', trabajo: null }), P.BLOQUEOS.sinFoto);
  assert.equal(b(null, { subiendo: true }), P.BLOQUEOS.subiendo);
  assert.equal(b(null), P.BLOQUEOS.sinProcesar);
  for (const estado of ['subida', 'analizando', 'mejorando', 'validando']) assert.equal(b(trabajo(estado)), P.BLOQUEOS.procesando, estado);
  assert.equal(b(trabajo('rechazada')), P.BLOQUEOS.rechazada);
  assert.equal(b(trabajo('fallida')), P.BLOQUEOS.fallida);
  assert.equal(b(trabajo('lista')), null);
  // El trabajo de OTRA foto (la cambió) no habilita nada.
  assert.equal(b(trabajo('lista', { original_url: 'https://otra.jpg' })), P.BLOQUEOS.sinProcesar);
  assert.equal(b(trabajo('mejorando'), { errorRed: true }), P.BLOQUEOS.errorRed);
});

test('IMG-FE-5: edición — sin cambiar la foto no bloquea; con foto nueva exige su trabajo "lista"', () => {
  const bolsa = { imagen_url: MEJORADA, imagen_original_url: FOTO, imagen_mejorada_url: MEJORADA };
  assert.equal(P.bloqueoPorFoto({ esEdicion: true, url: MEJORADA, bolsa, trabajo: null }), null);
  assert.equal(P.bloqueoPorFoto({ esEdicion: true, url: FOTO, bolsa, trabajo: null }), null, 'la original de la misma foto no es foto nueva');
  const NUEVA = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/bolsas/n1_2.jpg';
  assert.equal(P.bloqueoPorFoto({ esEdicion: true, url: NUEVA, bolsa, trabajo: null }), P.BLOQUEOS.sinProcesar);
  assert.equal(P.bloqueoPorFoto({ esEdicion: true, url: NUEVA, bolsa, trabajo: trabajo('lista', { original_url: NUEVA }) }), null);
  assert.equal(P.bolsaConImagenValidada({ estado_procesamiento_imagen: 'completada' }), true);
  assert.equal(P.bolsaConImagenValidada({ estado_procesamiento_imagen: 'descartada' }), true);
  assert.equal(P.bolsaConImagenValidada({ estado_procesamiento_imagen: null }), false);
});

// ── Motor de sondeo ─────────────────────────────────────────────────────────

function apiFalsa(secuencia, { crearFalla } = {}) {
  const llamadas = { crear: 0, obtener: 0, reintentar: 0 };
  let i = 0;
  return {
    llamadas,
    crear: async (url) => { llamadas.crear += 1; if (crearFalla) throw crearFalla; return { ...trabajo('subida'), original_url: url }; },
    obtener: async () => {
      llamadas.obtener += 1;
      const s = secuencia[Math.min(i++, secuencia.length - 1)];
      if (s instanceof Error) throw s;
      return trabajo(s);
    },
    reintentar: async () => { llamadas.reintentar += 1; return trabajo('subida'); },
  };
}

test('IMG-FE-6: sondeo — emite cada estado en orden y se detiene en "lista"', async () => {
  const api = apiFalsa(['analizando', 'mejorando', 'validando', 'lista', 'lista']);
  const vistos = [];
  const s = P.crearSondeoTrabajo(api, (e) => { if (e.trabajo) vistos.push(e.trabajo.estado); }, { esperar: async () => {} });
  await s.iniciar(FOTO);
  assert.deepEqual(vistos, ['subida', 'analizando', 'mejorando', 'validando', 'lista']);
  assert.equal(api.llamadas.obtener, 4, 'no sigue consultando tras un estado final');
});

test('IMG-FE-7: cambiar la foto a mitad cancela el sondeo anterior (sus respuestas se ignoran)', async () => {
  let liberar;
  const api = apiFalsa(['mejorando']);
  const vistos = [];
  const s = P.crearSondeoTrabajo(api, (e) => vistos.push(e.trabajo?.original_url || null), {
    esperar: () => new Promise((r) => { liberar = r; }),
  });
  s.iniciar(FOTO);
  await tick();
  const NUEVA = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/bolsas/n1_9.jpg';
  s.cancelar();
  liberar();
  await tick();
  assert.ok(!vistos.slice(2).includes(FOTO), 'nada de la foto vieja llega después de cancelar');
  assert.equal(s.estado.trabajo, null);
  void NUEVA;
});

test('IMG-FE-8: red caída 5 veces seguidas → errorRed (Guardar sigue bloqueado); Reintentar reanuda la consulta', async () => {
  const caida = Object.assign(new Error('Sin conexión'), { status: null });
  const api = apiFalsa([caida, caida, caida, caida, caida, 'lista']);
  let ultimo = null;
  const s = P.crearSondeoTrabajo(api, (e) => { ultimo = e; }, { esperar: async () => {} });
  await s.iniciar(FOTO);
  assert.equal(ultimo.errorRed, true);
  assert.equal(P.bloqueoPorFoto({ esEdicion: false, url: FOTO, trabajo: ultimo.trabajo, errorRed: ultimo.errorRed }), P.BLOQUEOS.errorRed);
  await s.reintentar();
  assert.equal(ultimo.errorRed, false);
  assert.equal(ultimo.trabajo.estado, 'lista');
});

test('IMG-FE-9: Reintentar desde fallida llama a la API de reintento; no se puede crear el trabajo → error visible', async () => {
  const api = apiFalsa(['fallida', 'mejorando', 'lista']);
  let ultimo = null;
  const s = P.crearSondeoTrabajo(api, (e) => { ultimo = e; }, { esperar: async () => {} });
  await s.iniciar(FOTO);
  assert.equal(ultimo.trabajo.estado, 'fallida');
  await s.reintentar();
  assert.equal(api.llamadas.reintentar, 1);
  assert.equal(ultimo.trabajo.estado, 'lista');

  const err = Object.assign(new Error('El procesamiento de imágenes no está disponible: falta aplicar la migración 20261014100000_trabajos_imagen.sql.'), { status: 503 });
  const s2 = P.crearSondeoTrabajo(apiFalsa([], { crearFalla: err }), (e) => { ultimo = e; }, { esperar: async () => {} });
  await s2.iniciar(FOTO);
  assert.equal(ultimo.trabajo, null);
  assert.match(ultimo.error, /20261014100000/);
});

// ── Componente ──────────────────────────────────────────────────────────────

const RN = { View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', StyleSheet: { create: (x) => x } };
const Estado = load('components/EstadoProcesoImagen.tsx', {
  'react-native': RN, '@/src/utils/procesoImagen': P, '@/constants/Colors': { Colors: {} },
}, { __DEV__: false }).default;
const nodos = (n) => (!n || typeof n !== 'object') ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodos)];
const texto = (n) => (typeof n === 'string' || typeof n === 'number') ? String(n) : (!n || typeof n !== 'object') ? '' : [n.props?.children].flat(Infinity).map(texto).join('');
const botones = (a) => nodos(a).filter((n) => n.type === 'Button');

test('IMG-FE-10: componente — procesando: spinner + pasos, sin Reintentar', () => {
  const a = Estado({ trabajo: trabajo('mejorando'), onReintentar() {}, onCambiarFoto() {} });
  assert.match(texto(a), /✨ Mejorando imagen con IA…/);
  assert.match(texto(a), /Mejorando con IA…/);
  assert.match(texto(a), /Guardar se habilita cuando la imagen esté lista/);
  assert.ok(nodos(a).some((n) => n.type === 'Spinner'));
  assert.equal(botones(a).find((b) => texto(b) === 'Reintentar'), undefined);
});

test('IMG-FE-11: componente — fallida: Reintentar y Cambiar foto llaman a sus acciones; rechazada: motivos y solo Cambiar foto', () => {
  const acciones = [];
  const a = Estado({ trabajo: trabajo('fallida', { error: 'El servicio de IA no respondió.' }), onReintentar: () => acciones.push('reintentar'), onCambiarFoto: () => acciones.push('cambiar') });
  assert.match(texto(a), /⚠️ No se pudo mejorar la imagen/);
  botones(a).find((b) => texto(b) === 'Reintentar').props.onPress();
  botones(a).find((b) => texto(b) === 'Cambiar foto').props.onPress();
  assert.deepEqual(acciones, ['reintentar', 'cambiar']);
  const r = Estado({ trabajo: trabajo('rechazada', { paso_error: 'validando', motivos: [{ codigo: 'recortada', mensaje: 'El producto está cortado.' }] }), onReintentar() {}, onCambiarFoto() {} });
  assert.match(texto(r), /❌ Esta imagen no cumple la calidad mínima para Bocara/);
  assert.match(texto(r), /La mejoramos con IA, pero el resultado final no se puede publicar/);
  assert.match(texto(r), /El producto está cortado/);
  assert.match(texto(r), /✓Mejorando con IA✗Validando resultado/);
  assert.deepEqual(botones(r).map(texto), ['Cambiar foto']);
  const ok = Estado({ trabajo: trabajo('lista'), onReintentar() {}, onCambiarFoto() {} });
  assert.match(texto(ok), /✅ Imagen lista para publicar/);
  const corregida = Estado({ trabajo: trabajo('lista', { problemas_corregidos: ['oscura', 'borrosa'] }), onReintentar() {}, onCambiarFoto() {} });
  assert.match(texto(corregida), /La IA mejoró tu foto: iluminación, nitidez./);
  const original = Estado({ trabajo: trabajo('lista', { usa_original: true }), onReintentar() {}, onCambiarFoto() {} });
  assert.match(texto(original), /Usaremos tu foto original/);
});

// ── Pantalla real: Guardar no llama a la API si la foto no está lista ──────

function hooks(forzados) {
  const cells = []; let cursor = 0, stateIndex = 0;
  const memo = (factory, deps) => {
    const i = cursor++; const old = cells[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: factory() };
    return cells[i].value;
  };
  return {
    reset() { cursor = 0; stateIndex = 0; },
    react: { ...React,
      useMemo: memo, useCallback: (f, deps) => memo(() => f, deps), useRef: (v) => memo(() => ({ current: v }), []),
      useState(inicial) { const k = stateIndex++; const cell = memo(() => ({ value: k in forzados ? forzados[k] : typeof inicial === 'function' ? inicial() : inicial }), []); return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
      useEffect() { cursor++; },
    },
  };
}
function fechaGT(dias) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [a, m, d] = p.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

function pantalla(trabajoActual, { editId = null, bolsaInicial = null } = {}) {
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan del día', descripcion: '', contenido: 'Pan variado',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: FOTO,
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: fechaGT(1), fecha_caducidad: fechaGT(3), categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false, es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  // items, loading, refreshing, modal, form, editId, negocioId
  const h = hooks([bolsaInicial ? [bolsaInicial] : [], false, false, true, form, editId, 'n1']);
  const alerts = [];
  const llamadas = { crear: [], actualizar: [] };
  const horarioReal = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
  const mocks = {
    react: h.react,
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
      ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image', Switch: 'Switch', RefreshControl: 'RefreshControl',
      StyleSheet: { create: (x) => x, absoluteFillObject: {} }, Platform: { OS: 'android' }, Alert: { alert: (...a) => alerts.push(a) } },
    'expo-router': { useRouter: () => ({ push() {}, replace() {} }), useFocusEffect: () => {} },
    '@/src/services/api': {
      bolsasAPI: {
        crear: async (p) => { llamadas.crear.push(p); return { data: { id: 'nueva' } }; },
        actualizar: async (id, p) => { llamadas.actualizar.push(p); return { data: { id } }; },
        listar: async () => ({ data: [] }),
      },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'n1' } }) },
      uploadsAPI: {}, iaAPI: { estado: async () => null },
    },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/pickImage': {},
    '@/components/HoraPicker': { __esModule: true, default: () => null },
    '@/components/CalendarioPicker': { __esModule: true, default: () => null },
    '@/components/EstadoImagenIA': { __esModule: true, default: () => null },
    '@/components/BotonDescripcionIA': { __esModule: true, default: () => null },
    '@/components/EstadoProcesoImagen': { __esModule: true, default: function EstadoProcesoImagen() { return null; } },
    '@/hooks/use-trabajo-imagen': { useTrabajoImagen: () => ({ trabajo: trabajoActual, error: null, errorRed: false, iniciar() {}, reintentar() {}, reiniciar() {} }) },
    '@/src/utils/procesoImagen': P,
    '@/src/utils/estadoImagen': { hayMejoraEnCurso: () => false },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/hora': load('src/utils/hora.ts'),
    '@/src/utils/estadoPublicacion': load('src/utils/estadoPublicacion.ts', { './horarioRecogida': horarioReal }),
  };
  const Componente = load('app/restaurante/bolsas.tsx', mocks, { __DEV__: false }).default;
  const arbol = Componente();
  return { arbol, alerts, llamadas, render: () => { h.reset(); return Componente(); } };
}
const guardarBtn = (arbol) => nodos(arbol).find((n) => n.type === 'Button' && n.props.onPress?.name === 'guardar');

test('IMG-FE-12: pantalla — con la foto procesándose, rechazada o fallida, Guardar se ve bloqueado, explica el motivo y NO llama a la API', async () => {
  for (const [estado, motivo] of [['mejorando', P.BLOQUEOS.procesando], ['validando', P.BLOQUEOS.procesando], ['rechazada', P.BLOQUEOS.rechazada], ['fallida', P.BLOQUEOS.fallida]]) {
    const { arbol, alerts, llamadas } = pantalla(trabajo(estado));
    const boton = guardarBtn(arbol);
    assert.match(texto(boton), /🔒 Guardar/, estado);
    assert.ok(nodos(arbol).some((n) => n.props?.testID === 'motivo-bloqueo' && texto(n) === motivo), `${estado}: motivo visible`);
    await boton.props.onPress(); await tick();
    assert.equal(llamadas.crear.length, 0, `${estado}: no se publicó`);
    assert.ok(alerts.some((a) => a.includes(motivo)), `${estado}: alerta con el motivo`);
  }
  const sinTrabajo = pantalla(null);
  await guardarBtn(sinTrabajo.arbol).props.onPress(); await tick();
  assert.equal(sinTrabajo.llamadas.crear.length, 0);
});

test('IMG-FE-13: pantalla — con la imagen lista: Guardar habilitado, se publica con imagen_trabajo_id y la vista previa muestra la mejorada', async () => {
  const { arbol, llamadas, alerts } = pantalla(trabajo('lista'));
  const boton = guardarBtn(arbol);
  assert.equal(texto(boton), 'Guardar');
  assert.ok(!nodos(arbol).some((n) => n.props?.testID === 'motivo-bloqueo'));
  assert.ok(nodos(arbol).some((n) => n.type === 'Image' && n.props.source?.uri === MEJORADA), 'vista previa = mejorada');
  await boton.props.onPress(); await tick();
  assert.equal(llamadas.crear.length, 1, JSON.stringify(alerts));
  assert.equal(llamadas.crear[0].imagen_trabajo_id, 't1');
});

test('IMG-FE-14: pantalla — editar una publicación cuya foto no pasó la IA: cambios de contenido bloqueados con aviso', async () => {
  const heredada = {
    id: 'b1', negocio_id: 'n1', nombre: 'Pan heredado', tipo: 'bolsa', precio_original: 40, precio_descuento: 20, cantidad_disponible: 5,
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', fecha_disponible: fechaGT(1), fecha_caducidad: fechaGT(3),
    activo: true, estado_aprobacion: 'aprobado', motivo_rechazo: null,
    imagen_url: FOTO, imagen_original_url: null, imagen_mejorada_url: null, estado_procesamiento_imagen: null,
  };
  const p = pantalla(null, { bolsaInicial: heredada });
  // Como el restaurante: toca "Editar" en la tarjeta (abrir() carga la publicación).
  const editar = nodos(p.arbol).find((n) => n.type === 'Button' && String(n.props.onPress).includes('abrir(b)'));
  assert.ok(editar, 'botón Editar de la tarjeta');
  editar.props.onPress();
  const arbol = p.render();
  assert.match(texto(arbol), /necesita una foto validada por IA/);
  assert.match(read('app/restaurante/bolsas.tsx'), /if \(!soloOperativo\) return marcarBloqueoFoto\(BLOQUEOS\.sinValidar\);/);
});

test('IMG-FE-15: cableado — subir foto inicia el procesamiento (web y nativo) y el componente recibe Reintentar / Cambiar foto', () => {
  const src = read('app/restaurante/bolsas.tsx');
  assert.equal((src.match(/procesoFoto\.iniciar\(data\.publicUrl\)/g) || []).length, 2);
  assert.match(src, /onReintentar=\{procesoFoto\.reintentar\}/);
  assert.match(src, /onCambiarFoto=\{seleccionarFotoBolsa\}/);
  assert.match(src, /if \(bloqueoFoto\) return marcarBloqueoFoto\(bloqueoFoto\);/);
  assert.match(src, /testID="ia-no-configurada"/, 'aviso si la IA de imagen no está configurada en el servidor');
  const api = read('src/services/api.ts');
  assert.match(api, /'\/imagenes\/trabajos'/);
  assert.doesNotMatch(api + src, /OPENAI_API_KEY|sk-[A-Za-z0-9]{20,}/, 'ninguna clave en la app');
});
