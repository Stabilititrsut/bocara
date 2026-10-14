// Error de la IA de texto. `codigo` lo traduce la ruta a un status HTTP; el
// mensaje es para logs (nunca incluye la API key ni los datos enviados).
//   no_configurado  TEXT_AI_PROVIDER=none o falta la credencial
//   timeout         el proveedor no respondió a tiempo
//   proveedor       error HTTP / de red del proveedor
//   bloqueado       el proveedor bloqueó la petición o la respuesta
//   salida_invalida respuesta vacía, cortada o con datos no verificables
// `motivo` (solo en 'proveedor'): modelo_no_disponible | clave_invalida | cuota | otro
class ErrorTextoIA extends Error {
  constructor(mensaje, { codigo = 'proveedor', status = null, motivo = null } = {}) {
    super(mensaje);
    this.name = 'ErrorTextoIA';
    this.codigo = codigo;
    this.status = status;
    this.motivo = motivo;
  }
}

module.exports = { ErrorTextoIA };
