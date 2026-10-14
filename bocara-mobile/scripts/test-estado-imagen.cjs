// Ejecutar: node scripts/test-estado-imagen.cjs. Sin red ni dispositivo.
// Render según estado de la mejora automática de fotos (pipeline de imágenes).
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
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj }, { filename: file });
  return exportsObj;
}
const { estadoImagenIA, hayMejoraEnCurso, urlImagenVisible } = load('src/utils/estadoImagen.ts');

test('IMG-UI-1: pendiente / procesando → "Mejorando tu foto…", sin acción, marca en curso', () => {
  for (const estado of ['pendiente', 'procesando']) {
    const e = estadoImagenIA({ estado_procesamiento_imagen: estado });
    assert.match(e.etiqueta, /Mejorando tu foto/);
    assert.equal(e.accion, null);
    assert.equal(e.enCurso, true);
  }
});

test('IMG-UI-2: completada con IA (OpenAI o Replicate) → "Foto mejorada con IA · se muestra la mejorada" + usar original + comparar', () => {
  for (const proveedor of ['openai', 'replicate']) {
    const e = estadoImagenIA({ estado_procesamiento_imagen: 'completada', proveedor_imagen_ia: proveedor, imagen_original_url: 'o', imagen_mejorada_url: 'm' });
    assert.equal(e.etiqueta, '✨ Foto mejorada con IA · se muestra la mejorada', proveedor);
    assert.equal(e.accion, 'usar-original');
    assert.equal(e.puedeComparar, true);
  }
});

test('IMG-UI-2b: el ajuste técnico local NUNCA se presenta como IA', () => {
  const e = estadoImagenIA({ estado_procesamiento_imagen: 'completada', proveedor_imagen_ia: 'local' });
  assert.equal(e.etiqueta, '✨ Foto ajustada automáticamente · se muestra la ajustada');
  assert.doesNotMatch(e.etiqueta, /\bIA\b/);
});

test('IMG-UI-2c: "Comparar" solo cuando existen original y mejorada', () => {
  assert.equal(estadoImagenIA({ estado_procesamiento_imagen: 'descartada', imagen_original_url: 'o', imagen_mejorada_url: 'm' }).puedeComparar, true);
  assert.equal(estadoImagenIA({ estado_procesamiento_imagen: 'fallida', imagen_original_url: 'o' }).puedeComparar, false);
  const comp = read('components/EstadoImagenIA.tsx');
  assert.match(comp, /estado\.puedeComparar \? \(/);
  assert.match(comp, /fila\.imagen_original_url/);
  assert.match(comp, /fila\.imagen_mejorada_url/);
});

test('IMG-UI-3: fallida → avisa que se muestra la original y ofrece reintentar', () => {
  const e = estadoImagenIA({ estado_procesamiento_imagen: 'fallida' });
  assert.match(e.etiqueta, /original/);
  assert.equal(e.accion, 'reintentar');
  assert.equal(e.textoAccion, 'Reintentar');
});

test('IMG-UI-4: descartada → original visible; "usar mejorada" solo si la mejorada existe', () => {
  assert.equal(estadoImagenIA({ estado_procesamiento_imagen: 'descartada', imagen_mejorada_url: 'm' }).accion, 'usar-mejorada');
  assert.equal(estadoImagenIA({ estado_procesamiento_imagen: 'descartada' }).accion, null);
});

test('IMG-UI-5: fotos anteriores al pipeline (estado null) no muestran nada nuevo', () => {
  for (const f of [{}, null, undefined, { estado_procesamiento_imagen: null }, { estado_procesamiento_imagen: 'raro' }]) {
    const e = estadoImagenIA(f);
    assert.equal(e.clave, 'sin_procesar');
    assert.equal(e.etiqueta, '');
    assert.equal(e.accion, null);
  }
});

test('IMG-UI-6: la imagen visible nunca se pierde (imagen_url o, si faltara, la original)', () => {
  assert.equal(urlImagenVisible({ imagen_url: 'm', imagen_original_url: 'o' }), 'm');
  assert.equal(urlImagenVisible({ imagen_url: '', imagen_original_url: 'o' }), 'o');
  assert.equal(urlImagenVisible({ imagen_url: null, imagen_original_url: null }), null);
});

test('IMG-UI-7: refresco automático solo mientras haya una mejora en curso', () => {
  assert.equal(hayMejoraEnCurso([{ estado_procesamiento_imagen: 'completada' }, { estado_procesamiento_imagen: 'pendiente' }]), true);
  assert.equal(hayMejoraEnCurso([{ estado_procesamiento_imagen: 'completada' }, {}]), false);
  assert.equal(hayMejoraEnCurso(null), false);
});

test('IMG-UI-8: panel del restaurante muestra el estado en publicaciones y en la foto del negocio', () => {
  const bolsas = read('app/restaurante/bolsas.tsx');
  assert.match(bolsas, /<EstadoImagenIA tipo="publicacion" id=\{b\.id\} fila=\{b\} onCambio=\{cargar\} \/>/);
  assert.match(bolsas, /if \(!mejoraEnCurso\) return undefined;\s*const t = setInterval\(cargar, 10000\);/);
  const perfil = read('app/restaurante/perfil.tsx');
  assert.match(perfil, /<EstadoImagenIA tipo="negocio" id=\{negocio\.id\} fila=\{negocio\} onCambio=\{cargarNegocio\} \/>/);
  const api = read('src/services/api.ts');
  assert.match(api, /api\.post\(`\/imagenes\/\$\{tipo\}\/\$\{id\}\/\$\{accion\}`\)/);
});

// ── Render real del componente (harness de hooks, sin dispositivo) ──────────
const React = require('react');
function montarEstado(fila, { accionFalla = false } = {}) {
  const llamadas = { accion: [], cambios: 0 };
  const estados = [];
  let cursor = 0;
  const reactMock = { ...React, useState(inicial) {
    const i = cursor++;
    if (!(i in estados)) estados[i] = inicial;
    return [estados[i], (v) => { estados[i] = typeof v === 'function' ? v(estados[i]) : v; }];
  } };
  const exportsObj = {};
  const code = ts.transpileModule(read('components/EstadoImagenIA.tsx'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const util = load('src/utils/estadoImagen.ts');
  vm.runInNewContext(code, { exports: exportsObj, console, require(nombre) {
    if (nombre === 'react') return reactMock;
    if (nombre === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (nombre === 'react-native') return { View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', Modal: 'Modal', StyleSheet: { create: (x) => x } };
    if (nombre === 'expo-image') return { Image: 'Image' };
    if (nombre === '@/src/services/api') return { imagenesAPI: { accion: async (...a) => { llamadas.accion.push(a); if (accionFalla) throw new Error('Sin conexión'); return {}; } } };
    if (nombre === '@/src/utils/estadoImagen') return util;
    if (nombre === '@/constants/Colors') return { Colors: {} };
    throw new Error('Import sin double: ' + nombre);
  } }, { filename: 'EstadoImagenIA.tsx' });
  const Componente = exportsObj.default;
  const render = () => { cursor = 0; return Componente({ tipo: 'publicacion', id: 'b1', fila, onCambio: () => { llamadas.cambios += 1; } }); };
  return { render, llamadas };
}
const nodos = (n) => (!n || typeof n !== 'object') ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodos)];
const texto = (n) => (typeof n === 'string' || typeof n === 'number') ? String(n) : (!n || typeof n !== 'object') ? '' : [n.props?.children].flat(Infinity).map(texto).join('');
// Lo visible: un Modal cerrado no aporta botones.
const visibles = (n) => (!n || typeof n !== 'object') ? [] : n.type === 'Modal' && !n.props.visible ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(visibles)];
const botones = (arbol) => visibles(arbol).filter((n) => n.type === 'Button');
const boton = (arbol, etiqueta) => botones(arbol).find((b) => texto(b).includes(etiqueta));

test('IMG-UI-9: render por estado — procesando muestra spinner y ningún botón', () => {
  const arbol = montarEstado({ estado_procesamiento_imagen: 'procesando' }).render();
  assert.match(texto(arbol), /Mejorando tu foto/);
  assert.ok(nodos(arbol).some((n) => n.type === 'Spinner'));
  assert.equal(botones(arbol).length, 0);
});

test('IMG-UI-10: fallida → "Reintentar" llama a la API correcta y refresca la lista', async () => {
  const c = montarEstado({ estado_procesamiento_imagen: 'fallida', imagen_original_url: 'o' });
  const arbol = c.render();
  assert.match(texto(arbol), /No se pudo mejorar, se muestra tu original/);
  await boton(arbol, 'Reintentar').props.onPress();
  assert.deepEqual(c.llamadas.accion, [['publicacion', 'b1', 'reintentar']]);
  assert.equal(c.llamadas.cambios, 1);
});

test('IMG-UI-11: completada → "Usar mi original" y "Comparar" (modal con original y mejorada)', async () => {
  const c = montarEstado({ estado_procesamiento_imagen: 'completada', proveedor_imagen_ia: 'openai', imagen_original_url: 'https://o.jpg', imagen_mejorada_url: 'https://m.webp' });
  let arbol = c.render();
  assert.match(texto(arbol), /mejorada con IA/);
  await boton(arbol, 'Usar mi original').props.onPress();
  assert.deepEqual(c.llamadas.accion[0], ['publicacion', 'b1', 'usar-original']);
  boton(arbol, 'Comparar').props.onPress();
  arbol = c.render();
  const modal = nodos(arbol).find((n) => n.type === 'Modal');
  assert.equal(modal.props.visible, true);
  const fuentes = nodos(modal).filter((n) => n.type === 'Image').map((n) => n.props.source.uri);
  assert.deepEqual(fuentes, ['https://o.jpg', 'https://m.webp']);
});

test('IMG-UI-12: descartada → "Usar mejorada"; error de red se muestra sin romper', async () => {
  const c = montarEstado({ estado_procesamiento_imagen: 'descartada', imagen_original_url: 'o', imagen_mejorada_url: 'm' }, { accionFalla: true });
  let arbol = c.render();
  assert.match(texto(arbol), /Se muestra tu foto original/);
  await boton(arbol, 'Usar mejorada').props.onPress();
  arbol = c.render();
  assert.match(texto(arbol), /Sin conexión/);
  assert.equal(c.llamadas.cambios, 0, 'no refresca si la acción falló');
});

test('IMG-UI-13: foto sin procesar (dato previo al pipeline) → el componente no renderiza nada', () => {
  assert.equal(montarEstado({}).render(), null);
});
