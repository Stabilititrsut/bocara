// Ejecutar: node scripts/test-indicadores.cjs. Sin red, Expo ni dependencias nuevas.
//
// Fase C del módulo 03 (Indicadores y Embudo): emisor de analítica
// (src/utils/analitica.ts), clientes tipados (src/services/api.ts), la
// instrumentación de carrito/pago y la pantalla Admin › Indicadores. Misma
// técnica que scripts/test-cart.cjs: transpila el .ts/.tsx REAL y lo ejecuta
// en un VM con doubles para cada import.
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
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  vm.runInNewContext(code, {
    exports, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, JSON, Date, Math,
    ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exports;
}

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
// Los objetos creados dentro del VM tienen otros prototipos: se comparan como datos.
const plano = (x) => JSON.parse(JSON.stringify(x));
const igual = (actual, esperado, msg) => assert.deepEqual(plano(actual), esperado, msg);
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function almacen(inicial = {}) {
  const valores = new Map(Object.entries(inicial));
  return { valores,
    async getItem(k) { return valores.has(k) ? valores.get(k) : null; },
    async setItem(k, v) { valores.set(k, v); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Emisor de analítica
// ═══════════════════════════════════════════════════════════════════════════

const nativoMinimo = { Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove() {} }) } };
function cargarAnalitica(extra = {}) {
  return load('src/utils/analitica.ts', {
    '@react-native-async-storage/async-storage': almacen(),
    'react-native': nativoMinimo,
    '../services/api': { analiticaAPI: { enviarEventos: async () => ({}) }, API_BASE_URL: 'http://api.test/api' },
    ...extra,
  });
}
const A = cargarAnalitica();

function emisor({ disco = almacen(), enviar, reloj = { t: Date.parse('2026-10-07T15:00:00Z') }, atribucion, enviarUrgente } = {}) {
  const enviados = [];
  let n = 0;
  const e = A.crearEmisorAnalitica({
    almacen: disco,
    enviar: enviar || (async (lote) => { enviados.push(lote); }),
    enviarUrgente,
    ahora: () => reloj.t,
    aleatorio: () => `r${String(++n).padStart(7, '0')}`,
    atribucion,
  });
  return { e, enviados, disco, reloj };
}

test('analítica: anon_id persistente en AsyncStorage y reutilizado por otra instancia', async () => {
  const disco = almacen();
  const a = emisor({ disco });
  a.e.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await a.e.vaciar();
  const anon = disco.valores.get(A.CLAVE_ANON);
  assert.match(anon, /^anon-[A-Za-z0-9]{8,}$/);
  const b = emisor({ disco });
  b.e.registrarEvento('view_item', { bolsa_id: UUID(2) });
  await b.e.vaciar();
  assert.equal(b.enviados[0][0].anon_id, anon);
});

test('analítica: primera actividad abre sesión con session_start; la sesión expira tras 30 min de inactividad', async () => {
  const { e, enviados, reloj } = emisor();
  e.registrarEvento('view_item', { bolsa_id: UUID(1), negocio_id: UUID(2) });
  reloj.t += 29 * 60 * 1000;
  e.registrarEvento('add_to_cart', { bolsa_id: UUID(1), negocio_id: UUID(2) });
  reloj.t += 30 * 60 * 1000 + 1;
  e.registrarEvento('view_item', { bolsa_id: UUID(3) });
  await e.vaciar();
  const eventos = enviados.flat();
  igual(eventos.map((x) => x.evento), ['session_start', 'view_item', 'add_to_cart', 'session_start', 'view_item']);
  const [s1, s2] = [eventos[0].sesion_id, eventos[3].sesion_id];
  assert.notEqual(s1, s2);
  igual(eventos.map((x) => x.sesion_id), [s1, s1, s1, s2, s2]);
  assert.equal(new Set(eventos.map((x) => x.client_event_id)).size, 5, 'client_event_id único por evento');
  for (const ev of eventos) {
    assert.match(ev.client_event_id, /^[A-Za-z0-9_.:-]{8,100}$/);
    assert.match(ev.sesion_id, /^[A-Za-z0-9_.:-]{8,100}$/);
    assert.match(ev.ocurrido_en, /Z$/);
  }
});

test('analítica: la sesión sobrevive a reiniciar la app si no pasaron 30 min', async () => {
  const disco = almacen();
  const reloj = { t: Date.parse('2026-10-07T15:00:00Z') };
  const a = emisor({ disco, reloj });
  a.e.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await a.e.vaciar();
  reloj.t += 10 * 60 * 1000;
  const b = emisor({ disco, reloj });
  b.e.registrarEvento('add_to_cart', { bolsa_id: UUID(1) });
  await b.e.vaciar();
  igual(b.enviados.flat().map((x) => x.evento), ['add_to_cart']);
  assert.equal(b.enviados[0][0].sesion_id, a.enviados[0][0].sesion_id);
});

test('analítica: ids que no son UUID no viajan; UTM solo en session_start y saneados', async () => {
  const { e, enviados } = emisor({ atribucion: () => A.atribucionDeUrl('?utm_source=Facebook&utm_campaign=Promo<Oct>!') });
  e.registrarEvento('begin_checkout', { pedido_id: UUID(9), bolsa_id: 'no-uuid', negocio_id: null });
  await e.vaciar();
  const [inicio, checkout] = enviados.flat();
  assert.equal(inicio.utm_source, 'Facebook');
  assert.equal(inicio.utm_campaign, 'PromoOct');
  assert.equal(checkout.pedido_id, UUID(9));
  assert.equal('bolsa_id' in checkout, false);
  assert.equal('utm_source' in checkout, false);
  assert.equal(A.atribucionDeUrl(''), null);
  assert.equal(A.limpiarUtm('<<<>>>'), undefined);
});

test('analítica: lote automático al llegar al umbral y lotes de máximo 50', async () => {
  const { e, enviados } = emisor();
  for (let i = 0; i < A.UMBRAL_ENVIO - 1; i++) e.registrarEvento('view_item', { bolsa_id: UUID(i + 1) });
  await tick();
  assert.equal(enviados.length, 1, 'session_start + 19 eventos = 20 → envío automático');
  assert.equal(enviados[0].length, A.UMBRAL_ENVIO);

  const lotes = [];
  const sano = A.crearEmisorAnalitica({ almacen: almacen(), enviar: async (l) => { lotes.push(l.length); }, ahora: () => 1e12 });
  for (let i = 0; i < 120; i++) sano.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await sano.vaciar();
  igual(lotes, [20, 20, 20, 20, 20, 20, 1], 'umbral dispara lotes de 20 y vaciar envía el resto');
  assert.ok(lotes.every((n) => n <= A.MAX_POR_LOTE));
});

test('analítica: 5xx o sin red conserva la cola; 4xx la descarta; nunca lanza', async () => {
  let modo = 'red';
  const intentos = [];
  const { e } = emisor({ enviar: async (lote) => {
    intentos.push(lote.length);
    if (modo === 'red') throw new Error('Network Error');
    if (modo === '503') throw Object.assign(new Error('x'), { response: { status: 503 } });
    if (modo === '400') throw Object.assign(new Error('x'), { status: 400 });
  } });
  e.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await e.vaciar();
  assert.equal(e.estado().cola.length, 2);
  modo = '503'; await e.vaciar();
  assert.equal(e.estado().cola.length, 2);
  modo = '400'; await e.vaciar();
  assert.equal(e.estado().cola.length, 0, 'un 4xx no se reintenta para siempre');
  igual(intentos, [2, 2, 2]);
});

test('analítica: un solo envío a la vez aunque se pida vaciar en paralelo', async () => {
  let enCurso = 0, maximo = 0;
  const { e } = emisor({ enviar: async () => { enCurso++; maximo = Math.max(maximo, enCurso); await tick(); enCurso--; } });
  e.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await Promise.all([e.vaciar(), e.vaciar(), e.vaciar()]);
  assert.equal(maximo, 1);
});

test('analítica: deshabilitada (admin/restaurante) no registra nada', async () => {
  const { e, enviados } = emisor();
  e.establecerHabilitada(false);
  e.registrarEvento('view_item', { bolsa_id: UUID(1) });
  await e.vaciar();
  assert.equal(enviados.length, 0);
  assert.equal(e.estado().cola.length, 0);
});

test('analítica: vaciarUrgente entrega lo pendiente al transporte keepalive', async () => {
  const urgentes = [];
  const { e } = emisor({ enviar: async () => { throw new Error('Network Error'); }, enviarUrgente: (l) => urgentes.push(l) });
  e.registrarEvento('begin_checkout', { pedido_id: UUID(5) });
  await e.vaciar();
  e.vaciarUrgente();
  igual(urgentes[0].map((x) => x.evento), ['session_start', 'begin_checkout']);
  assert.equal(e.estado().cola.length, 0);
});

test('analítica: iniciarAnalitica programa envíos, escucha AppState y vacía al desmontar', async () => {
  const lotes = [], subs = [], intervalos = [];
  let quitados = 0, limpiados = 0;
  const mod = load('src/utils/analitica.ts', {
    '@react-native-async-storage/async-storage': almacen(),
    'react-native': { Platform: { OS: 'android' }, AppState: { addEventListener: (_t, fn) => { subs.push(fn); return { remove() { quitados++; } }; } } },
    '../services/api': { analiticaAPI: { enviarEventos: async (l) => { lotes.push(l); } }, API_BASE_URL: 'http://api.test/api' },
  }, {
    setInterval: (fn, ms) => { intervalos.push({ fn, ms }); return intervalos.length; },
    clearInterval: () => { limpiados++; },
  });
  const detener = mod.iniciarAnalitica();
  assert.equal(intervalos[0].ms, mod.INTERVALO_ENVIO_MS);
  mod.registrarEvento('view_item', { bolsa_id: UUID(1) });
  subs[0]('background');
  await tick();
  assert.equal(lotes.length, 1, 'al pasar a segundo plano se envía');
  mod.registrarEvento('add_to_cart', { bolsa_id: UUID(1) });
  detener();
  await tick();
  assert.equal(lotes.length, 2, 'al desmontar se envía lo pendiente');
  assert.equal(lotes[1][0].evento, 'add_to_cart');
  assert.equal(quitados, 1);
  assert.equal(limpiados, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Clientes de API
// ═══════════════════════════════════════════════════════════════════════════

function cargarApi() {
  const instancias = [];
  const axios = { create: (config) => {
    const inst = { config, llamadas: [], interceptoresReq: [],
      interceptors: { request: { use: (fn) => inst.interceptoresReq.push(fn) }, response: { use: () => {} } },
      get: async (url, opts) => { inst.llamadas.push(['GET', url, opts]); return { data: {} }; },
      post: async (url, body) => { inst.llamadas.push(['POST', url, body]); return { data: {} }; },
      put: async () => ({}), patch: async () => ({}), delete: async () => ({}),
    };
    instancias.push(inst);
    return inst;
  } };
  const api = load('src/services/api.ts', {
    axios, 'react-native': { Platform: { OS: 'android' } },
    './sessionEvents': { emitSessionInvalid() {} },
    './authTokenStorage': { getAuthToken: async () => 'jwt-de-prueba' },
  }, { process: { env: {} } });
  return { api, instancias };
}

test('api: clientes de indicadores, embudo e inversión con parámetros limpios', async () => {
  const { api, instancias } = cargarApi();
  const principal = instancias[0];
  await api.indicadoresAPI.indicadores({ periodo: 'mes', mes: '2026-03', zona: '  ', negocio_id: '', tipo: 'cupon' });
  await api.indicadoresAPI.embudo({ periodo: 'rango', desde: '2026-03-01', hasta: '2026-03-31' });
  await api.indicadoresAPI.inversiones({ desde: '2026-03-01', hasta: '2026-03-31', canal: 'meta_ads' });
  await api.indicadoresAPI.registrarInversion({ fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: '1500.50', canal: 'meta_ads' });
  igual(principal.llamadas.map(([m, u, o]) => [m, u, o?.params ?? o]), [
    ['GET', '/admin/indicadores', { periodo: 'mes', mes: '2026-03', tipo: 'cupon' }],
    ['GET', '/admin/indicadores/embudo', { periodo: 'rango', desde: '2026-03-01', hasta: '2026-03-31' }],
    ['GET', '/admin/inversion-publicitaria', { desde: '2026-03-01', hasta: '2026-03-31', canal: 'meta_ads' }],
    ['POST', '/admin/inversion-publicitaria', { fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: '1500.50', canal: 'meta_ads' }],
  ]);
});

test('api: la analítica usa un cliente propio (sin interceptor de sesión) que adjunta el token', async () => {
  const { api, instancias } = cargarApi();
  const analitica = instancias[1];
  assert.equal(analitica.config.timeout, 10000);
  await api.analiticaAPI.enviarEventos([{ evento: 'view_item' }]);
  igual(analitica.llamadas[0], ['POST', '/analitica/eventos', { eventos: [{ evento: 'view_item' }] }]);
  const config = await analitica.interceptoresReq[0]({ headers: {} });
  assert.equal(config.headers.Authorization, 'Bearer jwt-de-prueba');
});

// ═══════════════════════════════════════════════════════════════════════════
// Instrumentación: carrito (add_to_cart) y pago (begin_checkout)
// ═══════════════════════════════════════════════════════════════════════════

function registroAnalitica() {
  const eventos = [];
  let vaciados = 0;
  return { eventos, get vaciados() { return vaciados; },
    double: { registrarEvento: (evento, datos) => eventos.push([evento, datos]), vaciarAnalitica: async () => { vaciados++; },
      iniciarAnalitica: () => () => {}, establecerAnaliticaHabilitada() {} } };
}

test('carrito: add_to_cart solo cuando el carrito acepta, y el resultado vuelve intacto', () => {
  const reg = registroAnalitica();
  const resultados = [{ ok: true }, { ok: false, motivo: 'agotado' }];
  const store = { subscribe: () => () => {}, getSnapshot: () => ({ items: [], loaded: true, storageError: null }), activate: () => () => {},
    agregar: () => resultados.shift(), quitar() {}, limpiar() {}, sincronizarDisponibilidad() {} };
  const { CartProvider } = load('src/context/CartContext.tsx', {
    react: { ...React, useMemo: (f) => f(), useLayoutEffect() {}, useSyncExternalStore: (_s, get) => get() },
    '@react-native-async-storage/async-storage': almacen(),
    './cartStore': { createCartStore: () => store, createCartPersistence: () => ({}) },
    '../utils/analitica': reg.double,
  });
  const valor = CartProvider({ userId: 'u1', children: null }).props.value;
  const bolsa = { id: UUID(1), negocio_id: UUID(2) };
  igual(valor.agregar(bolsa), { ok: true });
  igual(valor.agregar(bolsa), { ok: false, motivo: 'agotado' });
  igual(reg.eventos, [['add_to_cart', { bolsa_id: UUID(1), negocio_id: UUID(2) }]]);
});

// Hooks mínimos que conservan estado/memo entre renders y SÍ ejecutan efectos
// (tras cada render, como un commit), con limpieza al cambiar dependencias.
function crearHooks() {
  const celdas = [];
  let cursor = 0;
  const efectos = [];
  const memo = (fabrica, deps) => {
    const i = cursor++; const prev = celdas[i];
    if (!prev || !deps || deps.some((d, j) => !Object.is(d, prev.deps[j]))) celdas[i] = { deps, valor: fabrica() };
    return celdas[i].valor;
  };
  const react = { ...React,
    useMemo: memo, useCallback: (f, deps) => memo(() => f, deps), useRef: (v) => memo(() => ({ current: v }), []),
    useState(inicial) {
      const celda = memo(() => ({ v: typeof inicial === 'function' ? inicial() : inicial }), []);
      return [celda.v, (n) => { celda.v = typeof n === 'function' ? n(celda.v) : n; }];
    },
    useEffect(efecto, deps) {
      const i = cursor++; const prev = celdas[i];
      if (!prev || !deps || deps.some((d, j) => !Object.is(d, prev.deps[j]))) {
        const sig = { deps }; celdas[i] = sig;
        efectos.push(() => { prev?.limpiar?.(); const r = efecto(); sig.limpiar = typeof r === 'function' ? r : undefined; });
      }
    },
  };
  return { react, render(Componente, props = {}) { cursor = 0; const arbol = Componente(props); efectos.splice(0).forEach((f) => f()); return arbol; } };
}

const NATIVO = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
  ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', Image: 'Image', FlatList: 'FlatList', RefreshControl: 'Refresh',
  StyleSheet: { create: (x) => x }, Platform: { OS: 'android' } };

function expandir(nodo) {
  if (Array.isArray(nodo)) return nodo.map(expandir);
  if (!nodo || typeof nodo !== 'object') return nodo;
  if (typeof nodo.type === 'function') {
    return { ...expandir(nodo.type(nodo.props)), _componente: nodo.type.name, _props: nodo.props };
  }
  const children = nodo.props?.children;
  return { ...nodo, props: { ...nodo.props, children: children === undefined ? undefined : expandir(children) } };
}
function recorrer(nodo) {
  if (!nodo || typeof nodo !== 'object') return [];
  if (Array.isArray(nodo)) return nodo.flatMap(recorrer);
  return [nodo, ...[nodo.props?.children].flat(Infinity).flatMap(recorrer)];
}
function texto(nodo) {
  if (typeof nodo === 'string' || typeof nodo === 'number') return String(nodo);
  if (!nodo || typeof nodo !== 'object') return '';
  if (Array.isArray(nodo)) return nodo.map(texto).join('');
  return [nodo.props?.children].flat(Infinity).map(texto).join('');
}

test('pago: begin_checkout una sola vez por borrador, con pedido_id, y envío inmediato', async () => {
  const reg = registroAnalitica();
  const h = crearHooks();
  const item = { bolsa: { id: UUID(1), negocio_id: UUID(2), nombre: 'Bolsa', precio_descuento: 20, cantidad_disponible: 3,
    hora_recogida_inicio: '00:00', hora_recogida_fin: '23:59' }, cantidad: 1 };
  const horario = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
  let preparaciones = 0;
  const mod = load('app/pago.tsx', {
    react: h.react, 'react-native': NATIVO, '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ replace() {}, push() {}, back() {}, canGoBack: () => false }) },
    'expo-web-browser': {}, '@react-native-async-storage/async-storage': almacen(),
    '@/src/services/api': {
      pagosAPI: { preparar: async () => { preparaciones++; return { data: { pedidoId: UUID(77), codigoRecogida: 'BOC-1', total: 20 } }; },
        actualizarBorrador: async () => ({ data: {} }) },
      pedidosAPI: {}, cuponesAPI: {}, bolsasAPI: { detalle: async () => ({ data: item.bolsa }) },
    },
    '@/src/context/CartContext': { useCart: () => ({ loaded: true, items: [item], total: 20, limpiar() {}, sincronizarDisponibilidad() {} }) },
    '@/src/context/AuthContext': { useAuth: () => ({ usuario: { rol: 'cliente' } }) },
    '@/constants/Colors': { Colors: {} },
    '@/src/utils/horarioRecogida': horario,
    '@/src/utils/usePublicacionesVigentes': { useRelojPublicaciones: () => new Date() },
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/utils/analitica': reg.double,
  });
  const PagoContent = mod.default().type;
  assert.equal(PagoContent.name, 'PagoContent');
  h.render(PagoContent);
  await tick();
  assert.equal(preparaciones, 1);
  igual(reg.eventos, [], 'sin borrador todavía no hay begin_checkout');
  h.render(PagoContent); // re-render con pedidoId ya en estado
  h.render(PagoContent);
  igual(reg.eventos, [['begin_checkout', { pedido_id: UUID(77), bolsa_id: UUID(1), negocio_id: UUID(2) }]]);
  assert.equal(reg.vaciados, 1);
});

test('ficha de producto: view_item al cargar la oferta (fuente)', () => {
  const src = fs.readFileSync(path.join(root, 'app/producto/[id].tsx'), 'utf8');
  assert.match(src, /setBolsa\(data\);\s*\n\s*registrarEvento\('view_item', \{ bolsa_id: data\.id, negocio_id: data\.negocio_id \}\);/);
  // El refresco periódico de disponibilidad NO vuelve a emitir view_item.
  assert.equal((src.match(/registrarEvento\(/g) || []).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Lógica de la pantalla (src/utils/indicadores.ts)
// ═══════════════════════════════════════════════════════════════════════════

const I = load('src/utils/indicadores.ts', {});

test('indicadores: el día y el mes se calculan en hora de Guatemala (UTC-6)', () => {
  assert.equal(I.hoyGuatemala(new Date('2026-10-01T03:00:00Z')), '2026-09-30');
  assert.equal(I.hoyGuatemala(new Date('2026-10-01T06:00:00Z')), '2026-10-01');
  assert.equal(I.mesActualGuatemala(new Date('2026-01-01T05:59:59Z')), '2025-12');
  const f = I.filtrosIniciales(new Date('2026-10-07T18:00:00Z'));
  igual({ ...f }, { periodo: 'mes_actual', mes: '2026-10', desde: '2026-10-01', hasta: '2026-10-07', negocio_id: '', zona: '', tipo: '' });
});

test('indicadores: construirFiltros valida como el backend', () => {
  const base = I.filtrosIniciales(new Date('2026-10-07T18:00:00Z'));
  igual({ ...I.construirFiltros({ ...base, periodo: 'hoy' }).filtros }, { periodo: 'hoy' });
  igual({ ...I.construirFiltros({ ...base, periodo: 'mes', mes: '2026-03', zona: ' Zona 10 ', tipo: 'bolsa', negocio_id: UUID(4) }).filtros },
    { periodo: 'mes', mes: '2026-03', zona: 'Zona 10', tipo: 'bolsa', negocio_id: UUID(4) });
  assert.ok(I.construirFiltros({ ...base, periodo: 'mes', mes: '2026-13' }).error);
  assert.ok(I.construirFiltros({ ...base, periodo: 'rango', desde: '2026-03-10', hasta: '2026-03-01' }).error);
  assert.ok(I.construirFiltros({ ...base, periodo: 'rango', desde: '2026-02-30', hasta: '2026-03-01' }).error);
  assert.ok(I.construirFiltros({ ...base, negocio_id: 'x' }).error);
});

test('indicadores: nunca un número cuando el estado es no_aplica o sin_datos', () => {
  assert.equal(I.valorPrincipal({ estado: 'ok', valor: 66.67, unidad: '%' }), '66.67%');
  assert.equal(I.valorPrincipal({ estado: 'ok', valor: 3260, unidad: 'GTQ' }), 'Q3,260.00');
  assert.equal(I.valorPrincipal({ estado: 'ok', valor: 20, unidad: 'minutos' }), '20 min');
  assert.equal(I.valorPrincipal({ estado: 'ok', valor: 0, unidad: '%' }), '0%', 'un 0 medido sí se muestra');
  assert.equal(I.valorPrincipal({ estado: 'no_aplica', valor: null, unidad: '%' }), null);
  assert.equal(I.valorPrincipal({ estado: 'sin_datos', valor: 0, unidad: '%' }), null, 'aunque llegara un 0, sin_datos no se pinta');
  igual({ ...I.partesCociente({ unidad: 'GTQ', numerador: 3260, denominador: 1 }) }, { numerador: 'Q3,260.00', denominador: '1' });
  assert.equal(I.partesCociente({ unidad: '%', numerador: null, denominador: null }), null);
});

test('indicadores: semáforo de tiempos con umbrales, embudo y formulario de inversión', () => {
  assert.equal(I.nivelTiempo({ clave: 'tiempo_recibido_aceptado', estado: 'ok', valor: 5 }), 'ok');
  assert.equal(I.nivelTiempo({ clave: 'tiempo_recibido_aceptado', estado: 'ok', valor: 10 }), 'alerta');
  assert.equal(I.nivelTiempo({ clave: 'tiempo_recibido_aceptado', estado: 'ok', valor: 25 }), 'critico');
  assert.equal(I.nivelTiempo({ clave: 'tiempo_aceptado_listo', estado: 'sin_datos', valor: null }), 'sin_datos');

  const barras = I.barrasEmbudo({ estado: 'ok', pasos: [
    { clave: 'visita', sesiones: 4 }, { clave: 'vista_oferta', sesiones: 3 }, { clave: 'carrito', sesiones: 2 },
    { clave: 'inicio_pago', sesiones: 2 }, { clave: 'compra_pagada', sesiones: 0 }] });
  igual(barras.map((b) => [b.nombre, b.ancho]), [['Visita', 100], ['Ve oferta', 75], ['Carrito', 50], ['Inicia pago', 50], ['Compra pagada', 2]]);
  const sinDatos = I.barrasEmbudo({ estado: 'sin_datos', pasos: [{ clave: 'visita', sesiones: null }] });
  assert.equal(sinDatos[0].ancho, null);

  igual({ ...I.validarFormInversion({ campana: ' Octubre ', fecha_inicio: '2026-10-01', fecha_fin: '2026-10-31', monto: '1500,5' }).datos },
    { campana: 'Octubre', fecha_inicio: '2026-10-01', fecha_fin: '2026-10-31', monto: '1500.5' });
  for (const monto of ['0', '-1', 'abc', '1.234', '']) {
    assert.ok(I.validarFormInversion({ campana: '', fecha_inicio: '2026-10-01', fecha_fin: '2026-10-31', monto }).error, monto);
  }
  assert.ok(I.validarFormInversion({ campana: '', fecha_inicio: '2026-10-31', fecha_fin: '2026-10-01', monto: '5' }).error);
  assert.equal(I.describirPeriodo({ tipo: 'mes', desde_local: '2026-03-01', hasta_local: '2026-03-31' }), '1 mar 2026 – 31 mar 2026 · hora de Guatemala');
  assert.equal(I.formatearInstante('2026-03-01T10:00:00.000Z'), '1 mar 2026, 04:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// Pantalla Admin › Indicadores
// ═══════════════════════════════════════════════════════════════════════════

const periodoMarzo = { tipo: 'mes', desde: '2026-03-01T06:00:00.000Z', hasta: '2026-04-01T06:00:00.000Z', desde_local: '2026-03-01', hasta_local: '2026-03-31', zona_horaria: 'America/Guatemala' };
const kpi = (clave, nombre, extra) => ({ clave, nombre, unidad: '%', formula: `fórmula de ${nombre}`, exclusiones: 'exclusiones', periodo: periodoMarzo, ...extra });
const tramo = (clave, nombre, valor, muestras) => ({ clave, nombre, valor, unidad: 'minutos', formula: 'mediana', numerador: null, denominador: null,
  periodo: periodoMarzo, exclusiones: '', estado: muestras ? 'ok' : 'sin_datos', muestras });
const TRAMOS = [tramo('tiempo_recibido_aceptado', 'Recibido → aceptado', 12, 3), tramo('tiempo_aceptado_listo', 'Aceptado → listo (preparación)', null, 0),
  tramo('tiempo_listo_completado', 'Listo → completado (espera de recogida)', 30, 1)];
const RESPUESTA = {
  periodo: periodoMarzo, filtros: { negocio_id: null, zona: null, tipo: null }, generado_en: '2026-10-07T18:00:00Z', advertencias: [],
  kpis: [
    kpi('conversion_compra', 'Conversión a compra', { valor: 25, numerador: 1, denominador: 4, estado: 'ok', cobertura_parcial: true, cobertura_desde: '2026-03-01T10:00:00.000Z' }),
    kpi('pedidos_completados', 'Pedidos completados', { valor: 50, numerador: 2, denominador: 4, estado: 'ok', desglose: { completados: 2, en_curso: 1, cancelados: 1, rechazados_restaurante: 1 } }),
    kpi('recompra', 'Recompra', { valor: null, numerador: 0, denominador: 0, estado: 'no_aplica' }),
    kpi('liquidez_ofertas', 'Liquidez de ofertas', { valor: 66.67, numerador: 2, denominador: 3, estado: 'ok' }),
    kpi('tiempo_limitado_merma', 'Tiempo limitado / Merma', { valor: 33.33, numerador: 3, denominador: 9, estado: 'ok' }),
    kpi('cac_meta_ads', 'CAC · Meta Ads', { unidad: 'GTQ', valor: null, numerador: null, denominador: null, estado: 'sin_datos', nota: 'Sin inversión Meta Ads registrada para el periodo.' }),
    kpi('ticket_promedio', 'Ticket promedio', { unidad: 'GTQ', valor: 31.67, numerador: 95, denominador: 3, estado: 'ok' }),
    kpi('abandono_pago', 'Abandono del pago', { valor: 25, numerador: 1, denominador: 4, estado: 'ok', ventana_minutos: 30 }),
    kpi('pagos_fallidos', 'Pagos fallidos', { valor: 20, numerador: 1, denominador: 5, estado: 'ok' }),
    { ...TRAMOS[0], clave: 'tiempos_operativos', nombre: 'Tiempos operativos', desglose: TRAMOS },
    kpi('negocios_oferta_activa', 'Negocios con oferta activa', { valor: 50, numerador: 1, denominador: 2, estado: 'ok', periodo: { tipo: 'lectura_actual', instante: '2026-10-07T18:00:00Z' } }),
  ],
};
const EMBUDO = { periodo: periodoMarzo, filtros: RESPUESTA.filtros, generado_en: '', advertencias: [], estado: 'ok', regla: 'Sesiones únicas por paso.',
  pasos: [
    { clave: 'visita', nombre: 'Visita', evento: null, sesiones: 4, tasa_desde_anterior: null, tasa_desde_visita: null },
    { clave: 'vista_oferta', nombre: 'Vista de oferta', evento: 'view_item', sesiones: 3, tasa_desde_anterior: { valor: 75, numerador: 3, denominador: 4, unidad: '%', estado: 'ok' } },
    { clave: 'carrito', nombre: 'Carrito', evento: 'add_to_cart', sesiones: 2, tasa_desde_anterior: { valor: 66.67, numerador: 2, denominador: 3, unidad: '%', estado: 'ok' } },
    { clave: 'inicio_pago', nombre: 'Inicio de pago', evento: 'begin_checkout', sesiones: 2, tasa_desde_anterior: { valor: 100, numerador: 2, denominador: 2, unidad: '%', estado: 'ok' } },
    { clave: 'compra_pagada', nombre: 'Compra pagada', evento: null, sesiones: 1, tasa_desde_anterior: { valor: 50, numerador: 1, denominador: 2, unidad: '%', estado: 'ok' } },
  ] };

function montarPantalla({ fallarIndicadores = false } = {}) {
  const h = crearHooks();
  const llamadas = { indicadores: [], embudo: [], inversiones: [], registrar: [] };
  function CalendarioPicker(props) { return { type: 'Calendario', props: { ...props, children: props.value } }; }
  const mod = load('app/admin/indicadores.tsx', {
    react: h.react, 'react-native': NATIVO, '@expo/vector-icons': { Ionicons: 'Icon' },
    '@/components/CalendarioPicker': { __esModule: true, default: CalendarioPicker },
    '@/src/services/api': {
      adminAPI: { negocios: async () => ({ data: [{ id: UUID(21), nombre: 'Ola Azul', zona: '10' }, { id: UUID(22), nombre: 'Otro', zona: '4' }] }) },
      indicadoresAPI: {
        indicadores: async (f) => { llamadas.indicadores.push(f); if (fallarIndicadores) throw new Error('Servidor caído'); return { data: RESPUESTA }; },
        embudo: async (f) => { llamadas.embudo.push(f); return { data: EMBUDO }; },
        inversiones: async (p) => { llamadas.inversiones.push(p); return { data: { registros: [], total: 0 } }; },
        registrarInversion: async (d) => { llamadas.registrar.push(d); return { data: { id: 'x', ...d } }; },
      },
    },
    '@/src/utils/indicadores': I,
  });
  const Pantalla = mod.default;
  const render = () => expandir(h.render(Pantalla));
  return { mod, llamadas, render };
}

const botones = (arbol, etiqueta) => recorrer(arbol).filter((n) => n.type === 'Button' && texto(n).trim() === etiqueta);

test('pantalla: carga con mes actual y pinta los 11 KPIs con insignias, nunca ceros inventados', async () => {
  const p = montarPantalla();
  p.render();
  await tick();
  const arbol = p.render();
  igual({ ...p.llamadas.indicadores[0] }, { periodo: 'mes_actual' });
  igual({ ...p.llamadas.inversiones[0] }, { desde: '2026-03-01', hasta: '2026-03-31', canal: 'meta_ads' });

  const tarjetas = recorrer(arbol).filter((n) => n._componente === 'TarjetaKpi');
  assert.equal(tarjetas.length, 11);
  const porClave = Object.fromEntries(tarjetas.map((t) => [t._props.kpi.clave, texto(t)]));
  assert.match(porClave.recompra, /No aplica/);
  assert.match(porClave.recompra, /El denominador es 0/);
  assert.doesNotMatch(porClave.recompra, /0%/);
  assert.match(porClave.cac_meta_ads, /Sin datos/);
  assert.doesNotMatch(porClave.cac_meta_ads, /Q0/);
  assert.match(porClave.liquidez_ofertas, /66\.67%/);
  assert.match(porClave.liquidez_ofertas, /2 \/ 3/);
  assert.match(porClave.ticket_promedio, /Q31\.67/);
  assert.match(porClave.ticket_promedio, /Q95\.00 \/ 3/);

  const embudo = recorrer(arbol).find((n) => n._componente === 'SeccionEmbudo');
  assert.match(texto(embudo), /1\. Visita[\s\S]*2\. Ve oferta[\s\S]*3\. Carrito[\s\S]*4\. Inicia pago[\s\S]*5\. Compra pagada/);
  const tiempos = texto(recorrer(arbol).find((n) => n._componente === 'SeccionTiempos'));
  assert.match(tiempos, /12 min/);
  assert.match(tiempos, /Alerta ≥ 10 min · Crítico ≥ 20 min/);
  assert.match(tiempos, /Alerta/);
  assert.match(tiempos, /Sin datos/);
  assert.match(tiempos, /3 pedidos medidos/);
  assert.match(texto(arbol), /Sin inversión registrada/);
});

test('pantalla: "Ver fórmula" expone fórmula, numerador/denominador, periodo, exclusiones, desglose y notas', async () => {
  const p = montarPantalla();
  p.render(); await tick();
  let arbol = p.render();
  const tarjetaConv = () => recorrer(arbol).find((n) => n._componente === 'TarjetaKpi' && n._props.kpi.clave === 'pedidos_completados');
  assert.doesNotMatch(texto(tarjetaConv()), /fórmula de Pedidos completados/);
  botones(tarjetaConv(), 'Ver fórmula')[0].props.onPress();
  arbol = p.render();
  const t = texto(tarjetaConv());
  assert.match(t, /fórmula de Pedidos completados/);
  assert.match(t, /1 mar 2026 – 31 mar 2026 · hora de Guatemala/);
  assert.match(t, /Rechazados por restaurante/);
  assert.match(t, /exclusiones/);
});

test('pantalla: cambiar a Hoy, Mes, Rango, Histórico y tipo recalcula con los filtros correctos', async () => {
  const p = montarPantalla();
  p.render(); await tick();
  let arbol = p.render();
  botones(arbol, 'Hoy')[0].props.onPress(); arbol = p.render(); await tick();
  botones(arbol, 'Promoción')[0].props.onPress(); arbol = p.render(); await tick();
  botones(arbol, 'Mes')[0].props.onPress(); arbol = p.render(); await tick();
  recorrer(arbol).find((n) => n.type === 'Calendario' && n.props.label === 'Mes').props.onChange('2026-03');
  arbol = p.render(); await tick();
  botones(arbol, 'Rango')[0].props.onPress(); arbol = p.render(); await tick();
  const cal = (label) => recorrer(arbol).find((n) => n.type === 'Calendario' && n.props.label === label);
  cal('Desde').props.onChange('2026-03-05'); arbol = p.render(); await tick();
  cal('Hasta').props.onChange('2026-03-20'); arbol = p.render(); await tick();
  botones(arbol, 'Histórico')[0].props.onPress(); arbol = p.render(); await tick();
  p.render();
  const vistos = p.llamadas.indicadores.map((f) => JSON.stringify({ ...f }));
  assert.ok(vistos.includes(JSON.stringify({ periodo: 'hoy' })));
  assert.ok(vistos.includes(JSON.stringify({ periodo: 'hoy', tipo: 'cupon' })));
  assert.ok(vistos.includes(JSON.stringify({ periodo: 'mes', mes: '2026-03', tipo: 'cupon' })));
  assert.ok(vistos.includes(JSON.stringify({ periodo: 'rango', desde: '2026-03-05', hasta: '2026-03-20', tipo: 'cupon' })));
  assert.ok(vistos.includes(JSON.stringify({ periodo: 'historico', tipo: 'cupon' })));
  assert.equal(p.llamadas.indicadores.length, p.llamadas.embudo.length, 'embudo y KPIs siempre con los mismos filtros');
});

test('pantalla: filtro por zona y por negocio', async () => {
  const p = montarPantalla();
  p.render(); await tick(); await tick();
  let arbol = p.render();
  botones(arbol, 'Zona 4')[0].props.onPress(); arbol = p.render(); await tick();
  botones(arbol, 'Todos los negocios')[0].props.onPress(); arbol = p.render();
  const lista = recorrer(arbol).find((n) => n.type === 'FlatList');
  const opcion = lista.props.renderItem({ item: { id: UUID(21), nombre: 'Ola Azul' } });
  opcion.props.onPress(); p.render(); await tick(); p.render();
  const ultimo = { ...p.llamadas.indicadores.at(-1) };
  igual(ultimo, { periodo: 'mes_actual', negocio_id: UUID(21), zona: '4' });
});

test('pantalla: inversión Meta Ads valida, registra con canal meta_ads y recarga el CAC', async () => {
  const p = montarPantalla();
  p.render(); await tick();
  let arbol = p.render();
  botones(arbol, 'Guardar inversión')[0].props.onPress();
  arbol = p.render();
  assert.match(texto(arbol), /Elige fecha de inicio y de fin/);
  assert.equal(p.llamadas.registrar.length, 0);

  const cal = (label) => recorrer(arbol).find((n) => n.type === 'Calendario' && n.props.label === label);
  cal('Inicio').props.onChange('2026-03-01'); arbol = p.render();
  cal('Fin').props.onChange('2026-03-31'); arbol = p.render();
  const inputs = recorrer(arbol).filter((n) => n.type === 'Input');
  inputs.find((n) => n.props.placeholder === 'Campaña (opcional)').props.onChangeText('Marzo');
  inputs.find((n) => n.props.placeholder === 'Monto (Q)').props.onChangeText('3100');
  arbol = p.render();
  const consultasAntes = p.llamadas.indicadores.length;
  await botones(arbol, 'Guardar inversión')[0].props.onPress();
  igual({ ...p.llamadas.registrar[0] }, { campana: 'Marzo', fecha_inicio: '2026-03-01', fecha_fin: '2026-03-31', monto: '3100', canal: 'meta_ads' });
  assert.equal(p.llamadas.indicadores.length, consultasAntes + 1, 'recarga para reflejar el CAC');
});

test('pantalla: error del backend se muestra con reintento, sin tarjetas con ceros', async () => {
  const p = montarPantalla({ fallarIndicadores: true });
  p.render(); await tick();
  const arbol = p.render();
  assert.match(texto(arbol), /Servidor caído/);
  assert.equal(recorrer(arbol).filter((n) => n._componente === 'TarjetaKpi').length, 0);
  const antes = p.llamadas.indicadores.length;
  botones(arbol, 'Reintentar')[0].props.onPress();
  await tick();
  assert.equal(p.llamadas.indicadores.length, antes + 1);
});

test('layout admin: la pestaña Indicadores está registrada después de Cupones', () => {
  const src = fs.readFileSync(path.join(root, 'app/admin/_layout.tsx'), 'utf8');
  const orden = [...src.matchAll(/name: '([\w-]+)',\s+label:/g)].map((m) => m[1]);
  assert.equal(orden.indexOf('cupones'), 3);
  assert.equal(orden.indexOf('indicadores'), 4);
});
