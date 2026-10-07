// Ejecutar: node scripts/test-liquidaciones-resenas.cjs. Sin red ni Expo.
// Fase C — liquidaciones mensuales y reseñas verificadas en la app:
//   LR-1..  utilidades puras (src/utils/liquidacionesResenas.ts)
//   AC-1..  apertura del comprobante (src/utils/abrirComprobante.ts)
//   GAN-*   app/restaurante/ganancias.tsx montada con hooks que SÍ corren efectos
//   RES-*   app/restaurante/resenas.tsx (listar y responder)
//   PED-*   app/(tabs)/pedidos.tsx (estado "ya calificado" desde la API, sin AsyncStorage)
//   ADM-*   app/admin/resenas.tsx (moderación)
//   E2E-*   pantallas reales contra los routers reales del backend
//           (backend/test/helpers/appLiquidaciones.js, base en memoria)
const { test, before, after } = require('node:test');
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
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout, setInterval, clearInterval, globalThis: {},
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

// Recorre el árbol invocando componentes función sin hooks propios (PedidoCard,
// ResenaModal) para ver lo que de verdad pintan.
function walk(node) {
  if (!node || typeof node !== 'object') return [];
  const hijos = [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  if (typeof node.type === 'function') {
    try { hijos.push(...walk(node.type(node.props))); } catch { /* usa hooks: no invocable aquí */ }
  }
  return hijos;
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  const propio = [node?.props?.children].flat(Infinity).map(textOf).join(' ');
  if (typeof node.type === 'function') {
    try { return propio + ' ' + textOf(node.type(node.props)); } catch { return propio; }
  }
  return propio;
}
const native = (alerts) => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button', SafeAreaView: 'Safe',
  ActivityIndicator: 'Spinner', Modal: 'Modal', TextInput: 'Input', KeyboardAvoidingView: 'KAV',
  RefreshControl: 'RefreshControl', StyleSheet: { create: x => x }, Platform: { OS: 'android' },
  Alert: { alert: (...args) => alerts.push(args) }, Linking: { openURL() {} },
});

// Hooks que re-renderizan al cambiar estado y corren efectos (y useFocusEffect
// al montar), para probar ciclos reales "cargar → tocar → backend → re-render".
function hooksReales() {
  let cursor = 0; const cells = []; const pendientes = []; let renderFn = () => {};
  const memo = (factory, deps) => {
    const i = cursor++; const old = cells[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) cells[i] = { deps, value: factory() };
    return cells[i].value;
  };
  const useEffect = (effect, deps) => {
    const i = cursor++; const old = cells[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) { cells[i] = { deps }; pendientes.push(effect); }
  };
  return {
    react: { ...React, useMemo: memo, useCallback: (f, deps) => memo(() => f, deps), useEffect,
      useRef: initial => memo(() => ({ current: initial }), []),
      useState(inicial) {
        const i = cursor++;
        if (!(i in cells)) cells[i] = { value: typeof inicial === 'function' ? inicial() : inicial };
        const cell = cells[i];
        return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; renderFn(); }];
      },
    },
    useFocusEffect: cb => useEffect(cb, [cb]),
    reset() { cursor = 0; },
    setRenderFn(fn) { renderFn = fn; },
    flush() { pendientes.splice(0).forEach(e => e()); },
  };
}

const utils = load('src/utils/liquidacionesResenas.ts');
// Los objetos creados dentro del vm tienen otro prototipo: comparar por valor.
const plano = v => JSON.parse(JSON.stringify(v));

function cargarAbrir(abiertas, plataforma = 'android') {
  return load('src/utils/abrirComprobante.ts', {
    'react-native': { Platform: { OS: plataforma } },
    'expo-web-browser': { openBrowserAsync: async url => { abiertas.push(url); } },
  });
}

function montar(file, { api, abiertas = [], extra = {} } = {}) {
  const h = hooksReales();
  const alerts = [];
  const Component = load(file, {
    react: h.react, 'react-native': native(alerts), '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-router': { useRouter: () => ({ push() {}, back() {}, replace() {}, canGoBack: () => true }), useFocusEffect: h.useFocusEffect, useLocalSearchParams: () => ({}) },
    '@/constants/Colors': { Colors: {} },
    '@/src/services/api': api,
    '@/src/utils/liquidacionesResenas': utils,
    '@/src/utils/abrirComprobante': cargarAbrir(abiertas),
    '@/src/utils/backNavigation': { volver() {} },
    '@/src/context/RealtimeContext': { useRealtime: () => ({ onPedidoCambiado: () => () => {} }) },
    ...extra,
  }).default;
  let tree;
  const render = () => { h.reset(); tree = Component(); };
  h.setRenderFn(render);
  render();
  return {
    alerts, abiertas,
    get tree() { return tree; },
    // Normaliza espacios: textOf separa con ' ' los hijos de un mismo <Text>.
    texto: () => textOf(tree).replace(/\s+/g, ' '),
    async asentar() { for (let i = 0; i < 12; i++) { h.flush(); await new Promise(setImmediate); } },
    botones: () => walk(tree).filter(n => n.type === 'Button').map(n => ({ texto: textOf(n).trim(), onPress: n.props.onPress, disabled: n.props.disabled })),
    boton(re) { const b = this.botones().find(x => re.test(x.texto)); assert.ok(b, `no hay botón ${re} en: ${this.botones().map(x => x.texto).join(' | ')}`); return b; },
    inputs: () => walk(tree).filter(n => n.type === 'Input'),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Utilidades puras
// ════════════════════════════════════════════════════════════════════════════

test('LR-1: etiquetaMes y fechaGT (hora de Guatemala, igual que el PDF)', () => {
  assert.equal(utils.etiquetaMes('2026-09'), 'Septiembre 2026');
  assert.equal(utils.etiquetaMes(null), 'Liquidación anterior');
  assert.equal(utils.etiquetaMes('2026-13'), 'Liquidación anterior');
  assert.equal(utils.fechaGT('2026-10-06T05:59:59.000Z'), '05/10/2026'); // 23:59:59 GT del 5-oct
  assert.equal(utils.fechaGT('2026-10-06T06:00:00.000Z'), '06/10/2026');
  assert.equal(utils.fechaGT(null), '—');
  assert.equal(utils.fechaGT('no-fecha'), '—');
});

test('LR-2: estado y vencimiento de la liquidación', () => {
  assert.equal(utils.estadoLiquidacion('pagado').label, 'Pagado');
  assert.equal(utils.estadoLiquidacion('raro').label, 'Pendiente de pago');
  const ahora = new Date('2026-10-07T00:00:00Z');
  assert.equal(utils.pagoVencido({ estado: 'pendiente', fecha_limite_pago: '2026-10-06T05:59:59Z' }, ahora), true);
  assert.equal(utils.pagoVencido({ estado: 'pagado', fecha_limite_pago: '2026-10-06T05:59:59Z' }, ahora), false);
  assert.equal(utils.pagoVencido({ estado: 'pendiente', fecha_limite_pago: null }, ahora), false);
  assert.equal(utils.quetzales(37.25), 'Q37.25');
  assert.equal(utils.quetzales(undefined), 'Q0.00');
});

test('LR-3: reseñable según el resena_id que manda la API', () => {
  assert.equal(utils.puedeResenar({ estado: 'completado', resena_id: null }), true);
  assert.equal(utils.puedeResenar({ estado: 'recogido' }), true);
  assert.equal(utils.puedeResenar({ estado: 'completado', resena_id: 'r1' }), false);
  assert.equal(utils.puedeResenar({ estado: 'confirmado' }), false);
  assert.equal(utils.yaResenado({ estado: 'completado', resena_id: 'r1' }), true);
  assert.equal(utils.yaResenado({ estado: 'cancelado', resena_id: 'r1' }), false);
});

test('LR-4: 409 de POST /resenas se interpreta como "ya calificado"', () => {
  assert.equal(utils.resenaExistenteDeError({ status: 409, responseData: { resena_id: 'r9' } }), 'r9');
  assert.equal(utils.resenaExistenteDeError({ status: 409 }), 'existente');
  assert.equal(utils.resenaExistenteDeError({ status: 400 }), null);
  assert.equal(utils.resenaExistenteDeError(null), null);
});

test('LR-5: validaciones espejo del backend (500 caracteres como char_length)', () => {
  assert.equal(utils.largoTexto('😀😀'), 2);
  assert.equal(utils.validarRespuesta('   '), 'Escribe una respuesta');
  assert.equal(utils.validarRespuesta('😀'.repeat(500)), null);
  assert.match(utils.validarRespuesta('x'.repeat(501)), /500/);
  assert.match(utils.validarMotivoOcultar(''), /motivo/);
  assert.equal(utils.validarMotivoOcultar(' spam '), null);
  assert.equal(utils.estrellas(3), '★★★☆☆');
  assert.equal(utils.estrellas(9), '★★★★★');
  assert.equal(utils.nombreCorto('María José López'), 'María L.');
  assert.equal(utils.nombreCorto(''), 'Cliente');
  assert.equal(utils.nombreCorto('Ana'), 'Ana');
});

// ════════════════════════════════════════════════════════════════════════════
// Apertura del comprobante
// ════════════════════════════════════════════════════════════════════════════

test('AC-1: nativo pide la URL firmada y la abre con WebBrowser.openBrowserAsync', async () => {
  const abiertas = [];
  await cargarAbrir(abiertas).abrirComprobante(async () => 'https://firmada/1');
  assert.deepEqual(abiertas, ['https://firmada/1']);
});

test('AC-2: web abre la pestaña ANTES de esperar la URL (evita el bloqueador de pop-ups)', async () => {
  const orden = [];
  const pestana = { location: { href: '' }, close() { orden.push('close'); } };
  await cargarAbrir([], 'web').abrirComprobante(async () => { orden.push('url'); return 'https://firmada/2'; }, {
    abrirPestana: () => { orden.push('abrir'); return pestana; },
  });
  assert.deepEqual(orden, ['abrir', 'url']);
  assert.equal(pestana.location.href, 'https://firmada/2');
});

test('AC-3: web con pop-ups bloqueados navega en la misma pestaña; si falla la URL cierra la pestaña', async () => {
  const navegadas = [];
  await cargarAbrir([], 'web').abrirComprobante(async () => 'https://firmada/3', { abrirPestana: () => null, navegarAqui: u => navegadas.push(u) });
  assert.deepEqual(navegadas, ['https://firmada/3']);

  let cerrada = false;
  await assert.rejects(cargarAbrir([], 'web').abrirComprobante(async () => { throw new Error('403'); }, {
    abrirPestana: () => ({ location: { href: '' }, close() { cerrada = true; } }),
  }), /403/);
  assert.equal(cerrada, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Restaurante — ganancias / liquidaciones
// ════════════════════════════════════════════════════════════════════════════

const LIQ = {
  id: 'liq-1', mes: '2026-09', folio: 'LIQ-202609-ABCDEF12', estado: 'pendiente', monto: 37.25,
  ventas_brutas: 45, comision_bocara: 11.25, propinas: 2, costo_envio: 1.5, total_pedidos: 4,
  fecha_limite_pago: '2099-10-06T05:59:59.000Z', pagado_en: null, created_at: '2026-10-01T12:00:00Z', datos_transferencia: null,
};
const RESUMEN = { periodo: 'mes', negocio: { datos_bancarios: null }, resumen: { total_pedidos: 0, total_a_recibir: 0 }, liquidaciones: [] };

function apiGanancias({ liquidaciones = [LIQ], fallarLiqs = false, fallarComprobante = false, llamadas = [] } = {}) {
  return {
    negociosAPI: {
      ganancias: async () => ({ data: RESUMEN }),
      liquidaciones: async () => { llamadas.push('liquidaciones'); if (fallarLiqs) throw new Error('backend caído'); return { data: liquidaciones }; },
      comprobanteLiquidacion: async (id) => { llamadas.push(`comprobante:${id}`); if (fallarComprobante) throw new Error('No se pudo obtener el comprobante, intenta de nuevo'); return { data: { url: `https://firmada/${id}`, expira_en: 'x', folio: 'f' } }; },
    },
  };
}

test('GAN-1: muestra la liquidación mensual con folio, mes, neto, estado y fecha límite', async () => {
  const llamadas = [];
  const app = montar('app/restaurante/ganancias.tsx', { api: apiGanancias({ llamadas }) });
  await app.asentar();
  assert.ok(llamadas.includes('liquidaciones'), 'consume GET /negocios/mi-negocio/liquidaciones');
  const t = app.texto();
  for (const esperado of ['Septiembre 2026', 'Folio LIQ-202609-ABCDEF12', 'Q37.25', 'Pendiente de pago', 'Fecha límite de pago: 05/10/2099', '4 pedidos', 'Q45.00']) {
    assert.ok(t.includes(esperado), `falta "${esperado}"`);
  }
  assert.doesNotMatch(t, /cada semana los viernes/, 'el aviso de pago semanal ya no aplica');
});

test('GAN-2: "Ver comprobante" pide la URL firmada de ESA liquidación y la abre con WebBrowser', async () => {
  const llamadas = [];
  const app = montar('app/restaurante/ganancias.tsx', { api: apiGanancias({ llamadas }) });
  await app.asentar();
  await app.boton(/Ver comprobante/).onPress();
  await app.asentar();
  assert.ok(llamadas.includes('comprobante:liq-1'));
  assert.deepEqual(app.abiertas, ['https://firmada/liq-1']);
});

test('GAN-3: si falla el comprobante, el error queda visible en la tarjeta (también en web)', async () => {
  const app = montar('app/restaurante/ganancias.tsx', { api: apiGanancias({ fallarComprobante: true }) });
  await app.asentar();
  await app.boton(/Ver comprobante/).onPress();
  await app.asentar();
  assert.deepEqual(app.abiertas, []);
  assert.match(app.texto(), /No se pudo obtener el comprobante/);
});

test('GAN-4: pagada muestra fecha de pago y referencia; vencida se marca', async () => {
  const pagada = { ...LIQ, id: 'liq-2', estado: 'pagado', pagado_en: '2026-10-03T16:00:00Z', datos_transferencia: { referencia: 'TRX-7' } };
  const vencida = { ...LIQ, id: 'liq-3', mes: '2026-08', folio: 'LIQ-202608-X', fecha_limite_pago: '2026-09-04T05:59:59Z' };
  const app = montar('app/restaurante/ganancias.tsx', { api: apiGanancias({ liquidaciones: [pagada, vencida] }) });
  await app.asentar();
  const t = app.texto();
  assert.match(t, /Pagado el 03\/10\/2026/);
  assert.match(t, /Ref: TRX-7/);
  assert.match(t, /Vencido · Fecha límite de pago: 03\/09\/2026/);
});

test('GAN-5: si falla el historial mensual se ofrece reintentar, sin perder el resumen', async () => {
  const app = montar('app/restaurante/ganancias.tsx', { api: apiGanancias({ fallarLiqs: true }) });
  await app.asentar();
  const t = app.texto();
  assert.match(t, /backend caído/);
  assert.match(t, /Lo que recibirás/);
  assert.ok(app.boton(/Reintentar/));
});

// ════════════════════════════════════════════════════════════════════════════
// Restaurante — reseñas y respuestas
// ════════════════════════════════════════════════════════════════════════════

const RESENA = { id: 'r1', pedido_id: 'p1', calificacion: 4, comentario: 'Rico', respuesta_restaurante: null, respondida_en: null, visible: true, created_at: '2026-10-02T18:00:00Z', usuarios: { nombre: 'Ana' } };

function apiResenas({ resenas = [RESENA], respuestas = [], fallarResponder = false } = {}) {
  return {
    resenasAPI: {
      restaurante: async () => ({ data: resenas }),
      responder: async (id, respuesta) => {
        respuestas.push([id, respuesta]);
        if (fallarResponder) throw new Error('Reseña no encontrada');
        return { data: { id, respuesta_restaurante: respuesta, respondida_en: '2026-10-05T18:00:00Z' } };
      },
    },
  };
}

test('RES-1: lista reseñas con compra verificada, aviso de ocultas y pendientes de responder', async () => {
  const oculta = { ...RESENA, id: 'r2', pedido_id: null, visible: false, comentario: 'spam' };
  const app = montar('app/restaurante/resenas.tsx', { api: apiResenas({ resenas: [RESENA, oculta] }) });
  await app.asentar();
  const t = app.texto();
  assert.match(t, /Ana/);
  assert.match(t, /Rico/);
  assert.match(t, /Compra verificada/);
  assert.match(t, /Oculta por moderación/);
  assert.match(t, /4\.0/, 'promedio solo con las públicas');
});

test('RES-2: responder → PATCH /resenas/:id/respuesta con el texto recortado, y se muestra', async () => {
  const respuestas = [];
  const app = montar('app/restaurante/resenas.tsx', { api: apiResenas({ respuestas }) });
  await app.asentar();
  await app.boton(/Responder/).onPress();
  app.inputs()[0].props.onChangeText('  ¡Gracias por venir!  ');
  await app.boton(/Publicar respuesta/).onPress();
  await app.asentar();
  assert.deepEqual(respuestas, [['r1', '¡Gracias por venir!']]);
  assert.match(app.texto(), /Tu respuesta/);
  assert.match(app.texto(), /¡Gracias por venir!/);
});

test('RES-3: respuesta vacía no llama al backend; error del backend queda visible', async () => {
  const respuestas = [];
  const app = montar('app/restaurante/resenas.tsx', { api: apiResenas({ respuestas, fallarResponder: true }) });
  await app.asentar();
  await app.boton(/Responder/).onPress();
  await app.boton(/Publicar respuesta/).onPress();
  assert.deepEqual(respuestas, []);
  assert.match(app.texto(), /Escribe una respuesta/);
  app.inputs()[0].props.onChangeText('hola');
  await app.boton(/Publicar respuesta/).onPress();
  await app.asentar();
  assert.match(app.texto(), /Reseña no encontrada/);
});

// ════════════════════════════════════════════════════════════════════════════
// Cliente — pedidos
// ════════════════════════════════════════════════════════════════════════════

const pedido = (id, extra = {}) => ({ id, negocio_id: 'n1', estado: 'completado', total: 10, tipo_entrega: 'recogida', codigo_recogida: 'ABC', created_at: '2026-10-01T18:00:00Z', negocios: { nombre: 'Ola Azul' }, bolsas: { nombre: 'Bolsa' }, ...extra });

function apiPedidos({ pedidos, creadas = [], error = null }) {
  return {
    pedidosAPI: { listar: async () => ({ data: pedidos }) },
    resenasAPI: { crear: async (body) => { creadas.push(body); if (error) throw error; return { data: { id: 'nueva', ...body } }; } },
  };
}

test('PED-1: ya no usa AsyncStorage — si lo importara, montar fallaría por falta de doble', () => {
  assert.doesNotMatch(leer('app/(tabs)/pedidos.tsx'), /AsyncStorage|bocara_resenas_enviadas/);
});

test('PED-2: "Dejar reseña" / "Reseña enviada" salen del resena_id de la API', async () => {
  const app = montar('app/(tabs)/pedidos.tsx', { api: apiPedidos({ pedidos: [pedido('a', { resena_id: 'r1' }), pedido('b', { resena_id: null })] }) });
  await app.asentar();
  const t = app.texto();
  assert.equal((t.match(/Dejar reseña/g) || []).length, 2, 'botón de la tarjeta "b" + título del modal');
  assert.equal((t.match(/Reseña enviada/g) || []).length, 1);
});

test('PED-3: enviar reseña la marca en memoria (sin almacenamiento local)', async () => {
  const creadas = [];
  const app = montar('app/(tabs)/pedidos.tsx', { api: apiPedidos({ pedidos: [pedido('b')], creadas }) });
  await app.asentar();
  await app.botones().find(b => b.texto.includes('Dejar reseña') && !b.texto.includes('Enviar')).onPress();
  await app.boton(/Enviar reseña/).onPress();
  await app.asentar();
  assert.deepEqual(creadas.map(c => c.pedido_id), ['b']);
  assert.match(app.texto(), /Reseña enviada/);
  assert.deepEqual(app.alerts.at(-1).slice(0, 1), ['¡Gracias!']);
});

test('PED-4: 409 (calificado en otro dispositivo) se marca como enviada, no como error', async () => {
  const error = Object.assign(new Error('Ya calificaste este pedido'), { status: 409, responseData: { resena_id: 'r-otro' } });
  const app = montar('app/(tabs)/pedidos.tsx', { api: apiPedidos({ pedidos: [pedido('b')], error }) });
  await app.asentar();
  await app.botones().find(b => b.texto.includes('Dejar reseña') && !b.texto.includes('Enviar')).onPress();
  await app.boton(/Enviar reseña/).onPress();
  await app.asentar();
  assert.match(app.texto(), /Reseña enviada/);
  assert.equal(app.alerts.at(-1)[0], 'Reseña registrada');
});

// ════════════════════════════════════════════════════════════════════════════
// Ficha pública y layouts (estructura)
// ════════════════════════════════════════════════════════════════════════════

test('FICHA-1: la ficha del negocio muestra "Compra verificada" y la respuesta del restaurante', () => {
  const src = leer('app/negocio/[id].tsx');
  assert.match(src, /r\.compra_verificada/);
  assert.match(src, /Compra verificada/);
  assert.match(src, /r\.respuesta_restaurante/);
});

test('NAV-1: rutas registradas (reseñas del restaurante oculta en tabs; moderación en admin)', () => {
  assert.match(leer('app/restaurante/_layout.tsx'), /name="resenas"\s+options=\{\{ href: null \}\}/);
  assert.match(leer('app/restaurante/perfil.tsx'), /\/restaurante\/resenas/);
  assert.match(leer('app/admin/_layout.tsx'), /name: 'resenas'/);
});

// ════════════════════════════════════════════════════════════════════════════
// Admin — moderación
// ════════════════════════════════════════════════════════════════════════════

function apiAdmin({ items, moderaciones = [], filtros = [] }) {
  return {
    adminAPI: {
      resenas: async (params) => { filtros.push(params); return { data: items }; },
      moderarResena: async (id, body) => { moderaciones.push([id, body]); return { data: { id, ...body, motivo_moderacion: body.motivo ?? null } }; },
    },
  };
}

test('ADM-1: ocultar exige motivo; con motivo llama a PATCH /admin/resenas/:id/moderar', async () => {
  const moderaciones = [];
  const app = montar('app/admin/resenas.tsx', { api: apiAdmin({ items: [{ ...RESENA, negocios: { nombre: 'Ola Azul' } }], moderaciones }) });
  await app.asentar();
  await app.boton(/Ocultar$/).onPress(); // abre el modal (botón de la tarjeta)
  const modal = () => walk(app.tree).find(n => n.type === 'Modal');
  assert.equal(modal().props.visible, true);
  await app.botones().filter(b => b.texto === 'Ocultar').at(-1).onPress(); // confirmar sin motivo
  assert.deepEqual(moderaciones, []);
  assert.match(app.texto(), /Indica el motivo/);
  app.inputs()[0].props.onChangeText(' Lenguaje ofensivo ');
  await app.botones().filter(b => b.texto === 'Ocultar').at(-1).onPress();
  await app.asentar();
  assert.deepEqual(plano(moderaciones), [['r1', { visible: false, motivo: 'Lenguaje ofensivo' }]]);
  assert.equal(modal().props.visible, false);
  assert.match(app.texto(), /Volver a mostrar/);
});

test('ADM-2: volver a mostrar no pide motivo; filtros consultan visible=true/false', async () => {
  const moderaciones = []; const filtros = [];
  const app = montar('app/admin/resenas.tsx', { api: apiAdmin({ items: [{ ...RESENA, visible: false, motivo_moderacion: 'spam' }], moderaciones, filtros }) });
  await app.asentar();
  assert.match(app.texto(), /spam/);
  await app.boton(/Volver a mostrar/).onPress();
  await app.asentar();
  assert.deepEqual(plano(moderaciones), [['r1', { visible: true }]], 'sin motivo al volver a mostrar');
  await app.boton(/^Ocultas$/).onPress();
  await app.asentar();
  assert.deepEqual(plano(filtros.at(-1)), { visible: 'false' });
});

// ════════════════════════════════════════════════════════════════════════════
// E2E — pantallas reales contra el backend real (base en memoria)
// ════════════════════════════════════════════════════════════════════════════

let backend = null;
let motivoSinBackend = '';
try {
  backend = require(path.resolve(root, '..', 'backend', 'test', 'helpers', 'appLiquidaciones.js'));
} catch (e) {
  motivoSinBackend = `backend no disponible para integración: ${e.message.split('\n')[0]}`;
}
const integracion = (nombre, fn) => test(nombre, { skip: backend ? false : motivoSinBackend }, fn);
if (backend) {
  before(() => backend.iniciar());
  after(() => backend.detener());
}

// Mismo contrato que src/services/api.ts (rutas, params, errores con status y
// responseData como su interceptor), contra los routers reales.
function apiComo(usuario) {
  const llamar = async (metodo, ruta, { body, params } = {}) => {
    const limpio = params ? Object.entries(params).filter(([, v]) => v != null) : [];
    const qs = limpio.length ? '?' + new URLSearchParams(limpio.map(([k, v]) => [k, String(v)])) : '';
    const silenciar = console.log; console.log = () => {};
    let r;
    try { r = await backend.pedir(metodo, '/api' + ruta + qs, { como: usuario, body }); } finally { console.log = silenciar; }
    if (r.status >= 400) throw Object.assign(new Error(r.body?.error || `HTTP ${r.status}`), { status: r.status, responseData: r.body });
    return { data: r.body };
  };
  return {
    negociosAPI: {
      ganancias: periodo => llamar('GET', '/negocios/mi-negocio/ganancias', { params: { periodo } }),
      liquidaciones: params => llamar('GET', '/negocios/mi-negocio/liquidaciones', { params }),
      comprobanteLiquidacion: id => llamar('GET', `/negocios/mi-negocio/liquidaciones/${id}/comprobante`),
    },
    resenasAPI: {
      listarPorNegocio: id => llamar('GET', `/resenas/${id}`),
      crear: body => llamar('POST', '/resenas', { body }),
      restaurante: () => llamar('GET', '/resenas/restaurante'),
      responder: (id, respuesta) => llamar('PATCH', `/resenas/${id}/respuesta`, { body: { respuesta } }),
    },
    pedidosAPI: { listar: () => llamar('GET', '/pedidos') },
    adminAPI: {
      resenas: params => llamar('GET', '/admin/resenas', { params }),
      moderarResena: (id, body) => llamar('PATCH', `/admin/resenas/${id}/moderar`, { body }),
    },
  };
}

integracion('E2E-1: admin genera la liquidación → el restaurante la ve en Ganancias y abre su PDF firmado', async () => {
  backend.reiniciar();
  const mes = backend.mesRelativo(-1);
  backend.fake.tabla('pedidos').push(backend.pedidoPagado({ mes }), backend.pedidoPagado({ mes, neto: 16 }));
  const creada = await backend.pedir('POST', '/api/admin/liquidaciones', { como: backend.IDS.admin, body: { negocio_id: backend.IDS.olaAzul, mes } });
  assert.equal(creada.status, 201, JSON.stringify(creada.body));

  const app = montar('app/restaurante/ganancias.tsx', { api: apiComo(backend.IDS.restaurante) });
  await app.asentar();
  const t = app.texto();
  assert.ok(t.includes(creada.body.liquidacion.folio), t);
  assert.ok(t.includes(utils.etiquetaMes(mes)));
  assert.ok(t.includes('Q23.50'));
  await app.boton(/Ver comprobante/).onPress();
  await app.asentar();
  assert.equal(app.abiertas.length, 1);
  assert.match(app.abiertas[0], /^https:\/\/storage\.test\/bocara-comprobantes\/.+\.pdf\?token=firmado&expires=600$/);
});

integracion('E2E-2: cliente califica desde Pedidos → restaurante responde → ficha pública verificada → admin oculta', async () => {
  backend.reiniciar();
  const p = backend.pedidoPagado({ mes: '2026-09' });
  backend.fake.tabla('pedidos').push(p);

  // Cliente
  const cliente = montar('app/(tabs)/pedidos.tsx', { api: apiComo(backend.IDS.cliente) });
  await cliente.asentar();
  await cliente.botones().find(b => b.texto.includes('Dejar reseña') && !b.texto.includes('Enviar')).onPress();
  walk(cliente.tree).find(n => n.type === 'Input').props.onChangeText('Muy rico todo');
  await cliente.boton(/Enviar reseña/).onPress();
  await cliente.asentar();
  assert.match(cliente.texto(), /Reseña enviada/);
  // Reabrir la pantalla (otro dispositivo): el estado viene del backend
  const otroDispositivo = montar('app/(tabs)/pedidos.tsx', { api: apiComo(backend.IDS.cliente) });
  await otroDispositivo.asentar();
  assert.match(otroDispositivo.texto(), /Reseña enviada/);

  // Restaurante
  const resto = montar('app/restaurante/resenas.tsx', { api: apiComo(backend.IDS.restaurante) });
  await resto.asentar();
  assert.match(resto.texto(), /Muy rico todo/);
  await resto.boton(/Responder/).onPress();
  resto.inputs()[0].props.onChangeText('¡Gracias, vuelve pronto!');
  await resto.boton(/Publicar respuesta/).onPress();
  await resto.asentar();
  assert.match(resto.texto(), /¡Gracias, vuelve pronto!/);

  // Ficha pública: compra verificada + respuesta (lo que pinta app/negocio/[id].tsx)
  const publica = await apiComo(null).resenasAPI.listarPorNegocio(backend.IDS.olaAzul);
  assert.equal(publica.data.length, 1);
  assert.equal(publica.data[0].compra_verificada, true);
  assert.equal(publica.data[0].respuesta_restaurante, '¡Gracias, vuelve pronto!');

  // Admin
  const admin = montar('app/admin/resenas.tsx', { api: apiComo(backend.IDS.admin) });
  await admin.asentar();
  await admin.boton(/Ocultar$/).onPress();
  admin.inputs()[0].props.onChangeText('Prueba de moderación');
  await admin.botones().filter(b => b.texto === 'Ocultar').at(-1).onPress();
  await admin.asentar();
  assert.match(admin.texto(), /Volver a mostrar/);
  assert.equal((await apiComo(null).resenasAPI.listarPorNegocio(backend.IDS.olaAzul)).data.length, 0, 'ya no es pública');
});
