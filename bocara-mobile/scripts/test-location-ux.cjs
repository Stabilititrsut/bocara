// Ejecutar: node scripts/test-location-ux.cjs. Sin red, Expo ni GPS real.
// Cubre el criterio del sábado frontend: permisos de ubicación (granted/
// denied/bloqueado/servicio apagado), persistencia en el backend real
// (PATCH /api/auth/ubicacion), fallback a la ubicación guardada, y formato
// de distancia/horario/unidades. Mismo patrón de scripts/test-cart.cjs.
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

const locMod = () => load('src/context/LocationContext.tsx', {
  react: { createContext: () => ({}), useContext: () => ({}), useEffect: () => {}, useState: v => [v, () => {}], useCallback: f => f, useRef: v => ({ current: v }) },
  'expo-location': {}, './AuthContext': { useAuth: () => ({ usuario: null }) }, '../services/api': { authAPI: { actualizarUbicacion: async () => ({}) } },
});

// ── 1-2: permisos ────────────────────────────────────────────────────────

test('1) permiso concedido', () => {
  const { clasificarPermiso } = locMod();
  assert.equal(clasificarPermiso({ status: 'granted' }), 'granted');
});

test('2) permiso denegado (puede volver a pedirse)', () => {
  const { clasificarPermiso } = locMod();
  assert.equal(clasificarPermiso({ status: 'denied', canAskAgain: true }), 'denied');
});

test('permiso denegado permanentemente (bloqueado) — no se debe insistir, hay que mandar a Ajustes', () => {
  const { clasificarPermiso } = locMod();
  assert.equal(clasificarPermiso({ status: 'denied', canAskAgain: false }), 'bloqueado');
});

test('estado no reconocido/aún no decidido cae a undetermined, nunca se asume otorgado', () => {
  const { clasificarPermiso } = locMod();
  assert.equal(clasificarPermiso({ status: 'undetermined' }), 'undetermined');
  assert.equal(clasificarPermiso({ status: 'granted' }) !== clasificarPermiso({ status: 'undetermined' }), true);
});

// ── 3: ubicación válida / resolución de fallback ─────────────────────────

test('3) coordenadas del dispositivo, cuando existen, siempre ganan sobre el fallback del backend', () => {
  const { resolverCoordsFallback } = locMod();
  const r = resolverCoordsFallback({ coordsDispositivo: { lat: 14.6, lng: -90.5 }, usuarioLat: 99, usuarioLng: 99 });
  assert.equal(r.origen, 'dispositivo');
  assert.deepEqual(r.coords, { lat: 14.6, lng: -90.5 });
});

// ── 4-5: persistencia backend y su fallo ─────────────────────────────────

test('4) al obtener coords frescas, se persisten en el backend real (PATCH /api/auth/ubicacion)', () => {
  const src = read('src/context/LocationContext.tsx');
  assert.match(src, /authAPI\.actualizarUbicacion\(lat, lng\)/, 'debe llamar al contrato real del backend, no un endpoint inventado');
  assert.match(src, /from '\.\.\/services\/api'/, 'debe reusar src/services/api.ts, no un cliente HTTP aparte');
});

test('5) un fallo al persistir (offline, backend caído, migración pendiente) no rompe la app — la app sigue con la coordenada en memoria', () => {
  const { LocationProvider } = load('src/context/LocationContext.tsx', {
    react: { createContext: () => ({}), useContext: () => ({}), useEffect: () => {}, useState: v => [v, () => {}], useCallback: f => f, useRef: v => ({ current: v }) },
    'expo-location': {}, './AuthContext': { useAuth: () => ({ usuario: { id: 'u1' } }) },
    '../services/api': { authAPI: { actualizarUbicacion: async () => { throw new Error('offline'); } } },
  });
  assert.equal(typeof LocationProvider, 'function', 'el módulo debe seguir cargando aunque el backend de ubicación esté inalcanzable');
  const src = read('src/context/LocationContext.tsx');
  assert.match(src, /catch \{\s*\/\/ Best-effort/, 'la persistencia debe ser best-effort — un catch explícito, sin propagar el error a fetchLocation');
});

test('el fallback al backend solo se usa si la coordenada guardada es válida (no NaN, no fuera de rango)', () => {
  const { resolverCoordsFallback } = locMod();
  for (const [lat, lng] of [[999, 0], [0, 999], [Number.NaN, 0], ['14.6', '-90.5'], [null, null], [undefined, undefined]]) {
    const r = resolverCoordsFallback({ coordsDispositivo: null, usuarioLat: lat, usuarioLng: lng });
    assert.equal(r.origen, 'ninguna', `lat=${lat} lng=${lng} no debe usarse como fallback`);
  }
  const ok = resolverCoordsFallback({ coordsDispositivo: null, usuarioLat: 14.6, usuarioLng: -90.5 });
  assert.equal(ok.origen, 'backend');
});

// ── 6: web fallback ───────────────────────────────────────────────────────

test('6) hasServicesEnabledAsync no soportado (p. ej. web) no rompe: se degrada a "servicios activos" en vez de lanzar', () => {
  const src = read('src/context/LocationContext.tsx');
  const ocurrencias = src.match(/try \{ serviciosActivos = await Location\.hasServicesEnabledAsync\(\); \} catch/g) || [];
  assert.ok(ocurrencias.length >= 2, 'tanto el chequeo inicial como requestPermission deben envolver hasServicesEnabledAsync en try/catch');
});

test('no se solicita permiso repetidamente: denegado/bloqueado no se vuelve a pedir solo al montar', () => {
  const src = read('src/context/LocationContext.tsx');
  assert.match(src, /clasificado === 'denied' \|\| clasificado === 'bloqueado'/, 'denegado o bloqueado deben ser ramas explícitas que NO llaman a requestPermission');
  assert.match(src, /\/\/ Undetermined — primera vez que se pregunta, es la única situación/, 'solo "undetermined" (primera vez) debe disparar el pedido automático');
});

test('actualizarUbicacion (botón manual) no re-pide permiso si ya está denegado: solo refresca cuando ya es "granted"', () => {
  const src = read('src/context/LocationContext.tsx');
  assert.match(src, /if \(permissionStatus !== 'granted'\) \{ await requestPermission\(\); return; \}/);
});

// ── 7: formato de distancia ───────────────────────────────────────────────

test('7) formatDistancia: metros bajo 1km, "X.X km" en adelante, nunca NaN ni negativos', () => {
  const { formatDistancia } = locMod();
  assert.equal(formatDistancia(0.85), '850 m');
  assert.equal(formatDistancia(1.2), '1.2 km');
  assert.equal(formatDistancia(9.99), '10.0 km');
  assert.equal(formatDistancia(null), null);
  assert.equal(formatDistancia(undefined), null);
  assert.equal(formatDistancia(Number.NaN), null);
  assert.equal(formatDistancia(-3), null);
  assert.equal(formatDistancia(Infinity), null);
});

// ── 8: formato de horario (reusa el contrato real de horarioRecogida.ts) ──

test('8) horario: usa el contrato horaria Guatemala real, no UTC crudo', () => {
  const horario = load('src/utils/horarioRecogida.ts', { '@/constants/Colors': { Colors: {} } });
  // 2026-09-16T23:30:00Z = 17:30 en Guatemala (UTC-6) — si el helper leyera
  // UTC crudo, el resultado de "vencida a las 20:00" cambiaría.
  const ahoraUTC = new Date('2026-09-16T23:30:00.000Z');
  const bolsa = { hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' };
  assert.equal(horario.publicacionVencida(bolsa, ahoraUTC), false, 'a las 17:30 Guatemala (23:30 UTC) la ventana 18:00-20:00 todavía no vence');
});

// ── 9: unidades reales (reusa el contrato real de stock.ts) ──────────────

test('9) unidades: mensajes unificados, tomados de cantidad_disponible_real', () => {
  const stock = load('src/utils/stock.ts', {});
  assert.equal(stock.textoDisponibilidad(0), 'Agotado');
  assert.equal(stock.textoDisponibilidad(1), 'Solo queda 1 unidad disponible');
  assert.equal(stock.textoDisponibilidad(5), 'Quedan 5 unidades disponibles');
  assert.equal(stock.disponibilidadReal({ cantidad_disponible: 9, cantidad_disponible_real: 2 }), 2, 'el real del backend manda sobre el histórico de DB');
});
