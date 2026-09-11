const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ahoraGuatemala, hoyGuatemala, estaVencida, filtrarVigentes,
  validarHorarioFuturo, finVentanaRecogida, MENSAJE_HORARIO_VENCIDO,
} = require('../services/horarioGuatemala');

// Guatemala es UTC-6 todo el año (sin horario de verano).
test('la hora de Guatemala va 6 horas detrás de UTC', () => {
  const utc = new Date('2026-09-10T02:00:00Z');
  assert.deepEqual(ahoraGuatemala(utc), { fecha: '2026-09-09', hora: '20:00:00' });
});

test('hoyGuatemala no adelanta el día como lo hacía el cálculo en UTC', () => {
  // 20:00 del 9 en Guatemala; en UTC ya es el día 10 — antes esto ocultaba
  // publicaciones válidas del día 9 desde las 18:00 locales.
  assert.equal(hoyGuatemala(new Date('2026-09-10T02:00:00Z')), '2026-09-09');
});

const AHORA = { fecha: '2026-09-10', hora: '21:00:00' };

test('publicación con la ventana ya cerrada está vencida', () => {
  assert.equal(estaVencida({ hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' }, AHORA), true);
});

test('publicación dentro de la ventana no está vencida', () => {
  const ahora = { fecha: '2026-09-10', hora: '19:00:00' };
  assert.equal(estaVencida({ hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' }, ahora), false);
});

test('el instante exacto del cierre ya cuenta como vencida', () => {
  const ahora = { fecha: '2026-09-10', hora: '20:00:00' };
  assert.equal(estaVencida({ hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' }, ahora), true);
});

test('ventana que cruza la medianoche expira al día siguiente', () => {
  const bolsa = { hora_recogida_inicio: '22:00', hora_recogida_fin: '02:00', fecha_caducidad: '2026-09-10' };
  assert.deepEqual(finVentanaRecogida(bolsa, AHORA), { fecha: '2026-09-11', hora: '02:00:00' });
  // 23:00 del día 10: dentro de la ventana
  assert.equal(estaVencida(bolsa, { fecha: '2026-09-10', hora: '23:00:00' }), false);
  // 01:00 del día 11: sigue dentro
  assert.equal(estaVencida(bolsa, { fecha: '2026-09-11', hora: '01:00:00' }), false);
  // 03:00 del día 11: ya cerró
  assert.equal(estaVencida(bolsa, { fecha: '2026-09-11', hora: '03:00:00' }), true);
});

test('fecha_caducidad anterior a hoy está vencida', () => {
  assert.equal(estaVencida({
    hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00', fecha_caducidad: '2026-09-09',
  }, AHORA), true);
});

test('fecha_caducidad futura no está vencida aunque la hora de hoy ya pasó', () => {
  assert.equal(estaVencida({
    hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00', fecha_caducidad: '2026-09-12',
  }, AHORA), false);
});

test('sin hora de fin solo manda la fecha de caducidad', () => {
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-09' }, AHORA), true);
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10' }, AHORA), false);
  assert.equal(estaVencida({}, AHORA), false);
});

test('filtrarVigentes deja fuera solo las vencidas', () => {
  const vigente = { id: 'a', hora_recogida_inicio: '18:00', hora_recogida_fin: '23:30' };
  const vencida = { id: 'b', hora_recogida_inicio: '08:00', hora_recogida_fin: '10:00' };
  assert.deepEqual(filtrarVigentes([vigente, vencida], AHORA).map(b => b.id), ['a']);
  assert.deepEqual(filtrarVigentes(null, AHORA), []);
});

test('validarHorarioFuturo rechaza horarios ya expirados', () => {
  assert.equal(
    validarHorarioFuturo({ hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' }, AHORA),
    MENSAJE_HORARIO_VENCIDO
  );
  assert.equal(
    validarHorarioFuturo({ hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00', fecha_caducidad: '2026-09-09' }, AHORA),
    MENSAJE_HORARIO_VENCIDO
  );
});

test('validarHorarioFuturo acepta un horario aún abierto', () => {
  assert.equal(
    validarHorarioFuturo({ hora_recogida_inicio: '18:00', hora_recogida_fin: '23:30' }, AHORA),
    null
  );
  // Cruce de medianoche: sigue siendo futuro respecto a las 21:00 del día 10.
  assert.equal(
    validarHorarioFuturo({ hora_recogida_inicio: '22:00', hora_recogida_fin: '02:00' }, AHORA),
    null
  );
});
