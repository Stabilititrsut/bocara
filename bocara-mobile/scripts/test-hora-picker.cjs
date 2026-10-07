// Ejecutar: node scripts/test-hora-picker.cjs. Sin red, Expo ni dependencias
// nuevas. Cubre TIME-1..6 del picker de hora en formato rueda (12h UI / 24h
// backend): components/HoraPicker.tsx, montado de verdad (no un doble).
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
  const source = leer(file);
  const code = ts.transpileModule(source, { compilerOptions: {
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

// A diferencia de un render real, aquí los elementos son descriptores planos
// {type, props} sin reconciliador — si `type` es una función (como el
// subcomponente Columna), hay que LLAMARLA con sus props para obtener lo que
// de verdad devuelve y poder seguir bajando por sus hijos (Columna no usa
// hooks propios, así que llamarla directamente es seguro).
function walk(node) {
  if (!node || typeof node !== 'object') return [];
  const hijos = [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  if (typeof node.type === 'function' && node.type.name !== 'HoraPicker') {
    try { hijos.push(...walk(node.type(node.props))); } catch { /* no es un componente puro invocable */ }
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

// hooks() real (useState funcional de verdad, no un doble forzado): el picker
// tiene su propio estado interno (hora/minuto/am-pm/abierto) que hay que
// poder mutar entre renders para simular toques reales.
function montarHoraPicker(propsIniciales) {
  let estados = [];
  let cursor = 0;
  let props = { ...propsIniciales };
  const Component = load('components/HoraPicker.tsx', {
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
  }).default;

  let tree;
  function render() { cursor = 0; tree = Component(props); }
  render();

  return {
    get tree() { return tree; },
    setProps(nuevo) { props = { ...props, ...nuevo }; render(); },
    botones() { return walk(tree).filter(n => n.type === 'Button').map(n => ({ texto: textOf(n).trim(), onPress: n.props.onPress, disabled: n.props.disabled })); },
  };
}

test('TIME-1/TIME-2: el picker no tiene ningún TextInput — solo botones (selector visual)', () => {
  const src = leer('components/HoraPicker.tsx');
  assert.doesNotMatch(src, /TextInput/, 'no debe existir ningún input de texto para la hora');
  assert.match(src, /ScrollView/, 'debe usar columnas tipo rueda (ScrollView)');
});

test('TIME-2: abrir el picker muestra tres columnas — hora, minuto y am/pm', () => {
  const app = montarHoraPicker({ label: 'Hora inicio', value: '18:00', onChange: () => {} });
  const abrirBtn = app.botones().find(b => b.texto.includes('pm') || b.texto.includes('am'));
  assert.ok(abrirBtn, 'botón cerrado debe mostrar la hora en 12h');
  abrirBtn.onPress();
  const textos = app.botones().map(b => b.texto);
  // Columna de horas 1-12
  assert.ok(textos.includes('11'), 'columna de horas (1-12)');
  // Columna de minutos con cero a la izquierda
  assert.ok(textos.includes('00'), 'columna de minutos');
  // Columna AM/PM
  assert.ok(textos.includes('am') && textos.includes('pm'), 'columna am/pm');
});

test('TIME-3: seleccionar 11:00 pm y confirmar entrega "23:00" (formato canónico 24h)', () => {
  let recibido = null;
  const app = montarHoraPicker({ label: 'Hora fin', value: '18:00', onChange: (v) => { recibido = v; } });
  app.botones().find(b => /pm|am/.test(b.texto)).onPress(); // abrir
  app.botones().find(b => b.texto === '11').onPress();      // hora = 11
  app.botones().find(b => b.texto === '00').onPress();      // minuto = 00
  app.botones().find(b => b.texto === 'pm').onPress();      // pm
  app.botones().find(b => b.texto === 'Listo').onPress();   // confirmar
  assert.equal(recibido, '23:00');
});

test('TIME-4: "18:00:00" (columna time de la BD) se muestra correctamente como 6:00 pm', () => {
  const app = montarHoraPicker({ label: 'Hora inicio', value: '18:00:00', onChange: () => {} });
  const textoBoton = app.botones().find(b => /pm|am/.test(b.texto))?.texto;
  assert.equal(textoBoton.includes('6:00 pm'), true, textoBoton);
});

test('TIME-5: editar sin cambiar la hora — abrir y confirmar devuelve exactamente el mismo valor canónico', () => {
  let recibido = null;
  const app = montarHoraPicker({ label: 'Hora inicio', value: '08:05', onChange: (v) => { recibido = v; } });
  app.botones().find(b => /pm|am/.test(b.texto)).onPress();
  app.botones().find(b => b.texto === 'Listo').onPress();
  assert.equal(recibido, '08:05');
});

test('mediodía y medianoche: 12:00 pm = 12:00, 12:00 am = 00:00', () => {
  let recibido;
  const mediodia = montarHoraPicker({ label: 'x', value: '12:00', onChange: (v) => { recibido = v; } });
  assert.equal(mediodia.botones().find(b => /pm|am/.test(b.texto)).texto.includes('12:00 pm'), true);

  const medianoche = montarHoraPicker({ label: 'x', value: '00:00', onChange: (v) => { recibido = v; } });
  assert.equal(medianoche.botones().find(b => /pm|am/.test(b.texto)).texto.includes('12:00 am'), true);
  medianoche.botones().find(b => /pm|am/.test(b.texto)).onPress();
  medianoche.botones().find(b => b.texto === 'Listo').onPress();
  assert.equal(recibido, '00:00', 'confirmar sin tocar nada conserva 12:00 am = 00:00');
});

test('TIME-1: sin selección, el botón muestra el placeholder, no una hora inventada', () => {
  const app = montarHoraPicker({ label: 'Hora inicio', value: '', placeholder: 'Seleccionar hora', onChange: () => {} });
  assert.ok(app.botones().some(b => b.texto.includes('Seleccionar hora')));
});

test('disabled bloquea abrir el picker (no hay forma de tocar una hora)', () => {
  let abierto = false;
  const app = montarHoraPicker({ label: 'x', value: '18:00', disabled: true, onChange: () => {} });
  const btn = app.botones().find(b => /pm/.test(b.texto));
  assert.equal(btn.disabled, true);
});

test('TIME-6: Promoción y Tiempo limitado usan el mismo componente HoraPicker en restaurante/bolsas.tsx', () => {
  const src = leer('app/restaurante/bolsas.tsx');
  const ocurrencias = src.match(/<HoraPicker/g) || [];
  assert.equal(ocurrencias.length, 2, 'Hora inicio y Hora fin, compartidas por Promoción y Tiempo limitado en el mismo formulario');
  assert.doesNotMatch(src, /hora_recogida_inicio.*Field|Field.*hora_recogida_inicio/, 'ya no debe quedar un <Field> de texto libre para la hora');
});
