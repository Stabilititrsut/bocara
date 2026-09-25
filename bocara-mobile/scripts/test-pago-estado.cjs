// Ejecutar: node scripts/test-pago-estado.cjs. Sin red, Expo ni dependencias nuevas.
//
// Cubre la meta del martes frontend: guards, retorno de pago sin la URL como
// fuente de verdad, lectura de estado de pedido y errores visibles. Reusa la
// técnica de scripts/test-cart.cjs (transpila el .tsx real y lo ejecuta en un
// VM con los `require` que use con double) para probar la lógica pura tal cual
// vive en el archivo de producción — no una copia reescrita en el test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const source = read(file);
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exports;
}

// ═══════════════════════════════════════════════════════════════════════════
// FASE 2 — pago-retorno / pago-exitoso: la URL nunca es fuente de verdad
// ═══════════════════════════════════════════════════════════════════════════

test('pago-exitoso: vistaEfectivaDesde nunca muestra éxito solo porque la URL lo afirma', () => {
  const mod = load('app/pago-exitoso.tsx', {
    react: { useEffect: () => {}, useRef: () => ({ current: null }), useState: () => [null, () => {}] },
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'Button', StyleSheet: { create: x => x }, SafeAreaView: 'Safe', ActivityIndicator: 'Spinner' },
    'expo-router': { useRouter: () => ({}), useLocalSearchParams: () => ({}) },
    '@expo/vector-icons': { Ionicons: 'Icon' },
    '@/constants/Colors': { Colors: {} },
    '@/src/services/api': { pagosAPI: {} },
    '@/src/context/CartContext': { useCart: () => ({ limpiar: () => {} }) },
    '@/src/utils/backNavigation': { volver: () => {} },
  });

  // La URL dice SUCCEEDED, pero mientras el backend no lo confirme, nunca 'success'.
  assert.equal(mod.detectarResultado('SUCCEEDED', undefined), 'success');
  assert.equal(mod.vistaEfectivaDesde('success', 'verificando'), 'verifying', 'sin respuesta del backend, debe seguir en verificación, nunca en éxito');
  assert.equal(mod.vistaEfectivaDesde('success', 'pendiente'), 'pendiente', 'tras agotar reintentos sin confirmación, estado "pendiente" explícito — no éxito');
  assert.equal(mod.vistaEfectivaDesde('success', 'fallido'), 'rejected', 'si el backend dice fallido, se degrada a rechazado aunque la URL dijera éxito');
  assert.equal(mod.vistaEfectivaDesde('success', 'cancelado'), 'cancelled', 'un pedido cancelado (ej. reembolsado) nunca se muestra como pago exitoso');
  assert.equal(mod.vistaEfectivaDesde('success', 'error'), 'rejected', 'error al verificar (ej. pedidoId inválido) tampoco es éxito');
  // Solo la confirmación real del backend habilita la vista de éxito.
  assert.equal(mod.vistaEfectivaDesde('success', 'confirmado'), 'success');
  // Rechazado/cancelado declarados por Cubo no dependen de una verificación adicional.
  assert.equal(mod.vistaEfectivaDesde('rejected', 'verificando'), 'rejected');
  assert.equal(mod.vistaEfectivaDesde('cancelled', 'verificando'), 'cancelled');
});

test('pago-exitoso: el render de "¡Pago exitoso!" está condicionado a vistaEfectiva, no al parámetro crudo de la URL', () => {
  // Guarda estática contra reintroducir el bug: `if (resultado === 'success')`
  // en vez de `if (vistaEfectiva === 'success')` volvería a confiar en la URL.
  const src = read('app/pago-exitoso.tsx');
  assert.match(src, /if\s*\(vistaEfectiva === 'success'\)/, 'el bloque de éxito debe leer vistaEfectiva (post-verificación backend), no "resultado" crudo');
  assert.doesNotMatch(src, /if\s*\(resultado === 'success'\)/, 'no debe volver a decidir el render de éxito directo desde el parámetro de la URL');
  assert.match(src, /estado_pago === 'pagado' && estado === 'confirmado'/, 'la única condición de éxito real sigue siendo la confirmación del backend');
});

test('pago-retorno: los mensajes por código HTTP usan error.status (el campo real que arma services/api.ts)', () => {
  const mod = load('app/pago-retorno.tsx', {
    react: { useCallback: f => f, useEffect: () => {}, useRef: () => ({ current: null }), useState: () => [null, () => {}] },
    'react-native': { View: 'View', Text: 'Text', ActivityIndicator: 'Spinner', TouchableOpacity: 'Button', StyleSheet: { create: x => x } },
    'expo-router': { useLocalSearchParams: () => ({}), router: {} },
    '@/src/services/api': { pagosAPI: {} },
    '@/src/context/CartContext': { useCart: () => ({ limpiar: () => {} }) },
    '@/constants/Colors': { Colors: {} },
  });
  for (const status of [400, 401, 403, 404, 409, 500, 502, 503, 504]) {
    assert.notEqual(mod.mensajeHttp(status), 'No pudimos verificar el pago.', `status ${status} debe tener un mensaje específico, no el genérico`);
  }
  assert.equal(mod.mensajeHttp(undefined), 'No pudimos verificar el pago.', 'sin status (timeout/network) cae al genérico');
  assert.match(mod.mensajeHttp(409), /cambió/i, '409 debe indicar que el estado del pedido cambió, nunca marcar éxito');

  // Guarda estática: services/api.ts normaliza el error a `.status` (no
  // `.response.status`) — leer `.response?.status` es un bug silencioso que
  // hace que este mapeo de mensajes nunca se dispare.
  const apiSrc = read('src/services/api.ts');
  assert.match(apiSrc, /error\.status = err\.response\.status/);
  const src = read('app/pago-retorno.tsx');
  assert.doesNotMatch(src, /error\?\.response\?\.status/, 'debe leer error?.status, el campo real que arma el interceptor');
  assert.match(src, /mensajeHttp\(error\?\.status\)/);
});

test('pago-retorno: 409 nunca navega a éxito, y solo pagado+confirmado dispara la navegación de éxito', () => {
  const src = read('app/pago-retorno.tsx');
  // Única condición que navega a pago-exitoso con status SUCCEEDED:
  assert.match(src, /estado_pago === 'pagado' && data\.estado === 'confirmado'/);
  // Cualquier otro código (400/404/409/500/503/timeout) cae al catch → vista 'error', nunca a pago-exitoso.
  assert.match(src, /catch \(error: any\) \{ detener\(\); setVista\('error'\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 3 — Lectura de estado de pedido (contrato con orderStateMachine.js)
// ═══════════════════════════════════════════════════════════════════════════

test('qr-recogida: resolverVerificacion nunca confirma con un estado cancelado ni con uno desconocido', () => {
  const mod = load('app/qr-recogida.tsx', {
    react: { useCallback: f => f, useEffect: () => {}, useState: () => [null, () => {}] },
    'react-native': { View: 'View', Text: 'Text', StyleSheet: { create: x => x }, TouchableOpacity: 'Button', ScrollView: 'Scroll', SafeAreaView: 'Safe', Linking: {}, Alert: {}, ActivityIndicator: 'Spinner' },
    'expo-router': { useLocalSearchParams: () => ({}), useRouter: () => ({}) },
    'react-native-qrcode-svg': 'QRCode',
    '@/constants/Colors': { Colors: {} },
    '@/src/services/api': { pedidosAPI: {} },
  });
  for (const confirmado of ['confirmado', 'en_preparacion', 'listo', 'completado', 'recogido']) {
    assert.equal(mod.resolverVerificacion(confirmado), 'ok', confirmado);
  }
  assert.equal(mod.resolverVerificacion('cancelado'), 'cancelado', 'un pedido cancelado (reembolsado incluido, ver admin.js) nunca muestra el QR de éxito');
  assert.equal(mod.resolverVerificacion('pendiente'), 'no_confirmado', 'pendiente/borrador — pago aún no verificado por el backend');
  assert.equal(mod.resolverVerificacion('borrador'), 'no_confirmado');
  assert.equal(mod.resolverVerificacion(undefined), 'no_confirmado', 'estado desconocido/ausente cae a fallback visible, no crashea');
});

test('qr-recogida: la URL (codigo/pedidoId) por sí sola no basta — siempre se verifica contra el backend', () => {
  const src = read('app/qr-recogida.tsx');
  assert.match(src, /pedidosAPI\.detalle\(pedidoId\)/, 'debe consultar el pedido real antes de mostrar el QR');
  assert.match(src, /if \(!pedidoId\) \{ setVerificacion\('no_confirmado'\); return; \}/, 'sin pedidoId no hay nada que verificar: no se asume éxito');
  assert.match(src, /verificacion === 'cargando'/, 'debe existir un estado de carga antes de decidir — no muestra el QR por defecto mientras verifica');
});

test('estados canónicos del backend (services/orderStateMachine.js) siguen siendo los que el frontend espera', () => {
  // No reimporta el módulo del backend (repos separados en runtime), pero fija
  // el contrato para detectar si alguno de los dos lados cambia sin avisar.
  const src = read('../backend/services/orderStateMachine.js');
  for (const estado of ['pendiente', 'pagado', 'confirmado', 'completado', 'cancelado', 'reembolsado']) {
    assert.ok(src.includes(`'${estado}'`), `orderStateMachine.js debe seguir declarando el estado '${estado}'`);
  }
  // Regla crítica que pago-retorno.tsx/pago-exitoso.tsx asumen al exigir AMBAS
  // columnas: un reembolso dejar el pedido en estado='cancelado' con
  // estado_pago='pagado' (nunca resetea estado_pago) — ver admin.js.
  const adminSrc = read('../backend/routes/admin.js');
  assert.match(adminSrc, /estado_pago='pagado' para siempre/, 'la razón por la que el frontend exige estado===\'confirmado\' Y NO solo estado_pago===\'pagado\' sigue documentada en el backend');
});

test('(tabs)/pedidos: un error de red no se confunde con "no tengo pedidos"', () => {
  const src = read('app/(tabs)/pedidos.tsx');
  assert.doesNotMatch(src, /catch \{ setPedidos\(\[\]\); \}/, 'un fallo de red no debe vaciar la lista y disfrazarse de lista vacía');
  assert.match(src, /setErrorCarga\(true\)/, 'debe distinguir error de carga de "sin pedidos"');
  assert.match(src, /pedidos\.length === 0 && errorCarga/, 'el estado vacío real y el de error deben ser ramas distintas de la UI');
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 4 — Errores visibles
// ═══════════════════════════════════════════════════════════════════════════

test('restaurante/pedidos: una transición inválida (409) refresca la lista en vez de dejarla con el estado viejo', () => {
  const src = read('app/restaurante/pedidos.tsx');
  assert.match(src, /if \(e\?\.status === 409\) cargar\(\);/, 'tras un 409 el panel debe recargar para reflejar el estado real del backend');
  assert.match(src, /Alert\.alert\('Error', e\.message/, 'el error del backend debe llegar visible, no solo a consola');
});

test('tienda/[id]: un fallo al cargar la tienda muestra error con reintento, no una pantalla en blanco', () => {
  const src = read('app/tienda/[id].tsx');
  assert.match(src, /errorMsg \|\| !negocio/, 'debe distinguir "cargando" de "falló y no hay negocio" en vez de renderizar con datos nulos');
  assert.match(src, /setReintentoId/, 'debe ofrecer un reintento explícito');
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 1 — Guards de navegación
// ═══════════════════════════════════════════════════════════════════════════

test('AuthGuard: las secciones compartidas nunca incluyen las privadas de restaurante/admin/tabs', () => {
  const src = read('app/_layout.tsx');
  const sharedMatch = src.match(/const SHARED_SECTIONS = \[([^\]]+)\];/);
  const newMatch = src.match(/const NEW_SECTIONS = \[([^\]]+)\];/);
  assert.ok(sharedMatch && newMatch, 'no se pudo ubicar SHARED_SECTIONS/NEW_SECTIONS en _layout.tsx — revisar si el guard cambió de forma');
  const shared = [...sharedMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const nuevas = [...newMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const seccionPrivada of ['(tabs)', 'restaurante', 'admin']) {
    assert.ok(!shared.includes(seccionPrivada), `SHARED_SECTIONS no debe incluir '${seccionPrivada}' — daría acceso cruzado entre roles`);
    assert.ok(!nuevas.includes(seccionPrivada), `NEW_SECTIONS no debe incluir '${seccionPrivada}'`);
  }
});

test('AuthGuard: el contenido de cada Stack.Screen se bloquea sincrónicamente vía screenLayout, no solo por el redirect asíncrono', () => {
  const src = read('app/_layout.tsx');
  assert.match(src, /screenLayout=\{\(\{ route, children \}\) => \{/, 'debe seguir controlando el montaje por screenLayout (evita el flash de contenido protegido antes del redirect)');
  assert.match(src, /return <>\{allowed \? children : null\}<\/>;/, 'sin "allowed", los hijos de la ruta no deben montarse');
});

test('AuthGuard: sesión inválida (401 de sesión muerta) limpia la sesión y deja mensaje visible para login', () => {
  const authSrc = read('src/context/AuthContext.tsx');
  assert.match(authSrc, /SESSION_MESSAGE_KEY/);
  assert.match(authSrc, /setToken\(null\);\s*setUsuario\(null\);/);
  const loginSrc = read('app/login.tsx');
  assert.match(loginSrc, /SESSION_MESSAGE_KEY/, 'login debe leer y mostrar el mensaje dejado por una sesión invalidada');
});

// ═══════════════════════════════════════════════════════════════════════════
// FASE 7 — Push: listeners de foreground/tap, cleanup, navegación segura
// ═══════════════════════════════════════════════════════════════════════════

test('_layout: rutaParaNotificacion nunca manda un rol a la sección de otro rol', () => {
  // Real: _layout.tsx delega en resolverRutaNotificacion (src/utils) — se carga
  // el módulo real (sin dependencias) para probar la lógica de verdad, no una
  // copia reescrita en el test.
  const resolverReal = load('src/utils/resolverRutaNotificacion.ts');
  const mod = load('app/_layout.tsx', {
    react: { ...require('react') },
    'react-native': { Animated: {}, Platform: { OS: 'web' }, StyleSheet: { create: x => x }, Text: 'Text' },
    'expo-router': { Stack: 'Stack', useRouter: () => ({}), useSegments: () => [] },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/src/context/AuthContext': { AuthProvider: 'AuthProvider', useAuth: () => ({}) },
    '@/src/context/CartContext': { CartProvider: 'CartProvider' },
    '@/src/context/LocationContext': { LocationProvider: 'LocationProvider' },
    '@/src/context/RealtimeContext': { RealtimeProvider: 'RealtimeProvider' },
    '@/src/utils/resolverRutaNotificacion': resolverReal,
    '@/constants/Colors': { Colors: {} },
    '@/src/services/api': { notificacionesAPI: {} },
    '@/src/context/OnboardingContext': { OnboardingProvider: 'OnboardingProvider', useOnboarding: () => ({}) },
    'expo-splash-screen': { preventAutoHideAsync: () => Promise.resolve() },
  });
  assert.equal(mod.rutaParaNotificacion({ pedidoId: 'x' }, 'cliente'), '/(tabs)/pedidos');
  assert.equal(mod.rutaParaNotificacion({ pedidoId: 'x' }, 'restaurante'), '/restaurante/pedidos');
  assert.equal(mod.rutaParaNotificacion({}, 'restaurante'), '/restaurante');
  assert.equal(mod.rutaParaNotificacion({ pedidoId: 'x' }, 'admin'), '/admin');
  assert.equal(mod.rutaParaNotificacion({ screen: 'restaurante' }, 'cliente'), '/(tabs)/pedidos', 'nunca debe confiar en data.screen a ciegas: el rol de la sesión activa manda');
  assert.equal(mod.rutaParaNotificacion({ pedidoId: 'x' }, undefined), null, 'sin sesión no hay ruta segura — se debe esperar al login');
});

test('_layout: los listeners de notificaciones se limpian al desmontar y no se registran más de una vez', () => {
  const src = read('app/_layout.tsx');
  assert.match(src, /addNotificationReceivedListener/, 'falta el listener de foreground (Fase 7)');
  assert.match(src, /addNotificationResponseReceivedListener/, 'falta el listener de tap/respuesta (Fase 7)');
  assert.match(src, /getLastNotificationResponseAsync/, 'falta cubrir el cold start (app cerrada, abierta por tap)');
  assert.match(src, /subRecibida\.remove\(\);\s*subRespuesta\.remove\(\);/, 'cleanup: debe remover ambas suscripciones al desmontar');
  assert.match(src, /\}, \[\]\);/, 'los listeners deben registrarse una sola vez (deps vacías), no en cada render/relogin');
  assert.match(src, /pendingNotifRef\.current = null; \}/, 'logout/cambio de usuario debe descartar una notificación pendiente del usuario anterior');
});
