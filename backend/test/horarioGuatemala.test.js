const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ahoraGuatemala, hoyGuatemala, estaVencida, filtrarVigentes,
  validarHorarioFuturo, finVentanaRecogida, normalizarHora, MENSAJE_HORARIO_VENCIDO,
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

// ════════════════════════════════════════════════════════════════════════════
// Regresión — productos vencidos que seguían apareciendo en /tienda y /buscar
//
// La causa era normalizarHora: solo aceptaba 'HH:MM' y 'HH:MM:SS' con hora de
// dos dígitos. Cualquier otra forma devolvía null, finVentanaRecogida devolvía
// null, y estaVencida pasaba a juzgar la publicación SOLO por fecha_caducidad
// — dándola por vigente todo el día de su caducidad aunque la ventana de
// recogida ya hubiera cerrado.
// ════════════════════════════════════════════════════════════════════════════

test('normalizarHora acepta las formas que devuelve la base de datos', () => {
  // columna time con precisión fraccionaria
  assert.equal(normalizarHora('12:00:00.000'), '12:00:00');
  assert.equal(normalizarHora('12:00:00.5'), '12:00:00');
  // columna timetz — el offset se descarta: son horas de pared de Guatemala
  assert.equal(normalizarHora('12:00:00+00'), '12:00:00');
  assert.equal(normalizarHora('12:00:00-06:00'), '12:00:00');
  assert.equal(normalizarHora('12:00:00Z'), '12:00:00');
  // fila antigua en columna text, hora de un solo dígito
  assert.equal(normalizarHora('8:00'), '08:00:00');
  assert.equal(normalizarHora('9:30:15'), '09:30:15');
  // las formas de siempre siguen igual
  assert.equal(normalizarHora('18:00'), '18:00:00');
  assert.equal(normalizarHora('18:00:00'), '18:00:00');
});

test('normalizarHora sigue rechazando lo que no es una hora', () => {
  assert.equal(normalizarHora('25:00'), null);
  assert.equal(normalizarHora('12:60'), null);
  assert.equal(normalizarHora('mediodia'), null);
  assert.equal(normalizarHora(''), null);
  assert.equal(normalizarHora('   '), null);
  assert.equal(normalizarHora(null), null);
  assert.equal(normalizarHora(1200), null);
});

test('una ventana ya cerrada está vencida aunque la hora venga con microsegundos', () => {
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  const bolsa = {
    fecha_caducidad: '2026-09-10',
    hora_recogida_inicio: '08:00:00.000',
    hora_recogida_fin: '12:00:00.000',
  };
  assert.equal(estaVencida(bolsa, ahora), true);
});

test('una ventana ya cerrada está vencida aunque la hora traiga offset de zona', () => {
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  const bolsa = {
    fecha_caducidad: '2026-09-10',
    hora_recogida_inicio: '08:00:00-06',
    hora_recogida_fin: '12:00:00-06',
  };
  assert.equal(estaVencida(bolsa, ahora), true);
});

test('una ventana ya cerrada está vencida aunque la hora sea de un solo dígito', () => {
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  const bolsa = { fecha_caducidad: '2026-09-10', hora_recogida_inicio: '8:00', hora_recogida_fin: '9:00' };
  assert.equal(estaVencida(bolsa, ahora), true);
});

test('una ventana todavía abierta no se oculta por el formato de la hora', () => {
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10', hora_recogida_fin: '20:00:00.000' }, ahora), false);
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10', hora_recogida_fin: '20:00:00-06:00' }, ahora), false);
});

test('una hora de fin ininteligible falla CERRADO: la publicación se oculta', () => {
  // Mostrar una bolsa cuya ventana no se puede evaluar deja que un cliente
  // pague por comida que quizá ya no puede recoger. Ocultarla solo cuesta una
  // venta, así que ante un dato corrupto se oculta.
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  const warnOriginal = console.warn;
  console.warn = () => {};
  try {
    assert.equal(estaVencida({ fecha_caducidad: '2026-09-12', hora_recogida_fin: 'mediodia' }, ahora), true);
    assert.equal(estaVencida({ fecha_caducidad: '2026-09-12', hora_recogida_fin: '25:00' }, ahora), true);
    assert.deepEqual(filtrarVigentes([{ id: 'x', hora_recogida_fin: 'a las 3' }], ahora), []);
  } finally {
    console.warn = warnOriginal;
  }
});

test('la ausencia de hora de fin NO es un dato corrupto: manda la fecha', () => {
  // null, undefined y cadena vacía significan "esta publicación no declara
  // hora de cierre", que es distinto de "la hora de cierre no se entiende".
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10', hora_recogida_fin: null }, ahora), false);
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10', hora_recogida_fin: '' }, ahora), false);
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-10', hora_recogida_fin: '   ' }, ahora), false);
  assert.equal(estaVencida({ fecha_caducidad: '2026-09-09', hora_recogida_fin: '' }, ahora), true);
});

test('filtrarVigentes descarta las vencidas sea cual sea el formato de la hora', () => {
  const ahora = { fecha: '2026-09-10', hora: '15:00:00' };
  const lote = [
    { id: 'abierta',        hora_recogida_inicio: '08:00',       hora_recogida_fin: '20:00' },
    { id: 'micro',          hora_recogida_inicio: '08:00:00',    hora_recogida_fin: '12:00:00.000' },
    { id: 'timetz',         hora_recogida_inicio: '08:00:00-06', hora_recogida_fin: '12:00:00-06' },
    { id: 'digito-simple',  hora_recogida_inicio: '8:00',        hora_recogida_fin: '9:00' },
    { id: 'abierta-timetz', hora_recogida_inicio: '08:00:00-06', hora_recogida_fin: '20:00:00-06' },
  ];
  assert.deepEqual(filtrarVigentes(lote, ahora).map(b => b.id), ['abierta', 'abierta-timetz']);
});
