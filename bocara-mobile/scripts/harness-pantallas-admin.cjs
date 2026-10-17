// Harness compartido para montar pantallas del panel Admin sin dispositivo
// (lo usan test-suspension-admin.cjs y test-confirmaciones-admin.cjs).
// Hooks con estado real por posición (como test-foto-obligatoria.cjs); los
// componentes función (Section, ConfirmarAccionModal…) se expanden al recorrer
// el árbol. Alert.alert no hace nada, igual que en react-native-web: solo se
// registra, así que cualquier flujo que dependa de él falla aquí como en web.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function cargarModulo(file, mocks = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

// Expande componentes función (sin hooks) para ver lo que pintan.
function expandir(n) {
  if (n && typeof n === 'object' && typeof n.type === 'function') return expandir(n.type(n.props));
  return n;
}
function walk(n) {
  n = expandir(n);
  if (!n || typeof n !== 'object') return [];
  return [n, ...[n.props?.children].flat(Infinity).flatMap(walk)];
}
function textOf(n) {
  n = expandir(n);
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (!n || typeof n !== 'object') return '';
  return [n.props?.children].flat(Infinity).map(textOf).join(' ');
}

// `negociosApi`, `uploadsApi` y `pickImage` son opcionales: la carga de la
// foto del negocio por el admin (restaurante-detalle) los usa; por defecto el
// selector "se cancela" (null) y nada sube.
function montar(file, {
  forzados = {}, api, params = { id: 'n1' },
  negociosApi = {}, uploadsApi = {}, pickImage = async () => null, rutas = [], mocks = {},
} = {}) {
  const cells = []; let cursor = 0;
  const alerts = [];
  const react = { ...React,
    useState(inicial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: i in forzados ? forzados[i] : (typeof inicial === 'function' ? inicial() : inicial) };
      const cell = cells[i];
      return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; }];
    },
    useCallback(f) { cursor++; return f; },
    useMemo(f) { cursor++; return f(); },
    useEffect() { cursor++; },
  };
  const native = new Proxy({
    StyleSheet: { create: (x) => x }, Platform: { OS: 'web' },
    Alert: { alert: (...args) => alerts.push(args) },
    TouchableOpacity: 'Button', TextInput: 'Input',
  }, { get: (t, k) => (k in t ? t[k] : String(k)) });
  const confirmar = cargarModulo('components/ConfirmarAccionModal.tsx', { 'react-native': native });
  const Component = cargarModulo(file, {
    react, 'react-native': native,
    'expo-router': { useLocalSearchParams: () => params, useRouter: () => ({ push(r) { rutas.push(r); }, replace() {}, back() {} }) },
    '@expo/vector-icons': { Ionicons: 'Icon' },
    '@/src/services/api': { adminAPI: api, negociosAPI: negociosApi, uploadsAPI: uploadsApi, API_BASE_URL: 'http://api.test' },
    '@/src/utils/pickImage': { pickImage },
    '@/src/services/authTokenStorage': { getAuthToken: async () => 'tok' },
    '@/constants/Colors': { Colors: { orange: 'orange', white: 'white' } },
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/utils/suspensionAdmin': cargarModulo('src/utils/suspensionAdmin.ts'),
    '@/src/utils/accionAdmin': cargarModulo('src/utils/accionAdmin.ts'),
    '@/components/ConfirmarAccionModal': confirmar,
    ...mocks,
  }).default;
  const render = () => { cursor = 0; return Component(); };
  const app = {
    alerts,
    rutas,
    estado: (i) => cells[i]?.value,
    texto: () => textOf(render()),
    nodos: () => walk(render()),
    boton: (re) => walk(render()).filter((n) => n.type === 'Button' && re.test(textOf(n))).at(-1),
    input: (re) => walk(render()).find((n) => n.type === 'Input' && re.test(n.props.placeholder || '')),
    // Modales visibles (el <Modal> de ConfirmarAccionModal ya expandido).
    modalesVisibles: () => walk(render()).filter((n) => n.type === 'Modal' && n.props.visible),
  };
  render();
  return app;
}

module.exports = { read, cargarModulo, tick, walk, textOf, montar };
