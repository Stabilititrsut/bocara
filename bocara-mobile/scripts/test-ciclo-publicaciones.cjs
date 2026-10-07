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
  StatusBar: { currentHeight: 0 }, ImageBackground: 'ImageBackground', Linking: { openURL() {} }, Share: { share() {} },
});

const tipoPublicacionReal = load('src/utils/tipoPublicacion.ts', {});
const stockReal = load('src/utils/stock.ts', {});
const estadoReal = load('src/utils/estadoPublicacion.ts', { './horarioRecogida': horarioReal });

function montar(file, { forcedStates = [], mocks = {}, params = {} } = {}) {
  const h = hooks(); h.forcedStates.push(...forcedStates);
  const alerts = []; const focos = [];
  const Component = load(file, {
    react: h.react, 'react-native': native(alerts), 'expo-image': { Image: 'Image' }, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push() {}, replace() {} }), useFocusEffect: cb => focos.push(cb), useLocalSearchParams: () => params },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/estadoPublicacion': estadoReal,
    '@/src/utils/pickImage': { pickImage: async () => null },
    // Dobles de las pantallas del cliente (tienda, detalle): los mismos módulos
    // reales que usan scripts/test-cart.cjs y test-tipo-publicacion.cjs.
    '@/src/utils/horarioRecogida': horarioReal,
    '@/src/utils/usePublicacionesVigentes': { useRelojPublicaciones: () => new Date(), usePublicacionesVigentes: items => horarioReal.publicacionesVigentes(items) },
    '@/src/utils/tipoPublicacion': tipoPublicacionReal,
    '@/src/utils/stock': stockReal,
    '@/src/utils/cartFeedback': { mostrarErrorCarrito() {} },
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/utils/liquidacionesResenas': load('src/utils/liquidacionesResenas.ts'),
    '@/src/context/CartContext': { useCart: () => ({ loaded: true, items: [], cantidad: 0, total: 0, agregar: () => ({ ok: true }) }) },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/src/context/LocationContext': { useLocation: () => ({ haversine: () => null, formatDistancia: () => null }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/components/ProductCard': { __esModule: true, default: 'ProductCard', CARD_W: 170 },
    // Doble mínimo: un botón con el valor actual como texto, para poder leer
    // y "tocar" la hora seleccionada sin reimplementar el picker real. Nombrada
    // (no una arrow anónima) para que inputs() la reconozca igual que a Field.
    '@/components/HoraPicker': { __esModule: true, default: function HoraPicker({ label, value, onChange }) {
      return React.createElement('Button', { onPress: () => onChange(value), accessibilityLabel: label }, value);
    } },
    '@/components/CalendarioPicker': { __esModule: true, default: function CalendarioPicker({ label, value, onChange }) {
      return React.createElement('Button', { onPress: () => onChange(value), accessibilityLabel: label }, value);
    } },
    ...mocks,
  }).default;
  const app = {
    alerts,
    tree: Component(),
    render() { h.reset(); focos.length = 0; app.tree = Component(); return app.tree; },
    // Simula que la pantalla gana el foco (la primera vez = al abrirla): corre
    // todos los useFocusEffect del último render, como React Navigation.
    async enfocar() { assert.ok(focos.length, 'la pantalla debe registrar useFocusEffect'); focos.forEach(cb => cb()); await tick(); },
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
  hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59',
  fecha_disponible: '2026-01-01', imagen_url: 'https://cdn.bocara.test/foto.jpg', ...extra,
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
  assert.match(textOf(app.tree), /Inactiva/);
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
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg',
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
  assert.match(app.alerts[0][1], /quedó Pendiente/);
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

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — estados del restaurante (src/utils/estadoPublicacion.ts)
// ════════════════════════════════════════════════════════════════════════════

const AYER = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

for (const [caso, extra, etiqueta, visible] of [
  ['pendiente', { estado_aprobacion: 'pendiente' }, 'Pendiente', false],
  ['pendiente con cambios solicitados', { estado_aprobacion: 'pendiente', motivo_rechazo: 'corrige' }, 'Pendiente · cambios solicitados', false],
  ['rechazada', { estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'no' }, '✕ Rechazada', false],
  ['aprobada', {}, '✓ Aprobada', true],
  ['inactiva', { activo: false }, 'Inactiva', false],
  ['vencida', { fecha_caducidad: AYER }, 'Vencida', false],
  ['agotada', { cantidad_disponible: 0 }, 'Agotada', false],
]) {
  test(`estado restaurante: ${caso} → "${etiqueta}"`, () => {
    const e = estadoReal.estadoPublicacion(cupon(extra));
    assert.equal(e.etiqueta, etiqueta);
    assert.equal(e.visible, visible);
  });
}

test('horaParaFormulario: la hora de una columna time ("18:00:00") se carga como "18:00"', () => {
  assert.equal(estadoReal.horaParaFormulario('18:00:00', '20:00'), '18:00');
  assert.equal(estadoReal.horaParaFormulario('08:30:00+00', '20:00'), '08:30');
  assert.equal(estadoReal.horaParaFormulario('9:15', '20:00'), '9:15');
  assert.equal(estadoReal.horaParaFormulario(null, '20:00'), '20:00');
});

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — Disponibles (restaurante/bolsas.tsx): ver, corregir, reenviar
// ════════════════════════════════════════════════════════════════════════════

function pantallaDisponibles(lista, api = {}) {
  // items, loading, refreshing, modal, form, editId, negocioId, ...
  return montar('app/restaurante/bolsas.tsx', {
    forcedStates: [lista, false, false, false],
    mocks: {
      '@/src/utils/hora': load('src/utils/hora.ts'),
      '@/src/utils/pickImage': {},
      '@/src/services/api': {
        bolsasAPI: { listar: () => new Promise(() => {}), ...api },
        negociosAPI: { miNegocio: async () => ({ data: { id: 'n1' } }) },
        uploadsAPI: {},
      },
    },
  });
}
// TextInput directo, o el componente Field de restaurante/bolsas.tsx (value + onChange).
const inputs = tree => walk(tree)
  .filter(n => n.type === 'Input'
    || (typeof n.type === 'function' && ['Field', 'HoraPicker', 'CalendarioPicker'].includes(n.type.name) && 'value' in n.props))
  .map(n => (n.type === 'Input' ? n : { props: { value: n.props.value, onChangeText: n.props.onChange } }));
const modalVisible = tree => walk(tree).some(n => n.type === 'Modal' && n.props.visible);
const boton = (tree, re) => botones(tree).find(b => re.test(b.texto));
const guardarDe = tree => walk(tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'guardar');
// Hora tal como la devuelve una columna `time` (con segundos): el caso real.
const deBD = (extra = {}) => cupon({ hora_recogida_inicio: '00:00:00', hora_recogida_fin: '23:59:00', ...extra });

test('Disponibles: una rechazada muestra "Rechazada", su motivo y el botón Corregir', () => {
  const app = pantallaDisponibles([deBD({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'Un 2x1 no puede costar Q110' })]);
  const texto = textOf(app.tree);
  assert.match(texto, /Rechazada/);
  assert.match(texto, /Motivo:\s+Un 2x1 no puede costar Q110/);
  assert.ok(boton(app.tree, /^Corregir$/));
});

test('Disponibles: Corregir abre el formulario con los datos de la publicación (hora sin segundos)', () => {
  const app = pantallaDisponibles([deBD({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'precio' })]);
  boton(app.tree, /^Corregir$/).onPress();
  const tree = app.render();
  assert.equal(modalVisible(tree), true);
  const valores = inputs(tree).map(i => i.props.value);
  assert.ok(valores.includes('2x1 Ceviche'), JSON.stringify(valores));
  assert.ok(valores.includes('60'));
  assert.ok(valores.includes('00:00') && valores.includes('23:59'), 'la hora de la BD se carga como HH:MM');
  assert.match(textOf(tree), /se envía de nuevo a revisión/);
  assert.match(textOf(tree), /Motivo del administrador:\s+precio/);
});

test('Disponibles: guardar la corrección hace PUT sobre la MISMA publicación y la tarjeta pasa a Pendiente al instante', async () => {
  const llamadas = [];
  const app = pantallaDisponibles([deBD({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'precio' })], {
    crear: async () => { throw new Error('no debe crear una copia'); },
    actualizar: async (id, body) => {
      llamadas.push([id, body]);
      return { data: { ...deBD(), ...body, id, estado_aprobacion: 'pendiente', motivo_rechazo: null, activo: true } };
    },
  });
  boton(app.tree, /^Corregir$/).onPress();
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0][0], 'c1');
  const tree = app.render();
  assert.equal(modalVisible(tree), false);
  // listar() nunca resuelve en este doble: lo que se ve viene de la respuesta del PUT.
  assert.match(textOf(tree), /Pendiente/);
  assert.doesNotMatch(textOf(tree), /Rechazada/);
});

test('Disponibles: en una aprobada, cambiar solo las unidades manda solo cantidad_disponible (no vuelve a revisión)', async () => {
  const llamadas = [];
  // es_descuento=false con precios distintos: el formulario lo "deriva" a true;
  // eso NO es un cambio del usuario y no debe viajar.
  const app = pantallaDisponibles([deBD({ cantidad_disponible: 7, es_descuento: false })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: { ...deBD(), ...body, id } }; },
  });
  boton(app.tree, /^Editar$/).onPress();
  const tree = app.render();
  assert.match(textOf(tree), /Cambiar solo las unidades no requiere revisión/);
  inputs(tree).find(i => i.props.value === '7').props.onChangeText('9');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(JSON.stringify(llamadas), JSON.stringify([{ cantidad_disponible: 9 }]));
});

test('Disponibles: el tipo también se puede cambiar al editar (selector visible)', () => {
  const app = pantallaDisponibles([deBD()]);
  boton(app.tree, /^Editar$/).onPress();
  assert.match(textOf(app.render()), /Tipo de publicación/);
});

// Igual que inputs() más arriba: el doble de CalendarioPicker/HoraPicker no
// se "invoca" (walk() no ejecuta componentes función) — se lee `label`
// directo del descriptor {type, props} sin resolver, por nombre de función.
const etiquetasDeFecha = tree => walk(tree)
  .filter(n => typeof n.type === 'function' && ['HoraPicker', 'CalendarioPicker'].includes(n.type.name))
  .map(n => n.props.label);

test('DATE-3/DATE-4: Promoción muestra "Fecha de publicación" y NUNCA "Fecha fin"', () => {
  const app = pantallaDisponibles([deBD({ tipo: 'cupon' })]);
  boton(app.tree, /^Editar$/).onPress();
  const etiquetas = etiquetasDeFecha(app.render());
  assert.ok(etiquetas.some(e => e.includes('Fecha de publicación')), JSON.stringify(etiquetas));
  assert.ok(!etiquetas.some(e => e.includes('Fecha fin')), 'una Promoción no debe mostrar fecha fin');
  assert.ok(!etiquetas.some(e => e.includes('Fecha inicio')), 'Promoción usa "fecha de publicación", no "fecha inicio"');
});

test('DATE-5: Tiempo limitado muestra "Fecha inicio" Y "Fecha fin" (no "Fecha de publicación")', () => {
  const app = pantallaDisponibles([deBD({ tipo: 'bolsa', fecha_caducidad: '2030-12-31' })]);
  boton(app.tree, /^Editar$/).onPress();
  const etiquetas = etiquetasDeFecha(app.render());
  assert.ok(etiquetas.some(e => e.includes('Fecha inicio')), JSON.stringify(etiquetas));
  assert.ok(etiquetas.some(e => e.includes('Fecha fin')), JSON.stringify(etiquetas));
  assert.ok(!etiquetas.some(e => e.includes('Fecha de publicación')), 'Tiempo limitado usa "fecha inicio", no "fecha de publicación"');
});

const calendarios = tree => walk(tree)
  .filter(n => typeof n.type === 'function' && n.type.name === 'CalendarioPicker')
  .map(n => n.props);
const bolsaFechas = (extra = {}) => deBD({
  tipo: 'bolsa', categoria_alimento: 'cereales', fecha_disponible: '2030-06-10', fecha_caducidad: '2030-06-20', ...extra,
});

test('CAL-6: Promoción tiene un único calendario (fecha de publicación)', () => {
  const app = pantallaDisponibles([deBD({ tipo: 'cupon' })]);
  boton(app.tree, /^Editar$/).onPress();
  const cals = calendarios(app.render());
  assert.deepEqual(cals.map(c => c.label), ['Fecha de publicación *']);
});

test('CAL-7: Tiempo limitado tiene dos calendarios — inicio y fin — y fin usa inicio como minDate', () => {
  const app = pantallaDisponibles([bolsaFechas()]);
  boton(app.tree, /^Editar$/).onPress();
  const cals = calendarios(app.render());
  assert.deepEqual(cals.map(c => c.label), ['Fecha inicio *', 'Fecha fin *']);
  assert.equal(cals[1].minDate, '2030-06-10', 'el calendario de fin bloquea días anteriores al inicio');
});

test('CAL-8: fin anterior a inicio se bloquea al guardar (no llama al backend)', async () => {
  const llamadas = [];
  const app = pantallaDisponibles([bolsaFechas()], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: { id, ...body } }; },
  });
  boton(app.tree, /^Editar$/).onPress();
  calendarios(app.render()).find(c => c.label === 'Fecha fin *').onChange('2030-06-05');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(llamadas.length, 0, 'no debe enviar un rango inválido');
  assert.ok(app.alerts.some(a => /anterior a la fecha de inicio/.test(a[1])), JSON.stringify(app.alerts));
});

test('CAL-9: editar conserva las fechas existentes (YYYY-MM-DD) en los calendarios', () => {
  const app = pantallaDisponibles([bolsaFechas({ fecha_disponible: '2030-06-10T00:00:00', fecha_caducidad: '2030-06-20' })]);
  boton(app.tree, /^Editar$/).onPress();
  const cals = calendarios(app.render());
  assert.equal(cals[0].value, '2030-06-10');
  assert.equal(cals[1].value, '2030-06-20');
});

test('TIME-6/DATE: Promoción y Tiempo limitado comparten el mismo HoraPicker y CalendarioPicker (un solo formulario)', () => {
  const src = fs.readFileSync(path.join(root, 'app/restaurante/bolsas.tsx'), 'utf8');
  assert.doesNotMatch(src, /DD\/MM\/YYYY/, 'ya no debe quedar texto libre de fecha con ese formato');
  assert.doesNotMatch(src, /keyboard="numeric"[^/]*fecha/i, 'las fechas no deben usar teclado numérico de texto libre');
});

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — Promociones del restaurante (restaurante/cupones.tsx): formulario
// ════════════════════════════════════════════════════════════════════════════

function promocionesRestaurante(lista, api = {}) {
  return pantallaCupones(lista, { listar: () => new Promise(() => {}), ...api });
}

test('Promociones (restaurante): Corregir carga el formulario y guardar la deja Pendiente sin crear copia', async () => {
  const llamadas = [];
  const app = promocionesRestaurante([deBD({ estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'precio' })], {
    crear: async () => { throw new Error('no debe crear una copia'); },
    actualizar: async (id, body) => {
      llamadas.push([id, body]);
      return { data: { ...deBD(), ...body, id, estado_aprobacion: 'pendiente', motivo_rechazo: null, activo: true } };
    },
  });
  boton(app.tree, /Corregir/).onPress();
  let tree = app.render();
  const valores = inputs(tree).map(i => i.props.value);
  assert.ok(valores.includes('2x1 Ceviche') && valores.includes('OLA2X1') && valores.includes('00:00'), JSON.stringify(valores));
  inputs(tree).find(i => i.props.value === '60').props.onChangeText('55');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0][0], 'c1');
  assert.equal(llamadas[0][1].precio_descuento, 55);
  tree = app.render();
  assert.match(textOf(tree), /Pendiente/);
  assert.match(app.alerts[0][1], /quedó Pendiente/);
});

test('Promociones (restaurante): un error del backend deja el formulario abierto, con los datos y el error visible', async () => {
  const app = promocionesRestaurante([deBD({ estado_aprobacion: 'rechazado', activo: false })], {
    actualizar: async () => { throw new Error('El horario de recogida ya ha expirado'); },
  });
  boton(app.tree, /Corregir/).onPress();
  inputs(app.render()).find(i => i.props.value === '2x1 Ceviche').props.onChangeText('2x1 Ceviche XL');
  await guardarDe(app.render()).props.onPress(); await tick();
  const tree = app.render();
  assert.equal(modalVisible(tree), true, 'el modal sigue abierto');
  assert.ok(inputs(tree).some(i => i.props.value === '2x1 Ceviche XL'), 'lo escrito se conserva');
  assert.match(textOf(tree), /El horario de recogida ya ha expirado/);
  assert.ok(app.alerts.some(a => /expirado/.test(a[1])));
});

test('Promociones (restaurante): doble toque al reenviar una corrección no duplica el PUT', async () => {
  let intentos = 0; let soltar;
  const pendiente = new Promise(r => { soltar = r; });
  const app = promocionesRestaurante([deBD({ estado_aprobacion: 'rechazado', activo: false })], {
    actualizar: async (id, body) => { intentos++; await pendiente; return { data: { ...deBD(), ...body, id, estado_aprobacion: 'pendiente' } }; },
  });
  boton(app.tree, /Corregir/).onPress();
  const p1 = guardarDe(app.render()).props.onPress();
  const segundo = guardarDe(app.render());
  assert.equal(segundo.props.disabled, true);
  await segundo.props.onPress();
  soltar(); await p1; await tick();
  assert.equal(intentos, 1);
});

test('Promociones (restaurante): en una aprobada, cambiar solo las unidades manda solo cantidad_disponible', async () => {
  const llamadas = [];
  const app = promocionesRestaurante([deBD({ cantidad_disponible: 7 })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: { ...deBD(), ...body, id } }; },
  });
  boton(app.tree, /Editar/).onPress();
  inputs(app.render()).find(i => i.props.value === '7').props.onChangeText('3');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(JSON.stringify(llamadas), JSON.stringify([{ cantidad_disponible: 3 }]));
  assert.match(app.alerts[0][1], /Sigue aprobada/);
});

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — Admin: rechazo con motivo obligatorio
// ════════════════════════════════════════════════════════════════════════════

function adminConModal(motivo, api) {
  // items, loading, refreshing, procesando, erroresItem, toast, modalRechazo, motivoRechazo
  return montar('app/admin/contenido.tsx', {
    forcedStates: [[{ id: 'b1', nombre: '2x1 Ceviche', activo: true, negocios: { nombre: 'Ola Azul' } }], false, false, null, {}, null,
      { id: 'b1', nombre: '2x1 Ceviche' }, motivo],
    mocks: { '@/src/services/api': { adminAPI: { contenidoPendiente: async () => ({ data: [] }), ...api } } },
  });
}
const botonRechazarModal = tree => walk(tree).find(n => n.type === 'Button' && /Rechazar y notificar/.test(textOf(n)));

test('Admin: sin motivo, "Rechazar y notificar" está deshabilitado y no llama al backend', async () => {
  let llamadas = 0;
  const app = adminConModal('', { rechazarBolsa: async () => { llamadas++; return { data: {} }; } });
  const btn = botonRechazarModal(app.tree);
  assert.equal(btn.props.disabled, true);
  await btn.props.onPress(); await tick();
  assert.equal(llamadas, 0);
});

test('Admin: con motivo, rechaza, la saca de la cola y avisa que ya no es visible', async () => {
  const llamadas = [];
  const app = adminConModal('  Precio mal  ', { rechazarBolsa: async (id, motivo) => { llamadas.push([id, motivo]); return { data: {} }; } });
  await botonRechazarModal(app.tree).props.onPress(); await tick();
  assert.equal(JSON.stringify(llamadas), JSON.stringify([['b1', 'Precio mal']]));
  const texto = textOf(app.render());
  assert.doesNotMatch(texto, /✓ Aprobar/, 'la tarjeta salió de la cola');
  assert.match(texto, /ya no es visible para clientes/);
});

test('Admin: recarga la cola al recuperar el foco', async () => {
  let llamadas = 0;
  const app = montar('app/admin/contenido.tsx', { mocks: { '@/src/services/api': { adminAPI: { contenidoPendiente: async () => { llamadas++; return { data: [] }; } } } } });
  await app.enfocar(); await app.enfocar();
  assert.equal(llamadas, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN-1/2/3 — tarjeta pendiente: solo Rechazar + Aprobar, sin "Cambios"
// ════════════════════════════════════════════════════════════════════════════

test('ADMIN-1/2: la tarjeta pendiente muestra exactamente Rechazar y Aprobar — ningún botón "Cambios"', () => {
  const app = pantallaContenido({ visible_cliente: true, motivos_no_visible: [] });
  // Los botones del modal de rechazo ("Cancelar"/"Rechazar y notificar") están
  // siempre en el árbol en este harness (el doble de Modal no condiciona sus
  // hijos por `visible`) — se acota a los dos botones de la propia tarjeta.
  const btns = botones(app.tree).filter(b => /^✕ Rechazar$|^✓ Aprobar$/.test(b.texto));
  assert.equal(btns.length, 2, `se esperaban los 2 botones de la tarjeta, hay ${btns.length}`);
  assert.ok(!botones(app.tree).some(b => /Cambios/i.test(b.texto)), 'no debe existir ningún botón "Cambios" en ningún lado de la pantalla');
});

test('ADMIN-2: no queda código muerto de "pedir cambios" (handler, modal, estado ni llamada a la API)', () => {
  const fuente = fs.readFileSync(path.join(root, 'app/admin/contenido.tsx'), 'utf8');
  for (const patron of [/pedirCambiosBolsa/, /modalCambios/, /motivoCambios/, /function pedirCambios\b/, /Pedir cambios/i]) {
    assert.doesNotMatch(fuente, patron, `admin/contenido.tsx no debe contener ${patron}`);
  }
});

test('ADMIN-3: Rechazar usa fondo rojo con texto blanco (ya exige motivo — ver test de arriba)', () => {
  // Colores reales (no el doble vacío { Colors: {} } de montar()): sin esto, la
  // comparación sería undefined === undefined y pasaría sin probar nada.
  const ColorsReal = load('constants/Colors.ts').Colors;
  const app = montar('app/admin/contenido.tsx', {
    forcedStates: [[{ id: 'b1', nombre: '2x1 Ceviche', activo: true, negocios: { nombre: 'Ola Azul' } }], false],
    mocks: {
      '@/constants/Colors': { Colors: ColorsReal },
      '@/src/services/api': { adminAPI: { contenidoPendiente: async () => ({ data: [] }) } },
    },
  });
  const btnRechazar = botones(app.tree).find(b => /Rechazar/.test(b.texto));
  assert.ok(btnRechazar, 'botón Rechazar');
  const nodo = walk(app.tree).find(n => n.type === 'Button' && n.props.onPress === btnRechazar.onPress);
  const estilo = [nodo.props.style].flat(Infinity).filter(Boolean).reduce((acc, s) => ({ ...acc, ...s }), {});
  assert.equal(estilo.backgroundColor, ColorsReal.error, 'fondo rojo (Colors.error)');
  const textoNodo = walk(nodo).find(n => n.type === 'Text');
  const estiloTexto = [textoNodo.props.style].flat(Infinity).filter(Boolean).reduce((acc, s) => ({ ...acc, ...s }), {});
  assert.equal(estiloTexto.color, ColorsReal.white, 'texto blanco');
});

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — Cliente: tienda y ficha refrescan al foco; tipos canónicos
// ════════════════════════════════════════════════════════════════════════════

const productCards = tree => walk(tree).filter(n => typeof n.type === 'function' && n.type.name === 'ProductCard');

test('Tienda: al volver a la pantalla re-pide sus publicaciones y muestra la recién aprobada', async () => {
  let respuesta = [];
  let llamadas = 0;
  // negocio, bolsasGuardadas, filtro, loading
  const app = montar('app/tienda/[id].tsx', {
    params: { id: 'n1' },
    forcedStates: [{ id: 'n1', nombre: 'Ola Azul' }, [], 'todos', false],
    mocks: { '@/src/services/api': { negociosAPI: {}, bolsasAPI: { listar: async () => { llamadas++; return { data: respuesta }; } } } },
  });
  await app.enfocar(); // primera vez: la cubre la carga inicial
  assert.equal(llamadas, 0);
  respuesta = [cupon({ id: 'nueva' })];
  app.render();
  await app.enfocar();
  assert.equal(llamadas, 1);
  assert.deepEqual(productCards(app.render()).map(n => n.props.bolsa.id), ['nueva']);
});

test('Ficha del negocio: al volver re-pide sus publicaciones', async () => {
  let llamadas = 0;
  const app = montar('app/negocio/[id].tsx', {
    params: { id: 'n1' },
    mocks: { '@/src/services/api': {
      negociosAPI: { detalleCompleto: async () => { llamadas++; return { data: { negocio: {}, bolsas: { tiempo_limitado: [], promocion: [] } } }; } },
      pedidosAPI: {}, favoritosAPI: {}, resenasAPI: {},
    } },
  });
  await app.enfocar();
  app.render();
  await app.enfocar();
  assert.equal(llamadas, 1);
});

test('Tipos: cupon se etiqueta Promoción y bolsa Tiempo limitado en el detalle; la tienda los separa por tipo', () => {
  for (const [tipo, etiqueta] of [['cupon', 'Promoción'], ['bolsa', 'Tiempo limitado']]) {
    const app = montar('app/producto/[id].tsx', {
      params: { id: 'x' },
      forcedStates: [cupon({ id: 'x', tipo, negocios: { nombre: 'Ola Azul' } }), false],
      mocks: { '@/src/services/api': { bolsasAPI: {}, resenasAPI: {}, favoritosAPI: {} } },
    });
    assert.match(textOf(app.tree), new RegExp(etiqueta));
  }
  const lista = [cupon({ id: 'c', tipo: 'cupon', es_tiempo_limitado: true }), cupon({ id: 'b', tipo: 'bolsa', es_promocion: true })];
  for (const [filtro, esperado] of [['promociones', ['c']], ['tiempo_limitado', ['b']]]) {
    const app = montar('app/tienda/[id].tsx', {
      params: { id: 'n1' }, forcedStates: [{ id: 'n1', nombre: 'Ola Azul' }, lista, filtro, false],
      mocks: { '@/src/services/api': { negociosAPI: {}, bolsasAPI: {} } },
    });
    assert.deepEqual(productCards(app.tree).map(n => n.props.bolsa.id), esperado, `banderas de menú ignoradas en "${filtro}"`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FRONT-1 — Integración REAL frontend ↔ backend
//
// Las pantallas reales (restaurante, admin, cliente) hablan por HTTP con los
// routers reales del backend (backend/routes/*.js) sobre la base en memoria de
// backend/test/helpers/appPublicaciones.js. Ninguna regla de visibilidad se
// simula aquí: lo que el cliente ve es lo que el backend real devuelve.
//
// Requiere las dependencias del backend (express, jsonwebtoken) resolubles desde
// backend/. Si no lo están (p. ej. solo se instaló bocara-mobile), estos tests
// se reportan como SKIPPED con el motivo, nunca como PASS.
// ════════════════════════════════════════════════════════════════════════════

const { before, after } = require('node:test');
let backend = null;
let motivoSinBackend = '';
try {
  backend = require(path.resolve(root, '..', 'backend', 'test', 'helpers', 'appPublicaciones.js'));
} catch (e) {
  motivoSinBackend = `backend no disponible para integración: ${e.message.split('\n')[0]}`;
}
const integracion = (nombre, fn) => test(nombre, { skip: backend ? false : motivoSinBackend }, fn);
if (backend) {
  before(() => backend.iniciar());
  after(() => backend.detener());
}

// Mismo contrato que src/services/api.ts (rutas, params y errores como Error con
// el mensaje del backend, igual que su interceptor), pero contra el backend real.
// Llamadas HTTP en curso: las pantallas disparan cargas sin devolver la promesa
// (useFocusEffect, onPress), así que se espera a que no quede ninguna.
let enCurso = 0;
async function asentar() {
  for (let i = 0; i < 400; i++) {
    await tick();
    if (enCurso === 0) { await tick(); if (enCurso === 0) return; }
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('quedaron llamadas al backend sin terminar');
}

function apiComo(usuario) {
  const llamar = async (metodo, ruta, { body, params } = {}) => {
    enCurso++;
    try { return await llamarHttp(metodo, ruta, { body, params }); } finally { enCurso--; }
  };
  const llamarHttp = async (metodo, ruta, { body, params } = {}) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : '';
    const r = await backend.pedir(metodo, '/api' + ruta + qs, { como: usuario, body });
    if (r.status >= 400) { const e = new Error(r.body?.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return { data: r.body };
  };
  return {
    bolsasAPI: {
      listar: params => llamar('GET', '/bolsas', { params }),
      detalle: id => llamar('GET', `/bolsas/${id}`),
      crear: body => llamar('POST', '/bolsas', { body }),
      actualizar: (id, body) => llamar('PUT', `/bolsas/${id}`, { body }),
      eliminar: id => llamar('DELETE', `/bolsas/${id}`),
    },
    negociosAPI: {
      miNegocio: () => llamar('GET', '/negocios/mi-negocio'),
      feed: () => llamar('GET', '/negocios/feed'),
      detalle: id => llamar('GET', `/negocios/${id}`),
      detalleCompleto: id => llamar('GET', `/negocios/${id}/detalle`),
    },
    promocionesAPI: { listar: params => llamar('GET', '/bolsas', { params: { tipo: 'cupon', activo: true, ...params } }) },
    adminAPI: {
      contenidoPendiente: () => llamar('GET', '/admin/contenido/pendiente'),
      aprobarBolsa: id => llamar('PUT', `/admin/bolsas/${id}/aprobar`),
      rechazarBolsa: (id, motivo) => llamar('PUT', `/admin/bolsas/${id}/rechazar`, { body: { motivo } }),
      pedirCambiosBolsa: (id, motivo) => llamar('PUT', `/admin/bolsas/${id}/pedir-cambios`, { body: { motivo } }),
    },
    favoritosAPI: { listar: async () => ({ data: [] }) },
    notificacionesAPI: { listar: async () => ({ data: [] }) },
    uploadsAPI: {}, resenasAPI: {}, pedidosAPI: {},
  };
}

const horaMock = () => load('src/utils/hora.ts');
const formPromo = (extra = {}) => ({
  nombre: '2x1 Ceviche', contenido: 'ola2x1', categoria: '2x1', descripcion: 'Dos ceviches por uno',
  precio_original: '120', precio_descuento: '60', cantidad_disponible: '5',
  hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59', imagen_url: 'https://cdn.bocara.test/foto.jpg', ...extra,
});

// ── Actores, cada uno con su pantalla real ──────────────────────────────────

async function restauranteCrea(form) {
  const app = montar('app/restaurante/cupones.tsx', {
    forcedStates: [[], false, false, true, null, false, backend.IDS.olaAzul, form],
    mocks: { '@/src/utils/hora': horaMock(), '@/src/services/api': apiComo(backend.IDS.restaurante) },
  });
  await guardarDe(app.tree).props.onPress(); await asentar();
  assert.equal(app.alerts.length, 1, JSON.stringify(app.alerts));
  assert.match(app.alerts[0][1], /enviada a revisión/);
  return backend.fake.tabla('bolsas').at(-1).id;
}

async function panelRestaurante() {
  const app = montar('app/restaurante/cupones.tsx', {
    mocks: { '@/src/utils/hora': horaMock(), '@/src/services/api': apiComo(backend.IDS.restaurante) },
  });
  await app.enfocar(); await asentar();
  app.render();
  return app;
}

async function panelAdmin() {
  const app = montar('app/admin/contenido.tsx', { mocks: { '@/src/services/api': apiComo(backend.IDS.admin) } });
  await app.enfocar(); await asentar();
  app.render();
  return app;
}

async function adminRechaza(motivo) {
  const app = await panelAdmin();
  boton(app.tree, /^✕ Rechazar$/).onPress();
  walk(app.render()).find(n => n.type === 'Input' && /imágenes/.test(n.props.placeholder)).props.onChangeText(motivo);
  await botonRechazarModal(app.render()).props.onPress(); await asentar();
  return textOf(app.render());
}

async function adminAprueba() {
  const app = await panelAdmin();
  await boton(app.tree, /^✓ Aprobar$/).onPress(); await asentar();
  return textOf(app.render());
}

async function clientePromociones() {
  const app = montar('app/(tabs)/promociones.tsx', { mocks: { '@/src/services/api': apiComo(backend.IDS.cliente) } });
  await app.enfocar(); await asentar();
  return walk(app.render()).filter(n => typeof n.type === 'function' && n.type.name === 'PromoCard').map(n => n.props.bolsa);
}

async function clienteHome() {
  const app = montar('app/(tabs)/index.tsx', { mocks: {
    '@/src/services/api': apiComo(backend.IDS.cliente),
    '@/src/utils/cache': { getCache: async () => null, setCache: async () => {} },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: null }) },
    '@/src/context/LocationContext': { useLocation: () => ({ locationName: '', permissionStatus: 'granted', requestPermission() {}, actualizarUbicacion() {}, loading: false }) },
    '@/src/context/CartContext': { useCart: () => ({ cantidad: 0, loaded: true }) },
    '@/assets/images/logo.png': 'logo.png',
  } });
  await app.enfocar(); await asentar();
  return walk(app.render()).filter(n => typeof n.type === 'function' && n.type.name === 'NegocioCard').map(n => n.props.negocio);
}

async function clienteTienda(filtro = 'todos') {
  const app = montar('app/tienda/[id].tsx', {
    params: { id: backend.IDS.olaAzul },
    forcedStates: [{ id: backend.IDS.olaAzul, nombre: 'Ola Azul' }, [], filtro, false],
    mocks: { '@/src/services/api': apiComo(backend.IDS.cliente) },
  });
  await app.enfocar(); await asentar(); app.render(); await app.enfocar(); await asentar(); // la segunda vez = volver a la tienda
  return productCards(app.render()).map(n => n.props.bolsa);
}

async function clienteDetalle(id) {
  try {
    const { data } = await apiComo(backend.IDS.cliente).bolsasAPI.detalle(id);
    const app = montar('app/producto/[id].tsx', {
      params: { id }, forcedStates: [data, false],
      mocks: { '@/src/services/api': { bolsasAPI: {}, resenasAPI: {}, favoritosAPI: {} } },
    });
    return { status: 200, texto: textOf(app.tree) };
  } catch (e) { return { status: e.status }; }
}

// Lo que ve el cliente de la publicación `id` en cada pantalla.
async function clienteVe(id) {
  const [promos, home, tienda, detalle] = [await clientePromociones(), await clienteHome(), await clienteTienda(), await clienteDetalle(id)];
  return {
    promociones: promos.some(b => b.id === id),
    tienda: tienda.some(b => b.id === id),
    detalle: detalle.status === 200,
    homeOlaAzul: home.some(n => n.id === backend.IDS.olaAzul),
  };
}

// ── Caso Ola Azul ───────────────────────────────────────────────────────────

integracion('Ola Azul (integración): A mal creada → rechazada (no visible); B creada bien → aprobada (visible en todas las pantallas)', async () => {
  backend.fake.reiniciar(backend.datosBase());

  // 1-2. Restaurante crea A con el precio mal; queda Pendiente y el cliente no la ve.
  const a = await restauranteCrea(formPromo({ precio_descuento: '110' }));
  let panel = await panelRestaurante();
  assert.match(textOf(panel.tree), /Pendiente/);
  assert.equal((await clienteVe(a)).promociones, false);

  // 3-4. Admin la rechaza desde su panel, con motivo.
  const tAdmin = await adminRechaza('Un 2x1 de Q120 cuesta Q60');
  assert.match(tAdmin, /ya no es visible para clientes/);

  // 5. El restaurante ve Rechazada + motivo + Corregir.
  panel = await panelRestaurante();
  assert.match(textOf(panel.tree), /Rechazada/);
  assert.match(textOf(panel.tree), /Motivo:\s+Un 2x1 de Q120 cuesta Q60/);
  assert.ok(boton(panel.tree, /Corregir/));

  // 6-7. Crea B correcta con el MISMO nombre: no lo bloquea la rechazada.
  const b = await restauranteCrea(formPromo());
  assert.notEqual(a, b);

  // 8. Admin aprueba B: el aviso dice que quedó visible (respuesta real del backend).
  assert.match(await adminAprueba(), /aprobado y visible para clientes/);

  // 9-12. Cliente: B en Home, Promociones, tienda y detalle; A en ninguna.
  const veB = await clienteVe(b);
  assert.deepEqual(veB, { promociones: true, tienda: true, detalle: true, homeOlaAzul: true });
  const veA = await clienteVe(a);
  assert.deepEqual({ promociones: veA.promociones, tienda: veA.tienda, detalle: veA.detalle }, { promociones: false, tienda: false, detalle: false });

  const detalle = await clienteDetalle(b);
  assert.match(detalle.texto, /2x1 Ceviche/);
  assert.match(detalle.texto, /Ola Azul/);
  assert.match(detalle.texto, /Promoción/);
  const promoB = (await clientePromociones()).find(x => x.id === b);
  assert.equal(promoB.precio_descuento, 60);
  assert.equal(promoB.hora_recogida_inicio, '00:00');
  assert.equal(promoB.cantidad_disponible, 5);
  assert.equal(promoB.tipo, 'cupon');
});

integracion('Rechazada → Corregir → Pendiente → Aprobada → visible (integración, misma publicación)', async () => {
  backend.fake.reiniciar(backend.datosBase());
  const id = await restauranteCrea(formPromo({ precio_descuento: '110' }));
  await adminRechaza('Precio incorrecto');

  // Restaurante corrige la MISMA publicación desde su panel.
  const panel = await panelRestaurante();
  boton(panel.tree, /Corregir/).onPress();
  const form = panel.render();
  assert.match(textOf(form), /Motivo del administrador:\s+Precio incorrecto/);
  inputs(form).find(i => i.props.value === '110').props.onChangeText('60');
  await guardarDe(panel.render()).props.onPress(); await asentar();
  assert.match(panel.alerts.at(-1)[1], /quedó Pendiente/);
  assert.match(textOf(panel.render()), /Pendiente/, 'la tarjeta refleja Pendiente al instante');
  assert.equal(backend.fake.tabla('bolsas').length, 1, 'no se creó ninguna copia');
  assert.equal((await clienteVe(id)).promociones, false, 'pendiente: aún no visible');

  assert.match(await adminAprueba(), /aprobado y visible para clientes/);
  const ve = await clienteVe(id);
  assert.deepEqual(ve, { promociones: true, tienda: true, detalle: true, homeOlaAzul: true });
  assert.equal((await clientePromociones()).find(x => x.id === id).precio_descuento, 60);

  // Y el restaurante la ve Aprobada.
  assert.match(textOf((await panelRestaurante()).tree), /✓ Aprobada/);
});

integracion('Aprobada → modificar precio (integración): vuelve a Pendiente y desaparece del cliente hasta re-aprobar', async () => {
  backend.fake.reiniciar(backend.datosBase());
  const id = await restauranteCrea(formPromo());
  await adminAprueba();
  assert.equal((await clienteVe(id)).promociones, true);

  const panel = await panelRestaurante();
  boton(panel.tree, /Editar/).onPress();
  const form = panel.render();
  assert.match(textOf(form), /volverá a revisión/);
  inputs(form).find(i => i.props.value === '60').props.onChangeText('50');
  await guardarDe(panel.render()).props.onPress(); await asentar();
  assert.match(panel.alerts.at(-1)[1], /quedó Pendiente/);
  assert.equal((await clienteVe(id)).promociones, false);
  await adminAprueba();
  assert.equal((await clienteVe(id)).promociones, true);
});

integracion('Aprobada → cambiar solo unidades (integración): sigue visible, sin revisión', async () => {
  backend.fake.reiniciar(backend.datosBase());
  const id = await restauranteCrea(formPromo());
  await adminAprueba();
  const panel = await panelRestaurante();
  boton(panel.tree, /Editar/).onPress();
  inputs(panel.render()).find(i => i.props.value === '5').props.onChangeText('8');
  await guardarDe(panel.render()).props.onPress(); await asentar();
  assert.match(panel.alerts.at(-1)[1], /Sigue aprobada/);
  assert.equal(backend.fake.tabla('bolsas')[0].estado_aprobacion, 'aprobado');
  assert.equal((await clienteVe(id)).promociones, true);
});

integracion('Admin (integración): aprobar algo vencido muestra que NO quedó visible y por qué', async () => {
  backend.fake.reiniciar(backend.datosBase());
  backend.fake._db.tablas.bolsas.push({
    id: 'vencida-1', negocio_id: backend.IDS.olaAzul, nombre: 'Promo vieja', imagen_url: 'https://cdn.bocara.test/foto.jpg', tipo: 'cupon', precio_original: 100, precio_descuento: 50,
    cantidad_disponible: 3, activo: true, estado_aprobacion: 'pendiente', fecha_caducidad: AYER,
    hora_recogida_inicio: '08:00', hora_recogida_fin: '20:00', created_at: new Date().toISOString(),
  });
  const texto = await adminAprueba();
  assert.match(texto, /NO es visible para clientes: su horario o fecha ya venció/);
  assert.doesNotMatch(texto, /aprobado y visible/);
});

// ── Matriz de estados con el backend real ───────────────────────────────────

integracion('Estados (integración): el cliente solo ve la aprobada válida; el restaurante ve cada estado con su etiqueta', async () => {
  backend.fake.reiniciar(backend.datosBase());
  const MANANA = backend.fechaGuatemala(1);
  const fila = (id, extra) => ({
    id, negocio_id: backend.IDS.olaAzul, nombre: `Promo ${id}`, tipo: 'cupon', precio_original: 100, precio_descuento: 50,
    cantidad_disponible: 3, activo: true, estado_aprobacion: 'aprobado', motivo_rechazo: null,
    hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00', fecha_caducidad: MANANA, created_at: new Date().toISOString(), ...extra,
  });
  backend.fake._db.tablas.bolsas.push(
    fila('pendiente', { estado_aprobacion: 'pendiente' }),
    fila('rechazada', { estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'no' }),
    fila('aprobada', {}),
    fila('vencida', { fecha_caducidad: backend.fechaGuatemala(-1) }),
    fila('inactiva', { activo: false }),
    fila('agotada', { cantidad_disponible: 0 }),
  );

  assert.deepEqual((await clientePromociones()).map(b => b.id), ['aprobada']);
  assert.deepEqual((await clienteTienda()).map(b => b.id), ['aprobada']);
  assert.deepEqual((await clienteHome()).map(n => [n.id, n.cantidad_bolsas]), [[backend.IDS.olaAzul, 1]]);
  for (const id of ['pendiente', 'rechazada', 'vencida', 'inactiva']) {
    assert.equal((await clienteDetalle(id)).status, 404, id);
  }
  // Agotada: no se lista, pero el detalle directo responde (la app muestra "agotado").
  assert.equal((await clienteDetalle('agotada')).status, 200);

  const texto = textOf((await panelRestaurante()).tree);
  for (const etiqueta of ['Pendiente', '✕ Rechazada', '✓ Aprobada', 'Vencida', 'Inactiva', 'Agotada']) {
    assert.ok(texto.includes(etiqueta), `el restaurante ve "${etiqueta}"`);
  }
});

integracion('Tipos (integración): cupon solo en Promociones; bolsa (Tiempo limitado) nunca en Promociones aunque tenga es_promocion', async () => {
  backend.fake.reiniciar(backend.datosBase());
  const MANANA = backend.fechaGuatemala(1);
  const base = { negocio_id: backend.IDS.olaAzul, precio_original: 100, precio_descuento: 50, cantidad_disponible: 3, activo: true,
    estado_aprobacion: 'aprobado', hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00', fecha_caducidad: MANANA, created_at: new Date().toISOString() };
  backend.fake._db.tablas.bolsas.push(
    { ...base, id: 'promo', nombre: 'Promo', tipo: 'cupon', es_tiempo_limitado: true },
    { ...base, id: 'tl', nombre: 'Bolsa', tipo: 'bolsa', es_promocion: true },
  );
  assert.deepEqual((await clientePromociones()).map(b => b.id), ['promo']);
  assert.deepEqual((await clienteTienda('promociones')).map(b => b.id), ['promo']);
  assert.deepEqual((await clienteTienda('tiempo_limitado')).map(b => b.id), ['tl']);
  assert.match((await clienteDetalle('promo')).texto, /Promoción/);
  assert.match((await clienteDetalle('tl')).texto, /Tiempo limitado/);
});

// ════════════════════════════════════════════════════════════════════════════
// Foto obligatoria (PHOTO-PUB-1/2/7, PHOTO-LEGACY-1) — formularios reales de
// restaurante/bolsas.tsx y restaurante/cupones.tsx.
// ════════════════════════════════════════════════════════════════════════════

const MSG_FOTO = 'Debes agregar una foto antes de publicar.';
const botonFoto = tree => walk(tree).find(n => n.type === 'Button' && n.props.onPress?.name === 'seleccionarFotoBolsa');
const estiloPlano = st => Object.assign({}, ...[st].flat(Infinity).filter(Boolean));

async function nuevaSinFoto(tipo) {
  const llamadas = [];
  const app = pantallaDisponibles([], { crear: async (p) => { llamadas.push(p); return { data: { id: 'x', ...p } }; } });
  boton(app.tree, /^\+ Nueva$/).onPress();
  if (tipo === 'cupon') boton(app.render(), /Promoción/).onPress();
  const tree = app.render();
  await guardarDe(tree).props.onPress(); await tick();
  return { app, llamadas, tree: app.render() };
}

for (const [id, tipo, nombre] of [['PHOTO-PUB-1', 'cupon', 'Promoción'], ['PHOTO-PUB-2', 'bolsa', 'Tiempo limitado']]) {
  test(`${id}: crear ${nombre} sin foto se bloquea al Guardar — mensaje claro, bloque marcado, sin request`, async () => {
    const { app, llamadas, tree } = await nuevaSinFoto(tipo);
    assert.equal(llamadas.length, 0, 'no llega al backend');
    assert.ok(app.alerts.some(a => a[1] === MSG_FOTO), JSON.stringify(app.alerts));
    assert.match(textOf(tree), /Debes agregar una foto antes de publicar\./, 'el mensaje queda visible junto a la foto');
    assert.equal(estiloPlano(botonFoto(tree).props.style).borderWidth, 2, 'el bloque de foto queda marcado como error');
    assert.ok(walk(tree).some(n => typeof n.props?.onLayout === 'function' && /Foto \*/.test(textOf(n))),
      'el bloque de foto registra su posición para llevar el scroll hasta él');
  });
}

test('PHOTO-PUB: el formulario rotula la foto como obligatoria ("Foto *")', () => {
  const app = pantallaDisponibles([]);
  boton(app.tree, /^\+ Nueva$/).onPress();
  assert.match(textOf(app.render()), /📷 Foto \*/);
});

test('PHOTO-PUB: cupones.tsx (Promociones) tampoco crea sin foto', async () => {
  const llamadas = [];
  const app = pantallaCupones([], { crear: async (p) => { llamadas.push(p); return { data: {} }; } });
  boton(app.tree, /^\+ Nueva$/).onPress();
  const tree = app.render();
  assert.ok(walk(tree).some(n => n.type?.name === 'Field' && n.props.label === 'Foto *'), 'rotulada como obligatoria');
  await guardarDe(tree).props.onPress(); await tick();
  assert.equal(llamadas.length, 0);
  assert.ok(app.alerts.some(a => a[1] === MSG_FOTO), JSON.stringify(app.alerts));
  assert.match(textOf(app.render()), /Debes agregar una foto antes de publicar\./);
});

test('PHOTO-PUB-7: editar una publicación con foto no obliga a subirla de nuevo ni la manda vacía', async () => {
  const llamadas = [];
  const app = pantallaDisponibles([deBD({ nombre: 'Viejo' })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: { ...deBD(), ...body, id } }; },
  });
  boton(app.tree, /^Editar$/).onPress();
  inputs(app.render()).find(i => i.props.value === 'Viejo').props.onChangeText('Nuevo');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(llamadas.length, 1, JSON.stringify(app.alerts));
  assert.equal(llamadas[0].nombre, 'Nuevo');
  assert.equal(llamadas[0].imagen_url, undefined, 'la foto no cambió: no viaja (el backend conserva la guardada)');
});

test('PHOTO-LEGACY-1: heredada sin foto — cambiar unidades se permite; cambiar contenido exige foto', async () => {
  const llamadas = [];
  const app = pantallaDisponibles([deBD({ imagen_url: null, nombre: 'Heredada', cantidad_disponible: 7 })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: { ...deBD(), ...body, id } }; },
  });
  // Unidades: no vuelve a revisión → no exige foto.
  boton(app.tree, /^Editar$/).onPress();
  inputs(app.render()).find(i => i.props.value === '7').props.onChangeText('9');
  await guardarDe(app.render()).props.onPress(); await tick();
  assert.equal(JSON.stringify(llamadas), JSON.stringify([{ cantidad_disponible: 9 }]));

  // Contenido: volvería a revisión → bloquea hasta agregar la foto.
  const app2 = pantallaDisponibles([deBD({ imagen_url: null, nombre: 'Heredada' })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: {} }; },
  });
  boton(app2.tree, /^Editar$/).onPress();
  inputs(app2.render()).find(i => i.props.value === 'Heredada').props.onChangeText('Heredada v2');
  await guardarDe(app2.render()).props.onPress(); await tick();
  assert.equal(llamadas.length, 1, 'el cambio de contenido no se envió');
  assert.ok(app2.alerts.some(a => a[1] === MSG_FOTO), JSON.stringify(app2.alerts));
});

test('PHOTO-LEGACY-1: la lista del restaurante muestra una heredada sin foto sin romperse (placeholder)', () => {
  const app = pantallaDisponibles([deBD({ imagen_url: null, nombre: 'Sin foto' })]);
  assert.match(textOf(app.tree), /Sin foto/);
});

test('faltaFotoParaGuardar: crear siempre exige; editar solo si vuelve a revisión (mismo criterio que el backend)', () => {
  const { faltaFotoParaGuardar, tieneFoto } = estadoReal;
  assert.equal(tieneFoto('   '), false);
  assert.equal(tieneFoto(null), false);
  assert.equal(tieneFoto('https://x/y.jpg'), true);
  assert.equal(faltaFotoParaGuardar('', null), true);
  assert.equal(faltaFotoParaGuardar('https://x/y.jpg', null), false);
  const aprobada = { estado_aprobacion: 'aprobado' };
  assert.equal(faltaFotoParaGuardar(null, { bolsa: aprobada, cambios: { cantidad_disponible: 3 } }), false);
  assert.equal(faltaFotoParaGuardar(null, { bolsa: aprobada, cambios: { activo: false } }), false);
  assert.equal(faltaFotoParaGuardar(null, { bolsa: aprobada, cambios: { nombre: 'x' } }), true);
  assert.equal(faltaFotoParaGuardar(null, { bolsa: { estado_aprobacion: 'rechazado' }, cambios: { cantidad_disponible: 3 } }), true,
    'una rechazada vuelve a revisión con cualquier cambio');
});

// ── SEC-3: pendiente heredada sin foto — editable solo para agregar la foto ──

test('SEC-3: pendiente sin foto (revisión inicial) ofrece Editar y exige la foto al guardar', async () => {
  const llamadas = [];
  const app = pantallaDisponibles([deBD({ estado_aprobacion: 'pendiente', motivo_rechazo: null, imagen_url: null, nombre: 'Heredada' })], {
    actualizar: async (id, body) => { llamadas.push(body); return { data: {} }; },
  });
  const editar = boton(app.tree, /^Editar$/);
  assert.ok(editar, 'debe poder abrirse para agregar la foto');
  editar.onPress();
  const tree = app.render();
  assert.match(textOf(tree), /no tiene foto: agrégala para que el administrador pueda aprobarla/);
  await guardarDe(tree).props.onPress(); await tick();
  assert.equal(llamadas.length, 0);
  assert.ok(app.alerts.some(a => a[1] === MSG_FOTO), JSON.stringify(app.alerts));
});

test('SEC-3: pendiente CON foto sigue bloqueada para editar en revisión inicial', () => {
  assert.equal(estadoReal.bloqueadaParaEditar({ estado_aprobacion: 'pendiente', motivo_rechazo: null, imagen_url: 'https://x/y.jpg' }), true);
  assert.equal(estadoReal.bloqueadaParaEditar({ estado_aprobacion: 'pendiente', motivo_rechazo: null, imagen_url: null }), false);
  assert.equal(estadoReal.faltaFotoParaGuardar(null, {
    bolsa: { estado_aprobacion: 'pendiente', motivo_rechazo: null }, cambios: { cantidad_disponible: 2 },
  }), true, 'la única edición posible en revisión inicial es completar la foto');
});
