// Ejecutar: node scripts/test-dashboard-restaurante.cjs. Sin red, Expo ni
// dependencias nuevas. Cubre DASH-1..8: el dashboard del restaurante
// (app/restaurante/index.tsx) monta de verdad, con un doble de hooks que SÍ
// ejecuta useEffect (a diferencia del doble "simple" de otros scripts) para
// poder probar el ciclo real "cambiar de día/mes → vuelve a pedir al backend".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const root = path.resolve(__dirname, '..');
const leer = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(leer(file), { compilerOptions: {
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

function walk(node) {
  if (!node || typeof node !== 'object') return [];
  const hijos = [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  if (typeof node.type === 'function' && !['CalendarioPicker'].includes(node.type.name)) {
    try { hijos.push(...walk(node.type(node.props))); } catch { /* no invocable sin su propio estado */ }
  }
  return hijos;
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return [node?.props?.children].flat(Infinity).map(textOf).join(' ');
}
const native = {
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button',
  SafeAreaView: 'Safe', RefreshControl: 'RefreshControl', Modal: 'Modal',
  AppState: { addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: x => x },
};

// Doble de hooks que SÍ ejecuta useEffect (en orden de registro, tras cada
// render) — a propósito distinto del doble "simple" (useEffect no-op) que
// usan otros scripts: aquí se necesita simular el ciclo real de refetch al
// cambiar de día/mes, no solo leer el árbol ya renderizado.
function hooksReales() {
  let cursor = 0;
  const cells = [];
  let pendientes = [];
  let renderFn = () => {};
  const react = {
    ...React,
    useState(inicial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: typeof inicial === 'function' ? inicial() : inicial };
      const cell = cells[i];
      const setter = (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; renderFn(); };
      return [cell.value, setter];
    },
    useCallback(fn, deps) {
      const i = cursor++; const old = cells[i];
      if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: fn };
      return cells[i].value;
    },
    useMemo(factory, deps) {
      const i = cursor++; const old = cells[i];
      if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: factory() };
      return cells[i].value;
    },
    useRef(inicial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: { current: inicial } };
      return cells[i].value;
    },
    useEffect(effect, deps) {
      const i = cursor++; const old = cells[i];
      if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) {
        cells[i] = { deps };
        pendientes.push(effect);
      }
    },
  };
  return {
    react,
    reset() { cursor = 0; },
    setRenderFn(fn) { renderFn = fn; },
    flushEffects() { const efs = pendientes.splice(0); efs.forEach(e => e()); },
  };
}

function montar(apiMocks = {}) {
  const h = hooksReales();
  const Component = load('app/restaurante/index.tsx', {
    react: h.react, 'react-native': native, 'expo-router': { useRouter: () => ({ push() {} }) },
    '@/constants/Colors': { Colors: {} },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { nombre: 'Dueño' } }) },
    '@/src/services/api': apiMocks,
    '@/components/CalendarioPicker': { __esModule: true, default: function CalendarioPicker({ modo = 'dia', value, onChange }) {
      return React.createElement('Button', { onPress: () => onChange(value), accessibilityLabel: `cal:${modo}` }, value);
    } },
  }).default;

  let tree;
  function render() { h.reset(); tree = Component(); }
  h.setRenderFn(render);
  render();

  return {
    get tree() { return tree; },
    render,
    // Corre los efectos pendientes y deja que las promesas de los mocks
    // resuelvan, varias rondas (un ciclo puede re-programar el siguiente).
    async asentar() {
      for (let i = 0; i < 8; i++) { h.flushEffects(); await new Promise(setImmediate); }
    },
    calendario() { const n = walk(tree).find(x => typeof x.type === 'function' && x.type.name === 'CalendarioPicker'); return n && { modo: 'dia', ...n.props }; },
    botones() { return walk(tree).filter(n => n.type === 'Button').map(n => ({ texto: textOf(n).trim(), onPress: n.props.onPress, disabled: n.props.disabled })); },
  };
}

function apiBase({ resumen = { fecha: '2026-10-03', pedidos: [] }, porDia = {}, porMes = {}, llamadas = [], fallar = () => false } = {}) {
  return {
    negociosAPI: { miNegocio: async () => ({ data: { id: 'n1', nombre: 'Ola Azul', activo: true, estado_verificacion: 'aprobado' } }) },
    bolsasAPI: { listar: async () => ({ data: [] }) },
    pedidosAPI: {
      restaurante: async (params) => {
        llamadas.push(params);
        if (fallar(params)) throw new Error('backend caído');
        if (params?.fecha === 'hoy' || params?.fecha === undefined && params?.mes === undefined) return { data: resumen };
        if (params?.fecha) return { data: porDia[params.fecha] ?? { fecha: params.fecha, pedidos: [] } };
        if (params?.mes) return { data: porMes[params.mes] ?? { mes: params.mes, pedidos: [] } };
        return { data: resumen };
      },
    },
  };
}

test('DASH-1: no existe el bloque "Tu contribución" en ninguna parte del dashboard', async () => {
  const app = montar(apiBase());
  await app.asentar();
  assert.doesNotMatch(textOf(app.render() || app.tree), /Tu contribución/);
  const src = leer('app/restaurante/index.tsx');
  assert.doesNotMatch(src, /Tu contribución/);
});

test('DASH-2: por defecto muestra los pedidos de HOY (resuelto por el backend, no por el dispositivo)', async () => {
  const llamadas = [];
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-03', pedidos: [{ id: 'p1', estado: 'completado', estado_pago: 'pagado', total: 50, created_at: '2026-10-03T18:00:00Z' }] },
    llamadas,
  }));
  await app.asentar();
  // La primera llamada de "vista" (día) debe pedir fecha=hoy, no una fecha calculada en el cliente.
  assert.ok(llamadas.some(p => p?.fecha === 'hoy'), JSON.stringify(llamadas));
  const texto = textOf(app.tree);
  assert.match(texto, /Hoy/);
});

test('DASH-3: puede seleccionar un día anterior — vuelve a pedir ESE día al backend', async () => {
  const llamadas = [];
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-03', pedidos: [] },
    porDia: { '2026-10-02': { fecha: '2026-10-02', pedidos: [{ id: 'ayer', estado: 'completado', estado_pago: 'pagado', total: 30, created_at: '2026-10-02T18:00:00Z' }] } },
    llamadas,
  }));
  await app.asentar();
  const flechaAnterior = app.botones().find(b => b.texto === '‹');
  assert.ok(flechaAnterior, 'debe existir la flecha de día anterior');
  flechaAnterior.onPress();
  await app.asentar();
  assert.ok(llamadas.some(p => p?.fecha === '2026-10-02'), JSON.stringify(llamadas));
  assert.match(textOf(app.tree), /ayer|Ayer/i);
});

test('DASH: no se puede navegar al día futuro (la flecha "siguiente" queda deshabilitada en "hoy")', async () => {
  const app = montar(apiBase({ resumen: { fecha: '2026-10-03', pedidos: [] } }));
  await app.asentar();
  const flechaSiguiente = app.botones().filter(b => b.texto === '›')[0];
  assert.equal(flechaSiguiente.disabled, true);
});

test('DASH-4: puede consultar el mes actual (selector de mes, no de día)', async () => {
  const llamadas = [];
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-03', pedidos: [] },
    porMes: { '2026-10': { mes: '2026-10', pedidos: [{ id: 'm1', estado: 'completado', estado_pago: 'pagado', total: 10, created_at: '2026-10-01T12:00:00Z' }] } },
    llamadas,
  }));
  await app.asentar();
  const tabMes = app.botones().find(b => b.texto === 'Mes');
  assert.ok(tabMes, 'debe existir la pestaña Mes');
  tabMes.onPress();
  await app.asentar();
  assert.ok(llamadas.some(p => p?.mes === 'actual'), JSON.stringify(llamadas));
  assert.match(textOf(app.tree), /octubre 2026/i);
});

test('DASH-5: puede consultar un mes anterior', async () => {
  const llamadas = [];
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-03', pedidos: [] },
    porMes: { '2026-09': { mes: '2026-09', pedidos: [{ id: 'm0', estado: 'completado', estado_pago: 'pagado', total: 5, created_at: '2026-09-15T12:00:00Z' }] } },
    llamadas,
  }));
  await app.asentar();
  app.botones().find(b => b.texto === 'Mes').onPress();
  await app.asentar();
  const flechaAnteriorMes = app.botones().find(b => b.texto === '‹');
  flechaAnteriorMes.onPress();
  await app.asentar();
  assert.ok(llamadas.some(p => p?.mes === '2026-09'), JSON.stringify(llamadas));
  assert.match(textOf(app.tree), /septiembre 2026/i);
});

test('DASH: cambio de día sin romper formato — "fecha=hoy" dos sesiones distintas resuelve cada una correctamente', async () => {
  const llamadasA = [];
  const appA = montar(apiBase({ resumen: { fecha: '2026-10-03', pedidos: [] }, llamadas: llamadasA }));
  await appA.asentar();
  assert.ok(llamadasA.some(p => p?.fecha === 'hoy'));

  // "Al día siguiente" = una sesión nueva donde el backend resuelve otro día,
  // sin ningún cambio de código ni de parámetro: el cliente sigue pidiendo
  // literalmente "hoy".
  const llamadasB = [];
  const appB = montar(apiBase({ resumen: { fecha: '2026-10-04', pedidos: [] }, llamadas: llamadasB }));
  await appB.asentar();
  assert.ok(llamadasB.some(p => p?.fecha === 'hoy'));
  assert.match(textOf(appB.tree), /Hoy/);
});

test('DASH-3 (calendario): elegir un día en el calendario pide ESE día; volver a hoy regresa a "fecha=hoy"', async () => {
  const llamadas = [];
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-05', pedidos: [] },
    porDia: { '2026-09-20': { fecha: '2026-09-20', pedidos: [{ id: 'x', estado: 'listo', estado_pago: 'pagado', total: 20, created_at: '2026-09-20T18:00:00Z' }] } },
    llamadas,
  }));
  await app.asentar();
  const cal = app.calendario();
  assert.equal(cal.modo, 'dia');
  assert.equal(cal.value, '2026-10-05', 'por defecto el calendario muestra hoy (Guatemala)');
  assert.equal(cal.maxDate, '2026-10-05', 'no permite elegir días futuros');
  cal.onChange('2026-09-20');
  await app.asentar();
  assert.equal(JSON.stringify(llamadas.at(-1)), JSON.stringify({ fecha: '2026-09-20' }));
  assert.match(textOf(app.tree), /1 pedido/);
  // Elegir hoy en el calendario vuelve al modo automático ("hoy"), no ancla la fecha.
  app.calendario().onChange('2026-10-05');
  await app.asentar();
  assert.equal(JSON.stringify(llamadas.at(-1)), JSON.stringify({ fecha: 'hoy' }));
});

test('DASH-4/5 (calendario): el modo Mes usa el selector de mes y pide el mes elegido', async () => {
  const llamadas = [];
  const app = montar(apiBase({ resumen: { fecha: '2026-10-05', pedidos: [] }, llamadas }));
  await app.asentar();
  app.botones().find(b => b.texto === 'Mes').onPress();
  await app.asentar();
  const cal = app.calendario();
  assert.equal(cal.modo, 'mes');
  assert.equal(cal.value, '2026-10');
  assert.equal(cal.maxDate, '2026-10');
  cal.onChange('2026-07');
  await app.asentar();
  assert.equal(JSON.stringify(llamadas.at(-1)), JSON.stringify({ mes: '2026-07' }));
  assert.match(textOf(app.tree), /julio 2026/i);
});

test('DASH-6: un día sin pedidos muestra "No hay pedidos para este día." (sin error)', async () => {
  const app = montar(apiBase({ resumen: { fecha: '2026-10-05', pedidos: [] } }));
  await app.asentar();
  const texto = textOf(app.tree);
  assert.match(texto, /No hay pedidos para este día\./);
  assert.doesNotMatch(texto, /No se pudieron cargar/);
});

test('DASH-7: un mes sin pedidos muestra "No hay pedidos para este mes." (sin error)', async () => {
  const app = montar(apiBase({ resumen: { fecha: '2026-10-05', pedidos: [] } }));
  await app.asentar();
  app.botones().find(b => b.texto === 'Mes').onPress();
  await app.asentar();
  const texto = textOf(app.tree);
  assert.match(texto, /No hay pedidos para este mes\./);
  assert.doesNotMatch(texto, /No se pudieron cargar/);
});

test('DASH-8: el dashboard nunca descarga todo el historial — toda llamada lleva fecha o mes', async () => {
  const llamadas = [];
  const app = montar(apiBase({ resumen: { fecha: '2026-10-05', pedidos: [] }, llamadas }));
  await app.asentar();
  app.botones().find(b => b.texto === '‹').onPress();
  await app.asentar();
  app.botones().find(b => b.texto === 'Mes').onPress();
  await app.asentar();
  app.botones().find(b => b.texto === '‹').onPress();
  await app.asentar();
  assert.ok(llamadas.length >= 4, JSON.stringify(llamadas));
  for (const p of llamadas) {
    assert.ok(p && (p.fecha || p.mes) && !(p.fecha && p.mes), `llamada sin filtro: ${JSON.stringify(p)}`);
  }
  const src = leer('app/restaurante/index.tsx');
  assert.doesNotMatch(src, /pedidosAPI\.restaurante\(\)/, 'sin llamadas sin filtro');
  assert.doesNotMatch(src, /toDateString|getMonth\(\)/, 'sin filtrado por fecha en el cliente');
});

test('DASH: si el backend falla, muestra un mensaje breve y "Reintentar" vuelve a pedir', async () => {
  const llamadas = [];
  let caido = true;
  const app = montar(apiBase({ resumen: { fecha: '2026-10-05', pedidos: [] }, llamadas, fallar: (p) => caido && p?.fecha === '2026-10-04' }));
  await app.asentar();
  app.botones().find(b => b.texto === '‹').onPress();
  await app.asentar();
  assert.match(textOf(app.tree), /No se pudieron cargar los pedidos/);
  assert.doesNotMatch(textOf(app.tree), /No hay pedidos para este día/);
  caido = false;
  const antes = llamadas.length;
  app.botones().find(b => b.texto === 'Reintentar').onPress();
  await app.asentar();
  assert.equal(llamadas.length, antes + 1);
  assert.equal(JSON.stringify(llamadas.at(-1)), JSON.stringify({ fecha: '2026-10-04' }));
  assert.match(textOf(app.tree), /No hay pedidos para este día\./);
});

test('DASH: las horas de los pedidos se muestran en hora de Guatemala (UTC-6)', async () => {
  const app = montar(apiBase({
    resumen: { fecha: '2026-10-05', pedidos: [{ id: 'p', estado: 'listo', estado_pago: 'pagado', total: 10, created_at: '2026-10-05T20:30:00Z' }] },
  }));
  await app.asentar();
  assert.match(textOf(app.tree), /2:30 p\. m\./, '20:30 UTC = 2:30 p. m. en Guatemala');
});
