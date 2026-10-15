// Ejecutar: node scripts/test-suspension-admin.cjs. Sin red ni dispositivo.
// Suspensión en el panel Admin: el botón inferior del detalle del negocio
// (pestañas Negocio / Propietario / Bancario) usaba Alert.alert con botones,
// que en web no hace nada. Se prueba el flujo compartido (suspensionAdmin.ts)
// y que las pantallas lo usen en vez de llamar al API por su cuenta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function load(file) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj }, { filename: file });
  return exportsObj;
}
const {
  accionDisponibleNegocio, textosAccionNegocio, ejecutarAccionNegocio,
  suspenderCuenta, rehabilitarCuenta, MENSAJE_MOTIVO_OBLIGATORIO,
} = load('src/utils/suspensionAdmin.ts');

// API falsa que registra las llamadas y simula el toggle del backend.
function apiFalsa({ falla } = {}) {
  const llamadas = [];
  const responder = (nombre, args, data) => {
    llamadas.push({ nombre, args });
    if (falla) return Promise.reject(new Error(falla));
    return Promise.resolve({ data });
  };
  return {
    llamadas,
    toggleNegocio: (id, motivo) => responder('toggleNegocio', [id, motivo], { id, activo: !estado[id] }),
    suspenderUsuario: (id, motivo) => responder('suspenderUsuario', [id, motivo], { id, rol: 'suspendido' }),
    rehabilitarUsuario: (id, rol) => responder('rehabilitarUsuario', [id, rol], { id, rol }),
  };
}
const estado = {};
const NEG_ACTIVO = { id: 'n1', nombre: 'Tacos Don Pepe', verificado: true, activo: true };
const NEG_SUSP = { id: 'n2', nombre: 'Pupusería Ana', verificado: true, activo: false };
estado.n1 = true; estado.n2 = false;
const plano = (o) => JSON.parse(JSON.stringify(o));

test('SUSP-1: acción disponible según estado (suspendido → reactivar, nunca "Suspender" inútil)', () => {
  assert.equal(accionDisponibleNegocio(NEG_ACTIVO), 'suspender');
  assert.equal(accionDisponibleNegocio(NEG_SUSP), 'reactivar');
  assert.equal(accionDisponibleNegocio({ ...NEG_ACTIVO, activo: undefined }), 'suspender');
  assert.equal(accionDisponibleNegocio({ id: 'x', verificado: false, activo: false }), null);
  assert.equal(accionDisponibleNegocio(null), null);
});

test('SUSP-2: confirmación deja claro que se suspende el NEGOCIO, no la cuenta', () => {
  const t = textosAccionNegocio('suspender', 'Tacos Don Pepe');
  assert.equal(t.pregunta, '¿Seguro que deseas suspender el negocio "Tacos Don Pepe"?');
  assert.match(t.detalle, /cuenta del propietario no se suspende/);
  assert.equal(t.boton, 'Suspender negocio');
  assert.equal(textosAccionNegocio('reactivar', 'X').boton, 'Reactivar negocio');
});

test('SUSP-3: botón inferior → suspende vía PUT /admin/negocios/:id/toggle con motivo y devuelve el nuevo estado', async () => {
  const api = apiFalsa();
  const r = await ejecutarAccionNegocio(api, NEG_ACTIVO, 'suspender', '  Quejas reiteradas  ');
  assert.deepEqual(api.llamadas, [{ nombre: 'toggleNegocio', args: ['n1', 'Quejas reiteradas'] }]);
  assert.equal(r.ok, true);
  assert.equal(r.activo, false, 'el estado visual se actualiza con lo que devolvió el backend');
  assert.equal(r.mensaje, '"Tacos Don Pepe" fue suspendido.');
});

test('SUSP-3: motivo vacío no se envía (el backend no notifica sin motivo)', async () => {
  const api = apiFalsa();
  await ejecutarAccionNegocio(api, NEG_ACTIVO, 'suspender', '   ');
  assert.equal(api.llamadas[0].args[1], undefined);
});

test('SUSP-4: reactivar usa el mismo endpoint y deja el negocio activo', async () => {
  const api = apiFalsa();
  const r = await ejecutarAccionNegocio(api, NEG_SUSP, 'reactivar', 'ignorado');
  assert.deepEqual(api.llamadas, [{ nombre: 'toggleNegocio', args: ['n2', undefined] }]);
  assert.equal(r.ok, true);
  assert.equal(r.activo, true);
  assert.equal(r.mensaje, '"Pupusería Ana" fue reactivado.');
});

test('SUSP-5: el error real del backend se devuelve (nada de fallos silenciosos)', async () => {
  const api = apiFalsa({ falla: 'No se puede activar el negocio porque no tiene foto.' });
  const r = await ejecutarAccionNegocio(api, NEG_SUSP, 'reactivar');
  assert.deepEqual(plano(r), { ok: false, error: 'No se puede activar el negocio porque no tiene foto.' });
  const sinMensaje = { toggleNegocio: () => Promise.reject({}) };
  assert.equal((await ejecutarAccionNegocio(sinMensaje, NEG_ACTIVO, 'suspender')).error, 'No se pudo suspender el negocio.');
});

test('SUSP-6: el toggle no se llama sobre un estado que no corresponde (no invierte por error)', async () => {
  const api = apiFalsa();
  const ya = await ejecutarAccionNegocio(api, NEG_SUSP, 'suspender');
  assert.deepEqual(plano(ya), { ok: false, error: 'El negocio ya está suspendido.' });
  const activo = await ejecutarAccionNegocio(api, NEG_ACTIVO, 'reactivar');
  assert.deepEqual(plano(activo), { ok: false, error: 'El negocio ya está activo.' });
  const pendiente = await ejecutarAccionNegocio(api, { id: 'p', verificado: false, activo: false }, 'reactivar');
  assert.equal(pendiente.ok, false);
  assert.equal(api.llamadas.length, 0);
});

test('SUSP-7: suspender CUENTA (Usuarios) sigue usando PUT /admin/usuarios/:id/suspender con motivo obligatorio', async () => {
  const api = apiFalsa();
  const vacio = await suspenderCuenta(api, { id: 'u1', nombre: 'Ana', rol: 'cliente' }, '  ');
  assert.deepEqual(plano(vacio), { ok: false, error: MENSAJE_MOTIVO_OBLIGATORIO });
  assert.equal(api.llamadas.length, 0);
  const r = await suspenderCuenta(api, { id: 'u1', nombre: 'Ana', rol: 'cliente' }, ' Fraude ');
  assert.deepEqual(api.llamadas, [{ nombre: 'suspenderUsuario', args: ['u1', 'Fraude'] }]);
  assert.equal(r.ok, true);
  assert.equal(r.mensaje, 'La cuenta de "Ana" fue suspendida.');
  const admin = await suspenderCuenta(api, { id: 'a', rol: 'admin' }, 'x');
  assert.equal(admin.ok, false);
  assert.equal(api.llamadas.length, 1);
});

test('SUSP-7: errores de cuenta y rehabilitar', async () => {
  const falla = apiFalsa({ falla: 'No se puede suspender a un administrador' });
  assert.deepEqual(plano(await suspenderCuenta(falla, { id: 'u', rol: 'cliente' }, 'x')), { ok: false, error: 'No se puede suspender a un administrador' });
  const api = apiFalsa();
  const r = await rehabilitarCuenta(api, { id: 'u2', nombre: 'Luis' }, 'restaurante');
  assert.deepEqual(api.llamadas, [{ nombre: 'rehabilitarUsuario', args: ['u2', 'restaurante'] }]);
  assert.equal(r.mensaje, 'La cuenta de "Luis" fue rehabilitada.');
});

test('SUSP-8: los endpoints del cliente API son los esperados', () => {
  const api = read('src/services/api.ts');
  assert.match(api, /toggleNegocio: \(id: string, motivo\?: string\) => api\.put\(`\/admin\/negocios\/\$\{id\}\/toggle`, \{ motivo \}\)/);
  assert.match(api, /suspenderUsuario: \(id: string, motivo\?: string\) => api\.put\(`\/admin\/usuarios\/\$\{id\}\/suspender`, \{ motivo \}\)/);
});

test('SUSP-9: detalle del negocio — el botón inferior abre el modal y confirma con el flujo compartido', () => {
  const src = read('app/admin/restaurante-detalle.tsx');
  assert.match(src, /onPress=\{abrirSuspension\}/, 'el botón inferior tiene handler');
  assert.match(src, /onPress=\{confirmarSuspension\}/, 'el modal confirma');
  assert.match(src, /ejecutarAccionNegocio\(adminAPI, negocio, suspensionModal, motivoSuspension\)/);
  assert.match(src, /setNegocio\(\(prev: any\) => \(\{ \.\.\.prev, activo: r\.activo \}\)\)/, 'estado visual inmediato');
  assert.match(src, /setErrorSuspension\(r\.error\)/, 'muestra el error real');
  assert.ok(!/toggleSuspender/.test(src), 'sin el handler viejo basado en Alert');
});

test('SUSP-10: ninguna pantalla admin llama a toggle/suspender por fuera del flujo compartido ni confirma suspensión con Alert', () => {
  const dir = path.join(root, 'app/admin');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
    const src = read(`app/admin/${f}`);
    assert.ok(!/adminAPI\.(toggleNegocio|suspenderUsuario|rehabilitarUsuario)\(/.test(src), `${f} llama al API de suspensión directo`);
    assert.ok(!/Alert\.alert\([^)]*\b(Suspender|Activar|Reactivar|Rehabilitar)\b/.test(src), `${f} confirma una suspensión con Alert`);
  }
  assert.match(read('app/admin/negocios.tsx'), /ejecutarAccionNegocio\(adminAPI, n, 'reactivar'\)/);
  assert.match(read('app/admin/usuarios.tsx'), /suspenderCuenta\(adminAPI, suspendModal, suspendMotivo\)/);
});

// ── Render real de las pantallas (hooks con estado por posición, como en
//    test-foto-obligatoria.cjs). Se presiona el botón y se mira el resultado. ──
const React = require('react');
function cargarPantalla(file, mocks) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj.default;
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const walk = (n) => (!n || typeof n !== 'object') ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(walk)];
const textOf = (n) => (typeof n === 'string' || typeof n === 'number') ? String(n)
  : (!n || typeof n !== 'object') ? '' : [n.props?.children].flat(Infinity).map(textOf).join(' ');

function montar(file, { forzados = {}, api }) {
  const cells = []; let cursor = 0;
  const alerts = [];
  const react = { ...React,
    useState(inicial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { value: i in forzados ? forzados[i] : (typeof inicial === 'function' ? inicial() : inicial) };
      const cell = cells[i];
      return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; }];
    },
    useCallback(f) { cursor++; return f; },
    useEffect() { cursor++; },
  };
  const native = new Proxy({
    StyleSheet: { create: (x) => x }, Platform: { OS: 'web' },
    // Igual que react-native-web: Alert.alert no hace nada (solo se registra).
    Alert: { alert: (...args) => alerts.push(args) },
    TouchableOpacity: 'Button', TextInput: 'Input',
  }, { get: (t, k) => (k in t ? t[k] : String(k)) });
  const Component = cargarPantalla(file, {
    react, 'react-native': native,
    'expo-router': { useLocalSearchParams: () => ({ id: 'n1' }), useRouter: () => ({ push() {}, replace() {}, back() {} }) },
    '@/src/services/api': { adminAPI: api },
    '@/constants/Colors': { Colors: { orange: 'orange', white: 'white' } },
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/utils/suspensionAdmin': load('src/utils/suspensionAdmin.ts'),
  });
  const render = () => { cursor = 0; return Component(); };
  const app = {
    alerts,
    estado: (i) => cells[i]?.value,
    texto: () => textOf(render()),
    boton: (re) => walk(render()).filter((n) => n.type === 'Button' && re.test(textOf(n))).at(-1),
    input: (re) => walk(render()).find((n) => n.type === 'Input' && re.test(n.props.placeholder || '')),
  };
  render();
  return app;
}

// restaurante-detalle: negocio(0), propietario(1), loading(2), tab(3), procesando(4),
// rechazarModal(5), motivo(6), suspensionModal(7), motivoSuspension(8), errorSuspension(9), aviso(10)
const DETALLE = 'app/admin/restaurante-detalle.tsx';
function apiDetalle({ activoInicial = true, falla } = {}) {
  let activo = activoInicial;
  const llamadas = [];
  return {
    llamadas,
    negocios: async () => ({ data: [] }), usuarios: async () => ({ data: [] }),
    toggleNegocio: async (id, motivo) => {
      llamadas.push([id, motivo]);
      if (falla) throw new Error(falla);
      activo = !activo;
      return { data: { id, activo } };
    },
  };
}

test('SUSP-UI-1: botón inferior "Suspender negocio" (pestañas Negocio/Propietario/Bancario) confirma y suspende', async () => {
  const negocio = { id: 'n1', nombre: 'Tacos Don Pepe', verificado: true, activo: true };
  for (const tab of ['negocio', 'propietario', 'bancario']) {
    const a = montar(DETALLE, { forzados: { 0: negocio, 2: false, 3: tab }, api: apiDetalle() });
    assert.ok(a.boton(/⏸ Suspender negocio/), `botón visible en la pestaña ${tab}`);
  }

  const api = apiDetalle();
  const app = montar(DETALLE, { forzados: { 0: negocio, 2: false }, api });
  app.boton(/⏸ Suspender negocio/).props.onPress();
  assert.equal(app.estado(7), 'suspender', 'abre la confirmación (antes: Alert.alert, no-op en web)');
  assert.equal(api.llamadas.length, 0, 'no suspende sin confirmar');
  assert.match(app.texto(), /¿Seguro que deseas suspender el negocio "Tacos Don Pepe"\?/);

  app.input(/Quejas reiteradas/).props.onChangeText('Quejas reiteradas');
  await app.boton(/^Suspender negocio$/).props.onPress(); await tick();
  assert.deepEqual(api.llamadas, [['n1', 'Quejas reiteradas']], 'PUT /admin/negocios/:id/toggle con motivo');
  assert.equal(app.estado(0).activo, false, 'estado actualizado sin recargar');
  assert.equal(app.estado(7), null, 'cierra el modal');
  const texto = app.texto();
  assert.match(texto, /"Tacos Don Pepe" fue suspendido\./, 'mensaje de éxito');
  assert.match(texto, /Negocio suspendido/, 'badge de estado');
  assert.match(texto, /▶ Reactivar negocio/, 'ya no muestra un "Suspender" inútil');
  assert.ok(!/⏸ Suspender negocio/.test(texto));
  assert.equal(app.alerts.length, 0, 'no depende de Alert');
});

test('SUSP-UI-2: si el backend falla, el modal sigue abierto con el error real', async () => {
  const api = apiDetalle({ falla: 'Negocio no encontrado' });
  const app = montar(DETALLE, { forzados: { 0: { id: 'n1', nombre: 'X', verificado: true, activo: true }, 2: false }, api });
  app.boton(/⏸ Suspender negocio/).props.onPress();
  await app.boton(/^Suspender negocio$/).props.onPress(); await tick();
  assert.equal(api.llamadas.length, 1);
  assert.equal(app.estado(7), 'suspender', 'el modal no se cierra');
  assert.equal(app.estado(0).activo, true, 'el estado no cambia');
  assert.match(app.texto(), /Negocio no encontrado/);
});

test('SUSP-UI-3: negocio suspendido → "Reactivar negocio" usa el mismo endpoint y vuelve a activo', async () => {
  const api = apiDetalle({ activoInicial: false });
  const app = montar(DETALLE, { forzados: { 0: { id: 'n1', nombre: 'X', verificado: true, activo: false }, 2: false }, api });
  app.boton(/▶ Reactivar negocio/).props.onPress();
  assert.equal(app.estado(7), 'reactivar');
  assert.ok(!app.input(/Quejas reiteradas/), 'reactivar no pide motivo');
  await app.boton(/^Reactivar negocio$/).props.onPress(); await tick();
  assert.deepEqual(api.llamadas, [['n1', undefined]]);
  assert.equal(app.estado(0).activo, true);
  assert.match(app.texto(), /"X" fue reactivado\./);
  assert.match(app.texto(), /⏸ Suspender negocio/);
});

test('SUSP-UI-4: negocio pendiente no muestra suspender (solo Aprobar/Rechazar)', () => {
  const app = montar(DETALLE, { forzados: { 0: { id: 'n1', nombre: 'X', verificado: false, activo: false }, 2: false }, api: apiDetalle() });
  assert.ok(!/Suspender negocio|Reactivar negocio/.test(app.texto()));
});

// usuarios: usuarios(0), loading(1), refreshing(2), busqueda(3), rolFiltro(4), confirmando(5),
// procesando(6), errores(7), exito(8), suspendModal(9), suspendMotivo(10), suspendMotivoError(11), suspendando(12)
test('SUSP-UI-5: Usuarios — "Suspender cuenta" sigue funcionando con su endpoint y actualiza la tarjeta', async () => {
  const llamadas = [];
  const usuario = { id: 'u1', nombre: 'Ana', email: 'ana@x.gt', rol: 'cliente', negocio_activo: null };
  let enServidor = { ...usuario };
  const api = {
    usuarios: async () => ({ data: [{ ...enServidor }] }),
    suspenderUsuario: async (id, motivo) => { llamadas.push(['suspender', id, motivo]); enServidor.rol = 'suspendido'; return { data: enServidor }; },
    rehabilitarUsuario: async (id, rol) => { llamadas.push(['rehabilitar', id, rol]); enServidor.rol = rol; return { data: enServidor }; },
  };
  const app = montar('app/admin/usuarios.tsx', { forzados: { 0: [usuario], 1: false }, api });
  app.boton(/⏸ Suspender cuenta/).props.onPress();
  assert.equal(app.estado(9).id, 'u1');
  await app.boton(/^Suspender cuenta$/).props.onPress(); await tick();
  assert.equal(llamadas.length, 0, 'sin motivo no llama');
  assert.equal(app.estado(11), true);
  app.input(/Incumplimiento/).props.onChangeText('Fraude');
  await app.boton(/^Suspender cuenta$/).props.onPress(); await tick();
  assert.deepEqual(llamadas, [['suspender', 'u1', 'Fraude']], 'PUT /admin/usuarios/:id/suspender');
  assert.equal(app.estado(0)[0].rol, 'suspendido');
  assert.match(app.texto(), /La cuenta de "Ana" fue suspendida\./);

  app.boton(/▶ Rehabilitar cuenta/).props.onPress();
  await app.boton(/^Confirmar$/).props.onPress(); await tick();
  assert.deepEqual(llamadas[1], ['rehabilitar', 'u1', 'cliente']);
  assert.equal(app.estado(0)[0].rol, 'cliente');
  assert.match(app.texto(), /fue rehabilitada\./);
});

test('SUSP-UI-6: Usuarios — el error del backend se muestra en la tarjeta', async () => {
  const api = { usuarios: async () => ({ data: [] }), suspenderUsuario: async () => { throw new Error('Usuario no encontrado'); } };
  const app = montar('app/admin/usuarios.tsx', { forzados: { 0: [{ id: 'u1', nombre: 'Ana', rol: 'cliente' }], 1: false }, api });
  app.boton(/⏸ Suspender cuenta/).props.onPress();
  app.input(/Incumplimiento/).props.onChangeText('x');
  await app.boton(/^Suspender cuenta$/).props.onPress(); await tick();
  assert.match(app.texto(), /Usuario no encontrado/);
  assert.equal(app.estado(0)[0].rol, 'cliente');
});
