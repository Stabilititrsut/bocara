// Error de un proveedor de IA. `reintentable` decide si el pipeline vuelve a
// intentar (caída, timeout, 429/5xx) o marca fallida de inmediato (petición
// inválida, contenido bloqueado, salida que no es imagen).
class ErrorProveedor extends Error {
  constructor(mensaje, { reintentable = true } = {}) {
    super(mensaje);
    this.name = 'ErrorProveedor';
    this.reintentable = reintentable;
  }
}

module.exports = { ErrorProveedor };
