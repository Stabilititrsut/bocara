// Ejecutar: node scripts/test-push.cjs. Sin red, Expo ni dispositivo real.
// Cubre el criterio del domingo frontend: registro de push, foreground, tap,
// cold start, dedup, cleanup de listeners, logout limpia pendiente, y que web
// nunca ejecuta nada nativo de expo-notifications. La mayor parte de esta
// lógica vive en app/_layout.tsx — se audita por lectura de fuente (mismo
// patrón que scripts/test-pago-estado.cjs FASE 7) más los casos nuevos que esa
// suite no cubre todavía (payload inválido, ruta arbitraria, canal Android,
// registro condicionado a dispositivo real).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}) {
  const exportsObj = {};
  const source = read(file);
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const layoutSrc = read('app/_layout.tsx');

// ── 1) foreground ────────────────────────────────────────────────────────

test('1) foreground: el listener de "recibida" existe y no navega solo (no saca al usuario de lo que hace)', () => {
  assert.match(layoutSrc, /addNotificationReceivedListener\(\(\) => \{\}\)/, 'foreground no debe navegar automáticamente');
});

// ── 2) tap ───────────────────────────────────────────────────────────────

test('2) tap: el listener de respuesta resuelve la ruta con el resolver único y navega', () => {
  assert.match(layoutSrc, /addNotificationResponseReceivedListener\(\(response: any\) => \{/);
  assert.match(layoutSrc, /procesarTap\(response\?\.notification\?\.request\?\.identifier, response\?\.notification\?\.request\?\.content\?\.data\)/);
  assert.match(layoutSrc, /if \(ruta\) router\.push\(ruta as any\);/);
});

// ── 3) cold start ────────────────────────────────────────────────────────

test('3) cold start: getLastNotificationResponseAsync se consulta y también pasa por procesarTap/dedup', () => {
  assert.match(layoutSrc, /Notifications\.getLastNotificationResponseAsync\?\.\(\)/);
  assert.match(layoutSrc, /procesarTap\(response\.notification\.request\.identifier, response\.notification\.request\.content\.data\)/);
});

// ── 4) dedup ─────────────────────────────────────────────────────────────

test('4) dedup: la misma notificación (foreground/tap/cold start reportando el mismo id) no navega dos veces', () => {
  assert.match(layoutSrc, /const procesadas = new Set<string>\(\);/);
  assert.match(layoutSrc, /if \(id\) \{ if \(procesadas\.has\(id\)\) return; procesadas\.add\(id\); \}/);
});

// ── 5-6) rol cliente / rol restaurante (resolver compartido) ───────────────

const resolver = () => load('src/utils/resolverRutaNotificacion.ts');

test('5) rol cliente: pedido confirmado/listo/cancelado siempre resuelve a la lista de pedidos del cliente', () => {
  const { resolverRutaNotificacion } = resolver();
  for (const tipo of ['pedido.pago_confirmado', 'pedido.listo', 'pedido.cancelado', undefined]) {
    assert.equal(resolverRutaNotificacion({ pedidoId: 'p1', tipo }, 'cliente'), '/(tabs)/pedidos');
  }
});

test('6) rol restaurante: con pedidoId va al panel de pedidos; sin pedidoId (aviso genérico) va al home del restaurante', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, 'restaurante'), '/restaurante/pedidos');
  assert.equal(resolverRutaNotificacion({}, 'restaurante'), '/restaurante');
});

// ── 7) payload inválido ──────────────────────────────────────────────────

test('7) payload inválido (null, string, número, pedidoId no-string) no lanza y no produce una ruta rota', () => {
  const { resolverRutaNotificacion, validarPayloadNotificacion } = resolver();
  for (const payload of [null, undefined, 'texto', 42, [], { pedidoId: 123 }, { pedidoId: '' }]) {
    assert.doesNotThrow(() => resolverRutaNotificacion(payload, 'cliente'));
  }
  // deepEqual con un objeto creado dentro del VM sandbox falla por identidad
  // de prototipo entre realms, no por contenido — se compara por claves.
  assert.equal(Object.keys(validarPayloadNotificacion(null)).length, 0);
  assert.equal(Object.keys(validarPayloadNotificacion('texto')).length, 0);
  assert.equal(validarPayloadNotificacion({ pedidoId: 123 }).pedidoId, undefined, 'pedidoId debe ser string — un número no es válido');
});

// ── 8) ruta arbitraria rechazada ─────────────────────────────────────────

test('8) data.route/data.screen arbitrarios nunca se usan como ruta — solo deciden entre rutas ya fijas por rol', () => {
  const { resolverRutaNotificacion } = resolver();
  const maliciosos = [
    { screen: '/admin/usuarios/eliminar-todo' },
    { route: '../../etc/passwd' },
    { screen: 'http://evil.example.com' },
  ];
  for (const data of maliciosos) {
    const ruta = resolverRutaNotificacion(data, 'cliente');
    assert.equal(ruta, '/(tabs)/pedidos', 'un cliente siempre cae en su propia sección, sin importar qué diga el payload');
  }
  const src = read('src/utils/resolverRutaNotificacion.ts');
  assert.doesNotMatch(src, /return data\.route/);
  assert.doesNotMatch(src, /return data\.screen/);
  assert.doesNotMatch(src, /router\.push\(data\.route/);
});

test('rol inválido/ajeno (ni cliente, ni restaurante, ni admin) nunca resuelve — mejor no navegar que navegar mal', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, 'hacker'), null);
  assert.equal(resolverRutaNotificacion({ pedidoId: 'p1' }, ''), null);
});

// ── 9) logout limpia pendiente ──────────────────────────────────────────

test('9) logout/cambio de cuenta descarta cualquier notificación pendiente del usuario anterior', () => {
  assert.match(layoutSrc, /if \(!usuario\) \{ pushRegistered\.current = false; pendingNotifRef\.current = null; \}/);
});

// ── 10) web no ejecuta nativo ────────────────────────────────────────────

test('10) web: expo-notifications/expo-device solo se cargan fuera de web, y el registro de token exige un dispositivo real', () => {
  assert.match(layoutSrc, /if \(Platform\.OS !== 'web'\) \{/);
  assert.match(layoutSrc, /if \(!Notifications \|\| !Device\) return;/);
  assert.match(layoutSrc, /if \(!Device\.isDevice\) return;/, 'no debe intentar obtener push token en un simulador/emulador sin push real');
});

test('canal de Android configurado con sonido por defecto — nunca un asset inventado', () => {
  assert.match(layoutSrc, /Notifications\.setNotificationChannelAsync\('default', \{/);
  assert.match(layoutSrc, /sound: 'default'/, 'debe usar el sonido default del sistema, no un archivo que podría no existir');
  assert.doesNotMatch(layoutSrc, /sound:\s*['"](?!default)[^'"]+\.(mp3|wav|caf)['"]/i, 'no debe referenciar un archivo de sonido que no viene con el proyecto');
});

// ── 11) cleanup de listeners ─────────────────────────────────────────────

test('11) cleanup: ambos listeners se remueven al desmontar, y se registran una sola vez por vida de la app', () => {
  assert.match(layoutSrc, /subRecibida\.remove\(\);\s*subRespuesta\.remove\(\);/);
  assert.match(layoutSrc, /\}, \[\]\);/, 'deps vacías: no se vuelven a registrar en cada render/relogin');
});

// ── 12) Fase C: canales, SDK 54, projectId, rotación de token, logout ──────

// Cuerpo de una función de nivel superior de _layout.tsx: hasta la siguiente
// declaración `async function`/`function` o separador `// ──` de columna 0.
function cuerpoFuncion(src, nombre) {
  const inicio = src.indexOf(`async function ${nombre}(`);
  assert.notEqual(inicio, -1, `no existe la función ${nombre}`);
  const resto = src.slice(inicio + 1);
  const fin = resto.search(/\r?\n(async function |function |\/\/ ── )/);
  return src.slice(inicio, fin === -1 ? undefined : inicio + 1 + fin);
}

test('12a) canales Android: default intacto + pedidos (HIGH, sonido, vibración) + promociones (DEFAULT)', () => {
  const canales = cuerpoFuncion(layoutSrc, 'crearCanalesAndroid');
  assert.match(canales, /if \(Platform\.OS !== 'android'\) return;/);
  const bloque = (id) => {
    const m = canales.match(new RegExp(`setNotificationChannelAsync\\('${id}', \\{([\\s\\S]*?)\\}\\);`));
    assert.ok(m, `falta el canal ${id}`);
    return m[1];
  };
  const def = bloque('default');
  assert.match(def, /name: 'Bocara'/);
  assert.match(def, /AndroidImportance\.HIGH/);
  const pedidos = bloque('pedidos');
  assert.match(pedidos, /AndroidImportance\.HIGH/);
  assert.match(pedidos, /sound: 'default'/);
  assert.match(pedidos, /vibrationPattern: \[/);
  assert.match(bloque('promociones'), /AndroidImportance\.DEFAULT/);
});

test('12b) los canales se crean ANTES de pedir permiso (Android 13+ no muestra el diálogo sin canal)', () => {
  const registro = cuerpoFuncion(layoutSrc, 'registrarPushToken');
  const canales = registro.indexOf('await crearCanalesAndroid();');
  assert.notEqual(canales, -1, 'registrarPushToken debe crear los canales');
  assert.ok(canales < registro.indexOf('getPermissionsAsync'), 'canales antes de consultar permisos');
  assert.ok(canales < registro.indexOf('requestPermissionsAsync'), 'canales antes de pedir permisos');
});

test('12c) SDK 54: handler con shouldShowBanner/shouldShowList y sin shouldShowAlert obsoleto', () => {
  assert.match(layoutSrc, /shouldShowBanner: true/);
  assert.match(layoutSrc, /shouldShowList: true/);
  assert.doesNotMatch(layoutSrc, /shouldShowAlert:/, 'la propiedad obsoleta no debe seguir en el handler');
});

test('12d) projectId sale de la config de EAS con respaldo EXPO_PUBLIC_PROJECT_ID (nunca de una env no pública)', () => {
  const fn = layoutSrc.slice(layoutSrc.indexOf('function resolverProjectId'));
  assert.match(fn, /Constants\.expoConfig\?\.extra\?\.eas\?\.projectId/);
  assert.match(fn, /process\.env\.EXPO_PUBLIC_PROJECT_ID/);
  assert.doesNotMatch(layoutSrc, /process\.env\.EXPO_PROJECT_ID/, 'EXPO_PROJECT_ID no llega al bundle: siempre era undefined');
  assert.match(layoutSrc, /getExpoPushTokenAsync\(\{ projectId: resolverProjectId\(\) \}\)/);
});

test('12e) rotación: addPushTokenListener re-deriva el token de EXPO (el evento trae el nativo) y se limpia', () => {
  const ini = layoutSrc.indexOf('Notifications.addPushTokenListener(');
  assert.notEqual(ini, -1, 'falta el listener de rotación');
  const bloque = layoutSrc.slice(ini, layoutSrc.indexOf('}, [usuarioId]);', ini));
  assert.match(bloque, /obtenerYGuardarExpoToken\(\)/, 'debe volver a pedir el Expo token, no guardar el token nativo del evento');
  assert.doesNotMatch(bloque, /guardarToken\(/, 'el token del evento es FCM/APNs: nunca se manda tal cual');
  assert.match(bloque, /subToken\.remove\(\)/);
  assert.match(layoutSrc, /if \(!usuarioId \|\| !Notifications\?\.addPushTokenListener\) return undefined;/, 'sin sesión no se escucha (y web no tiene Notifications)');
});

test('12f) el token registrado se recuerda para que logout desvincule SOLO este dispositivo', () => {
  const fn = cuerpoFuncion(layoutSrc, 'obtenerYGuardarExpoToken');
  assert.match(fn, /recordarPushToken\(token\);/);
  assert.match(fn, /notificacionesAPI\.guardarToken\(token\)/);
});

test('12g) logout: DELETE /notificaciones/token con el token actual ANTES de borrar el JWT, sin bloquear', () => {
  const auth = read('src/context/AuthContext.tsx');
  const logout = auth.slice(auth.indexOf('async function logout()'));
  const desvincular = logout.indexOf('await desvincularPushDispositivo();');
  assert.notEqual(desvincular, -1);
  assert.ok(desvincular < logout.indexOf('deleteAuthToken()'), 'el DELETE va autenticado: antes de soltar el JWT');
  const fn = auth.slice(auth.indexOf('async function desvincularPushDispositivo()'), auth.indexOf('async function logout()'));
  assert.match(fn, /if \(!pushToken\) return;/, 'sin token conocido (web) no se llama: borraría el del teléfono real');
  assert.match(fn, /notificacionesAPI\.eliminarToken\(pushToken\)/);
  assert.match(fn, /catch \(error\)/, 'un fallo de red no puede impedir cerrar sesión');
  const api = read('src/services/api.ts');
  assert.match(api, /api\.delete\('\/notificaciones\/token', \{ data: \{ expo_push_token: token \}, timeout: \d+ \}\)/);
});

// ── 13) Fase C: deep link a publicación y a pedido ──────────────────────────

const UUID_BOLSA = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const UUID_PEDIDO = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

test('13a) cliente con bolsaId UUID → /producto/<bolsaId> (aviso de publicación cercana)', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ tipo: 'promocion', bolsaId: UUID_BOLSA, negocioId: 'n1' }, 'cliente'), `/producto/${UUID_BOLSA}`);
  // bolsaId gana sobre pedidoId: el payload de cercanía es de una publicación.
  assert.equal(resolverRutaNotificacion({ bolsaId: UUID_BOLSA, pedidoId: UUID_PEDIDO }, 'cliente'), `/producto/${UUID_BOLSA}`);
});

test('13b) cliente con pedidoId UUID → /(tabs)/pedidos?pedidoId=<id> para enfocar la orden', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ pedidoId: UUID_PEDIDO }, 'cliente'), `/(tabs)/pedidos?pedidoId=${UUID_PEDIDO}`);
});

test('13c) ids que no son UUID nunca entran a la URL (sin inyección de segmentos, query ni esquema)', () => {
  const { resolverRutaNotificacion, validarPayloadNotificacion } = resolver();
  const maliciosos = [
    '../admin', `${UUID_BOLSA}/../../admin`, `${UUID_BOLSA}?x=1`, 'http://evil.example.com',
    `${UUID_BOLSA} `, '', 123, null, { id: UUID_BOLSA },
  ];
  for (const valor of maliciosos) {
    assert.equal(validarPayloadNotificacion({ bolsaId: valor }).bolsaId, undefined, `bolsaId ${JSON.stringify(valor)} no es UUID`);
    assert.equal(resolverRutaNotificacion({ bolsaId: valor }, 'cliente'), '/(tabs)/pedidos');
    assert.equal(resolverRutaNotificacion({ pedidoId: valor }, 'cliente'), '/(tabs)/pedidos');
  }
});

test('13d) restaurante y admin ignoran bolsaId: siguen en su propia sección', () => {
  const { resolverRutaNotificacion } = resolver();
  assert.equal(resolverRutaNotificacion({ bolsaId: UUID_BOLSA }, 'restaurante'), '/restaurante');
  assert.equal(resolverRutaNotificacion({ bolsaId: UUID_BOLSA, pedidoId: UUID_PEDIDO }, 'restaurante'), '/restaurante/pedidos');
  assert.equal(resolverRutaNotificacion({ bolsaId: UUID_BOLSA }, 'admin'), '/admin');
  assert.equal(resolverRutaNotificacion({ bolsaId: UUID_BOLSA }, null), null, 'sin sesión: pendiente hasta el login');
});

test('13e) /(tabs)/pedidos lee ?pedidoId, resalta esa tarjeta y hace scroll una sola vez por id', () => {
  const src = read('app/(tabs)/pedidos.tsx');
  assert.match(src, /useLocalSearchParams<\{ pedidoId\?: string \}>\(\)/);
  assert.match(src, /if \(id !== pedidoEnfocado \|\| enfocadoRef\.current === id\) return;/, 'no debe volver a saltar en cada refresco del polling');
  assert.match(src, /scrollRef\.current\?\.scrollTo\(/);
  assert.match(src, /enfocado && s\.cardEnfocada/);
});
