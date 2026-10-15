// Ejecutar: node scripts/test-avisos-cliente.cjs. Sin red, Expo ni dispositivo.
// Cubre la detección de avisos del cliente (src/utils/avisosCliente.ts): cada
// cambio de fase del pedido suena una sola vez, lo previo al abrir la app no
// suena, y las ofertas cercanas respetan radio y enfriamiento.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function load(file, mocks = {}) {
  const exportsObj = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports: exportsObj, console,
    require(name) {
      if (name in mocks) return mocks[name];
      throw new Error(`Import sin double: ${name}`);
    },
  }, { filename: file });
  return exportsObj;
}

const sonidos = [];
const A = load('src/utils/avisosCliente.ts', {
  'react-native': { Platform: { OS: 'web' }, Vibration: { vibrate() {} } },
  './alertaPedido': { sonarAvisoWeb: async () => { sonidos.push('beep'); }, PATRON_VIBRACION: [0] },
  '../services/pushToken': { pushTokenActual: () => null },
});

// Los objetos salen de otro contexto vm: se aplanan antes de comparar.
const plano = (x) => JSON.parse(JSON.stringify(x));

const AHORA = Date.parse('2026-10-14T18:00:00Z');
const hace = (min) => new Date(AHORA - min * 60000).toISOString();
const aviso = (id, tipo, extra = {}) => ({ id, tipo, titulo: tipo, cuerpo: '', leida: false, created_at: hace(1), ...extra });

test('primera carga: nada suena (lo que ya estaba no es nuevo)', () => {
  const r = A.detectarAvisosNuevos(null, [aviso('1', 'pedido_listo')], AHORA);
  assert.equal(r.nuevos.length, 0);
  assert.ok(r.vistos.has('1'));
});

test('cada fase nueva suena una vez: confirmado, preparación, listo, entregado, cancelado', () => {
  let vistos = A.detectarAvisosNuevos(null, [], AHORA).vistos;
  const fases = ['pago_confirmado', 'pedido_en_preparacion', 'pedido_listo', 'bolsa_recogida', 'pedido_cancelado'];
  const acumuladas = [];
  fases.forEach((tipo, i) => {
    acumuladas.push(aviso(String(i), tipo));
    const r = A.detectarAvisosNuevos(vistos, acumuladas, AHORA);
    assert.deepEqual(r.nuevos.map((n) => n.tipo), [tipo], tipo);
    vistos = r.vistos;
  });
  // Un segundo poll sin cambios no vuelve a sonar.
  assert.equal(A.detectarAvisosNuevos(vistos, acumuladas, AHORA).nuevos.length, 0);
});

test('no suenan: leídas, viejas (> 30 min) ni tipos ajenos al cliente', () => {
  const vistos = new Set();
  const r = A.detectarAvisosNuevos(vistos, [
    aviso('a', 'pedido_listo', { leida: true }),
    aviso('b', 'pedido_listo', { created_at: hace(45) }),
    aviso('c', 'liquidacion'),
    aviso('d', 'nueva_bolsa'),
  ], AHORA);
  assert.deepEqual(r.nuevos.map((n) => n.id), ['d']);
});

test('ofertas cercanas: solo dentro del radio, una por restaurante, Tiempo limitado gana y hay enfriamiento', () => {
  const bolsas = [
    { id: 'p1', negocio_id: 'n1', tipo: 'cupon', distancia_km: 0.4, negocios: { nombre: 'Ola Azul' } },
    { id: 't1', negocio_id: 'n1', tipo: 'bolsa', distancia_km: 0.4, negocios: { nombre: 'Ola Azul' } },
    { id: 'p2', negocio_id: 'n2', tipo: 'cupon', distancia_km: 1.5, negocios: { nombre: 'Cafecito' } },
    { id: 'p3', negocio_id: 'n3', tipo: 'cupon', distancia_km: 5, negocios: { nombre: 'Lejos' } },
    { id: 'p4', negocio_id: 'n4', tipo: 'cupon', distancia_km: null },
    { id: 'p5', negocio_id: 'n5', tipo: 'cupon', distancia_km: 0.1, cantidad_disponible: 0 },
  ];
  const r = A.detectarOfertasCercanas(bolsas, {}, AHORA);
  assert.deepEqual(plano(r.map((o) => [o.negocioId, o.tipo, o.bolsaId])), [['n1', 'tiempo_limitado', 't1'], ['n2', 'promocion', 'p2']]);
  assert.match(A.textoOfertaCercana(r[0]).cuerpo, /400 m/);

  const enfriado = A.detectarOfertasCercanas(bolsas, { n1: AHORA - 60 * 60 * 1000 }, AHORA);
  assert.deepEqual(plano(enfriado.map((o) => o.negocioId)), ['n2']);
  const vencido = A.detectarOfertasCercanas(bolsas, { n1: AHORA - 13 * 60 * 60 * 1000 }, AHORA);
  assert.deepEqual(plano(vencido.map((o) => o.negocioId)), ['n1', 'n2']);
});

test('web: emitirAvisoCliente suena con Web Audio', async () => {
  sonidos.length = 0;
  await A.emitirAvisoCliente({ titulo: 't', cuerpo: 'c' });
  assert.deepEqual(sonidos, ['beep']);
});
