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

test('IMG-UI-2: completada → "Foto mejorada" con opción de usar la original', () => {
  const e = estadoImagenIA({ estado_procesamiento_imagen: 'completada' });
  assert.match(e.etiqueta, /mejorada/);
  assert.equal(e.accion, 'usar-original');
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
