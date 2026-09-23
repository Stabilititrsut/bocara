// Ejecutar: node scripts/test-stock-real.cjs. Sin red, Expo ni dependencias nuevas.
// Cubre el criterio "Detalle/carrito usan disponibilidad real; UX agotado/retry":
// cantidad_disponible_real como fuente de verdad (con fallback a cantidad_disponible),
// revalidación del carrito, bloqueo de checkout agotado, y refresco tras 400/409.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}, globals = {}, extraSource = '') {
  const exports = {};
  const source = fs.readFileSync(path.join(root, file), 'utf8') + extraSource;
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, console, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exports;
}
const horarioReal = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
const stockReal = load('src/utils/stock.ts', {});
const tipoPublicacionReal = load('src/utils/tipoPublicacion.ts', {});
const relojMock = { useRelojPublicaciones: () => new Date(), usePublicacionesVigentes: items => horarioReal.publicacionesVigentes(items) };
const { createCartStore, createCartPersistence } = load('src/context/cartStore.ts', { '../utils/horarioRecogida': horarioReal, '../utils/stock': stockReal });
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const bolsa = (stock = 3, negocio = 'rest-1', id = 'bolsa-1', real) => ({
  id, negocio_id: negocio, nombre: id, precio_original: 40, precio_descuento: 20,
  cantidad_disponible: stock, ...(real !== undefined ? { cantidad_disponible_real: real } : {}),
  tipo: 'bolsa', hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
});
const ids = store => Array.from(store.getSnapshot().items, i => i.bolsa.id);
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return { values, writes,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { writes.push([key, value]); values.set(key, value); },
  };
}

// ── 1-3: disponibilidadReal / campoDisponibilidad — fuente de verdad y fallback ──

test('disponibilidadReal usa cantidad_disponible_real aunque cantidad_disponible sea mayor (real=0 -> agotado)', () => {
  assert.equal(stockReal.disponibilidadReal({ cantidad_disponible: 5, cantidad_disponible_real: 0 }), 0);
});

test('disponibilidadReal usa real=1 como máximo aunque el histórico sea mayor', () => {
  assert.equal(stockReal.disponibilidadReal({ cantidad_disponible: 5, cantidad_disponible_real: 1 }), 1);
});

test('disponibilidadReal cae a cantidad_disponible cuando el backend no manda el campo real', () => {
  assert.equal(stockReal.disponibilidadReal({ cantidad_disponible: 5 }), 5);
  assert.equal(stockReal.disponibilidadReal(null), 0);
});

test('textoDisponibilidad singular/plural y agotado', () => {
  assert.equal(stockReal.textoDisponibilidad(0), 'Agotado');
  assert.equal(stockReal.textoDisponibilidad(1), 'Solo queda 1 unidad disponible');
  assert.equal(stockReal.textoDisponibilidad(4), 'Quedan 4 unidades disponibles');
});

test('cartStore.agregar respeta cantidad_disponible_real por encima del histórico', async () => {
  const cart = createCartStore('A', createCartPersistence(storage())); cart.activate(); await tick();
  // histórico dice 5, real dice 1: el primer agregar debe pasar y el segundo debe topar en 1, no en 5.
  assert.equal(cart.agregar(bolsa(5, 'rest-1', 'b1', 1)).ok, true);
  const segundo = cart.agregar(bolsa(5, 'rest-1', 'b1', 1));
  assert.equal(segundo.motivo, 'limite_stock');
  assert.equal(segundo.stockDisponible, 1);
  assert.equal(cart.getSnapshot().items[0].cantidad, 1);
});

test('cartStore.agregar usa cantidad_disponible como fallback si no llega cantidad_disponible_real', async () => {
  const cart = createCartStore('A', createCartPersistence(storage())); cart.activate(); await tick();
  assert.equal(cart.agregar(bolsa(1, 'rest-1', 'b1')).ok, true); // sin campo real, histórico=1
  assert.equal(cart.agregar(bolsa(1, 'rest-1', 'b1')).motivo, 'limite_stock');
});

test('doble tap no supera el stock real: dos llamadas sincrónicas de agregar respetan real=1', async () => {
  const cart = createCartStore('A', createCartPersistence(storage())); cart.activate(); await tick();
  const b = bolsa(9, 'rest-1', 'b1', 1);
  const [r1, r2] = [cart.agregar(b), cart.agregar(b)];
  assert.equal(r1.ok, true);
  assert.equal(r2.motivo, 'limite_stock');
  assert.equal(cart.getSnapshot().items[0].cantidad, 1);
});

// ── 4, 10: sincronizarDisponibilidad — revalidación de carrito ──

test('sincronizarDisponibilidad recorta cantidad 3 -> 1 cuando el real baja, sin borrar el item', async () => {
  const disk = storage();
  const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
  cart.agregar(bolsa(5, 'rest-1', 'b1', 5));
  cart.agregar(bolsa(5, 'rest-1', 'b1', 5));
  cart.agregar(bolsa(5, 'rest-1', 'b1', 5));
  await tick();
  assert.equal(cart.getSnapshot().items[0].cantidad, 3);
  cart.sincronizarDisponibilidad({ b1: 1 }); await tick();
  assert.equal(cart.getSnapshot().items[0].cantidad, 1);
  assert.equal(cart.getSnapshot().items[0].bolsa.cantidad_disponible_real, 1);
  assert.deepEqual(ids(cart), ['b1'], 'el item se conserva, no se borra silenciosamente');
});

test('sincronizarDisponibilidad marca real=0 como agotado sin borrar el item; quitar lo retira', async () => {
  const disk = storage();
  const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
  cart.agregar(bolsa(5, 'rest-1', 'b1', 5)); cart.agregar(bolsa(5, 'rest-1', 'b1', 5)); await tick();
  cart.sincronizarDisponibilidad({ b1: 0 }); await tick();
  assert.equal(cart.getSnapshot().items[0].cantidad, 2, 'cantidad deseada se conserva para mostrarla junto al aviso de agotado');
  assert.equal(cart.getSnapshot().items[0].bolsa.cantidad_disponible_real, 0);
  cart.quitar('b1'); cart.quitar('b1'); await tick();
  assert.deepEqual(ids(cart), []);
});

test('hidratación no resucita una cantidad superior al stock real actual tras revalidar', async () => {
  const saved = JSON.stringify([{ bolsa: bolsa(5, 'rest-1', 'b1', 5), cantidad: 5 }]);
  const disk = storage({ A: saved });
  const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
  assert.equal(cart.getSnapshot().items[0].cantidad, 5, 'hidratación por sí sola conserva el histórico persistido');
  cart.sincronizarDisponibilidad({ b1: 2 }); await tick();
  assert.equal(cart.getSnapshot().items[0].cantidad, 2);
  assert.equal(JSON.parse(disk.values.get('A'))[0].cantidad, 2, 'la cantidad recortada queda persistida');
});

test('sincronizarDisponibilidad es no-op si no hay cambios (no genera escrituras extra)', async () => {
  const disk = storage();
  const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
  cart.agregar(bolsa(5, 'rest-1', 'b1', 5)); await tick();
  const writesAntes = disk.writes.length;
  cart.sincronizarDisponibilidad({ b1: 5 }); await tick();
  assert.equal(disk.writes.length, writesAntes);
});

// ── UI: producto y carrito ──

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
function ui(file, cart, forcedStates = [], extraMocks = {}, extraSource = '') {
  const h = hooks(); h.forcedStates.push(...forcedStates); const alerts = [], navigation = [];
  let focusEffect;
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image',
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Dimensions: { get: () => ({ width: 400, height: 800 }) },
    Platform: { OS: 'android' }, StatusBar: {}, Alert: { alert: (...args) => alerts.push(args) } };
  const feedback = load('src/utils/cartFeedback.ts', { 'react-native': native });
  const mocks = { react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    '@/components/ProductCard': { __esModule: true, default: 'ProductCard', CARD_W: 170 },
    'expo-router': { useRouter: () => ({ push: p => navigation.push(p), replace: p => navigation.push(p) }), useFocusEffect: effect => { focusEffect = effect; }, useLocalSearchParams: () => ({ id: 'bolsa-1' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/context/CartContext': { useCart: () => cart }, '@/src/utils/cartFeedback': feedback,
    '@/src/utils/horarioRecogida': load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } }),
    '@/src/utils/stock': stockReal,
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    '@/constants/Colors': { Colors: {} }, '@/src/services/api': {},
    '@react-native-async-storage/async-storage': {}, 'expo-web-browser': {},
    '@/src/utils/backNavigation': { volver: (router, fallback) => router.replace(fallback) },
    ...extraMocks,
  };
  const Component = load(file, mocks, {}, extraSource).default;
  return { tree: Component(), alerts, navigation,
    render() { h.reset(); return Component(); },
    focus() { return focusEffect?.(); },
  };
}

test('Detalle: producto con real=0 se muestra agotado aunque el histórico diga 5', () => {
  const b = bolsa(5, 'rest-1', 'b1', 0);
  const result = ui('app/producto/[id].tsx', { loaded: true, items: [], agregar: () => ({ ok: true }) }, [b, false]);
  assert.ok(textOf(result.tree).includes('Agotado'));
  assert.equal(walk(result.tree).some(n => n.type === 'Button' && textOf(n).includes('Agregar al carrito')), false);
});

test('Detalle: real=1 se muestra como "Solo queda 1 unidad disponible"', () => {
  const b = bolsa(9, 'rest-1', 'b1', 1);
  const result = ui('app/producto/[id].tsx', { loaded: true, items: [], agregar: () => ({ ok: true }) }, [b, false]);
  assert.ok(textOf(result.tree).includes('Solo queda 1 unidad disponible'));
});

test('Carrito: item con real=0 bloquea checkout y no navega aunque se presione el botón', () => {
  const cart = { loaded: true, items: [{ bolsa: bolsa(5, 'rest-1', 'b1', 0), cantidad: 2 }], total: 40, storageError: null,
    agregar: () => ({ ok: true }), quitar: () => {}, limpiar: () => {}, sincronizarDisponibilidad: () => {} };
  const result = ui('app/(tabs)/carrito.tsx', cart, [], { '@/src/services/api': { bolsasAPI: { detalle: async () => ({ data: {} }) } } });
  assert.ok(textOf(result.tree).includes('Agotado'));
  const button = walk(result.tree).find(n => n.type === 'Button' && textOf(n).includes('Proceder al pago'));
  assert.equal(button.props.disabled, true);
  button.props.onPress();
  assert.equal(result.navigation.length, 0);
});

test('Carrito: al enfocar, revalida contra el backend y recorta la cantidad si el real bajó', async () => {
  const disk = storage();
  const store = createCartStore('A', createCartPersistence(disk)); store.activate(); await tick();
  store.agregar(bolsa(9, 'rest-1', 'b1', 9)); store.agregar(bolsa(9, 'rest-1', 'b1', 9)); store.agregar(bolsa(9, 'rest-1', 'b1', 9)); await tick();
  const snap = () => store.getSnapshot();
  const cart = { get loaded() { return snap().loaded; }, get items() { return snap().items; }, get storageError() { return snap().storageError; },
    total: 60, agregar: store.agregar, quitar: store.quitar, limpiar: store.limpiar, sincronizarDisponibilidad: store.sincronizarDisponibilidad };
  let llamados = 0;
  const result = ui('app/(tabs)/carrito.tsx', cart, [], {
    '@/src/services/api': { bolsasAPI: { detalle: async (id) => { llamados++; return { data: { id, cantidad_disponible: 9, cantidad_disponible_real: 1 } }; } } },
  });
  assert.equal(store.getSnapshot().items[0].cantidad, 3);
  result.focus(); await tick();
  assert.equal(llamados, 1);
  assert.equal(store.getSnapshot().items[0].cantidad, 1, 'la revalidación al enfocar recorta la cantidad al real actual');
});

test('Carrito: error de red al revalidar muestra aviso con reintento y conserva el carrito', async () => {
  const cart = { loaded: true, items: [{ bolsa: bolsa(5, 'rest-1', 'b1', 5), cantidad: 1 }], total: 20, storageError: null,
    agregar: () => ({ ok: true }), quitar: () => {}, limpiar: () => {}, sincronizarDisponibilidad: () => { throw new Error('no debería llamarse'); } };
  const result = ui('app/(tabs)/carrito.tsx', cart, [], {
    '@/src/services/api': { bolsasAPI: { detalle: async () => { throw new Error('network'); } } },
  });
  result.focus(); await tick();
  const tree = result.render();
  assert.ok(textOf(tree).includes('No pudimos verificar la disponibilidad'));
  assert.ok(walk(tree).some(n => n.type === 'Button' && textOf(n).includes('Reintentar')));
  assert.equal(cart.items.length, 1, 'el carrito no se vacía ante un fallo de red');
});

// PagoContent no se exporta desde app/pago.tsx (solo PagoScreen, que decide si
// montarlo) — se expone acá igual que el harness ya hace con ProductCard en
// tienda/[id].tsx, agregando un export al final del código transpilado.
function pagoContentHarness(cart, apiMocks) {
  const h = hooks(); h.forcedStates.push('pedido-1', 'listo'); // pedidoId, fase
  const navigation = [];
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image',
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Platform: { OS: 'android' }, StatusBar: {} };
  const mocks = {
    react: h.react, 'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {}, replace: p => navigation.push(p) }) },
    'expo-web-browser': { openBrowserAsync: async () => {} },
    '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {} },
    '@/src/context/CartContext': { useCart: () => cart },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/utils/backNavigation': { volver: (router, fallback) => router.replace?.(fallback) },
    '@/src/services/api': { pedidosAPI: {}, cuponesAPI: {}, ...apiMocks },
  };
  const { PagoContent } = load('app/pago.tsx', mocks, {}, '\nexport { PagoContent };');
  return { navigation, render() { h.reset(); return PagoContent(); } };
}

test('Pago: 409 al generar el link refresca disponibilidad, muestra el mensaje del backend y nunca éxito', async () => {
  const sincronizaciones = [];
  const cart = {
    items: [{ bolsa: bolsa(5, 'rest-1', 'b1', 5), cantidad: 1 }], total: 20, limpiar: () => {},
    sincronizarDisponibilidad: (actualizaciones) => sincronizaciones.push(actualizaciones),
  };
  const h = pagoContentHarness(cart, {
    pagosAPI: { generarLink: async () => { const e = new Error('"Pan": solo queda 1 unidad disponible.'); e.status = 409; throw e; } },
    bolsasAPI: { detalle: async () => ({ data: { id: 'b1', cantidad_disponible: 5, cantidad_disponible_real: 1 } }) },
  });
  const tree = h.render();
  const button = walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Pagar'));
  assert.ok(button, 'botón Pagar visible en fase listo');
  await button.props.onPress(); await tick();
  assert.equal(sincronizaciones.length, 1);
  // sincronizaciones[0] se construye dentro del módulo cargado en su propio
  // realm de vm; comparar por JSON evita el falso negativo de deepEqual por
  // prototipos de distinto realm en vez de por valor.
  assert.equal(JSON.stringify(sincronizaciones[0]), JSON.stringify({ b1: 1 }));
  const after = h.render();
  assert.ok(textOf(after).includes('solo queda 1 unidad disponible'));
  assert.equal(h.navigation.length, 0, 'jamás navega a éxito (qr-recogida) ante un 409');
});

test('Pago: retry tras 409 continúa si el backend ya tiene stock', async () => {
  let intentos = 0;
  const cart = { items: [{ bolsa: bolsa(5, 'rest-1', 'b1', 5), cantidad: 1 }], total: 20, limpiar: () => {}, sincronizarDisponibilidad: () => {} };
  const h = pagoContentHarness(cart, {
    pagosAPI: {
      generarLink: async () => {
        intentos++;
        if (intentos === 1) { const e = new Error('sin stock'); e.status = 409; throw e; }
        return { data: { visaLinkUrl: 'https://cubo.test/pagar' } };
      },
    },
    bolsasAPI: { detalle: async () => ({ data: { id: 'b1', cantidad_disponible: 5, cantidad_disponible_real: 0 } }) },
  });
  let tree = h.render();
  await walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Pagar')).props.onPress(); await tick();
  tree = h.render();
  assert.ok(textOf(tree).includes('No se pudo procesar el pago'));
  const reintentar = walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Reintentar'));
  reintentar.props.onPress(); // handleReintentar en fase 'generar' solo limpia el error; no repite la llamada
  tree = h.render();
  const pagar = walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Pagar'));
  assert.ok(pagar, 'tras reintentar vuelve a ofrecer el botón Pagar');
  await pagar.props.onPress(); await tick();
  assert.equal(intentos, 2);
  tree = h.render();
  assert.equal(textOf(tree).includes('No se pudo procesar el pago'), false, 'el segundo intento ya no falla');
});

test('Pago: 400 al preparar (stock insuficiente) refresca disponibilidad y permite reintentar', async () => {
  const sincronizaciones = [];
  let intentos = 0;
  const cart = {
    items: [{ bolsa: bolsa(5, 'rest-1', 'b1', 5), cantidad: 2 }], total: 40, limpiar: () => {},
    sincronizarDisponibilidad: (actualizaciones) => sincronizaciones.push(actualizaciones),
  };
  const h = hooks(); h.forcedStates.push(null, 'error', '', 'preparar'); // pedidoId, fase, errorMsg, errorFase
  const navigation = [];
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image',
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Platform: { OS: 'android' }, StatusBar: {} };
  const mocks = {
    react: h.react, 'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {}, replace: p => navigation.push(p) }) },
    'expo-web-browser': {}, '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {} },
    '@/src/context/CartContext': { useCart: () => cart },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/utils/backNavigation': { volver: (router, fallback) => router.replace?.(fallback) },
    '@/src/services/api': {
      pedidosAPI: {}, cuponesAPI: {},
      pagosAPI: {
        preparar: async () => {
          intentos++;
          if (intentos === 1) { const e = new Error('"Pan": solo queda 1 unidad disponible.'); e.status = 400; throw e; }
          return { data: { pedidoId: 'pedido-1', codigoRecogida: 'BOC-1', total: 40 } };
        },
      },
      bolsasAPI: { detalle: async () => ({ data: { id: 'b1', cantidad_disponible: 5, cantidad_disponible_real: 1 } }) },
    },
  };
  const { PagoContent } = load('app/pago.tsx', mocks, {}, '\nexport { PagoContent };');
  const render = () => { h.reset(); return PagoContent(); };
  let tree = render();
  assert.ok(textOf(tree).includes('No se pudo procesar el pago'));
  const reintentar = walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Reintentar'));
  await reintentar.props.onPress(); await tick();
  assert.equal(sincronizaciones.length, 1);
  // sincronizaciones[0] se construye dentro del módulo cargado en su propio
  // realm de vm; comparar por JSON evita el falso negativo de deepEqual por
  // prototipos de distinto realm en vez de por valor.
  assert.equal(JSON.stringify(sincronizaciones[0]), JSON.stringify({ b1: 1 }));
  tree = render();
  assert.ok(textOf(tree).includes('solo queda 1 unidad disponible'));
});
