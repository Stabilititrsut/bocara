// Ejecutar: node scripts/test-realtime.cjs. Sin red, Expo ni Supabase real.
// Cubre el criterio del viernes frontend: capa de realtime (canales, cleanup,
// dedup, logout, cambio de usuario, reconexión) — ver src/services/realtime.ts
// y src/context/RealtimeContext.tsx. Mismo patrón de scripts/test-cart.cjs:
// transpila el .ts/.tsx real y lo ejecuta en un VM con dobles inyectados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}, globals = {}) {
  const exportsObj = {};
  const source = read(file);
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, Promise, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

// ── Doble mínimo de un cliente Supabase Realtime ─────────────────────────────
// Reproduce la forma encadenable real (.channel().on().subscribe()) y expone
// helpers de test para simular lo que Postgres/Realtime harían: entregar un
// payload a los handlers de un canal, o cambiar su estado de conexión.
function crearClienteFalso() {
  const canales = new Map();
  const cliente = {
    channel(nombre) {
      const canal = {
        nombre, handlers: [], statusCb: null,
        on(evento, config, cb) { canal.handlers.push({ evento, config, cb }); return canal; },
        subscribe(cb) { canal.statusCb = cb; canales.set(nombre, canal); return canal; },
      };
      return canal;
    },
    removeChannel(canal) { canales.delete(canal?.nombre); },
    emitir(nombreCanal, payload) {
      const canal = canales.get(nombreCanal);
      if (!canal) return;
      for (const h of canal.handlers.slice()) h.cb(payload);
    },
    marcarEstado(nombreCanal, status) { canales.get(nombreCanal)?.statusCb?.(status); },
    canalActivo(nombreCanal) { return canales.has(nombreCanal); },
    obtenerCanal(nombreCanal) { return canales.get(nombreCanal); },
  };
  return cliente;
}

// setTimeout/clearTimeout controlados: capturan el callback en vez de
// ejecutarlo, así el test avanza el "reloj" cuando quiere (reconexión
// determinista, sin esperas reales).
function crearReloj() {
  let siguienteId = 1;
  const pendientes = new Map();
  return {
    setTimeout(fn, ms) { const id = siguienteId++; pendientes.set(id, fn); return id; },
    clearTimeout(id) { pendientes.delete(id); },
    avanzar() { const entradas = Array.from(pendientes.entries()); pendientes.clear(); for (const [, fn] of entradas) fn(); },
    pendientesCount() { return pendientes.size; },
  };
}

const realtime = () => load('src/services/realtime.ts', { './supabase': { supabase: {} } });

// ── Funciones puras ───────────────────────────────────────────────────────

test('construirClaveDedup identifica el mismo cambio de fila, no el mismo envío', () => {
  const { construirClaveDedup } = realtime();
  const p1 = { eventType: 'UPDATE', new: { id: 'ped-1' }, commit_timestamp: 't1' };
  const p2 = { eventType: 'UPDATE', new: { id: 'ped-1' }, commit_timestamp: 't1' };
  const p3 = { eventType: 'UPDATE', new: { id: 'ped-1' }, commit_timestamp: 't2' };
  assert.equal(construirClaveDedup(p1), construirClaveDedup(p2));
  assert.notEqual(construirClaveDedup(p1), construirClaveDedup(p3));
});

test('crearDeduplicador: un segundo evento igual se reconoce como visto, y el buffer no crece sin límite', () => {
  const { crearDeduplicador } = realtime();
  const d = crearDeduplicador(3);
  assert.equal(d.yaVisto('a'), false);
  assert.equal(d.yaVisto('a'), true);
  d.yaVisto('b'); d.yaVisto('c'); d.yaVisto('d'); // desplaza 'a' del buffer (max=3)
  assert.equal(d.size(), 3);
  assert.equal(d.yaVisto('a'), false, 'tras salir del buffer, "a" puede volver a verse (no es un problema: ya se procesó hace mucho)');
});

test('mapearEventoPedido descarta payloads sin id en vez de emitir un evento roto', () => {
  const { mapearEventoPedido } = realtime();
  assert.equal(mapearEventoPedido({ eventType: 'DELETE', old: {} }), null);
  assert.equal(mapearEventoPedido({}), null);
  const ok = mapearEventoPedido({ eventType: 'UPDATE', new: { id: 'p1', estado: 'listo', estado_pago: 'pagado' } });
  // Comparación campo a campo (no deepStrictEqual del objeto completo): `ok`
  // se crea dentro del VM sandbox, con un `Object.prototype` de otro realm —
  // deepStrictEqual lo compara y falla por la identidad de prototipo, no por
  // el contenido real.
  assert.equal(ok.tipo, 'UPDATE');
  assert.equal(ok.pedidoId, 'p1');
  assert.equal(ok.estado, 'listo');
  assert.equal(ok.estado_pago, 'pagado');
  assert.ok(ok.raw);
});

test('calcularBackoffMs crece exponencialmente y tiene tope (no reintenta en bucle rápido)', () => {
  const { calcularBackoffMs } = realtime();
  assert.equal(calcularBackoffMs(1), 2000);
  assert.equal(calcularBackoffMs(2), 4000);
  assert.equal(calcularBackoffMs(3), 8000);
  assert.equal(calcularBackoffMs(10), 30000, 'tope en 30s aunque el intento sea muy alto');
});

// ── suscribirPedidosPorFiltro: orquestación end-to-end con el doble ─────────

test('1) cliente recibe un cambio de un pedido propio', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  const recibidos = [];
  suscribirPedidosPorFiltro({ filtro: 'usuario_id=eq.cliente-1', nombreCanal: 'pedidos-cliente-1', onEvento: e => recibidos.push(e), cliente });
  cliente.marcarEstado('pedidos-cliente-1', 'SUBSCRIBED');
  cliente.emitir('pedidos-cliente-1', { eventType: 'UPDATE', new: { id: 'ped-1', usuario_id: 'cliente-1', estado: 'listo' }, commit_timestamp: 't1' });
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].pedidoId, 'ped-1');
  assert.equal(recibidos[0].estado, 'listo');
});

test('2) restaurante recibe un cambio de un pedido de su propio negocio', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  const recibidos = [];
  suscribirPedidosPorFiltro({ filtro: 'negocio_id=eq.negocio-1', nombreCanal: 'pedidos-restaurante-1', onEvento: e => recibidos.push(e), cliente });
  cliente.marcarEstado('pedidos-restaurante-1', 'SUBSCRIBED');
  cliente.emitir('pedidos-restaurante-1', { eventType: 'INSERT', new: { id: 'ped-9', negocio_id: 'negocio-1', estado: 'confirmado' }, commit_timestamp: 't1' });
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].pedidoId, 'ped-9');
});

test('3) la suscripción se arma con el filtro server-side del dueño — nunca sin filtro (así un evento ajeno no puede llegar)', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  suscribirPedidosPorFiltro({ filtro: 'usuario_id=eq.cliente-1', nombreCanal: 'c1', onEvento: () => {}, cliente });
  const canal = cliente.obtenerCanal('c1');
  assert.equal(canal.handlers.length, 1);
  assert.equal(canal.handlers[0].evento, 'postgres_changes');
  assert.equal(canal.handlers[0].config.table, 'pedidos');
  assert.equal(canal.handlers[0].config.filter, 'usuario_id=eq.cliente-1', 'el filtro debe ir server-side (Postgres), no post-filtrado en el cliente');
});

test('4) el mismo cambio entregado dos veces (redelivery de Realtime) no duplica el evento', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  const recibidos = [];
  suscribirPedidosPorFiltro({ filtro: 'usuario_id=eq.cliente-1', nombreCanal: 'c1', onEvento: e => recibidos.push(e), cliente });
  const payload = { eventType: 'UPDATE', new: { id: 'ped-1', estado: 'confirmado' }, commit_timestamp: 't1' };
  cliente.emitir('c1', payload);
  cliente.emitir('c1', payload); // mismo payload — redelivery
  assert.equal(recibidos.length, 1);
});

test('5) cleanup: tras desmontar, un evento que llegara tarde no actualiza estado (no hay "setState tras unmount")', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  const recibidos = [];
  const limpiar = suscribirPedidosPorFiltro({ filtro: 'usuario_id=eq.cliente-1', nombreCanal: 'c1', onEvento: e => recibidos.push(e), cliente });
  limpiar();
  cliente.emitir('c1', { eventType: 'UPDATE', new: { id: 'ped-1' }, commit_timestamp: 't1' });
  assert.equal(recibidos.length, 0, 'el flag `montado` debe impedir procesar eventos después del cleanup');
  assert.equal(cliente.canalActivo('c1'), false, 'removeChannel debe haberse llamado');
});

test('8) reconexión: CHANNEL_ERROR agenda un reintento con backoff y reconstruye el canal', () => {
  const { suscribirPedidosPorFiltro } = realtime();
  const cliente = crearClienteFalso();
  const reloj = crearReloj();
  const estados = [];
  // setTimeout/clearTimeout globales del módulo se resuelven en tiempo de
  // ejecución (no import), así que se inyectan como globals del VM.
  const mod = load('src/services/realtime.ts', { './supabase': { supabase: {} } }, { setTimeout: reloj.setTimeout, clearTimeout: reloj.clearTimeout });
  mod.suscribirPedidosPorFiltro({ filtro: 'usuario_id=eq.c1', nombreCanal: 'c1', onEvento: () => {}, onEstadoConexion: s => estados.push(s), cliente });
  cliente.marcarEstado('c1', 'SUBSCRIBED');
  assert.deepEqual(estados, [true]);
  cliente.marcarEstado('c1', 'CHANNEL_ERROR');
  assert.deepEqual(estados, [true, false]);
  assert.equal(reloj.pendientesCount(), 1, 'debe haber agendado exactamente un reintento con backoff');
  reloj.avanzar(); // simula que pasó el tiempo de backoff — aquí se limpia el canal viejo y se reconecta
  assert.equal(cliente.canalActivo('c1'), true, 'conectar() ya reconstruyó el canal con el mismo nombre');
  cliente.marcarEstado('c1', 'SUBSCRIBED'); // el canal reconstruido vuelve a conectar
  assert.deepEqual(estados, [true, false, true]);
});

// ── configCanalPedidos (RealtimeContext) — sesión/logout/cambio de usuario ──

const realtimeContext = () => load('src/context/RealtimeContext.tsx', {
  react: { createContext: () => ({}), useCallback: f => f, useContext: () => ({}), useEffect: () => {}, useRef: v => ({ current: v }), useState: v => [v, () => {}] },
  './AuthContext': { useAuth: () => ({ usuario: null }) },
  '../services/api': { negociosAPI: { miNegocio: async () => ({ data: {} }) } },
  '../services/realtime': { suscribirPedidosPorFiltro: () => () => {} },
});

test('6) sin sesión (logout) no hay canal para ningún rol', () => {
  const { configCanalPedidos } = realtimeContext();
  assert.equal(configCanalPedidos(null), null);
  assert.equal(configCanalPedidos(undefined), null);
});

test('7) cambio de usuario produce un canal distinto (nombre único por id) — nunca comparte el canal del anterior', () => {
  const { configCanalPedidos } = realtimeContext();
  const canalA = configCanalPedidos({ id: 'user-a', rol: 'cliente' });
  const canalB = configCanalPedidos({ id: 'user-b', rol: 'cliente' });
  assert.notEqual(canalA.nombreCanal, canalB.nombreCanal);
  assert.notEqual(canalA.filtro, canalB.filtro);
});

test('restaurante sin negocio resuelto todavía: sin canal (no se suscribe con filtro vacío/erróneo)', () => {
  const { configCanalPedidos } = realtimeContext();
  assert.equal(configCanalPedidos({ id: 'user-r', rol: 'restaurante' }, null), null);
  assert.equal(configCanalPedidos({ id: 'user-r', rol: 'restaurante' }, undefined), null);
});

test('admin no tiene canal de pedidos', () => {
  const { configCanalPedidos } = realtimeContext();
  assert.equal(configCanalPedidos({ id: 'admin-1', rol: 'admin' }), null);
});

test('RealtimeProvider: el efecto reconstruye el canal cuando cambia usuario.id o usuario.rol, nunca por una razón distinta', () => {
  const src = read('src/context/RealtimeContext.tsx');
  assert.match(src, /\}, \[usuario\?\.id, usuario\?\.rol, emitir\]\);/, 'las dependencias del efecto deben incluir id y rol del usuario — un cambio de cuenta debe limpiar y rearmar');
  assert.match(src, /cancelado = true;\s*limpiarCanal\?\.\(\);/, 'el cleanup del efecto debe cancelar la promesa en vuelo y limpiar el canal');
  assert.match(src, /setConectado\(false\);\s*if \(!usuario\) return undefined;/, 'sin usuario (logout) el efecto no debe intentar abrir canal alguno');
});

test('un listener que lanza no debe tumbar a los demás listeners registrados', () => {
  const src = read('src/context/RealtimeContext.tsx');
  assert.match(src, /try \{ cb\(evento\); \} catch/, 'emitir debe aislar errores de cada listener');
});
