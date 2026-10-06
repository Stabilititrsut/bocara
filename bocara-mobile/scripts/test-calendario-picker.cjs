// Ejecutar: node scripts/test-calendario-picker.cjs. Sin red, Expo ni
// dependencias nuevas. Cubre CAL-1..5 del calendario visual compacto
// (components/CalendarioPicker.tsx), montado de verdad (no un doble), más su
// modo mes (dashboard del restaurante) y los límites minDate/maxDate.
const { test } = require('node:test');
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
  vm.runInNewContext(code, { exports: exportsObj, console, setTimeout, clearTimeout,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

function walk(node) {
  if (!node || typeof node !== 'object') return [];
  const hijos = [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  if (typeof node.type === 'function' && node.type.name !== 'CalendarioPicker') {
    try { hijos.push(...walk(node.type(node.props))); } catch { /* no invocable */ }
  }
  return hijos;
}
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return [node?.props?.children].flat(Infinity).map(textOf).join(' ');
}
const native = {
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'Button',
  Modal: 'Modal', StyleSheet: { create: x => x },
};
const estilo = s => Object.assign({}, ...[s].flat(Infinity).filter(Boolean));

function montarCalendario(propsIniciales) {
  let estados = [];
  let cursor = 0;
  let props = { ...propsIniciales };
  const mod = load('components/CalendarioPicker.tsx', {
    react: {
      ...React,
      useState(inicial) {
        const i = cursor++;
        if (!(i in estados)) estados[i] = typeof inicial === 'function' ? inicial() : inicial;
        const valor = estados[i];
        const setter = (v) => { estados[i] = typeof v === 'function' ? v(estados[i]) : v; render(); };
        return [valor, setter];
      },
    },
    'react-native': native,
    '@/constants/Colors': { Colors: {} },
  });
  const Component = mod.default;

  let tree;
  function render() { cursor = 0; tree = Component(props); }
  render();

  return {
    mod,
    get tree() { return tree; },
    setProps(nuevo) { props = { ...props, ...nuevo }; render(); },
    modal() { return walk(tree).find(n => n.type === 'Modal'); },
    botones() { return walk(tree).filter(n => n.type === 'Button').map(n => ({ texto: textOf(n).trim(), onPress: n.props.onPress, disabled: n.props.disabled, label: n.props.accessibilityLabel })); },
    abrir() { this.botones()[0].onPress(); },
    dia(n) { return this.botones().find(b => b.texto === String(n)); },
  };
}

test('CAL-1: el calendario no es un input libre — sin TextInput, solo botones', () => {
  const src = leer('components/CalendarioPicker.tsx');
  assert.doesNotMatch(src, /TextInput/, 'no debe existir ningún input de texto para la fecha');
  const app = montarCalendario({ label: 'Fecha', value: '', onChange: () => {} });
  assert.ok(!walk(app.tree).some(n => n.type === 'Input'));
});

test('CAL-2: el modal es una tarjeta centrada de ancho acotado (no pantalla completa)', () => {
  const app = montarCalendario({ label: 'Fecha', value: '2026-10-05', onChange: () => {} });
  app.abrir();
  const modal = app.modal();
  assert.equal(modal.props.visible, true);
  assert.equal(modal.props.transparent, true);
  assert.notEqual(modal.props.animationType, 'slide', 'no debe ser una hoja que sube desde abajo');

  const overlay = estilo(modal.props.children.props.style);
  assert.equal(overlay.justifyContent, 'center', 'centrado vertical');
  assert.equal(overlay.alignItems, 'center', 'centrado horizontal');
  assert.ok(overlay.padding >= 12, 'deja margen lateral en pantallas angostas');

  const card = walk(modal).map(n => estilo(n.props?.style)).find(s => s.maxWidth);
  assert.ok(card, 'la tarjeta debe tener maxWidth');
  assert.ok(card.maxWidth >= 320 && card.maxWidth <= 420, `ancho desktop acotado (320–420), es ${card.maxWidth}`);
  assert.equal(card.width, '100%', 'en móvil se adapta al ancho disponible');
  assert.equal(card.height, undefined, 'alto según contenido');
  assert.equal(card.flex, undefined, 'no se estira a toda la pantalla');
  assert.ok(card.borderRadius > 0);
  assert.equal(app.mod.ANCHO_MAX_CALENDARIO, card.maxWidth);
});

test('CAL-3: cuadrícula de 7 columnas (Lu..Do) con días cercanos', () => {
  const app = montarCalendario({ label: 'Fecha', value: '2026-10-05', onChange: () => {} });
  app.abrir();
  const textos = walk(app.modal()).filter(n => n.type === 'Text').map(textOf);
  for (const d of ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do']) assert.ok(textos.includes(d), `falta ${d}`);
  const celdaDia1 = walk(app.modal()).find(n => n.type === 'Button' && textOf(n).trim() === '1');
  const st = estilo(celdaDia1.props.style);
  assert.equal(st.width, '14.2857%', '7 columnas');
  assert.ok(st.height <= 44, `celda compacta (alto fijo), es ${st.height}`);
  assert.equal(st.aspectRatio, undefined, 'sin aspectRatio: el alto no crece con el ancho');
  // Octubre 2026 empieza en jueves → 3 huecos (Lu, Ma, Mi) antes del día 1.
  const grid = walk(app.modal()).find(n => n.type === 'View' && [n.props.children].flat().length > 28);
  const primeros = [grid.props.children].flat(Infinity).slice(0, 4).map(c => textOf(c).trim());
  assert.deepEqual(primeros, ['', '', '', '1']);
});

test('CAL-4: mes anterior y siguiente cambian el mes (y el año al cruzar)', () => {
  const app = montarCalendario({ label: 'Fecha', value: '2026-01-15', onChange: () => {} });
  app.abrir();
  assert.match(textOf(app.modal()), /enero 2026/);
  app.botones().find(b => b.label === 'Mes anterior').onPress();
  assert.match(textOf(app.modal()), /diciembre 2025/);
  app.botones().find(b => b.label === 'Mes siguiente').onPress();
  app.botones().find(b => b.label === 'Mes siguiente').onPress();
  assert.match(textOf(app.modal()), /febrero 2026/);
});

test('CAL-5: elegir un día entrega YYYY-MM-DD, cierra el modal y la UI muestra DD/MM/AAAA', () => {
  let recibido = null;
  const app = montarCalendario({ label: 'Fecha de caducidad', value: '2026-10-05', onChange: (v) => { recibido = v; } });
  assert.equal(app.botones()[0].texto.startsWith('05/10/2026'), true);
  app.abrir();
  app.botones().find(b => b.label === 'Mes siguiente').onPress();
  app.dia(1).onPress();
  assert.equal(recibido, '2026-11-01');
  assert.equal(app.modal().props.visible, false, 'se cierra tras elegir');
  app.setProps({ value: '2026-10-31' });
  assert.match(app.botones()[0].texto, /^31\/10\/2026/);
});

test('fecha vacía muestra el placeholder, no una fecha inventada', () => {
  const app = montarCalendario({ label: 'Fecha', value: '', placeholder: 'Seleccionar fecha', onChange: () => {} });
  assert.ok(app.botones()[0].texto.includes('Seleccionar fecha'));
});

test('Cancelar cierra sin cambiar el valor', () => {
  let recibido = 'sin tocar';
  const app = montarCalendario({ label: 'Fecha', value: '2026-10-05', onChange: (v) => { recibido = v; } });
  app.abrir();
  app.botones().find(b => b.texto === 'Cancelar').onPress();
  assert.equal(app.modal().props.visible, false);
  assert.equal(recibido, 'sin tocar');
});

test('minDate deshabilita los días anteriores (fin >= inicio en la UI)', () => {
  let recibido = 'sin tocar';
  const app = montarCalendario({ label: 'Fecha fin', value: '2026-06-15', minDate: '2026-06-10', onChange: (v) => { recibido = v; } });
  app.abrir();
  const dia5 = app.dia(5);
  assert.equal(dia5.disabled, true);
  dia5.onPress();
  assert.equal(recibido, 'sin tocar');
  assert.equal(app.dia(10).disabled, false, 'el mismo día de inicio sí es válido');
});

test('maxDate deshabilita días futuros (dashboard: no consultar el futuro)', () => {
  const app = montarCalendario({ label: '', value: '2026-10-05', maxDate: '2026-10-05', onChange: () => {} });
  app.abrir();
  assert.equal(app.dia(5).disabled, false);
  assert.equal(app.dia(6).disabled, true);
});

test('modo mes: rejilla de 12 meses, navega por año y entrega YYYY-MM', () => {
  let recibido = null;
  const app = montarCalendario({ label: '', modo: 'mes', value: '2026-10', maxDate: '2026-10', onChange: (v) => { recibido = v; } });
  assert.match(app.botones()[0].texto, /octubre 2026/);
  app.abrir();
  assert.equal(app.botones().find(b => b.label === 'noviembre 2026').disabled, true, 'mes futuro bloqueado');
  app.botones().find(b => b.label === 'Año anterior').onPress();
  app.botones().find(b => b.label === 'marzo 2025').onPress();
  assert.equal(recibido, '2025-03');
});

test('disabled bloquea abrir el calendario', () => {
  const app = montarCalendario({ label: 'x', value: '2026-01-01', disabled: true, onChange: () => {} });
  assert.equal(app.botones()[0].disabled, true);
});
