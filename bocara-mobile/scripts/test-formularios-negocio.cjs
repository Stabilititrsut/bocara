// Ejecutar: node scripts/test-formularios-negocio.cjs. Sin red, Expo ni dependencias nuevas.
// Cubre el criterio "Formularios negocio y etiquetas cliente; payload tipado;
// eliminar hardcode de 25% donde contradiga backend": payload tipado de
// crear/editar bolsas y cupones, normalización de tipo de publicación,
// etiquetas cliente unificadas, comisión derivada de datos (no 25% fijo) y
// comportamiento de submit (error no limpia el formulario, doble submit
// bloqueado, loading visible).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}, globals = {}, extraSource = '') {
  const exportsObj = {};
  const source = fs.readFileSync(path.join(root, file), 'utf8') + extraSource;
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      // Analítica (src/utils/analitica.ts): no-op salvo que la prueba pase su double.
      if (name.endsWith('utils/analitica')) return { registrarEvento() {}, vaciarAnalitica: async () => {}, iniciarAnalitica: () => () => {}, establecerAnaliticaHabilitada() {} };
      // Meta Pixel (lib/metaPixel.ts): solo web; no-op en las pruebas.
      if (name.endsWith('lib/metaPixel')) return { iniciarMetaPixel() {}, trackPageView() {}, trackEvent() {} };
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const horarioReal = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
const tipoPublicacionReal = load('src/utils/tipoPublicacion.ts', {});
const relojMock = { useRelojPublicaciones: () => new Date(), usePublicacionesVigentes: items => horarioReal.publicacionesVigentes(items) };
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

// '00:00'-'23:59' (no '18:00'-'20:00'): guardar() y ProductCard llaman a
// publicacionVencida(form/bolsa) con la hora real del sistema (sin `now`
// inyectado) — una ventana angosta hacía que estas pruebas fallaran solas
// cada noche después de las 20:00 hora de Guatemala. Ventana casi de 24h para
// que el resultado no dependa de a qué hora corre la suite.
const bolsa = (overrides = {}) => ({
  id: 'b1', negocio_id: 'n1', nombre: 'Bolsa sorpresa', precio_original: 40, precio_descuento: 20,
  cantidad_disponible: 5, tipo: 'bolsa', hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
  ...overrides,
});

function hooks() {
  const cells = []; let cursor = 0, stateIndex = 0; const pending = []; const forcedStates = [];
  const memo = (factory, deps) => {
    const i = cursor++; const old = cells[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: factory() };
    return cells[i].value;
  };
  return { forcedStates, reset() { cursor = 0; stateIndex = 0; }, commit() { pending.splice(0).forEach(f => f()); },
    react: { ...React,
      useMemo: memo, useCallback: (f, deps) => memo(() => f, deps), useRef: initial => memo(() => ({ current: initial }), []),
      useState(initial) { const override = stateIndex++; const cell = memo(() => ({ value: override in forcedStates ? forcedStates[override] : typeof initial === 'function' ? initial() : initial }), []); return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
      useEffect() { cursor++; },
      useLayoutEffect(effect, deps) {
        const i = cursor++; const old = cells[i];
        if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) {
          const next = { deps }; cells[i] = next;
          pending.push(() => { old?.cleanup?.(); next.cleanup = effect(); });
        }
      },
      useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    },
  };
}
function walk(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return [node?.props?.children].flat(Infinity).map(textOf).join(' ');
}

// Harness genérico para pantallas de restaurante (bolsas.tsx / cupones.tsx):
// mismo patrón que scripts/test-cart.cjs usa para estas dos pantallas.
function uiRestaurante(file, forcedStates, extraMocks = {}) {
  const h = hooks(); h.forcedStates.push(...forcedStates); const alerts = [], navigation = [];
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image', Switch: 'Switch',
    RefreshControl: 'RefreshControl',
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Dimensions: { get: () => ({ width: 400, height: 800 }) },
    Platform: { OS: 'android' }, StatusBar: {}, Alert: { alert: (...args) => alerts.push(args) } };
  const mocks = {
    react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: p => navigation.push(p), replace: p => navigation.push(p) }), useFocusEffect: () => {} },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/estadoPublicacion': load('src/utils/estadoPublicacion.ts', { './horarioRecogida': horarioReal }),
    '@/src/utils/pickImage': {},
    '@/src/utils/hora': load('src/utils/hora.ts'),
    '@/constants/Colors': { Colors: {} },
    '@/components/HoraPicker': { __esModule: true, default: function HoraPicker({ label, value, onChange }) {
      return { type: 'Button', props: { onPress: () => onChange(value), accessibilityLabel: label, children: value } };
    } },
    '@/components/CalendarioPicker': { __esModule: true, default: function CalendarioPicker({ label, value, onChange }) {
      return { type: 'Button', props: { onPress: () => onChange(value), accessibilityLabel: label, children: value } };
    } },
    ...extraMocks,
  };
  const Component = load(file, mocks).default;
  return { tree: Component(), alerts, navigation, render() { h.reset(); return Component(); } };
}

// ── 1-3: Payload tipado — crear/editar bolsa y cupón ─────────────────────────

test('bolsas.tsx: crear bolsa manda negocio_id, tipo="bolsa" y fecha_disponible/fecha_caducidad en formato canónico', async () => {
  const calls = [];
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan del día', descripcion: '', contenido: 'Pan variado',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: '2026-01-01', fecha_caducidad: '2026-12-31', categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false,
    es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  // items, loading, refreshing, modal, form, editId, negocioId, uploadingFoto, uploadFotoError, tabVista, saving
  const states = [[], false, false, true, form, null, 'negocio-1', false, '', 'todos', false];
  const result = uiRestaurante('app/restaurante/bolsas.tsx', states, {
    '@/src/services/api': {
      bolsasAPI: { crear: async p => { calls.push(p); return { data: { id: 'nueva' } }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  assert.ok(button);
  await button.props.onPress(); await tick();
  assert.equal(calls.length, 1);
  const payload = calls[0];
  assert.equal(payload.negocio_id, 'negocio-1');
  assert.equal(payload.tipo, 'bolsa');
  assert.equal(payload.nombre, 'Pan del día');
  assert.equal(payload.precio_original, 40);
  assert.equal(payload.precio_descuento, 20);
  assert.equal(typeof payload.precio_original, 'number');
  assert.equal(payload.cantidad_disponible, 5);
  assert.equal(payload.fecha_disponible, '2026-01-01');
  assert.equal(payload.fecha_caducidad, '2026-12-31');
  assert.equal(payload.peso_estimado_kg, 0.5);
  assert.equal(payload.categoria, undefined, 'categoria (tipo de descuento) solo aplica a cupones');
});

test('bolsas.tsx: editar bolsa NO manda negocio_id (PUT lo ignora, ver backend/routes/bolsas.js)', async () => {
  const calls = [];
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan del día', descripcion: '', contenido: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: '2026-01-01', fecha_caducidad: '2026-12-31', categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false,
    es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  const states = [[], false, false, true, form, 'bolsa-existente', 'negocio-1', false, '', 'todos', false];
  const result = uiRestaurante('app/restaurante/bolsas.tsx', states, {
    '@/src/services/api': {
      bolsasAPI: { actualizar: async (id, p) => { calls.push([id, p]); return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  await button.props.onPress(); await tick();
  assert.equal(calls.length, 1);
  const [id, payload] = calls[0];
  assert.equal(id, 'bolsa-existente');
  assert.equal('negocio_id' in payload, false);
});

test('cupones.tsx: crear cupón manda tipo="cupon" y negocio_id; editar NO manda negocio_id', async () => {
  const form = {
    nombre: 'Miércoles feliz', contenido: 'bocara20', categoria: 'Porcentaje', descripcion: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '3',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
  };
  // cupones, loading, refreshing, modal, editando, saving, negocioId, form
  const crearCalls = [];
  const crear = uiRestaurante('app/restaurante/cupones.tsx', [[], false, false, true, null, false, 'negocio-1', form], {
    '@/src/services/api': {
      bolsasAPI: { crear: async p => { crearCalls.push(p); return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const crearBtn = walk(crear.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  await crearBtn.props.onPress(); await tick();
  assert.equal(crearCalls.length, 1);
  assert.equal(crearCalls[0].tipo, 'cupon');
  assert.equal(crearCalls[0].negocio_id, 'negocio-1');
  assert.equal(crearCalls[0].contenido, 'BOCARA20', 'código de cupón siempre en mayúsculas');

  const actualizarCalls = [];
  const editar = uiRestaurante('app/restaurante/cupones.tsx', [[], false, false, true, { id: 'cupon-1' }, false, 'negocio-1', form], {
    '@/src/services/api': {
      bolsasAPI: { actualizar: async (id, p) => { actualizarCalls.push([id, p]); return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const editarBtn = walk(editar.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  await editarBtn.props.onPress(); await tick();
  assert.equal(actualizarCalls.length, 1);
  assert.equal('negocio_id' in actualizarCalls[0][1], false);
});

// ── Doble submit bloqueado / loading visible / error no limpia el formulario ─

// El botón real deshabilita onPress mientras saving=true (disabled={saving} en
// la TouchableOpacity) — un segundo toque nativo ni siquiera llega a invocar
// el handler. La guarda interna `if (saving) return` es la segunda línea de
// defensa: protege el re-render con saving=true, no la MISMA invocación en
// curso (ahí el cierre todavía capturó saving=false, igual que en React real).
test('bolsas.tsx: tras el primer toque, el botón queda deshabilitado y un segundo submit no duplica la llamada', async () => {
  let intentos = 0;
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan', descripcion: '', contenido: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: '2026-01-01', fecha_caducidad: '2026-12-31', categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false,
    es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  const states = [[], false, false, true, form, null, 'negocio-1', false, '', 'todos', false];
  let resolver;
  const pending = new Promise(r => { resolver = r; });
  const result = uiRestaurante('app/restaurante/bolsas.tsx', states, {
    '@/src/services/api': {
      bolsasAPI: { crear: async p => { intentos++; await pending; return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  const p1 = button.props.onPress(); // saving=true se setea sincrónicamente antes del primer await
  const rerendido = result.render();
  const button2 = walk(rerendido).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  assert.equal(button2.props.disabled, true, 'un segundo toque real no llegaría a invocar onPress');
  await button2.props.onPress(); // aun invocándolo directamente, la guarda interna lo bloquea
  resolver(); await p1; await tick();
  assert.equal(intentos, 1);
});

test('cupones.tsx: tras el primer toque, el botón queda deshabilitado y un segundo submit no duplica la llamada', async () => {
  let intentos = 0;
  const form = {
    nombre: 'Miércoles feliz', contenido: 'BOCARA20', categoria: 'Porcentaje', descripcion: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '3',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
  };
  let resolver;
  const pending = new Promise(r => { resolver = r; });
  const result = uiRestaurante('app/restaurante/cupones.tsx', [[], false, false, true, null, false, 'negocio-1', form], {
    '@/src/services/api': {
      bolsasAPI: { crear: async p => { intentos++; await pending; return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  const p1 = button.props.onPress();
  const rerendido = result.render();
  const button2 = walk(rerendido).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  assert.equal(button2.props.disabled, true, 'un segundo toque real no llegaría a invocar onPress');
  await button2.props.onPress();
  resolver(); await p1; await tick();
  assert.equal(intentos, 1);
});

test('bolsas.tsx: si el submit falla, el modal permanece abierto y el formulario no se limpia', async () => {
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan', descripcion: '', contenido: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: '2026-01-01', fecha_caducidad: '2026-12-31', categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false,
    es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  const states = [[], false, false, true, form, null, 'negocio-1', false, '', 'todos', false];
  const result = uiRestaurante('app/restaurante/bolsas.tsx', states, {
    '@/src/services/api': {
      bolsasAPI: { crear: async () => { throw new Error('Ya existe una publicación activa con ese nombre'); }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  await button.props.onPress(); await tick();
  assert.ok(result.alerts.some(args => args.join(' ').includes('Ya existe una publicación activa')), 'el error del backend se muestra');
  const tree = result.render();
  // El modal sigue montado en modo creación (no se cerró) y los precios cargados
  // siguen ahí: si el form se hubiera limpiado, este bloque (que depende de
  // precio_original/precio_descuento) desaparecería. bolsas.tsx envuelve nombre
  // en un componente <Field> propio que este renderer no ejecuta, así que se
  // verifica con este bloque, que sí está inline en el JSX principal.
  const texto = textOf(tree);
  assert.ok(texto.includes('Nueva publicación'));
  // textOf inserta espacios entre fragmentos JSX interpolados (el '%' es un
  // nodo de texto separado del número), así que se comprueban por separado.
  assert.ok(texto.includes('Descuento:') && texto.includes('50') && texto.includes('ahorra'),
    'los precios ingresados no se perdieron tras el error');
});

test('bolsas.tsx: muestra loading (spinner) en vez del botón Guardar mientras el submit está en curso', async () => {
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan', descripcion: '', contenido: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
    peso_estimado_kg: '0.5', activo: true, categoria: 'Porcentaje',
    fecha_disponible: '2026-01-01', fecha_caducidad: '2026-12-31', categoria_alimento: 'cereales', categoria_menu: '',
    es_tiempo_limitado: true, es_promocion: false, es_descuento: false,
    es_destacado: false, es_mas_vendido: false, es_precio_bajo: false,
  };
  const states = [[], false, false, true, form, null, 'negocio-1', false, '', 'todos', false];
  let resolver;
  const pending = new Promise(r => { resolver = r; });
  const result = uiRestaurante('app/restaurante/bolsas.tsx', states, {
    '@/src/services/api': {
      bolsasAPI: { crear: async () => { await pending; return { data: {} }; }, listar: async () => ({ data: [] }) },
      negociosAPI: { miNegocio: async () => ({ data: { id: 'negocio-1' } }) },
    },
  });
  const button = walk(result.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  const promise = button.props.onPress(); // no await todavía: submit en curso
  await tick();
  const tree = result.render();
  assert.ok(walk(tree).some(n => n.type === 'Spinner'), 'se muestra un spinner mientras saving=true');
  resolver(); await promise;
});

// ── Normalización de tipo de publicación ─────────────────────────────────────

test('tipoPublicacion: normaliza cualquier valor que no sea "cupon" como "bolsa"', () => {
  for (const raro of [null, undefined, '', 'merma', 'BOLSA', 'CUPON', 'promocion']) {
    assert.equal(tipoPublicacionReal.etiquetaTipoProducto(raro), 'Tiempo limitado', String(raro));
    assert.equal(tipoPublicacionReal.etiquetaTipoProductoCorta(raro), 'T. LIMITADO', String(raro));
    assert.equal(tipoPublicacionReal.emojiTipoProducto(raro), '⏱️', String(raro));
  }
  assert.equal(tipoPublicacionReal.etiquetaTipoProducto('cupon'), 'Promoción');
  assert.equal(tipoPublicacionReal.etiquetaTipoProductoCorta('cupon'), 'PROMO');
  assert.equal(tipoPublicacionReal.emojiTipoProducto('cupon'), '🏷️');
});

// ── Etiquetas cliente: consistentes en detalle, tienda y tarjeta compartida ──

test('Etiquetas cliente: ProductCard compartido muestra el tipo con el mismo texto que el helper', () => {
  const h = hooks();
  const native = { View: 'View', Text: 'Text', TouchableOpacity: 'Button', StyleSheet: { create: x => x }, Dimensions: { get: () => ({ width: 400 }) } };
  const Component = load('components/ProductCard.tsx', {
    react: h.react, 'react-native': native, 'expo-image': {}, '@expo/vector-icons': {}, 'expo-router': { useRouter: () => ({}) },
    '@/src/utils/usePublicacionesVigentes': relojMock, '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/stock': load('src/utils/stock.ts', {}), '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/context/CartContext': { useCart: () => ({ loaded: true, items: [] }) }, '@/src/services/api': {},
    '@/src/utils/cartFeedback': { mostrarErrorCarrito: () => false },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
  }).default;
  const render = b => { h.reset(); return Component({ bolsa: b, onAgregar: () => ({ ok: true }) }); };
  assert.ok(textOf(render(bolsa({ tipo: 'bolsa' }))).includes('T. LIMITADO'));
  assert.ok(textOf(render(bolsa({ tipo: 'cupon' }))).includes('PROMO'));
});

test('Etiquetas cliente: detalle de producto usa "Promoción" (no "Cupón") y agrega etiqueta para bolsas de tiempo limitado', () => {
  const h = hooks(); h.forcedStates.push(bolsa({ tipo: 'cupon' }), false);
  const alerts = [];
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', StyleSheet: { create: x => x, absoluteFillObject: {} },
    Dimensions: { get: () => ({ height: 800 }) }, Platform: { OS: 'android' }, StatusBar: {}, Alert: { alert: (...a) => alerts.push(a) }, Share: { share: () => {} } };
  const mocks = {
    react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({ id: 'b1' }) },
    '@/src/services/api': {}, '@/src/context/CartContext': { useCart: () => ({ loaded: true, items: [], agregar: () => ({ ok: true }) }) },
    '@/src/utils/cartFeedback': { mostrarErrorCarrito: () => false },
    '@/src/utils/horarioRecogida': horarioReal, '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/utils/stock': load('src/utils/stock.ts', {}), '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/backNavigation': { volver: () => {} },
  };
  const Component = load('app/producto/[id].tsx', mocks).default;
  const cuponText = textOf(Component());
  assert.ok(cuponText.includes('Promoción'));
  assert.equal(cuponText.includes('Cupón'), false, 'ya no debe usar la palabra "Cupón", inconsistente con el resto de la app');

  const h2 = hooks(); h2.forcedStates.push(bolsa({ tipo: 'bolsa' }), false);
  const Component2 = load('app/producto/[id].tsx', { ...mocks, react: h2.react }).default;
  assert.ok(textOf(Component2()).includes('Tiempo limitado'), 'antes no había ninguna etiqueta de tipo para bolsas');
});

// ── Ganancias: % de comisión desde datos + historial de pagos mensual ───────

const nativeSimple = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
  ActivityIndicator: 'Spinner', RefreshControl: 'RefreshControl', StyleSheet: { create: x => x } };

// Estado forzado por posición: periodo, mes, data, loading, refreshing, mesBuscado.
function montarGanancias(data, { mesBuscado = '' } = {}) {
  const h = hooks();
  h.forcedStates.push('mes', '2026-10', data, false, false, mesBuscado);
  const Component = load('app/restaurante/ganancias.tsx', {
    react: h.react, 'react-native': nativeSimple,
    '@/src/services/api': { negociosAPI: { ganancias: async () => ({ data }) } },
    '@/constants/Colors': { Colors: {} },
    '@/components/CalendarioPicker': { __esModule: true, default: 'Calendario' },
    '@/src/utils/horarioRecogida': horarioReal,
  }).default;
  const render = () => { h.reset(); return Component(); };
  return { render, texto: () => textOf(render()) };
}

const dataGanancias = (overrides = {}) => ({
  resumen: { total_pedidos: 4, ventas_brutas: 100, comision_bocara: 40, neto_restaurante: 60, total_a_recibir: 60 },
  desglose_tipos: {
    tiempo_limitado: { ventas: 100, comision_bocara: 40, ganancia: 60, unidades: 4, porcentaje_comision: 40 },
    promocion: { ventas: 0, comision_bocara: 0, ganancia: 0, unidades: 0, porcentaje_comision: null },
    propinas: 0, envios: 0, total_a_recibir: 60,
  },
  ...overrides,
});

test('ganancias.tsx: el % de comisión mostrado sale del backend (snapshot), no de un 25% fijo', () => {
  const texto = montarGanancias(dataGanancias()).texto();
  assert.ok(texto.includes('(40%)'), 'debe mostrar el % real cobrado, no 25%');
  assert.ok(texto.includes('(60%)'));
  assert.equal(texto.includes('(25%)'), false);
});

test('ganancias.tsx: sin ventas no muestra un porcentaje inventado (nada de NaN%/Infinity%)', () => {
  const texto = montarGanancias({ resumen: { total_pedidos: 0, ventas_brutas: 0, comision_bocara: 0, neto_restaurante: 0, total_a_recibir: 0 } }).texto();
  assert.equal(texto.includes('NaN'), false);
  assert.equal(texto.includes('Infinity'), false);
});

const pagosMensuales = [
  { mes: '2026-09', estado: 'pagado', monto: 120.5, monto_pagado: 120.5, monto_pendiente: 0, total_pedidos: 6, pagado_en: '2026-10-03T15:00:00Z', referencias: ['TRF-9'] },
  { mes: '2026-08', estado: 'parcial', monto: 80, monto_pagado: 50, monto_pendiente: 30, total_pedidos: 3, pagado_en: '2026-09-04T15:00:00Z', referencias: ['TRF-8'] },
];

test('ganancias.tsx: el historial de pagos muestra UN pago por mes con estado y referencia', () => {
  const texto = montarGanancias(dataGanancias({ pagos_mensuales: pagosMensuales })).texto();
  assert.match(texto, /Septiembre 2026/);
  assert.match(texto, /Agosto 2026/);
  assert.match(texto, /Pagado/);
  assert.match(texto, /Pagado en parte/);
  assert.match(texto, /TRF-9/);
  assert.match(texto, /Q\s*120\.50/);
});

test('ganancias.tsx: el buscador por mes filtra el historial y avisa si ese mes no tiene pago', () => {
  const sep = montarGanancias(dataGanancias({ pagos_mensuales: pagosMensuales }), { mesBuscado: '2026-09' }).texto();
  assert.match(sep, /TRF-9/);
  assert.equal(sep.includes('TRF-8'), false, 'solo el mes buscado');
  const jul = montarGanancias(dataGanancias({ pagos_mensuales: pagosMensuales }), { mesBuscado: '2026-07' }).texto();
  assert.match(jul, /Julio 2026 aún no tiene un pago registrado/);
});

// ── Historial de pedidos: estrictamente operativo, sin montos ───────────────

function renderHistorial(pedidos) {
  const h = hooks();
  h.forcedStates.push(pedidos, false, false, 'todo'); // pedidos, loading, refreshing, periodo
  const Component = load('app/restaurante/historial.tsx', {
    react: h.react, 'react-native': nativeSimple,
    'expo-router': { useRouter: () => ({ push() {}, replace() {}, back() {} }) },
    '@/src/services/api': { pedidosAPI: { restaurante: async () => ({ data: pedidos }) } },
    '@/constants/Colors': { Colors: {} },
    '@/components/CalendarioPicker': { __esModule: true, default: 'Calendario' },
    '@/src/utils/horarioRecogida': horarioReal,
  }).default;
  return textOf(Component());
}

test('historial.tsx: lista código, producto, fecha/hora (Guatemala) y estado de cada pedido', () => {
  const texto = renderHistorial([
    // 13/10 18:05 UTC = 12:05 Guatemala
    { id: '1', codigo_recogida: 'AB12', estado: 'completado', created_at: '2026-10-13T18:05:00Z', bolsas: { nombre: 'Bolsa sorpresa' }, cantidad: 2, total: 50, monto_neto_restaurante: 37.5, comision_bocara: 12.5 },
    { id: '2', codigo_recogida: 'CD34', estado: 'en_preparacion', created_at: '2026-10-12T15:00:00Z', bolsas: { nombre: 'Pan dulce' }, total: 20 },
    { id: '3', codigo_recogida: 'EF56', estado: 'cancelado', created_at: '2026-10-12T14:00:00Z', bolsas: { nombre: 'Café' } },
  ]);
  for (const esperado of ['AB12', 'Bolsa sorpresa', '2 unid.', '12:05', '13 de octubre de 2026', 'Recogido',
    'CD34', 'Pan dulce', 'En preparación', 'EF56', 'Cancelado', '12 de octubre de 2026']) {
    assert.ok(texto.includes(esperado), `falta "${esperado}"`);
  }
});

test('historial.tsx: sin resumen financiero — ni montos, ni comisión, ni ganancias', () => {
  const texto = renderHistorial([
    { id: '1', codigo_recogida: 'AB12', estado: 'completado', created_at: '2026-10-13T18:05:00Z', bolsas: { nombre: 'Bolsa' }, total: 50, monto_neto_restaurante: 37.5, comision_bocara: 12.5, propina: 3 },
  ]);
  assert.equal(/Q\s*\d/.test(texto), false, 'no debe mostrar montos en quetzales');
  assert.equal(/comisi[oó]n/i.test(texto), false);
  assert.equal(/Ventas brutas|Tu ganancia|Resumen del período/.test(texto), false);
});

test('historial.tsx: sin pedidos muestra el estado vacío sin NaN', () => {
  const texto = renderHistorial([]);
  assert.match(texto, /No hay pedidos en este período/);
  assert.equal(texto.includes('NaN'), false);
});
