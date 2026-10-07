// Ejecutar: node scripts/test-realtime-fallback-polling.cjs. Sin red, Expo ni
// Supabase real. Mismo patrón VM que scripts/test-realtime.cjs.
//
// Objetivo (Prueba #14 — QA): demostrar que cuando el canal de Supabase
// Realtime NUNCA llega a SUBSCRIBED (CHANNEL_ERROR/TIMED_OUT en bucle), la
// app (a) no se cae, (b) sigue reintentando con backoff acotado en vez de
// martillar la red, y (c) el polling que ya vive en cada pantalla/contexto es
// INDEPENDIENTE del estado de conexión de Realtime — no está condicionado a
// `conectado === true`, así que sigue corriendo exactamente igual si Realtime
// nunca conecta.
//
// La parte (c) se verifica por inspección de código fuente real (no por
// render de componentes React Native: cargarlos en este VM exigiría mockear
// AsyncStorage, expo-camera, expo-router, etc. — fuera del alcance de un
// doble de Supabase). Es una prueba estática pero determinista: falla si
// alguien acopla el `setInterval` de polling a `conectado`.
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
    marcarEstado(nombreCanal, status) { canales.get(nombreCanal)?.statusCb?.(status); },
    canalActivo(nombreCanal) { return canales.has(nombreCanal); },
  };
  return cliente;
}

function crearReloj() {
  let siguienteId = 1;
  const pendientes = new Map();
  return {
    setTimeout(fn, ms) { const id = siguienteId++; pendientes.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pendientes.delete(id); },
    // Avanza UNA tanda de timers pendientes (como test-realtime.cjs). Devuelve
    // los `ms` con los que se agendó cada uno, para verificar el backoff.
    avanzar() {
      const entradas = Array.from(pendientes.entries());
      pendientes.clear();
      const msAgendados = entradas.map(([, v]) => v.ms);
      for (const [, { fn }] of entradas) fn();
      return msAgendados;
    },
    pendientesCount() { return pendientes.size; },
  };
}

// ── A) Canal que NUNCA llega a SUBSCRIBED: no debe tumbar la app ────────────

test('el canal en CHANNEL_ERROR permanente reintenta con backoff creciente y acotado, sin lanzar', () => {
  const cliente = crearClienteFalso();
  const reloj = crearReloj();
  const estados = [];
  const mod = load('src/services/realtime.ts', { './supabase': { supabase: {} } },
    { setTimeout: reloj.setTimeout, clearTimeout: reloj.clearTimeout });

  assert.doesNotThrow(() => {
    mod.suscribirPedidosPorFiltro({
      filtro: 'negocio_id=eq.negocio-1',
      nombreCanal: 'pedidos-restaurante-1',
      onEvento: () => {},
      onEstadoConexion: s => estados.push(s),
      cliente,
    });
  });

  const msBackoff = [];
  for (let i = 0; i < 5; i++) {
    cliente.marcarEstado('pedidos-restaurante-1', 'CHANNEL_ERROR');
    const agendados = reloj.avanzar(); // dispara el reintento agendado tras este fallo
    msBackoff.push(...agendados);
  }

  // Nunca se reportó conectado=true: el canal jamás llegó a SUBSCRIBED.
  assert.ok(estados.every(s => s === false), `esperaba solo estados false, obtuve: ${estados}`);
  assert.equal(estados.length, 5, 'un estado false por cada CHANNEL_ERROR recibido');
  // Backoff exponencial acotado: 2s,4s,8s,16s,30s (tope) — igual que
  // calcularBackoffMs, no reintenta en bucle rápido con la red muerta.
  assert.deepEqual(msBackoff, [2000, 4000, 8000, 16000, 30000]);
  // El canal se reconstruyó en cada ciclo (limpiarCanalActual + conectar) sin
  // quedar en un estado roto: sigue "vivo" para el próximo intento.
  assert.equal(cliente.canalActivo('pedidos-restaurante-1'), true);
});

test('TIMED_OUT y CLOSED se tratan igual que CHANNEL_ERROR: false + reintento agendado', () => {
  for (const status of ['TIMED_OUT', 'CLOSED']) {
    const cliente = crearClienteFalso();
    const reloj = crearReloj();
    const estados = [];
    const mod = load('src/services/realtime.ts', { './supabase': { supabase: {} } },
      { setTimeout: reloj.setTimeout, clearTimeout: reloj.clearTimeout });
    mod.suscribirPedidosPorFiltro({
      filtro: 'usuario_id=eq.c1', nombreCanal: 'c1', onEvento: () => {},
      onEstadoConexion: s => estados.push(s), cliente,
    });
    cliente.marcarEstado('c1', status);
    assert.deepEqual(estados, [false], `status=${status}`);
    assert.equal(reloj.pendientesCount(), 1, `status=${status} debe agendar un reintento`);
  }
});

// ── B) El polling de cada pantalla/contexto NO depende de `conectado` ───────
// Prueba estática (regex sobre el archivo real): estos setInterval deben
// existir SIN condicionarse al booleano `conectado` de useRealtime(). Si
// alguien cambia esto a `if (conectado) return;` antes del setInterval, esta
// prueba debe fallar — sería un regreso a "sin realtime no hay refresco".

test('cliente (app/(tabs)/pedidos.tsx): el polling de pedidos activos no depende de `conectado`', () => {
  const src = read('app/(tabs)/pedidos.tsx');
  // El efecto de polling arma el interval mirando solo `pedidos` (tieneActivos),
  // no el estado de conexión de realtime.
  const bloque = src.match(/useEffect\(\(\) => \{\s*const tieneActivos[\s\S]*?\}, \[pedidos[^\]]*\]\);/);
  assert.ok(bloque, 'debe existir el efecto de polling condicionado a pedidos activos');
  assert.doesNotMatch(bloque[0], /conectado/, 'el polling no debe leer `conectado` — debe funcionar aunque Realtime nunca conecte');
  assert.match(bloque[0], /setInterval\(cargar, 10000\)/);
  // useRealtime se usa aparte, solo para acelerar el refresco — no para
  // decidir si el polling corre.
  assert.match(src, /const \{ onPedidoCambiado \} = useRealtime\(\);/);
});

test('restaurante (app/restaurante/pedidos.tsx): el polling corre incondicionalmente en un efecto propio, ajeno a `conectado`', () => {
  const src = read('app/restaurante/pedidos.tsx');
  const bloque = src.match(/useEffect\(\(\) => \{\s*pollingRef\.current = setInterval\(cargar, PEDIDOS_POLL_MS\);[\s\S]*?\}, \[cargar\]\);/);
  assert.ok(bloque, 'debe existir el efecto de polling con setInterval(cargar, PEDIDOS_POLL_MS)');
  assert.doesNotMatch(bloque[0], /conectado/, 'el polling no debe leer `conectado`');
  assert.match(src, /const \{ onPedidoCambiado \} = useRealtime\(\);/);
});

test('NotificacionesRestauranteContext: el polling de 30s corre incondicionalmente, independiente de `conectado`', () => {
  const src = read('src/context/NotificacionesRestauranteContext.tsx');
  const bloque = src.match(/useEffect\(\(\) => \{\s*refrescar\(\);\s*pollingRef\.current = setInterval\(refrescar, 30000\);[\s\S]*?\}, \[refrescar\]\);/);
  assert.ok(bloque, 'debe existir el efecto de polling de 30s');
  assert.doesNotMatch(bloque[0], /conectado/, 'el polling no debe leer `conectado`');
  // Y por separado, realtime solo ACELERA (no reemplaza) ese refresco.
  assert.match(src, /onPedidoCambiado\(\(\) => \{ refrescar\(\); \}\)/);
});

// ── C) Documentación viva: el propio código declara el estado real de RLS ───
// Si alguien borra este aviso creyendo que Realtime "ya funciona" en
// producción, esta prueba debe fallar y obligar a revisar la migración RLS.

test('realtime.ts documenta que RLS deny_all_client_access bloquea la réplica hoy (Realtime no es la vía funcional todavía)', () => {
  const src = read('src/services/realtime.ts');
  assert.match(src, /deny_all_client_access/);
  assert.match(src, /el polling[\s\S]{0,40}sigue siendo la vía funcional/);
});
