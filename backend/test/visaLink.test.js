const test = require('node:test');
const assert = require('node:assert/strict');
const { construirPayloadLink, FORMATOS_EXPIRACION } = require('../services/visaLink');
const { RESERVA_TTL_MINUTOS } = require('../services/stock');

// ════════════════════════════════════════════════════════════════════════════
// Vigencia del link de pago (AC-03)
//
// El link de Cubo y la reserva de stock tienen que caducar a la vez. Mientras
// el link vivía más que la reserva, el cliente podía pagar a los 40 minutos una
// bolsa que el catálogo había devuelto al stock en el minuto 15 y que otro
// cliente ya se había llevado.
//
// construirPayloadLink es la parte pura de generarLinkPago: arma el cuerpo de
// POST /api/v1/links/one-use sin tocar la red, así que la caducidad se puede
// comprobar sin llamar a Cubo.
// ════════════════════════════════════════════════════════════════════════════

const AHORA = Date.parse('2026-09-14T12:00:00.000Z');

const base = () => ({
  referencia: 'BOC-123',
  pedidoId: '11111111-2222-4333-8444-555555555555',
  titulo: 'Bocara - Bolsa sorpresa',
  monto: 50,
  urlRedireccion: 'https://bocarafood.com/pago-retorno',
  ahora: AHORA,
});

test('el link nace con el mismo TTL que la reserva de stock', () => {
  const { body, expiraEn, ttlMinutos } = construirPayloadLink(base());

  assert.equal(ttlMinutos, RESERVA_TTL_MINUTOS,
    'si el link vive más que la reserva, el pago tardío vuelve a ser posible');
  assert.equal(expiraEn, new Date(AHORA + RESERVA_TTL_MINUTOS * 60 * 1000).toISOString());
  assert.equal(body.metadata.expiraEn, expiraEn,
    'Cubo devuelve metadata intacta: la vigencia emitida queda registrada en el webhook');
  assert.equal(body.metadata.ttlReservaMinutos, RESERVA_TTL_MINUTOS);
});

test('metadata conserva orderId — el webhook no encuentra el pedido sin él', () => {
  const { body } = construirPayloadLink(base());
  assert.equal(body.metadata.orderId, '11111111-2222-4333-8444-555555555555');
  assert.equal(body.metadata.pedidoId, '11111111-2222-4333-8444-555555555555');
  assert.equal(body.metadata.referencia, 'BOC-123');
});

test('sin CUBO_LINK_EXPIRACION_CAMPO no se inventa ningún campo de API', () => {
  const { body } = construirPayloadLink(base());
  const conocidos = ['description', 'amount', 'redirectUri', 'metadata'];
  assert.deepEqual(Object.keys(body).sort(), conocidos.sort(),
    'Cubo no documenta el campo de expiración: enviar uno inventado devuelve 422');
});

test('con el campo configurado, la expiración viaja también en el cuerpo', () => {
  const { body, expiraEn } = construirPayloadLink({ ...base(), campoExpiracion: 'expiresAt' });
  assert.equal(body.expiresAt, expiraEn, 'por defecto, ISO-8601');
});

test('cada formato de expiración produce el valor que espera esa API', () => {
  const vencimiento = AHORA + RESERVA_TTL_MINUTOS * 60 * 1000;
  const casos = [
    ['iso',      new Date(vencimiento).toISOString()],
    ['epoch',    Math.floor(vencimiento / 1000)],
    ['epoch_ms', vencimiento],
    ['minutos',  RESERVA_TTL_MINUTOS],
  ];

  for (const [formato, esperado] of casos) {
    const { body } = construirPayloadLink({
      ...base(), campoExpiracion: 'expiraEn', formatoExpiracion: formato,
    });
    assert.equal(body.expiraEn, esperado, `formato ${formato}`);
  }

  assert.deepEqual(Object.keys(FORMATOS_EXPIRACION).sort(), casos.map(c => c[0]).sort(),
    'la lista documentada en .env.example y la implementada no pueden divergir');
});

test('un formato mal escrito se detecta al construir, no en un 422 de Cubo', () => {
  assert.throws(
    () => construirPayloadLink({ ...base(), campoExpiracion: 'expiresAt', formatoExpiracion: 'unix' }),
    /CUBO_LINK_EXPIRACION_FORMATO/,
  );
});

test('las variables de entorno gobiernan el campo cuando no se pasa explícito', () => {
  const previo = {
    campo: process.env.CUBO_LINK_EXPIRACION_CAMPO,
    formato: process.env.CUBO_LINK_EXPIRACION_FORMATO,
  };
  process.env.CUBO_LINK_EXPIRACION_CAMPO = 'expirationTime';
  process.env.CUBO_LINK_EXPIRACION_FORMATO = 'epoch';
  try {
    const { body } = construirPayloadLink(base());
    assert.equal(body.expirationTime, Math.floor((AHORA + RESERVA_TTL_MINUTOS * 60 * 1000) / 1000));
  } finally {
    if (previo.campo === undefined) delete process.env.CUBO_LINK_EXPIRACION_CAMPO;
    else process.env.CUBO_LINK_EXPIRACION_CAMPO = previo.campo;
    if (previo.formato === undefined) delete process.env.CUBO_LINK_EXPIRACION_FORMATO;
    else process.env.CUBO_LINK_EXPIRACION_FORMATO = previo.formato;
  }
});

test('un TTL inválido cae al de la reserva en vez de emitir un link eterno', () => {
  for (const ttl of [0, -5, null, undefined, 'quince']) {
    const { ttlMinutos } = construirPayloadLink({ ...base(), ttlMinutos: ttl });
    assert.equal(ttlMinutos, RESERVA_TTL_MINUTOS, `ttlMinutos=${ttl}`);
  }
});

test('un TTL explícito se respeta (para pruebas de sandbox y nada más)', () => {
  const { body, ttlMinutos } = construirPayloadLink({ ...base(), ttlMinutos: 2 });
  assert.equal(ttlMinutos, 2);
  assert.equal(body.metadata.expiraEn, new Date(AHORA + 2 * 60 * 1000).toISOString());
});

test('el monto sigue validándose antes de salir a la red', () => {
  assert.throws(() => construirPayloadLink({ ...base(), monto: 0 }), /Monto inválido/);
  assert.throws(() => construirPayloadLink({ ...base(), monto: -3 }), /Monto inválido/);
  assert.throws(() => construirPayloadLink({ ...base(), monto: 'gratis' }), /Monto inválido/);
  assert.equal(construirPayloadLink({ ...base(), monto: '12.34' }).montoCentavos, 1234);
});

test('los datos del cliente y los items solo viajan si existen', () => {
  const sinExtras = construirPayloadLink(base()).body;
  assert.equal('clientName' in sinExtras, false);
  assert.equal('items' in sinExtras, false);

  const conExtras = construirPayloadLink({
    ...base(),
    cliente: { nombre: 'Ana', email: 'ana@example.com', telefono: '+50255555555' },
    items: [{ name: 'Bolsa', price: '50.00', quantity: 1 }],
  }).body;
  assert.equal(conExtras.clientName, 'Ana');
  assert.equal(conExtras.clientEmail, 'ana@example.com');
  assert.equal(conExtras.clientPhone, '+50255555555');
  assert.equal(conExtras.items.length, 1);
});
