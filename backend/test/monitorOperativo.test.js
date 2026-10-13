// Monitor operativo en vivo (Admin › Dashboard): minutos en el estado actual,
// semáforo verde/amarillo/rojo y tipo Tiempo Limitado / Promoción.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../services/monitorOperativo');

const AHORA = new Date('2026-10-13T18:00:00.000Z');
const haceMin = (n) => new Date(AHORA.getTime() - n * 60000).toISOString();

test('nivelAlerta: verde < 10, amarillo 10–25, rojo > 25', () => {
  assert.equal(M.nivelAlerta(0), 'verde');
  assert.equal(M.nivelAlerta(9), 'verde');
  assert.equal(M.nivelAlerta(10), 'amarillo');
  assert.equal(M.nivelAlerta(25), 'amarillo');
  assert.equal(M.nivelAlerta(26), 'rojo');
  assert.equal(M.nivelAlerta(null), 'sin_datos');
});

test('marcaDelEstado usa la marca del estado y cae a la anterior del ciclo', () => {
  const base = { pagado_en: 'P', created_at: 'C', aceptado_en: 'A', listo_en: 'L' };
  assert.equal(M.marcaDelEstado({ ...base, estado: 'confirmado' }), 'P');
  assert.equal(M.marcaDelEstado({ ...base, estado: 'en_preparacion' }), 'A');
  assert.equal(M.marcaDelEstado({ ...base, estado: 'listo' }), 'L');
  // Sin migración de marcas: listo → aceptado_en → pagado_en → created_at.
  assert.equal(M.marcaDelEstado({ estado: 'listo', aceptado_en: 'A', created_at: 'C' }), 'A');
  assert.equal(M.marcaDelEstado({ estado: 'en_preparacion', created_at: 'C' }), 'C');
});

test('tipoPedido: snapshot por líneas, mixto, y bolsa para heredados', () => {
  const linea = (t) => ({ tipo_financiero: t });
  assert.equal(M.tipoPedido({ snapshot_financiero: { lineas: [linea('merma')] } }), 'tiempo_limitado');
  assert.equal(M.tipoPedido({ snapshot_financiero: { lineas: [linea('promocion')] } }), 'promocion');
  assert.equal(M.tipoPedido({ snapshot_financiero: { lineas: [linea('merma'), linea('promocion')] } }), 'mixto');
  const bolsas = new Map([['b1', { es_promocion: true }]]);
  assert.equal(M.tipoPedido({ bolsa_id: 'b1' }, bolsas), 'promocion');
  assert.equal(M.tipoPedido({ bolsa_id: 'desconocida' }, bolsas), 'tiempo_limitado');
});

test('construirMonitor filtra estados activos, ordena por atraso y cuenta niveles', () => {
  const neg = { nombre: 'Ola Azul', zona: '10', telefono: '5555-0000' };
  const r = M.construirMonitor([
    { id: 'a', estado: 'confirmado', pagado_en: haceMin(4), codigo_recogida: 'BOC-AAAAA', negocio_id: 'n1', negocios: neg, total: '50.5' },
    { id: 'b', estado: 'en_preparacion', pagado_en: haceMin(60), aceptado_en: haceMin(30), negocio_id: 'n1', negocios: neg },
    { id: 'c', estado: 'listo', listo_en: haceMin(12), negocio_id: 'n2' },
    { id: 'd', estado: 'completado', pagado_en: haceMin(90), negocio_id: 'n2' },
  ], { ahora: AHORA });

  assert.deepEqual(r.pedidos.map((p) => p.id), ['b', 'c', 'a']);
  assert.deepEqual(r.pedidos.map((p) => p.nivel), ['rojo', 'amarillo', 'verde']);
  assert.equal(r.pedidos[0].minutos_en_estado, 30);
  assert.equal(r.pedidos[0].estado_etiqueta, 'En cocina');
  assert.equal(r.pedidos[2].codigo, 'BOC-AAAAA');
  assert.equal(r.pedidos[2].total, 50.5);
  assert.deepEqual(r.pedidos[2].restaurante, { id: 'n1', nombre: 'Ola Azul', zona: '10', telefono: '5555-0000' });
  assert.equal(r.pedidos[1].restaurante.nombre, 'Sin nombre');
  assert.deepEqual(r.conteo, { verde: 1, amarillo: 1, rojo: 1, sin_datos: 0 });
  assert.equal(r.total, 3);
});
