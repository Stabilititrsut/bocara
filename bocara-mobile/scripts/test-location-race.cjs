// Ejecutar: node scripts/test-location-race.cjs. Sin red, Expo ni GPS real.
//
// Reproduce específicamente la race condition del diagnóstico QA #4 y prueba
// el fix: cuando `usuario` (AuthContext) carga DESPUÉS de que ya hay coords
// de dispositivo en memoria, el PATCH /api/auth/ubicacion debe salir
// exactamente una vez -- ni cero (el bug original: persistirEnBackend hacía
// `return` temprano y no había reintento) ni más de una (doble PATCH).
//
// Motor de hooks mínimo (useState/useEffect/useCallback/useRef reales, con
// re-render y comparación de deps por índice) porque LocationContext.tsx es
// un componente con hooks de verdad: el mock de solo-funciones-puras que usa
// test-location-ux.cjs no re-ejecuta efectos y no sirve para probar timing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function crearMotorHooks() {
  let hooks = [];
  let cursor = 0;
  let efectosPendientes = [];

  function depsIguales(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((d, idx) => Object.is(d, b[idx]));
  }

  function useState(inicial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = { valor: typeof inicial === 'function' ? inicial() : inicial };
    const celda = hooks[i];
    const setState = v => {
      const nuevo = typeof v === 'function' ? v(celda.valor) : v;
      if (!Object.is(nuevo, celda.valor)) { celda.valor = nuevo; motor.render(); }
    };
    return [celda.valor, setState];
  }

  function useRef(inicial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = { current: inicial };
    return hooks[i];
  }

  function useCallback(fn, deps) {
    const i = cursor++;
    const celda = hooks[i];
    if (!celda || !depsIguales(celda.deps, deps)) hooks[i] = { valor: fn, deps };
    return hooks[i].valor;
  }

  function useEffect(crear, deps) {
    const i = cursor++;
    const celda = hooks[i];
    const cambio = !celda || !depsIguales(celda.deps, deps);
    hooks[i] = { deps, cleanup: celda ? celda.cleanup : undefined };
    if (cambio) efectosPendientes.push({ i, crear });
  }

  const motor = {
    Componente: null,
    ultimoRender: null,
    render() {
      cursor = 0;
      efectosPendientes = [];
      motor.ultimoRender = motor.Componente();
      const pendientes = efectosPendientes;
      efectosPendientes = [];
      for (const { i, crear } of pendientes) {
        if (hooks[i].cleanup) hooks[i].cleanup();
        const cleanup = crear();
        hooks[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
      return motor.ultimoRender;
    },
    react: { createContext: () => ({ Provider: 'Provider' }), useContext: () => ({}), useState, useEffect, useCallback, useRef },
  };
  return motor;
}

function load(file, mocks = {}) {
  const exportsObj = {};
  const source = read(file);
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, Promise, setTimeout, clearTimeout,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const expoLocationMock = (coords) => ({
  Accuracy: { Balanced: 'balanced' },
  hasServicesEnabledAsync: async () => true,
  getForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  getCurrentPositionAsync: async () => ({ coords: { latitude: coords.lat, longitude: coords.lng } }),
  reverseGeocodeAsync: async () => ([]),
});

// Deja correr todos los microtasks encolados (mocks async resuelven
// inmediatamente, pero encadenan varios `await`); un macrotask corto basta.
const flush = () => new Promise(r => setTimeout(r, 15));

test('QA #4 — coords primero, usuario carga después: el PATCH sale exactamente una vez (no cero, no duplicado)', async () => {
  const calls = [];
  const authMock = { usuario: null }; // simula AuthContext todavía cargando sesión
  const motor = crearMotorHooks();
  const mod = load('src/context/LocationContext.tsx', {
    react: motor.react,
    'expo-location': expoLocationMock({ lat: 14.6349, lng: -90.5069 }),
    './AuthContext': { useAuth: () => authMock },
    '../services/api': { authAPI: { actualizarUbicacion: async (lat, lng) => { calls.push([lat, lng]); } } },
  });

  motor.Componente = () => mod.LocationProvider({ children: null });
  motor.render(); // mount: permiso ya concedido, pero usuario aún null
  await flush();

  assert.equal(calls.length, 0, 'con usuario aún null no debe salir ningún PATCH (comportamiento del bug original, no del fix)');
  // Comparación campo a campo, no deepEqual: el objeto {lat,lng} lo crea el
  // código transpilado corriendo dentro del vm context (otro "realm"), así
  // que su prototipo nunca es === al de un literal creado en este script aunque
  // los valores coincidan -- deepEqual fallaría por eso, no por un bug real.
  assert.equal(motor.ultimoRender.props.value.coords.lat, 14.6349,
    'las coords del dispositivo deben quedar en memoria aunque el PATCH todavía no pueda salir');
  assert.equal(motor.ultimoRender.props.value.coords.lng, -90.5069);

  authMock.usuario = { id: 'u1', latitud: null, longitud: null }; // AuthContext termina de cargar
  motor.render(); // React re-renderiza LocationProvider porque el contexto de auth cambió
  await flush();

  assert.equal(calls.length, 1, 'al terminar de cargar `usuario`, debe reintentar y el PATCH debe salir -- este es el fix de la race condition');
  assert.deepEqual(calls[0], [14.6349, -90.5069]);

  motor.render(); // re-render adicional sin cambios de usuario/coords (p.ej. otro estado no relacionado)
  await flush();
  assert.equal(calls.length, 1, 'un re-render posterior sin cambios de usuario/coords NO debe generar un segundo PATCH');
});

test('QA #4 — usuario ya cargado cuando llegan las coords: un solo PATCH (sin duplicado entre la llamada inline y el efecto de reintento)', async () => {
  const calls = [];
  const authMock = { usuario: { id: 'u1', latitud: null, longitud: null } }; // sesión ya lista desde el mount
  const motor = crearMotorHooks();
  const mod = load('src/context/LocationContext.tsx', {
    react: motor.react,
    'expo-location': expoLocationMock({ lat: 14.6, lng: -90.5 }),
    './AuthContext': { useAuth: () => authMock },
    '../services/api': { authAPI: { actualizarUbicacion: async (lat, lng) => { calls.push([lat, lng]); } } },
  });

  motor.Componente = () => mod.LocationProvider({ children: null });
  motor.render();
  await flush();

  assert.equal(calls.length, 1,
    'fetchLocation dispara el PATCH inline y, en el mismo tick, el efecto de reintento también observa coords nuevas -- ' +
    'el guard síncrono (marcar la clave antes del await) debe evitar que ambos caminos manden la petición');
  assert.deepEqual(calls[0], [14.6, -90.5]);
});

test('QA #4 — cambio de usuario en el mismo dispositivo (logout/login) con las mismas coords: persiste de nuevo para el nuevo usuario', async () => {
  const calls = [];
  const authMock = { usuario: { id: 'u1', latitud: null, longitud: null } };
  const motor = crearMotorHooks();
  const mod = load('src/context/LocationContext.tsx', {
    react: motor.react,
    'expo-location': expoLocationMock({ lat: 14.6, lng: -90.5 }),
    './AuthContext': { useAuth: () => authMock },
    '../services/api': { authAPI: { actualizarUbicacion: async (lat, lng) => { calls.push([authMock.usuario?.id, lat, lng]); } } },
  });

  motor.Componente = () => mod.LocationProvider({ children: null });
  motor.render();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'u1');

  authMock.usuario = null; // logout
  motor.render();
  await flush();
  assert.equal(calls.length, 1, 'sin usuario no debe intentar persistir');

  authMock.usuario = { id: 'u2', latitud: null, longitud: null }; // login como otro usuario, mismas coords ya en memoria
  motor.render();
  await flush();
  assert.equal(calls.length, 2, 'el usuario nuevo debe generar su propio PATCH aunque las coords sean las mismas del usuario anterior');
  assert.equal(calls[1][0], 'u2');
});

test('QA #4 — falla el PATCH (offline/backend caído): no queda marcado como persistido, se puede reintentar después', async () => {
  const calls = [];
  const authMock = { usuario: { id: 'u1', latitud: null, longitud: null } };
  let falla = true;
  const motor = crearMotorHooks();
  const mod = load('src/context/LocationContext.tsx', {
    react: motor.react,
    'expo-location': expoLocationMock({ lat: 14.6, lng: -90.5 }),
    './AuthContext': { useAuth: () => authMock },
    '../services/api': { authAPI: { actualizarUbicacion: async (lat, lng) => {
      calls.push([lat, lng]);
      if (falla) throw new Error('offline');
    } } },
  });

  motor.Componente = () => mod.LocationProvider({ children: null });
  motor.render();
  await flush();
  assert.equal(calls.length, 1, 'primer intento falla pero sí se intenta');

  falla = false;
  authMock.usuario = { id: 'u1', latitud: null, longitud: null }; // misma sesión, dispara el efecto de reintento de nuevo
  motor.render();
  await flush();
  assert.equal(calls.length, 2, 'tras el fallo, un disparo posterior debe reintentar (no quedó marcado como ya guardado)');
});
