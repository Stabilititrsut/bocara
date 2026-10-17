// NAV-1: GET /api/pedidos (lista del cliente) trae los datos de navegación del
// negocio — dirección, URLs manuales de Google Maps/Waze y coordenadas — para
// el botón "Cómo llegar" de las tarjetas activas en (tabs)/pedidos.tsx.
// Router real sobre Supabase en memoria.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, IDS, datosBase, iniciar, detener, pedir, pedidoPagado } = require('./helpers/appPedidos');

const CLIENTE = '00000000-0000-4000-8000-0000000000c1';
const OTRO_CLIENTE = '00000000-0000-4000-8000-0000000000c2';

const NAVEGACION = {
  direccion: '6a avenida 12-34',
  punto_referencia: 'Frente al parque',
  google_maps_url: 'https://maps.app.goo.gl/olaazul',
  waze_url: 'https://waze.com/ul/olaazul',
  latitud: 14.6349,
  longitud: -90.5069,
};

test.before(iniciar);
test.after(detener);
test.beforeEach(() => {
  const datos = datosBase();
  datos.usuarios.push(
    { id: CLIENTE, rol: 'cliente', activo: true, nombre: 'Cliente' },
    { id: OTRO_CLIENTE, rol: 'cliente', activo: true, nombre: 'Otro' },
  );
  Object.assign(datos.negocios[0], NAVEGACION, { zona: '10', nit: '123456-7', datos_bancarios: { cuenta: '999' } });
  fake.reiniciar(datos);
});

function pedidoDe(usuarioId, id, estado = 'confirmado') {
  return { ...pedidoPagado({ id, estado, createdAtISO: new Date().toISOString() }), usuario_id: usuarioId };
}

test('NAV-1: GET /api/pedidos incluye los campos de navegación del negocio del pedido', async () => {
  fake.tabla('pedidos').push(pedidoDe(CLIENTE, 'p-activo'));
  const r = await pedir('GET', '/api/pedidos', { como: CLIENTE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.length, 1);
  assert.deepEqual(r.body[0].negocios, {
    id: IDS.olaAzul, nombre: 'Ola Azul', zona: '10', ...NAVEGACION,
  });
});

test('NAV-1: el join solo trae navegación, no datos sensibles del negocio', async () => {
  fake.tabla('pedidos').push(pedidoDe(CLIENTE, 'p-activo'));
  const r = await pedir('GET', '/api/pedidos', { como: CLIENTE });
  const negocio = r.body[0].negocios;
  for (const campo of ['nit', 'datos_bancarios', 'propietario_id']) {
    assert.ok(!(campo in negocio), `${campo} no debe viajar al cliente`);
  }
});

test('NAV-1: cada cliente sigue viendo solo sus propios pedidos', async () => {
  fake.tabla('pedidos').push(pedidoDe(CLIENTE, 'p-mio'), pedidoDe(OTRO_CLIENTE, 'p-ajeno'));
  const r = await pedir('GET', '/api/pedidos', { como: CLIENTE });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((p) => p.id), ['p-mio']);
});
