// Horario de recogida para fixtures que NUNCA está vencido, a cualquier hora en
// que corra la suite.
//
// Una Promoción no tiene fecha_caducidad: vence HOY a su hora_recogida_fin.
// Con un '22:00' fijo, toda la suite fallaba como "horario expirado" a partir
// de las 22:00 de Guatemala. Aquí el fin se calcula relativo a ahora (+4 h):
//   · Si +4 h sigue siendo hoy, la ventana es 00:00 → fin y termina hoy. No
//     cruza la medianoche, así que una publicación con fecha_caducidad = AYER
//     sigue vencida, como esperan las pruebas de estados.
//   · Si +4 h ya es mañana (corrida después de las 20:00), la ventana cruza la
//     medianoche (fin < inicio, válido: ver validarDatosBolsa) y termina
//     mañana a esa hora. Con fecha_caducidad = AYER terminó hoy de madrugada:
//     también vencida.
// Fin == inicio es inválido; con estas dos ramas nunca coinciden.
// Los valores se fijan al cargar el módulo: la suite dura segundos.
const { ahoraGuatemala } = require('../../services/horarioGuatemala');

// HH:MM de Guatemala dentro de `horas` horas (admite fracciones).
function horaGuatemalaEn(horas) {
  return ahoraGuatemala(new Date(Date.now() + horas * 60 * 60 * 1000)).hora.slice(0, 5);
}

const FIN_VIGENTE = horaGuatemalaEn(4);
const CRUZA_MEDIANOCHE = FIN_VIGENTE < horaGuatemalaEn(0);
const HORA_INICIO_PRUEBA = CRUZA_MEDIANOCHE ? '08:00' : '00:00';

// Hora futura en `horas` (o media hora más) que nunca coincide con el inicio.
function horaFinEn(horas) {
  const h = horaGuatemalaEn(horas);
  return h !== HORA_INICIO_PRUEBA ? h : horaGuatemalaEn(horas + 0.5);
}

// Fin del horario base de los fixtures: ≥ 4 h de margen sobre la corrida.
function horaFinVigente() {
  return FIN_VIGENTE;
}

module.exports = { HORA_INICIO_PRUEBA, horaGuatemalaEn, horaFinEn, horaFinVigente };
