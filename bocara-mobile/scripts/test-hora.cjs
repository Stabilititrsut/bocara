// Ejecutar: node scripts/test-hora.cjs. Sin red, Expo ni dependencias nuevas.
//
// Cubre normalizarHora() (src/utils/hora.ts), el hotfix de producción de main
// (64dcd395) que convierte horas escritas a mano ("8:00", "8:00 pm") al formato
// estricto HH:MM de 24h que exige el backend. Sin él, "8:00" se rechazaba como
// "Hora de inicio inválida" aunque la hora fuera correcta.
//
// Además verifica que app/restaurante/bolsas.tsx y cupones.tsx sigan llamando
// a normalizarHora() antes de armar el payload y envíen el valor normalizado,
// para que un merge futuro no vuelva a perder el hotfix sin que falle QA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(file) {
  const exportsObj = {};
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: exportsObj }, { filename: file });
  return exportsObj;
}

const { normalizarHora } = load('src/utils/hora.ts');

const VALIDOS = [
  ['8:00', '08:00'],
  ['08:00', '08:00'],
  ['8:00 pm', '20:00'],
  ['20:00', '20:00'],
  ['8', '08:00'],
  ['20:5', '20:05'],
  ['  8:30  ', '08:30'],
  ['8:00pm', '20:00'],
  ['8:00 PM', '20:00'],
  ['8:00 am', '08:00'],
  ['12:00 am', '00:00'],
  ['12:30 pm', '12:30'],
  ['0:00', '00:00'],
  ['23:59', '23:59'],
];

for (const [entrada, esperado] of VALIDOS) {
  test(`normalizarHora(${JSON.stringify(entrada)}) → ${esperado}`, () => {
    assert.equal(normalizarHora(entrada), esperado);
  });
}

const INVALIDOS = ['', '24:00', '25:00', '8:60', '13:00 pm', '0:00 am', 'abc', '8:00 xm', '8.00', '-1:00', '08:00:00'];

for (const entrada of INVALIDOS) {
  test(`normalizarHora(${JSON.stringify(entrada)}) → null (inválida)`, () => {
    assert.equal(normalizarHora(entrada), null);
  });
}

test('normalizarHora tolera valores vacíos/nulos sin lanzar', () => {
  assert.equal(normalizarHora(undefined), null);
  assert.equal(normalizarHora(null), null);
});

for (const pantalla of ['app/restaurante/bolsas.tsx', 'app/restaurante/cupones.tsx']) {
  test(`${pantalla} normaliza las horas antes de armar el payload y envía el valor normalizado`, () => {
    const src = fs.readFileSync(path.join(root, pantalla), 'utf8');
    assert.match(src, /import \{ normalizarHora \} from '@\/src\/utils\/hora';/);
    const iInicio = src.indexOf('normalizarHora(form.hora_recogida_inicio)');
    const iFin = src.indexOf('normalizarHora(form.hora_recogida_fin)');
    const iPayload = src.indexOf('const payload');
    assert.ok(iInicio > 0 && iFin > 0, 'faltan las llamadas a normalizarHora');
    assert.ok(iPayload > iInicio && iPayload > iFin, 'normalizarHora debe ejecutarse antes de construir el payload');
    assert.match(src, /hora_recogida_inicio: horaInicio,/);
    assert.match(src, /hora_recogida_fin: horaFin,/);
    assert.doesNotMatch(src, /hora_recogida_(inicio|fin): form\.hora_recogida_(inicio|fin),/,
      'el payload no debe enviar la hora cruda del formulario');
  });
}
