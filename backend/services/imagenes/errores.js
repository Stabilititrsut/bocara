// Error de un proveedor de IA. `reintentable` decide si el pipeline vuelve a
// intentar (caída, timeout, 429/5xx) o marca fallida de inmediato (petición
// inválida, contenido bloqueado, salida que no es imagen).
// `motivo` dice POR QUÉ falló, para que el restaurante y los logs no queden
// con un "falló la IA" ambiguo:
//   sin_credito    la cuenta del proveedor no tiene saldo / cuota
//   clave_invalida la API key no es válida o no tiene permisos
//   modelo         el modelo configurado no existe o no está disponible
//   limite         demasiadas solicitudes (429 transitorio)
//   timeout | red  el proveedor no respondió
//   otro           cualquier otro error
class ErrorProveedor extends Error {
  constructor(mensaje, { reintentable = true, motivo = 'otro' } = {}) {
    super(mensaje);
    this.name = 'ErrorProveedor';
    this.reintentable = reintentable;
    this.motivo = motivo;
  }
}

module.exports = { ErrorProveedor };
