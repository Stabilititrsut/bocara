// Ejecutar: node scripts/test-ciclo-publicaciones.cjs. Sin red, Expo ni dependencias nuevas.
//
// Parte frontend del ciclo de vida de una publicación (BACK-1, caso Ola Azul).
// La regla de visibilidad vive en el backend (backend/services/publicaciones.js,
// cubierta por backend/test/publicacionesCiclo.test.js); aquí se certifica que
// la app no la contradice:
//   - las pestañas del cliente (Home, Tiendas, Promociones) vuelven a pedir los
//     datos al recuperar el foco: una publicación recién aprobada aparece sin
//     pull-to-refresh manual (antes solo cargaban al montarse y las pestañas
//     quedan montadas);
//   - la pantalla de Promociones del restaurante muestra el estado de revisión
//     y el motivo de rechazo, permite corregir una rechazada y reactivar una
//     aprobada oculta (antes no mostraba nada de eso);
//   - el panel admin informa si lo aprobado quedó visible o no, según la
//     respuesta del backend.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}) {
  const exportsObj = {};
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
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

const horarioReal = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

// Mismo doble de hooks que scripts/test-formularios-negocio.cjs. useEffect NO
// corre: si una pantalla solo cargara al montarse, los tests de foco lo notan.
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
const native = (alerts = []) => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
  ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image', Switch: 'Switch',
  RefreshControl: 'RefreshControl', StyleSheet: { create: x => x, absoluteFill: {}, absoluteFillObject: {} },
  Dimensions: { get: () => ({ width: 400, height: 800 }) }, Platform: { OS: 'android' },
  Alert: { alert: (...args) => alerts.push(args) },
});

function montar(file, { forcedStates = [], mocks = {} } = {}) {
  const h = hooks(); h.forcedStates.push(...forcedStates);
  const alerts = []; const focos = [];
  const Component = load(file, {
    react: h.react, 'react-native': native(alerts), 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push() {}, replace() {} }), useFocusEffect: cb => focos.push(cb) },
    '@/constants/Colors': { Colors: {} },
    ...mocks,
  }).default;
  const app = {
    alerts,
    tree: Component(),
    render() { h.reset(); app.tree = Component(); return app.tree; },
    // Simula que la pantalla gana el foco (la primera vez = al abrirla).
    async enfocar() { const cb = focos[focos.length - 1]; assert.ok(cb, 'la pantalla debe registrar useFocusEffect'); cb(); await tick(); },
  };
  return app;
}

// ════════════════════════════════════════════════════════════════════════════
// Cliente: refetch al recuperar el foco
// ════════════════════════════════════════════════════════════════════════════

test('Promociones (cliente): cada foco vuelve a pedir GET /bolsas?tipo=cupon', async () => {
  let llamadas = 0;
  const app = montar('app/(tabs)/promociones.tsx', { mocks: {
    '@/src/services/api': { promocionesAPI: { listar: async () => { llamadas++; return { data: [] }; } } },
    '@/src/utils/usePublicacionesVigentes': { usePublicacionesVigentes: items => items },
  } });
  await app.enfocar();
  assert.equal(llamadas, 1, 'al abrir la pestaña');
  await app.enfocar();
  assert.equal(llamadas, 2, 'al volver a la pestaña tras una aprobación');
});

test('Tiendas (cliente): cada foco vuelve a pedir el feed de negocios', async () => {
  let llamadas = 0;
  const app = montar('app/(tabs)/tiendas.tsx', { mocks: {
    '@/src/services/api': {
      negociosAPI: { feed: async () => { llamadas++; return { data: [] }; } },
      favoritosAPI: { listar: async () => ({ data: [] }) },
    },
  } });
  await app.enfocar();
  await app.enfocar();
  assert.equal(llamadas, 2);
});

test('Home (cliente): cada foco vuelve a pedir el feed aunque haya caché', async () => {
  let llamadas = 0;
  const app = montar('app/(tabs)/index.tsx', { mocks: {
    '@/src/services/api': {
      negociosAPI: { feed: async () => { llamadas++; return { data: [{ id: 'n1', nombre: 'Ola Azul' }] }; } },
      notificacionesAPI: { listar: async () => ({ data: [] }) },
    },
    // Caché "fresca" con el feed viejo: aun así debe consultarse la red.
    '@/src/utils/cache': { getCache: async () => [], setCache: async () => {} },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: null }) },
    '@/src/context/LocationContext': { useLocation: () => ({ locationName: '', permissionStatus: 'granted', requestPermission() {}, actualizarUbicacion() {}, loading: false }) },
    '@/src/context/CartContext': { useCart: () => ({ cantidad: 0, loaded: true }) },
    '@/assets/images/logo.png': 'logo.png',
  } });
  await app.enfocar();
  await app.enfocar();
  assert.equal(llamadas, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// Restaurante: pantalla de Promociones (restaurante/cupones.tsx)
// ════════════════════════════════════════════════════════════════════════════

const cupon = (extra = {}) => ({
  id: 'c1', negocio_id: 'n1', nombre: '2x1 Ceviche', contenido: 'OLA2X1', categoria: '2x1', tipo: 'cupon',
  precio_original: 120, precio_descuento: 60, cantidad_disponible: 5, activo: true,
  estado_aprobacion: 'aprobado', motivo_rechazo: null,
  hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', ...extra,
});

function pantallaCupones(lista, api = {}) {
  // cupones, loading, refreshing, modal, editando, saving, negocioId, form
  return montar('app/restaurante/cupones.tsx', {
    forcedStates: [lista, false, false, false, null, false, 'n1'],
    mocks: {
      '@/src/utils/horarioRecogida': horarioReal,
      '@/src/utils/hora': load('src/utils/hora.ts'),
      '@/src/services/api': {
        bolsasAPI: { listar: async () => ({ data: lista }), ...api },
        negociosAPI: { miNegocio: async () => ({ data: { id: 'n1' } }) },
      },
    },
  });
}
const botones = tree => walk(tree).filter(n => n.type === 'Button').map(n => ({ texto: textOf(n).trim(), onPress: n.props.onPress }));

test('Promociones (restaurante): una rechazada muestra estado, motivo y "Corregir", sin "Desactivar"', () => {
  const app = pantallaCupones([cupon({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'Un 2x1 no puede costar Q110' })]);
  const texto = textOf(app.tree);
  assert.match(texto, /Rechazada/);
  assert.match(texto, /Motivo:\s+Un 2x1 no puede costar Q110/);
  assert.match(texto, /enviarla de nuevo a revisión/);
  const t = botones(app.tree).map(b => b.texto);
  assert.ok(t.some(x => /Corregir/.test(x)));
  assert.equal(t.some(x => /Desactivar|Activar/.test(x)), false);
});

test('Promociones (restaurante): en revisión inicial no ofrece editar (el backend respondería 409)', () => {
  const app = pantallaCupones([cupon({ estado_aprobacion: 'pendiente' })]);
  assert.match(textOf(app.tree), /En revisión/);
  assert.equal(botones(app.tree).some(b => /Editar|Corregir/.test(b.texto)), false);
});

test('Promociones (restaurante): aprobada y visible muestra "Visible"', () => {
  const app = pantallaCupones([cupon()]);
  assert.match(textOf(app.tree), /Visible/);
  assert.ok(botones(app.tree).some(b => b.texto === 'Desactivar'));
});

test('Promociones (restaurante): aprobada pero oculta ofrece "Activar", que solo cambia activo', async () => {
  const llamadas = [];
  const app = pantallaCupones([cupon({ activo: false })], {
    actualizar: async (id, body) => { llamadas.push([id, body]); return { data: {} }; },
  });
  assert.match(textOf(app.tree), /Oculta/);
  const activar = botones(app.tree).find(b => b.texto === 'Activar');
  assert.ok(activar);
  await activar.onPress(); await tick();
  // JSON: el objeto nace dentro del contexto vm (otro prototipo de Object).
  assert.equal(JSON.stringify(llamadas), JSON.stringify([['c1', { activo: true }]]));
});

test('Promociones (restaurante): al guardar una corrección avisa que vuelve a revisión', async () => {
  const form = {
    nombre: '2x1 Ceviche', contenido: 'ola2x1', categoria: '2x1', descripcion: '',
    precio_original: '120', precio_descuento: '60', cantidad_disponible: '5',
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
  };
  const app = montar('app/restaurante/cupones.tsx', {
    forcedStates: [[], false, false, true, cupon({ estado_aprobacion: 'rechazado' }), false, 'n1', form],
    mocks: {
      '@/src/utils/horarioRecogida': horarioReal,
      '@/src/utils/hora': load('src/utils/hora.ts'),
      '@/src/services/api': {
        bolsasAPI: { listar: async () => ({ data: [] }), actualizar: async () => ({ data: { estado_aprobacion: 'pendiente' } }) },
        negociosAPI: { miNegocio: async () => ({ data: { id: 'n1' } }) },
      },
    },
  });
  const guardar = walk(app.tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
  await guardar.props.onPress(); await tick();
  assert.equal(app.alerts.length, 1);
  assert.match(app.alerts[0][1], /volvió a revisión/);
});

// ════════════════════════════════════════════════════════════════════════════
// Admin: aviso de visibilidad real al aprobar
// ════════════════════════════════════════════════════════════════════════════

function pantallaContenido(respuestaAprobar, item = { id: 'b1', nombre: '2x1 Ceviche', activo: true, negocios: { nombre: 'Ola Azul' } }) {
  // items, loading, refreshing, procesando, erroresItem, toast, ...
  return montar('app/admin/contenido.tsx', {
    forcedStates: [[item], false],
    mocks: {
      '@/src/services/api': { adminAPI: {
        contenidoPendiente: async () => ({ data: [] }),
        aprobarBolsa: async () => ({ data: respuestaAprobar }),
      } },
    },
  });
}

async function aprobarEnPanel(app) {
  const btn = botones(app.tree).find(b => /Aprobar/.test(b.texto));
  assert.ok(btn, 'botón Aprobar');
  await btn.onPress(); await tick();
  return textOf(app.render());
}

test('Admin: si el backend dice visible, el aviso confirma que el cliente la ve', async () => {
  const texto = await aprobarEnPanel(pantallaContenido({ visible_cliente: true, motivos_no_visible: [] }));
  assert.match(texto, /aprobado y visible para clientes/);
});

test('Admin: si queda aprobada pero oculta, el aviso dice por qué', async () => {
  const texto = await aprobarEnPanel(pantallaContenido({ visible_cliente: false, motivos_no_visible: ['vencida'] }));
  assert.match(texto, /NO es visible para clientes: su horario o fecha ya venció/);
});
