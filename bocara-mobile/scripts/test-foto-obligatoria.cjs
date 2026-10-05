// Ejecutar: node scripts/test-foto-obligatoria.cjs. Sin red, Expo ni
// dependencias nuevas. Foto del negocio obligatoria en el frontend:
//   PHOTO-BIZ-1  registro de restaurante (app/registro-restaurante.tsx)
//   PHOTO-BIZ-4  perfil del restaurante (app/restaurante/perfil.tsx)
//   PHOTO-BIZ-2  admin ve por qué no se pudo aprobar (app/admin/negocios.tsx)
// (Las publicaciones — PHOTO-PUB-* — están en test-ciclo-publicaciones.cjs,
// que ya monta los formularios reales de bolsas.tsx y cupones.tsx.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');

const MSG_NEGOCIO = 'Debes agregar una foto del negocio para continuar.';
const FOTO = 'https://cdn.bocara.test/negocio.jpg';

function load(file, mocks = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function walk(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return [node?.props?.children].flat(Infinity).map(textOf).join(' ');
}

// Hooks con estado real (los setters re-renderizan) y estados iniciales
// forzados por posición; useEffect no corre (las cargas iniciales no importan aquí).
function montar(file, { forzados = {}, mocks = {} } = {}) {
  const cells = []; let cursor = 0; let tree; let Component;
  const alerts = [];
  const react = { ...React,
    useState(inicial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: i in forzados ? forzados[i] : (typeof inicial === 'function' ? inicial() : inicial) };
      const cell = cells[i];
      return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; }];
    },
    useRef(inicial) { const i = cursor++; if (!(i in cells)) cells[i] = { value: { current: inicial } }; return cells[i].value; },
    useCallback(f) { cursor++; return f; },
    useMemo(f) { cursor++; return f(); },
    useEffect() { cursor++; },
  };
  const native = new Proxy({
    StyleSheet: { create: x => x, absoluteFillObject: {} }, Platform: { OS: 'android' },
    Alert: { alert: (...args) => alerts.push(args) }, Dimensions: { get: () => ({ width: 400, height: 800 }) },
    TouchableOpacity: 'Button', TextInput: 'Input',
  }, { get: (t, k) => (k in t ? t[k] : String(k)) });
  Component = load(file, {
    react, 'react-native': native, 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push() {}, replace() {}, back() {} }), useFocusEffect: () => {} },
    'expo-location': {}, 'expo-image-picker': {},
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    '@/constants/Colors': { Colors: { error: 'red' } },
    '@/constants/zonas': { ZONAS_GT: [] },
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/utils/pickImage': { pickImage: async () => null },
    ...mocks,
  }).default;
  const app = {
    alerts,
    render() { cursor = 0; tree = Component(); return tree; },
    get tree() { return tree; },
    estado(i) { return cells[i]?.value; },
    boton(nombreHandler) { return walk(app.render()).find(n => n.type === 'Button' && n.props.onPress?.name === nombreHandler); },
  };
  app.render();
  return app;
}

// ── PHOTO-BIZ-1: registro de restaurante ─────────────────────────────────────

const formRegistro = (extra = {}) => ({
  nombre: 'Ana', apellido: 'López', email: 'ana@ola.gt', password: 'Segura123!', confirmPassword: 'Segura123!', telefono: '55555555',
  nombre_negocio: 'Ola Azul', descripcion: 'Mariscos', categoria: 'Restaurante', categoria_otro: '',
  direccion_negocio: '6a avenida', zona: '10', horario_atencion: 'L-V 8-18',
  nit: '1234567-8', dpi: '1234567890123',
  banco: 'Banco Industrial', banco_otro: '', numero_cuenta: '1234567890', tipo_cuenta: 'Monetaria', titular_cuenta: 'Ana López',
  dpi_foto_uri: 'file://dpi.jpg', dpi_foto_base64: 'ZHBp',
  foto_negocio_uri: '', foto_negocio_base64: '',
  latitud: '', longitud: '', ...extra,
});

function registro({ step, form, api = {}, auth = {} }) {
  // Orden de useState: step(0), form(1), ...
  return montar('app/registro-restaurante.tsx', {
    forzados: { 0: step, 1: form },
    mocks: {
      '@/src/context/AuthContext': { useAuth: () => ({ registroRestaurante: async () => ({}), ...auth }) },
      '@/src/services/api': {
        negociosAPI: { miNegocio: async () => ({ data: { id: 'neg-1' } }), actualizar: async () => ({ data: {} }), ...api.negociosAPI },
        uploadsAPI: { uploadBase64: async () => ({ data: { publicUrl: FOTO } }), ...api.uploadsAPI },
      },
    },
  });
}

test('PHOTO-BIZ-1: el paso del negocio rotula "Foto del negocio *"', () => {
  const app = registro({ step: 2, form: formRegistro() });
  assert.match(textOf(app.tree), /Foto del negocio \*/);
});

test('PHOTO-BIZ-1: sin foto del negocio no se puede continuar — mensaje claro', () => {
  const app = registro({ step: 2, form: formRegistro() });
  app.boton('nextStep').props.onPress();
  assert.equal(app.estado(0), 2, 'se queda en el paso del negocio');
  assert.match(textOf(app.render()), /Debes agregar una foto del negocio para continuar\./);
});

test('PHOTO-BIZ-1: una vista previa sin la foto real (borrador restaurado) tampoco cuenta', () => {
  const app = registro({ step: 2, form: formRegistro({ foto_negocio_uri: 'file://vieja.jpg', foto_negocio_base64: '' }) });
  app.boton('nextStep').props.onPress();
  assert.equal(app.estado(0), 2);
});

test('PHOTO-BIZ-1: con foto del negocio sí avanza', () => {
  const app = registro({ step: 2, form: formRegistro({ foto_negocio_uri: 'file://n.jpg', foto_negocio_base64: 'bmVn' }) });
  app.boton('nextStep').props.onPress();
  assert.equal(app.estado(0), 3);
});

test('PHOTO-BIZ-1: el envío final sin foto no crea la cuenta y vuelve al paso de la foto', async () => {
  let creadas = 0;
  const app = registro({ step: 4, form: formRegistro(), auth: { registroRestaurante: async () => { creadas++; } } });
  await app.boton('handleRegistro').props.onPress(); await tick();
  assert.equal(creadas, 0);
  assert.equal(app.estado(0), 2);
});

test('PHOTO-BIZ-1: con foto, el registro la sube y la guarda en negocios.imagen_url', async () => {
  const actualizaciones = [];
  const app = registro({
    step: 4, form: formRegistro({ foto_negocio_uri: 'file://n.jpg', foto_negocio_base64: 'bmVn' }),
    api: { negociosAPI: { actualizar: async (id, body) => { actualizaciones.push([id, body]); return { data: {} }; } } },
  });
  await app.boton('handleRegistro').props.onPress(); await tick();
  assert.equal(actualizaciones.length, 1);
  assert.equal(actualizaciones[0][1].imagen_url, FOTO);
  assert.doesNotMatch(textOf(app.render()), /No pudimos subir la foto del negocio/);
});

test('PHOTO-BIZ-1: si la foto no se pudo subir tras crear la cuenta, se avisa (no se esconde)', async () => {
  const app = registro({
    step: 4, form: formRegistro({ foto_negocio_uri: 'file://n.jpg', foto_negocio_base64: 'bmVn' }),
    api: { uploadsAPI: { uploadBase64: async (_b64, ruta) => { if (ruta.startsWith('negocios/')) throw new Error('red'); return { data: { publicUrl: 'https://cdn/dpi.jpg' } }; } } },
  });
  await app.boton('handleRegistro').props.onPress(); await tick();
  assert.match(textOf(app.render()), /No pudimos subir la foto del negocio/);
  assert.match(textOf(app.tree), /sin foto tu solicitud no puede aprobarse/);
});

// ── PHOTO-BIZ-4: perfil del restaurante ──────────────────────────────────────

function perfil(negocio, api = {}) {
  // negocio(0), form(1), camposPendientes(2), loading(3), saving(4), ..., toast(7)
  return montar('app/restaurante/perfil.tsx', {
    forzados: { 0: negocio, 1: { ...negocio }, 2: new Set(['descripcion']), 3: false },
    mocks: {
      '@/src/context/AuthContext': { useAuth: () => ({ usuario: { nombre: 'Ana' }, logout() {} }) },
      '@/src/services/api': {
        negociosAPI: { actualizar: async () => ({ data: {} }), solicitarCambios: async () => ({}), cambiosPendientes: async () => ({ data: [] }), ...api },
        uploadsAPI: {},
      },
    },
  });
}

test('PHOTO-BIZ-4: el perfil rotula "Foto del negocio *" y avisa si falta', () => {
  const sinFoto = perfil({ id: 'n1', nombre: 'Ola', estado_verificacion: 'aprobado', imagen_url: null, descripcion: 'x' });
  const texto = textOf(sinFoto.tree);
  assert.match(texto, /Foto del negocio \*/);
  assert.match(texto, /Debes agregar una foto del negocio para continuar\./);
  const conFoto = perfil({ id: 'n1', nombre: 'Ola', estado_verificacion: 'aprobado', imagen_url: FOTO, descripcion: 'x' });
  assert.doesNotMatch(textOf(conFoto.tree), /Debes agregar una foto del negocio/);
});

test('PHOTO-BIZ-4: un negocio rechazado sin foto no puede reenviar su solicitud', async () => {
  const llamadas = [];
  const app = perfil({ id: 'n1', nombre: 'Ola', estado_verificacion: 'rechazado', imagen_url: '', descripcion: 'x' },
    { actualizar: async (id, body) => { llamadas.push(body); return { data: {} }; } });
  await app.boton('guardar').props.onPress(); await tick();
  assert.equal(llamadas.length, 0, 'no se reenvía sin foto');
  assert.match(textOf(app.render()), /Debes agregar una foto del negocio para continuar\./);
});

test('PHOTO-BIZ-4: la foto del perfil solo se reemplaza — nunca se envía vacía', () => {
  const src = fs.readFileSync(path.join(root, 'app/restaurante/perfil.tsx'), 'utf8');
  for (const m of src.matchAll(/imagen_url:\s*([^,}\n]+)/g)) {
    assert.doesNotMatch(m[1], /^(null|''|"")\s*$/, `envía imagen_url vacía: ${m[0]}`);
  }
});

// ── PHOTO-BIZ-2: el admin ve por qué no se pudo aprobar ──────────────────────

test('PHOTO-BIZ-2: si el backend bloquea la aprobación por falta de foto, el admin ve el motivo en la tarjeta', async () => {
  const negocio = { id: 'n9', nombre: 'Sin foto', verificado: false, activo: false };
  const app = montar('app/admin/negocios.tsx', {
    // negocios(0), loading(1), refreshing(2), busqueda(3), filtro(4)
    forzados: { 0: [negocio], 1: false, 4: 'todos' },
    mocks: {
      '@/src/services/api': { adminAPI: {
        negocios: async () => ({ data: [negocio] }),
        verificarNegocio: async () => { throw new Error('No se puede aprobar el negocio porque no tiene foto.'); },
      } },
    },
  });
  // La tarjeta entera también es un botón: el de Aprobar es el más interno.
  const aprobar = walk(app.tree).filter(n => n.type === 'Button' && /Aprobar/.test(textOf(n))).at(-1);
  await aprobar.props.onPress(); await tick();
  assert.match(textOf(app.render()), /No se puede aprobar el negocio porque no tiene foto\./);
});
