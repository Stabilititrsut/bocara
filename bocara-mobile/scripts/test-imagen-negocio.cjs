// Ejecutar: node scripts/test-imagen-negocio.cjs. Sin red ni dispositivo.
// IA de imágenes para la foto de PERFIL y la PORTADA del restaurante
// (components/ImagenNegocioIA.tsx): mismo pipeline que las publicaciones,
// Guardar bloqueado mientras procesa, "Usar original" solo si el backend dice
// que la original cumple la calidad mínima.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function load(file, mocks = {}, globals = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout, Promise, ...globals,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}
const plano = (o) => JSON.parse(JSON.stringify(o));
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

const P = load('src/utils/procesoImagen.ts');
const ORIGINAL = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/negocios/n1/perfil_1.jpg';
const MEJORADA = 'https://proyecto.supabase.co/storage/v1/object/public/bocara-images/mejoradas/trabajos/t1/1.webp';
const trabajo = (estado, extra = {}) => ({
  id: 't1', uso: 'perfil', estado, original_url: ORIGINAL, mejorada_url: estado === 'lista' ? MEJORADA : null, motivos: [],
  error_codigo: null, error: null, detalle: null, puede_reintentar: estado === 'fallida', puede_usar_original: false, ...extra,
});

// ── Reglas puras ────────────────────────────────────────────────────────────

test('NEG-FE-1: textos — perfil/portada "lista" no habla de publicar; "Usar original" solo en perfil/portada fallida o rechazada', () => {
  assert.equal(P.resumenProceso(trabajo('lista')).titulo, '✅ Imagen optimizada y lista');
  assert.equal(P.resumenProceso(trabajo('lista', { uso: 'portada' })).titulo, '✅ Imagen optimizada y lista');
  assert.equal(P.resumenProceso(trabajo('lista', { uso: 'publicacion' })).titulo, '✅ Imagen optimizada y lista para publicar', 'publicaciones sin cambios');
  for (const estado of ['subida', 'analizando', 'mejorando', 'validando']) {
    const r = P.resumenProceso(trabajo(estado, { puede_usar_original: true }));
    assert.equal(r.puedeUsarOriginal, false, estado);
    assert.equal(r.mensajes[0], 'Procesando imagen con IA, espera un momento…');
  }
  const fallida = P.resumenProceso(trabajo('fallida', { error: 'La versión con IA cambió tu logo.', puede_usar_original: true }));
  assert.equal(fallida.puedeUsarOriginal, true);
  assert.equal(fallida.puedeReintentar, true);
  assert.ok(fallida.mensajes.includes(P.TEXTOS_IMAGEN.originalDisponible));
  const rechazada = P.resumenProceso(trabajo('rechazada', { uso: 'portada', paso_error: 'analizando' }));
  assert.equal(rechazada.puedeUsarOriginal, false);
  assert.deepEqual(plano(rechazada.mensajes), ['Usa otra imagen de tu negocio.']);
  assert.equal(P.resumenProceso(trabajo('fallida', { uso: 'publicacion', puede_usar_original: true })).puedeUsarOriginal, false, 'nunca en publicaciones');
  assert.equal(P.mensajeCorregido(['no_cuadrada', 'borrosa']), 'La IA mejoró encuadre y nitidez.');
  // La IA no conservaba la marca: se usa la original y se explica sin tecnicismos.
  const original = P.resumenProceso(trabajo('lista', { usa_original: true, mejorada_url: ORIGINAL }));
  assert.equal(original.titulo, '✅ Imagen optimizada y lista');
  assert.deepEqual(plano(original.mensajes), ['Conservamos tu imagen original: la versión con IA no la mantenía exactamente igual (letras, logo, colores o elementos).']);
  assert.equal(P.imagenAGuardar(trabajo('lista', { usa_original: true, mejorada_url: ORIGINAL })), ORIGINAL);
  assert.match(P.resumenProceso(trabajo('lista', { uso: 'publicacion', usa_original: true })).mensajes[0], /^Usaremos tu foto original/, 'publicaciones sin cambios');
});

test('NEG-FE-2: Guardar bloqueado mientras sube o procesa, rechazada o fallida; con original solo si cumple', () => {
  const B = P.BLOQUEOS_NEGOCIO;
  assert.equal(P.bloqueoImagenNegocio({ trabajo: null, subiendo: true }), B.subiendo);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: null }), B.sinFoto);
  for (const estado of ['subida', 'analizando', 'mejorando', 'validando']) {
    assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo(estado) }), B.procesando, estado);
    assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo(estado, { puede_usar_original: true }), usarOriginal: true }), B.procesando, `${estado}: tampoco con la original`);
  }
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('mejorando'), errorRed: true }), B.errorRed);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('rechazada') }), B.rechazada);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('fallida') }), B.fallida);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('fallida'), usarOriginal: true }), B.originalNoPermitida);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('fallida', { puede_usar_original: true }), usarOriginal: true }), null);
  assert.equal(P.bloqueoImagenNegocio({ trabajo: trabajo('lista') }), null);
  assert.equal(B.procesando, 'Procesando imagen con IA, espera un momento…');
});

test('NEG-FE-3: vista previa de lo que se guardará — mejorada si está lista, original si se eligió, nada mientras procesa', () => {
  assert.equal(P.imagenAGuardar(trabajo('lista')), MEJORADA);
  assert.equal(P.imagenAGuardar(trabajo('lista'), { usarOriginal: true }), ORIGINAL);
  assert.equal(P.imagenAGuardar(trabajo('fallida', { puede_usar_original: true }), { usarOriginal: true }), ORIGINAL);
  assert.equal(P.imagenAGuardar(trabajo('mejorando')), null);
  assert.equal(P.imagenAGuardar(null), null);
});

// ── Componente real ─────────────────────────────────────────────────────────

const RN = {
  View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner',
  StyleSheet: { create: (x) => x, absoluteFillObject: {} }, Platform: { OS: 'android' },
};
const Estado = load('components/EstadoProcesoImagen.tsx', {
  'react-native': RN, '@/src/utils/procesoImagen': P, '@/constants/Colors': { Colors: {} },
}, { __DEV__: false }).default;
const nodos = (n) => {
  if (!n || typeof n !== 'object') return [];
  // Componentes función (EstadoProcesoImagen) se expanden como en un render real.
  if (typeof n.type === 'function') return nodos(n.type(n.props));
  return [n, ...[n.props?.children].flat(Infinity).flatMap(nodos)];
};
const texto = (n) => {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (!n || typeof n !== 'object') return '';
  if (typeof n.type === 'function') return texto(n.type(n.props));
  return [n.props?.children].flat(Infinity).map(texto).join('');
};

function hooks() {
  const cells = []; let cursor = 0;
  return {
    reset() { cursor = 0; },
    react: { ...React,
      useState(inicial) { const i = cursor++; if (!(i in cells)) cells[i] = { value: inicial }; const c = cells[i]; return [c.value, (v) => { c.value = typeof v === 'function' ? v(c.value) : v; }]; },
      useRef(v) { const i = cursor++; if (!(i in cells)) cells[i] = { value: { current: v } }; return cells[i].value; },
      useEffect() { cursor++; },
    },
  };
}

function montar(tipo, trabajoActual, { guardarFalla = false } = {}) {
  const h = hooks();
  const llamadas = { guardar: [], subir: [], iniciar: [], reintentar: 0, reiniciar: 0, pick: [], guardadas: [], usos: [] };
  const Componente = load('components/ImagenNegocioIA.tsx', {
    react: h.react, 'react-native': RN, 'expo-image': { Image: 'Image' },
    '@/src/services/api': {
      negociosAPI: { guardarImagen: async (id, body) => { llamadas.guardar.push([id, body]); if (guardarFalla) throw Object.assign(new Error('x'), { response: { data: { error: 'Tu imagen original no cumple la calidad mínima.' } } }); return { data: { id, logo_url: MEJORADA } }; } },
      uploadsAPI: { uploadBase64: async (b64, ruta, mime) => { llamadas.subir.push([ruta, mime]); return { data: { publicUrl: `https://s/${ruta}` } }; } },
    },
    '@/hooks/use-trabajo-imagen': {
      useTrabajoImagen: (uso) => {
        llamadas.usos.push(uso);
        return { trabajo: trabajoActual, error: null, errorRed: false, iniciar: (u) => llamadas.iniciar.push(u), reintentar: () => { llamadas.reintentar += 1; }, reiniciar: () => { llamadas.reiniciar += 1; } };
      },
    },
    '@/src/utils/pickImage': { pickImage: async (o) => { llamadas.pick.push(o); return { base64: 'QUJD', mimeType: 'image/jpeg' }; } },
    '@/src/utils/procesoImagen': P,
    '@/components/EstadoProcesoImagen': { __esModule: true, default: Estado },
    '@/constants/Colors': { Colors: {} },
  }).default;
  const props = { tipo, negocioId: 'n1', actualUrl: 'https://s/actual.jpg', onGuardada: (d) => llamadas.guardadas.push(d) };
  const render = () => { h.reset(); return Componente(props); };
  return { render, llamadas };
}
const boton = (arbol, testID) => nodos(arbol).find((n) => n.type === 'Button' && n.props.testID === testID);
const botonTexto = (arbol, t) => nodos(arbol).find((n) => n.type === 'Button' && texto(n) === t);

test('NEG-FE-4: mientras la IA procesa, Guardar está deshabilitado, explica el motivo y no llama a la API', async () => {
  for (const tipo of ['perfil', 'portada']) {
    for (const estado of ['subida', 'analizando', 'mejorando', 'validando']) {
      const c = montar(tipo, trabajo(estado, { uso: tipo }));
      const arbol = c.render();
      const g = boton(arbol, `guardar-${tipo}`);
      assert.equal(g.props.disabled, true, `${tipo}/${estado}`);
      assert.match(texto(arbol), /Procesando imagen con IA, espera un momento…/);
      assert.match(texto(arbol), /Analizando imagen/);
      assert.match(texto(arbol), /Mejorando tamaño, calidad y presentación con IA/);
      assert.match(texto(arbol), /Validando resultado/);
      await g.props.onPress(); await tick();
      assert.equal(c.llamadas.guardar.length, 0, `${tipo}/${estado}: no se guardó`);
      assert.deepEqual(c.llamadas.usos.slice(0, 1), [tipo], 'el trabajo se crea con el uso correcto');
    }
  }
});

test('NEG-FE-5: imagen lista → vista previa de la mejorada y Guardar envía el trabajo; el padre recibe el negocio actualizado', async () => {
  const c = montar('perfil', trabajo('lista', { problemas_corregidos: ['borrosa'] }));
  const arbol = c.render();
  assert.match(texto(arbol), /✅ Imagen optimizada y lista/);
  assert.match(texto(arbol), /La IA mejoró nitidez\./);
  assert.ok(nodos(arbol).some((n) => n.type === 'Image' && n.props.source?.uri === MEJORADA), 'vista previa = mejorada');
  const g = boton(arbol, 'guardar-perfil');
  assert.equal(g.props.disabled, false);
  assert.equal(texto(g), 'Guardar foto de perfil');
  await g.props.onPress(); await tick();
  assert.deepEqual(plano(c.llamadas.guardar), [['n1', { tipo: 'perfil', imagen_trabajo_id: 't1', usar_original: false }]]);
  assert.equal(c.llamadas.guardadas[0].logo_url, MEJORADA);
  assert.equal(c.llamadas.reiniciar, 1, 'tras guardar se limpia el proceso');
});

test('NEG-FE-6: falla → Reintentar, Cambiar foto y "Usar original" solo si la original cumple; guardar con la original la manda marcada', async () => {
  const sinOriginal = montar('portada', trabajo('fallida', { uso: 'portada', error: 'No se pudo mejorar.' }));
  const a1 = sinOriginal.render();
  assert.equal(boton(a1, 'usar-original'), undefined);
  assert.ok(botonTexto(a1, 'Reintentar') && botonTexto(a1, 'Cambiar foto'));
  assert.equal(boton(a1, 'guardar-portada').props.disabled, true);

  const c = montar('portada', trabajo('fallida', { uso: 'portada', error: 'La versión con IA cambió tu logo.', puede_usar_original: true }));
  let arbol = c.render();
  assert.match(texto(arbol), /también puedes usarla tal cual/);
  assert.equal(boton(arbol, 'guardar-portada').props.disabled, true, 'sin elegir nada, sigue bloqueado');
  botonTexto(arbol, 'Reintentar').props.onPress();
  assert.equal(c.llamadas.reintentar, 1);
  boton(arbol, 'usar-original').props.onPress();
  arbol = c.render();
  const g = boton(arbol, 'guardar-portada');
  assert.equal(g.props.disabled, false);
  assert.equal(texto(g), 'Guardar portada (original)');
  assert.match(texto(arbol), /Se guardará tu imagen original, tal como la subiste\./);
  assert.ok(nodos(arbol).some((n) => n.type === 'Image' && n.props.source?.uri === ORIGINAL));
  await g.props.onPress(); await tick();
  assert.deepEqual(plano(c.llamadas.guardar), [['n1', { tipo: 'portada', imagen_trabajo_id: 't1', usar_original: true }]]);
});

test('NEG-FE-7: si el backend rechaza al guardar, se muestra su motivo y no se avisa éxito', async () => {
  const c = montar('perfil', trabajo('lista'), { guardarFalla: true });
  await boton(c.render(), 'guardar-perfil').props.onPress(); await tick();
  assert.match(texto(c.render()), /Tu imagen original no cumple la calidad mínima\./);
  assert.equal(c.llamadas.guardadas.length, 0);
});

test('NEG-FE-8: elegir foto → recorte sugerido (1:1 perfil, 3:2 portada), sube a su carpeta y arranca la IA', async () => {
  for (const [tipo, aspect] of [['perfil', [1, 1]], ['portada', [3, 2]]]) {
    const c = montar(tipo, null);
    const arbol = c.render();
    assert.equal(boton(arbol, `guardar-${tipo}`), undefined, 'sin foto nueva no hay Guardar');
    botonTexto(arbol, '📷 Cambiar foto').props.onPress(); await tick();
    assert.deepEqual(plano(c.llamadas.pick), [{ aspect }]);
    assert.match(c.llamadas.subir[0][0], new RegExp(`^negocios/n1/${tipo}_\\d+\\.jpeg$`));
    assert.deepEqual(c.llamadas.iniciar, [`https://s/${c.llamadas.subir[0][0]}`]);
  }
});

test('NEG-FE-9: cableado — la API manda el uso; el perfil usa los dos espacios con IA y ya no sube la portada por PUT directo', () => {
  const api = read('src/services/api.ts');
  assert.match(api, /crearTrabajo: \(imagen_url: string, uso: UsoImagen = 'publicacion'\) =>/);
  assert.match(api, /\{ imagen_url, uso \}/);
  assert.match(api, /api\.put\(`\/negocios\/\$\{id\}\/imagen`, data\)/);
  assert.match(read('hooks/use-trabajo-imagen.ts'), /crear: \(url: string\) => imagenesAPI\.crearTrabajo\(url, uso\)/);
  const perfil = read('app/restaurante/perfil.tsx');
  assert.match(perfil, /<ImagenNegocioIA\s+tipo="portada"/);
  assert.match(perfil, /<ImagenNegocioIA\s+tipo="perfil"/);
  assert.doesNotMatch(perfil, /negociosAPI\.actualizar\([^)]*imagen_url/, 'la portada ya no se guarda sin IA');
  assert.doesNotMatch(read('components/ImagenNegocioIA.tsx'), /OPENAI_API_KEY|sk-[A-Za-z0-9]{20,}/);
});
