// Ejecutar: node scripts/test-cart.cjs. Sin red, Expo ni dependencias de test nuevas.
// Los doubles de hooks prueban lógica y árboles de UI; no sustituyen pruebas en dispositivo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { ...globals, exports, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exports;
}
const { createCartStore, createCartPersistence } = load('src/context/cartStore.ts');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const bolsa = (stock = 3, negocio = 'rest-1', id = 'bolsa-1') => ({
  id, negocio_id: negocio, nombre: id, precio_original: 40, precio_descuento: 20,
  cantidad_disponible: stock, tipo: 'bolsa', hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
});
const packed = (id, count = 1) => JSON.stringify([{ bolsa: bolsa(3, 'rest-1', id), cantidad: count }]);
const ids = store => Array.from(store.getSnapshot().items, i => i.bolsa.id);
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return { values, writes,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { writes.push([key, value]); values.set(key, value); },
  };
}

test('P1-1 hidratación conserva cantidades y productos con stock histórico inferior, cero o desconocido', async () => {
  for (const stock of [1, 0, null, undefined]) {
    const saved = JSON.stringify([{ bolsa: { ...bolsa(), cantidad_disponible: stock }, cantidad: 3 }]);
    const disk = storage({ A: saved });
    const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
    assert.equal(cart.getSnapshot().loaded, true);
    assert.equal(cart.getSnapshot().items.length, 1);
    assert.equal(cart.getSnapshot().items[0].cantidad, 3);
    assert.equal(disk.writes.length, 0);
    cart.agregar(bolsa(2, 'rest-1', 'nuevo')); await tick();
    assert.equal(JSON.parse(disk.values.get('A'))[0].cantidad, 3, 'otra edición no pierde cantidad restaurada');
  }
});

test('P1-1 hidratación descarta estructura y cantidades corruptas aunque conserve stock histórico', async () => {
  const invalid = [null, {}, { cantidad: 1 }, { bolsa: { ...bolsa(), id: '' }, cantidad: 1 },
    { bolsa: { ...bolsa(), negocio_id: '' }, cantidad: 1 },
    ...['3', null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(cantidad => ({ bolsa: bolsa(), cantidad }))];
  const cart = createCartStore('A', createCartPersistence(storage({ A: JSON.stringify(invalid) })));
  cart.activate(); await tick(); assert.equal(cart.getSnapshot().loaded, true); assert.deepEqual(ids(cart), []);
});

test('P1-2 web muestra cada rechazo con window.alert y ok no muestra error', () => {
  const visible = [], native = [];
  const { mostrarErrorCarrito } = load('src/utils/cartFeedback.ts', {
    'react-native': { Platform: { OS: 'web' }, Alert: { alert: (...args) => native.push(args) } },
  }, { window: { alert: message => visible.push(message) } });
  for (const motivo of ['no_cargado', 'otro_negocio', 'agotado', 'limite_stock', 'stock_invalido', 'producto_invalido']) {
    assert.equal(mostrarErrorCarrito({ ok: false, motivo }), true);
  }
  assert.equal(visible.length, 6); assert.equal(new Set(visible).size, 6);
  assert.ok(visible.every(message => message.includes('\n\n')));
  assert.equal(mostrarErrorCarrito({ ok: true }), false);
  assert.equal(visible.length, 6); assert.equal(native.length, 0);
});

test('P1-2 native conserva Alert para todos los motivos; SSR sin window es seguro', () => {
  for (const OS of ['android', 'ios', 'web']) {
    const calls = [];
    const { mostrarErrorCarrito } = load('src/utils/cartFeedback.ts', {
      'react-native': { Platform: { OS }, Alert: { alert: (...args) => calls.push(args) } },
    });
    for (const motivo of ['no_cargado', 'otro_negocio', 'agotado', 'limite_stock', 'stock_invalido', 'producto_invalido']) {
      assert.equal(mostrarErrorCarrito({ ok: false, motivo }), true);
    }
    assert.equal(mostrarErrorCarrito({ ok: true }), false);
    assert.equal(calls.length, OS === 'web' ? 0 : 6);
  }
});

for (const sequence of [
  ['A', 'anonimo', 'B'], ['A', 'anonimo'], ['anonimo', 'A'], ['A', 'B', 'A'],
]) test(`A3 aislamiento ${sequence.join(' -> ')}`, async () => {
  const disk = storage({ carrito_A: packed('A'), carrito_B: packed('B'), carrito_anonimo: packed('anonimo') });
  const persistence = createCartPersistence(disk);
  let dispose = () => {}, previous;
  for (const account of sequence) {
    dispose();
    const cart = createCartStore(`carrito_${account}`, persistence);
    assert.equal(cart.getSnapshot().loaded, false);
    assert.deepEqual(ids(cart), []);
    dispose = cart.activate(); await tick();
    assert.deepEqual(ids(cart), [account]);
    if (previous) assert.equal(previous.agregar(bolsa()).motivo, 'no_cargado');
    previous = cart;
  }
  dispose(); assert.equal(disk.writes.length, 0, 'hidratar no escribe');
});

test('A3 lectura tardía A no cambia B ni una nueva instancia A', async () => {
  const late = deferred(); let readsA = 0;
  const disk = storage({ carrito_B: packed('B') });
  disk.getItem = key => key === 'carrito_A' ? (++readsA === 1 ? late.promise : Promise.resolve(packed('A-new'))) : Promise.resolve(packed('B'));
  const persistence = createCartPersistence(disk);
  const a = createCartStore('carrito_A', persistence); const stopA = a.activate(); await tick(); stopA();
  const b = createCartStore('carrito_B', persistence); b.activate(); await tick();
  const a2 = createCartStore('carrito_A', persistence); a2.activate(); await tick();
  late.resolve(packed('A-old')); await tick();
  assert.deepEqual(ids(a), []); assert.deepEqual(ids(b), ['B']); assert.deepEqual(ids(a2), ['A-new']);
  assert.equal(disk.writes.length, 0);
});

test('A3 escrituras serializadas y retorno a A espera su última escritura', async () => {
  const disk = storage(); const pending = deferred(); const realWrite = disk.setItem; let count = 0;
  disk.setItem = async (key, value) => { if (++count === 1) await pending.promise; await realWrite(key, value); };
  const persistence = createCartPersistence(disk);
  const a = createCartStore('carrito_A', persistence); const stopA = a.activate(); await tick();
  a.agregar(bolsa()); a.agregar(bolsa()); await tick(); assert.equal(count, 1); stopA();
  const b = createCartStore('carrito_B', persistence); b.activate(); await tick(); assert.equal(b.getSnapshot().loaded, true);
  const a2 = createCartStore('carrito_A', persistence); a2.activate(); await tick(); assert.equal(a2.getSnapshot().loaded, false);
  pending.resolve(); await tick();
  assert.equal(a2.getSnapshot().items[0].cantidad, 2);
  assert.ok(disk.writes.every(([key]) => key === 'carrito_A'));
});

test('A3 errores get/set recuperables y sin sobrescritura automática', async () => {
  const disk = storage({ carrito_A: packed('saved') });
  disk.getItem = async () => { throw new Error('fallo get simulado'); };
  const persistence = createCartPersistence(disk); const cart = createCartStore('carrito_A', persistence);
  cart.activate(); await tick();
  assert.equal(cart.getSnapshot().loaded, true); assert.equal(cart.getSnapshot().storageError, 'lectura');
  assert.equal(disk.writes.length, 0); assert.equal(disk.values.get('carrito_A'), packed('saved'));
  disk.setItem = async () => { throw new Error('fallo set simulado'); };
  assert.equal(cart.agregar(bolsa()).ok, true); await tick();
  assert.equal(cart.getSnapshot().loaded, true); assert.equal(cart.getSnapshot().storageError, 'escritura');
  assert.equal(cart.getSnapshot().items[0].cantidad, 1);
  disk.setItem = async (key, value) => disk.values.set(key, value);
  cart.agregar(bolsa()); await tick(); assert.equal(cart.getSnapshot().storageError, null);
});

test('A3 datos corruptos y cantidades inválidas no bloquean ni generan totales inválidos', async () => {
  for (const raw of ['{', '{}', JSON.stringify([{ bolsa: bolsa(), cantidad: -1 }, { bolsa: bolsa(0), cantidad: 0 }])]) {
    const cart = createCartStore('A', createCartPersistence(storage({ A: raw })));
    cart.activate(); await tick(); assert.equal(cart.getSnapshot().loaded, true); assert.deepEqual(ids(cart), []);
  }
});

test('A4 agotado, inválido, límite, reducción de stock, otro negocio y acciones consecutivas', async () => {
  const cart = createCartStore('A', createCartPersistence(storage()));
  assert.equal(cart.agregar(bolsa()).motivo, 'no_cargado'); cart.activate(); await tick();
  assert.equal(cart.agregar(bolsa(0)).motivo, 'agotado');
  for (const bad of [null, undefined, NaN, Infinity, -1, 1.5, '3']) {
    assert.equal(cart.agregar({ ...bolsa(), cantidad_disponible: bad }).motivo, 'stock_invalido');
    assert.deepEqual(ids(cart), []);
  }
  for (let i = 0; i < 3; i++) assert.equal(cart.agregar(bolsa()).ok, true);
  assert.equal(cart.agregar(bolsa()).motivo, 'limite_stock'); assert.equal(cart.getSnapshot().items[0].cantidad, 3);
  assert.equal(cart.agregar(bolsa(9, 'other')).motivo, 'otro_negocio');
  assert.equal(cart.agregar(bolsa(1)).motivo, 'limite_stock'); assert.equal(cart.getSnapshot().items[0].cantidad, 1);
  assert.equal(cart.agregar(bolsa(0)).motivo, 'agotado'); assert.deepEqual(ids(cart), []);
  cart.quitar('missing'); cart.quitar('missing'); assert.deepEqual(ids(cart), []);
});

test('limpiar durante hidratación no resucita items y queda persistido aunque se desmonte', async () => {
  const pending = deferred(); const disk = storage(); disk.getItem = () => pending.promise;
  const cart = createCartStore('A', createCartPersistence(disk)); const stop = cart.activate(); await tick();
  cart.limpiar(); await tick(); stop(); pending.resolve(packed('old')); await tick();
  assert.deepEqual(ids(cart), []); assert.equal(disk.values.get('A'), '[]');
});

// Renderer mínimo: preserva memo/ref/state y permite separar render de commit.
test('A3 limpieza con escritura fallida conserva aviso al terminar hidratación', async () => {
  const pending = deferred(); const disk = storage(); disk.getItem = () => pending.promise;
  disk.setItem = async () => { throw new Error('simulated'); };
  const cart = createCartStore('A', createCartPersistence(disk)); cart.activate(); await tick();
  cart.limpiar(); await tick(); pending.resolve(packed('old')); await tick();
  assert.equal(cart.getSnapshot().loaded, true); assert.deepEqual(ids(cart), []);
  assert.equal(cart.getSnapshot().storageError, 'escritura');
});

test('A3 ciclo setup-cleanup-setup invalida la primera lectura y mantiene suscripciones', async () => {
  const reads = [deferred(), deferred()]; let index = 0;
  const disk = storage(); disk.getItem = () => reads[index++].promise;
  const cart = createCartStore('A', createCartPersistence(disk)); let updates = 0;
  const unsubscribe = cart.subscribe(() => updates++);
  const stop = cart.activate(); await tick(); stop(); cart.activate(); await tick();
  reads[1].resolve(packed('new')); await tick(); reads[0].resolve(packed('old')); await tick();
  assert.deepEqual(ids(cart), ['new']); assert.equal(updates, 1);
  unsubscribe(); cart.limpiar(); await tick(); assert.equal(updates, 1);
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

test('A3 provider cambia snapshot antes del commit sin exponer A a B; badges y total son cero', async () => {
  const h = hooks(); const disk = storage({ carrito_A: packed('A'), carrito_B: packed('B') });
  const { CartProvider } = load('src/context/CartContext.tsx', { react: h.react,
    '@react-native-async-storage/async-storage': disk, './cartStore': { createCartStore, createCartPersistence } });
  const render = userId => { h.reset(); return CartProvider({ userId, children: null }).props.value; };
  render('A'); h.commit(); await tick(); const a = render('A'); assert.equal(a.items[0].bolsa.id, 'A');
  const b = render('B'); assert.equal(b.loaded, false); assert.equal(b.items.length, 0); assert.equal(b.total, 0); assert.equal(b.cantidad, 0);
  h.commit(); assert.equal(a.agregar(bolsa()).motivo, 'no_cargado'); await tick(); assert.equal(render('B').items[0].bolsa.id, 'B');
});

function walk(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return [node?.props?.children].flat(Infinity).map(textOf).join(' ');
}
function ui(file, cart, forcedStates = []) {
  const h = hooks(); h.forcedStates.push(...forcedStates); const alerts = [], navigation = [];
  let focusEffect;
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image',
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Dimensions: { get: () => ({ width: 400, height: 800 }) },
    Platform: { OS: 'android' }, StatusBar: {}, Alert: { alert: (...args) => alerts.push(args) } };
  const feedback = load('src/utils/cartFeedback.ts', { 'react-native': native });
  const mocks = { react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: p => navigation.push(p), replace: p => navigation.push(p) }), useFocusEffect: effect => { focusEffect = effect; }, useLocalSearchParams: () => ({ id: 'bolsa-1' }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/src/context/CartContext': { useCart: () => cart }, '@/src/utils/cartFeedback': feedback,
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    '@/constants/Colors': { Colors: {} }, '@/src/services/api': {},
    '@react-native-async-storage/async-storage': {}, 'expo-web-browser': {},
  };
  const Component = load(file, mocks).default;
  return { tree: Component(), alerts, navigation,
    render() { h.reset(); return Component(); },
    focus() { focusEffect?.(); },
  };
}

test('A5 carrito carga antes del vacío y bloquea checkout vacío/no hidratado; doble toque', () => {
  for (const loaded of [false, true]) {
    const result = ui('app/(tabs)/carrito.tsx', { loaded, items: [], total: 0 });
    assert.equal(textOf(result.tree).includes('Tu carrito está vacío'), loaded);
    assert.equal(walk(result.tree).some(n => n.type === 'Button' && textOf(n).includes('Proceder al pago')), false);
  }
  const result = ui('app/(tabs)/carrito.tsx', { loaded: true, items: [{ bolsa: bolsa(), cantidad: 1 }], total: 20 });
  const button = walk(result.tree).find(n => n.type === 'Button' && textOf(n).includes('Proceder al pago'));
  button.props.onPress(); button.props.onPress(); assert.deepEqual(result.navigation, ['/pago']);
});

test('A5 entrada directa a pago no monta flujo operativo hasta tener carrito hidratado no vacío', () => {
  for (const [loaded, items, allowed] of [[false, [], false], [false, [{ bolsa: bolsa(), cantidad: 1 }], false], [true, [], false], [true, [{ bolsa: bolsa(), cantidad: 1 }], true]]) {
    const result = ui('app/pago.tsx', { loaded, items });
    assert.equal(walk(result.tree).some(n => n.type?.name === 'PagoContent'), allowed);
  }
});

test('P1-3 tienda bloquea doble toque, carga y vacío; permite checkout al volver al foco', () => {
  const cart = { loaded: true, items: [{ bolsa: bolsa(), cantidad: 1 }], cantidad: 1, total: 20 };
  const result = ui('app/tienda/[id].tsx', cart, [{ nombre: 'Tienda' }, [], 'todos', false]);
  const button = tree => walk(tree).find(n => n.type === 'Button' && textOf(n).includes('Ver carrito'));
  result.focus(); button(result.tree).props.onPress(); button(result.tree).props.onPress();
  assert.deepEqual(result.navigation, ['/pago']);
  button(result.render()).props.onPress(); assert.equal(result.navigation.length, 1, 'render no desbloquea');
  result.focus(); button(result.render()).props.onPress(); assert.equal(result.navigation.length, 2);
  result.focus(); cart.items = []; button(result.render()).props.onPress();
  assert.equal(result.navigation.length, 2, 'items vacíos bloquean incluso con cantidad inconsistente');
  cart.loaded = false;
  const pending = result.render(); assert.equal(button(pending), undefined, 'carga no ofrece checkout');
  assert.equal(result.navigation.length, 2);
  cart.loaded = true; cart.items = [{ bolsa: bolsa(), cantidad: 1 }];
  result.focus(); button(result.render()).props.onPress(); assert.equal(result.navigation.length, 3);
});

test('A4 producto muestra éxito solo si agregar devuelve ok y una sola alerta ante rechazo', () => {
  for (const reason of ['otro_negocio', 'limite_stock', 'agotado', 'no_cargado', 'stock_invalido', 'producto_invalido', null]) {
    const result = ui('app/producto/[id].tsx', { loaded: true, items: [], agregar: () => reason ? { ok: false, motivo: reason } : { ok: true } }, [bolsa(), false]);
    const button = walk(result.tree).find(n => n.type === 'Button' && textOf(n).includes('Agregar al carrito'));
    button.props.onPress(); assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0][0] === '¡Agregado!', reason === null);
  }
});

test('A4 tarjeta no permite agregar durante hidratación y muestra rechazo del contexto', () => {
  const h = hooks(); const alerts = []; const native = { Platform: { OS: 'android' }, Dimensions: { get: () => ({ width: 400 }) }, StyleSheet: { create: x => x }, Alert: { alert: (...args) => alerts.push(args) } };
  let loaded = false;
  const Component = load('components/ProductCard.tsx', { react: h.react, 'react-native': native, 'expo-image': {}, '@expo/vector-icons': {}, 'expo-router': { useRouter: () => ({}) },
    '@/src/context/CartContext': { useCart: () => ({ loaded, items: [] }) }, '@/src/services/api': {}, '@/src/utils/cartFeedback': load('src/utils/cartFeedback.ts', { 'react-native': native }) }).default;
  const render = () => { h.reset(); return Component({ bolsa: bolsa(), onAgregar: () => ({ ok: false, motivo: 'otro_negocio' }) }); };
  let button = walk(render()).find(n => n.props?.hitSlop && n.props?.onPress);
  assert.equal(button.props.disabled, true); loaded = true; button = walk(render()).find(n => n.props?.hitSlop && n.props?.onPress);
  button.props.onPress(); assert.equal(alerts.length, 1); assert.equal(alerts[0][0], 'Un restaurante por pedido');
});
