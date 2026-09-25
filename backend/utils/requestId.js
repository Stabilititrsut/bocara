// request_id de correlación: uno por request, propio o heredado del caller
// (proxies, otros servicios), nunca derivado de datos del cliente que no sean
// el propio header. Separado de server.js para poder probar la validación
// (longitud, formato, inyección de log) sin levantar Express.

// Restringido a caracteres de palabra y guion, 1-100 de largo:
//   · sin límite de tamaño → un header de varios MB entraría tal cual en cada
//     línea de log (`morgan`, el error global) — vector de log-flooding.
//   · sin restricción de charset → saltos de línea o caracteres de control
//     permitirían inyectar líneas de log falsas (log injection) con un
//     request_id fabricado.
const FORMATO_VALIDO = /^[\w-]{1,100}$/;

function esRequestIdValido(valor) {
  return typeof valor === 'string' && FORMATO_VALIDO.test(valor);
}

function generarRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// `heredado` es lo que llegó en el header `x-request-id` (string, array si el
// header se repitió, o undefined). Si no es un string único con formato válido,
// se genera uno nuevo — nunca se propaga un valor no confiable a los logs.
function resolverRequestId(heredado) {
  return esRequestIdValido(heredado) ? heredado : generarRequestId();
}

module.exports = { esRequestIdValido, generarRequestId, resolverRequestId, FORMATO_VALIDO };
