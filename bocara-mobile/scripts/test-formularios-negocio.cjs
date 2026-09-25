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
  cantidad_disponible: 5, tipo: 'bolsa', hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
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
    '@/src/utils/pickImage': {},
    '@/src/utils/hora': load('src/utils/hora.ts'),
    '@/constants/Colors': { Colors: {} },
    ...extraMocks,
  };
  const Component = load(file, mocks).default;
  return { tree: Component(), alerts, navigation, render() { h.reset(); return Component(); } };
}

// ── 1-3: Payload tipado — crear/editar bolsa y cupón ─────────────────────────

test('bolsas.tsx: crear bolsa manda negocio_id, tipo="bolsa" y convierte fecha DD/MM/YYYY -> YYYY-MM-DD', async () => {
  const calls = [];
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan del día', descripcion: '', contenido: 'Pan variado',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
    peso_estimado_kg: '0.5', imagen_url: '', activo: true, categoria: 'Porcentaje',
    fecha_caducidad: '31/12/2026', categoria_alimento: 'cereales', categoria_menu: '',
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
  assert.equal(payload.fecha_caducidad, '2026-12-31');
  assert.equal(payload.peso_estimado_kg, 0.5);
  assert.equal(payload.categoria, undefined, 'categoria (tipo de descuento) solo aplica a cupones');
});

test('bolsas.tsx: editar bolsa NO manda negocio_id (PUT lo ignora, ver backend/routes/bolsas.js)', async () => {
  const calls = [];
  const form = {
    tipo_form: 'bolsa', nombre: 'Pan del día', descripcion: '', contenido: '',
    precio_original: '40', precio_descuento: '20', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
    peso_estimado_kg: '0.5', imagen_url: '', activo: true, categoria: 'Porcentaje',
    fecha_caducidad: '31/12/2026', categoria_alimento: 'cereales', categoria_menu: '',
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
    peso_estimado_kg: '0.5', imagen_url: '', activo: true, categoria: 'Porcentaje',
    fecha_caducidad: '31/12/2026', categoria_alimento: 'cereales', categoria_menu: '',
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
    peso_estimado_kg: '0.5', imagen_url: '', activo: true, categoria: 'Porcentaje',
    fecha_caducidad: '31/12/2026', categoria_alimento: 'cereales', categoria_menu: '',
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
    peso_estimado_kg: '0.5', imagen_url: '', activo: true, categoria: 'Porcentaje',
    fecha_caducidad: '31/12/2026', categoria_alimento: 'cereales', categoria_menu: '',
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

// ── Comisión no hardcodeada: derivada de datos, con fallback seguro ─────────

function renderGanancias(resumenOverrides = {}) {
  const h = hooks();
  const data = { resumen: { total_pedidos: 4, ventas_brutas: 100, comision_bocara: 25, neto_restaurante: 75, total_a_recibir: 75, ...resumenOverrides } };
  h.forcedStates.push('mes', data, false, false); // periodo, data, loading, refreshing
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', RefreshControl: 'RefreshControl', StyleSheet: { create: x => x } };
  const Component = load('app/restaurante/ganancias.tsx', {
    react: h.react, 'react-native': native, '@/src/services/api': { negociosAPI: { ganancias: async () => ({ data }) } },
    '@/constants/Colors': { Colors: {} },
  }).default;
  return textOf(Component());
}

test('ganancias.tsx: el % de comisión mostrado se deriva de comision_bocara/ventas_brutas, no de un 25% fijo', () => {
  // 40% real (p.ej. un período con configuración de comisión distinta a la actual)
  const texto = renderGanancias({ ventas_brutas: 100, comision_bocara: 40, neto_restaurante: 60 });
  assert.ok(texto.includes('(40%)'), 'debe mostrar el % real derivado de los montos, no 25%');
  assert.ok(texto.includes('(60%)'));
  assert.equal(texto.includes('(25%)'), false);
});

test('ganancias.tsx: sin ventas (ventas_brutas=0) no muestra un porcentaje inventado (nada de NaN%/Infinity%)', () => {
  const texto = renderGanancias({ total_pedidos: 0, ventas_brutas: 0, comision_bocara: 0, neto_restaurante: 0, total_a_recibir: 0 });
  assert.equal(texto.includes('NaN'), false);
  assert.equal(texto.includes('Infinity'), false);
});

function renderHistorial(pedidos) {
  const h = hooks();
  h.forcedStates.push(pedidos, false, false, '7d', null); // pedidos, loading, refreshing, periodo, expandido
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', RefreshControl: 'RefreshControl', StyleSheet: { create: x => x } };
  const Component = load('app/restaurante/historial.tsx', {
    react: h.react, 'react-native': native, '@/src/services/api': { pedidosAPI: { restaurante: async () => ({ data: pedidos }) } },
    '@/constants/Colors': { Colors: {} },
  }).default;
  return textOf(Component());
}

test('historial.tsx: el % de comisión del resumen y de la nota se derivan de los pedidos reales del período', () => {
  const ahora = new Date().toISOString();
  const pedidos = [
    { id: '1', estado: 'completado', created_at: ahora, precio_bolsa: 100, comision_bocara: 30, monto_neto_restaurante: 70, propina: 0 },
  ];
  const texto = renderHistorial(pedidos);
  assert.ok(texto.includes('(30%)'), 'resumen debe reflejar el 30% real de este pedido, no 25%');
  assert.ok(texto.includes('70% + propina'), 'la ganancia del restaurante es el 70% restante, no el 75% fijo');
  assert.ok(texto.includes('retuvo el 30%'));
});

test('historial.tsx: sin pedidos en el período, la nota de comisión no afirma un 25% que no ocurrió', () => {
  const texto = renderHistorial([]);
  assert.equal(texto.includes('25%'), false);
  assert.equal(texto.includes('NaN'), false);
});
