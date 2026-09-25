// Ejecutar: node scripts/test-tipo-publicacion.cjs. Sin red, Expo ni dependencias nuevas.
//
// QA #23 "Promoción vs Merma" está bloqueada visualmente porque hoy no hay
// ninguna publicación real de tipo "merma" (bolsa) en los datos. Este script
// certifica, con datos de prueba (dobles/mocks, sin BD), que la LÓGICA que
// distingue "promoción" (cupon) de "merma / tiempo limitado" (bolsa) es la
// misma en src/utils/tipoPublicacion.ts y se usa de forma consistente en:
//   - components/ProductCard.tsx (tarjetas del home/tienda)
//   - app/producto/[id].tsx (detalle)
//   - app/tienda/[id].tsx (tarjeta local de la tienda + tabs de filtro)
//   - app/(tabs)/buscar.tsx (resultados de búsqueda)
//
// También cubre el fix del hallazgo QA #23: los tabs de filtro de
// app/tienda/[id].tsx ("Tiempo Limitado" / "Promociones") ahora clasifican
// con esTiempoLimitado()/esPromocion() de tipoPublicacion.ts (mismo criterio
// que el badge), no con las banderas de menú `es_tiempo_limitado`/
// `es_promocion` (editables de forma independiente desde
// app/restaurante/bolsas.tsx). Antes del fix esas banderas podían colar una
// publicación bajo el tab equivocado mostrando su propio badge (una
// "Promoción" listada en "Tiempo Limitado", o viceversa); los tests de abajo
// prueban que esa bandera ya no tiene efecto sobre a qué tab pertenece cada
// publicación.
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

const tipoPublicacionReal = load('src/utils/tipoPublicacion.ts', {});
const horarioReal = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
const stockReal = load('src/utils/stock.ts', {});
const relojMock = { useRelojPublicaciones: () => new Date(), usePublicacionesVigentes: items => horarioReal.publicacionesVigentes(items) };

// bolsa "merma" (tipo real 'bolsa' => se muestra como Tiempo limitado)
const merma = (over = {}) => ({
  id: 'merma-1', negocio_id: 'rest-1', nombre: 'Pan del día', precio_original: 40, precio_descuento: 20,
  cantidad_disponible: 5, tipo: 'bolsa',
  hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', ...over,
});
// cupon "promoción" (tipo real 'cupon' => se muestra como Promoción)
const promo = (over = {}) => ({
  id: 'promo-1', negocio_id: 'rest-1', nombre: '20% en sushi', precio_original: 40, precio_descuento: 32,
  cantidad_disponible: 5, tipo: 'cupon',
  hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', ...over,
});

// ── 1. tipoPublicacion.ts: la fuente única de verdad ──────────────────────

test('tipoPublicacion: bolsa.tipo="bolsa" => Tiempo limitado / T. LIMITADO / ⏱️', () => {
  assert.equal(tipoPublicacionReal.etiquetaTipoProducto('bolsa'), 'Tiempo limitado');
  assert.equal(tipoPublicacionReal.etiquetaTipoProductoCorta('bolsa'), 'T. LIMITADO');
  assert.equal(tipoPublicacionReal.emojiTipoProducto('bolsa'), '⏱️');
});

test('tipoPublicacion: bolsa.tipo="cupon" => Promoción / PROMO / 🏷️', () => {
  assert.equal(tipoPublicacionReal.etiquetaTipoProducto('cupon'), 'Promoción');
  assert.equal(tipoPublicacionReal.etiquetaTipoProductoCorta('cupon'), 'PROMO');
  assert.equal(tipoPublicacionReal.emojiTipoProducto('cupon'), '🏷️');
});

test('tipoPublicacion: valores ausentes/desconocidos caen a bolsa (mismo criterio que el backend: tipo || "bolsa")', () => {
  for (const v of [null, undefined, '', 'algo-raro', 'CUPON', 'Cupon']) {
    assert.equal(tipoPublicacionReal.etiquetaTipoProducto(v), 'Tiempo limitado', `valor: ${JSON.stringify(v)}`);
  }
});

// ── 2. ProductCard.tsx (tarjetas en tienda/búsqueda vía renderGrid) ───────

function renderProductCard(bolsa, h) {
  const native = { View: 'View', Text: 'Text', TouchableOpacity: 'Button', StyleSheet: { create: x => x, absoluteFill: {} },
    Dimensions: { get: () => ({ width: 400, height: 800 }) } };
  const mocks = {
    react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {} }) },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/context/CartContext': { useCart: () => ({ items: [], loaded: true }) },
    '@/src/utils/cartFeedback': { mostrarErrorCarrito: () => {} },
    '@/src/services/api': { favoritosAPI: { agregarBolsa: async () => {}, quitarBolsa: async () => {} } },
    '@/src/utils/stock': stockReal,
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    '@/src/types': {},
  };
  const Component = load('components/ProductCard.tsx', mocks).default;
  return Component({ bolsa, onAgregar: () => ({ ok: true }) });
}
// Renderer mínimo: a diferencia de un textOf que solo recorre props.children,
// este SÍ ejecuta los componentes-función anidados (p.ej. el ProductCard local
// que app/tienda/[id].tsx define dentro del mismo archivo y usa vía JSX), algo
// imprescindible para ver el texto que esos subcomponentes realmente renderizan.
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return '';
  if (typeof node.type === 'function') {
    try { return textOf(node.type(node.props || {})); }
    catch { return ''; } // subcomponente que retorna null u otro caso no relevante para estas aserciones
  }
  return textOf(node?.props?.children);
}

test('ProductCard: merma (tipo=bolsa) muestra badge "T. LIMITADO"', () => {
  const h = hooks();
  const tree = renderProductCard(merma(), h);
  assert.ok(textOf(tree).includes('T. LIMITADO'), textOf(tree));
  assert.equal(textOf(tree).includes('PROMO'), false);
});

test('ProductCard: promoción (tipo=cupon) muestra badge "PROMO"', () => {
  const h = hooks();
  const tree = renderProductCard(promo(), h);
  assert.ok(textOf(tree).includes('PROMO'), textOf(tree));
});

// ── 3. app/producto/[id].tsx (detalle) ─────────────────────────────────────

function hooks() {
  const cells = []; let cursor = 0, stateIndex = 0; const forcedStates = [];
  const memo = (factory, deps) => {
    const i = cursor++; const old = cells[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: factory() };
    return cells[i].value;
  };
  return { forcedStates, reset() { cursor = 0; stateIndex = 0; },
    react: { ...React,
      useMemo: memo, useCallback: (f, deps) => memo(() => f, deps), useRef: initial => memo(() => ({ current: initial }), []),
      useState(initial) { const override = stateIndex++; const cell = memo(() => ({ value: override in forcedStates ? forcedStates[override] : typeof initial === 'function' ? initial() : initial }), []); return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
      useEffect() { cursor++; },
      useLayoutEffect() { cursor++; },
      useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    },
  };
}
function detalleTree(bolsa) {
  const h = hooks(); h.forcedStates.push(bolsa, false); // [bolsa, loading] -- mismo orden que test-stock-real.cjs
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
    ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image', Linking: { openURL: () => {} },
    Dimensions: { get: () => ({ width: 400, height: 800 }) }, Alert: { alert: () => {} }, Share: { share: async () => {} },
    StyleSheet: { create: x => x, absoluteFill: {} }, Platform: { OS: 'android' }, StatusBar: {} };
  const mocks = { react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {}, replace: () => {} }), useFocusEffect: () => {}, useLocalSearchParams: () => ({ id: bolsa.id }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/context/CartContext': { useCart: () => ({ loaded: true, items: [], agregar: () => ({ ok: true }) }) },
    '@/src/utils/cartFeedback': { mostrarErrorCarrito: () => false },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/stock': stockReal,
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    '@/constants/Colors': { Colors: {} }, '@/src/services/api': { favoritosAPI: {}, negociosAPI: {} },
    '@react-native-async-storage/async-storage': {}, 'expo-web-browser': {},
    '@/src/utils/backNavigation': { volver: () => {} },
  };
  const Component = load('app/producto/[id].tsx', mocks).default;
  return Component();
}

test('Detalle producto: merma (tipo=bolsa) muestra "Tiempo limitado" y ⏱️, no "Promoción"', () => {
  const txt = textOf(detalleTree(merma()));
  assert.ok(txt.includes('Tiempo limitado'), txt);
  assert.ok(txt.includes('⏱️'), txt);
  assert.equal(txt.includes('Promoción'), false);
});

test('Detalle producto: promoción (tipo=cupon) muestra "Promoción" y 🏷️, no "Tiempo limitado"', () => {
  const txt = textOf(detalleTree(promo()));
  assert.ok(txt.includes('Promoción'), txt);
  assert.ok(txt.includes('🏷️'), txt);
  assert.equal(txt.includes('Tiempo limitado'), false);
});

// ── 4. app/(tabs)/buscar.tsx (resultados de búsqueda) ──────────────────────

function buscarTree(resultados) {
  const h = hooks(); h.forcedStates.push('pan', resultados, false, true); // [query, resultadosGuardadas, loading, buscado]
  const native = { View: 'View', Text: 'Text', TextInput: 'Input', ScrollView: 'ScrollView', TouchableOpacity: 'Button',
    StyleSheet: { create: x => x, absoluteFill: {} }, SafeAreaView: 'Safe', ActivityIndicator: 'Spinner' };
  const mocks = { react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {} }) },
    '@/src/services/api': { bolsasAPI: { listar: async () => ({ data: [] }) } },
    '@/src/types': {}, '@/constants/Colors': { Colors: {} },
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/utils/usePublicacionesVigentes': relojMock,
  };
  const Component = load('app/(tabs)/buscar.tsx', mocks).default;
  return Component();
}

test('Búsqueda: lista mixta muestra "T. LIMITADO" para la merma y "PROMO" para la promoción, sin cruzarse', () => {
  const txt = textOf(buscarTree([merma({ id: 'm1' }), promo({ id: 'p1' })]));
  assert.ok(txt.includes('T. LIMITADO'), txt);
  assert.ok(txt.includes('PROMO'), txt);
});

// ── 5. app/tienda/[id].tsx: tarjeta local + tabs de filtro ─────────────────
// tienda/[id].tsx define su PROPIA función ProductCard local (no reutiliza
// components/ProductCard.tsx) pero importa el mismo etiquetaTipoProductoCorta
// de tipoPublicacion.ts, así que el badge debe coincidir igual.

function tiendaTree(bolsas, filtro) {
  const h = hooks();
  h.forcedStates.push(
    { id: 'rest-1', nombre: 'Restaurante Test' }, // negocio
    bolsas,                                        // bolsasGuardadas
    filtro,                                         // filtro
    false,                                          // loading
    null,                                            // errorMsg
    0,                                               // reintentoId
  );
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button',
    ActivityIndicator: 'Spinner', ImageBackground: 'ImgBg', StyleSheet: { create: x => x, absoluteFill: {} },
    Dimensions: { get: () => ({ width: 400, height: 800 }) }, Linking: { openURL: () => {} },
    Platform: { OS: 'android' }, StatusBar: {} };
  const mocks = { react: h.react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push: () => {}, replace: () => {} }), useLocalSearchParams: () => ({ id: 'rest-1' }), useFocusEffect: () => {} },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/src/services/api': { negociosAPI: {}, bolsasAPI: {} },
    '@/src/context/CartContext': { useCart: () => ({ items: [], loaded: true, total: 0, cantidad: 0, agregar: () => ({ ok: true }) }) },
    '@/src/utils/cartFeedback': { mostrarErrorCarrito: () => false },
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/stock': stockReal,
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/utils/usePublicacionesVigentes': relojMock,
    '@/src/utils/backNavigation': { volver: () => {} },
  };
  const Component = load('app/tienda/[id].tsx', mocks).default;
  return Component();
}

test('Tienda: tarjeta local muestra "T. LIMITADO"/"PROMO" igual que ProductCard (mismo util, mismo criterio)', () => {
  const txt = textOf(tiendaTree([merma({ id: 'm1' }), promo({ id: 'p1' })], 'todos'));
  assert.ok(txt.includes('T. LIMITADO'), txt);
  assert.ok(txt.includes('PROMO'), txt);
});

test('FIX #23: una promoción (tipo=cupon) marcada es_tiempo_limitado=true YA NO aparece en el tab "Tiempo Limitado"', () => {
  const cuponMarcadoComoTiempoLimitado = promo({ id: 'raro-1', es_tiempo_limitado: true });
  const txt = textOf(tiendaTree([cuponMarcadoComoTiempoLimitado], 'tiempo_limitado'));
  // La bandera de menú ya no decide el tab -- solo bolsa.tipo (esTiempoLimitado).
  // tipo='cupon' => esTiempoLimitado=false => excluida de este tab pase lo que
  // pase con la bandera, así que su badge "PROMO" no debe verse aquí.
  assert.equal(txt.includes('PROMO'), false, txt);
});

test('FIX #23: una merma (tipo=bolsa) marcada es_promocion=true YA NO aparece en el tab "Promociones"', () => {
  const mermaMarcadaComoPromo = merma({ id: 'raro-2', es_promocion: true });
  const txt = textOf(tiendaTree([mermaMarcadaComoPromo], 'promociones'));
  assert.equal(txt.includes('T. LIMITADO'), false, txt);
});

test('FIX #23: la merma marcada es_promocion=true sí aparece en su tab real ("Tiempo Limitado")', () => {
  const mermaMarcadaComoPromo = merma({ id: 'raro-2', es_promocion: true });
  const txt = textOf(tiendaTree([mermaMarcadaComoPromo], 'tiempo_limitado'));
  assert.ok(txt.includes('T. LIMITADO'), txt);
});

test('FIX #23: legacy sin `tipo` (undefined) cae de forma determinista en "Tiempo Limitado", nunca en "Promociones"', () => {
  const legacy = merma({ id: 'legacy-1', tipo: undefined });
  const enTiempoLimitado = textOf(tiendaTree([legacy], 'tiempo_limitado'));
  const enPromociones = textOf(tiendaTree([legacy], 'promociones'));
  assert.ok(enTiempoLimitado.includes('T. LIMITADO'), enTiempoLimitado);
  assert.equal(enPromociones.includes('T. LIMITADO'), false, enPromociones);
  assert.equal(enPromociones.includes('PROMO'), false, enPromociones);
});
