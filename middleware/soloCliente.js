// Solo cuentas con rol='cliente' pueden completar una compra. Las cuentas de
// restaurante y admin quedan fuera para que las ventas queden limpias y
// separadas por restaurante, y Finanzas pueda calcular liquidaciones sin ruido
// de pedidos de prueba hechos desde cuentas internas.
module.exports = (req, res, next) => {
  if (req.usuario.rol !== 'cliente') {
    return res.status(403).json({
      error: 'Solo las cuentas de cliente pueden realizar compras. Esta cuenta tiene rol de ' + req.usuario.rol + '.',
    });
  }
  next();
};
