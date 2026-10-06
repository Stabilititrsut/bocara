// Emisión de `publicacion.visible` desde las rutas reales (bolsas.js y
// admin.js) sobre Supabase en memoria. El aviso a cercanos/favoritos ya no se
// hace inline en la ruta: solo se encola, y lo procesa el despachador.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');

const HOY = fechaGuatemala(0);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';

function promo(extra = {}) {
  return {
    nombre: '2x1 Ceviche', contenido: 'OLA2X1', tipo: 'cupon', categoria: '2x1',
    descripcion: 'Dos por uno', precio_original: 120, precio_descuento: 60, cantidad_disponible: 5,
    imagen_url: FOTO, hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(),
    fecha_disponible: HOY, fecha_caducidad: fechaGuatemala(1), ...extra,
  };
}

const crear = async (datos, como = IDS.restaurante) => {
  const r = await pedir('POST', '/api/bolsas', { como, body: { ...datos, negocio_id: IDS.olaAzul } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const aprobar = (id) => pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
const visibles = (id) => fake.tabla('eventos_dominio')
  .filter(e => e.event_type === 'publicacion.visible' && (!id || e.aggregate_id === id));

test.before(iniciar);
test.after(detener);
test.beforeEach(() => {
  const datos = datosBase();
  datos.usuarios.find(u => u.id === IDS.cliente).expo_push_token = 'ExponentPushToken[cliente]';
  datos.favoritos = [{ id: 'fav-1', usuario_id: IDS.cliente, tipo: 'negocio', referencia_id: IDS.olaAzul }];
  fake.reiniciar(datos);
});

test('crear como restaurante (pendiente) no encola el aviso', async () => {
  await crear(promo());
  assert.equal(visibles().length, 0);
});

test('aprobar una publicación visible encola publicacion.visible con su ciclo, sin avisar inline', async () => {
  const p = await crear(promo());
  const r = await aprobar(p.id);
  assert.equal(r.body.visible_cliente, true);

  const [ev] = visibles(p.id);
  assert.ok(ev, 'debe encolarse publicacion.visible');
  assert.equal(ev.idempotency_key, `bolsa:${p.id}:publicacion.visible:${HOY}`);
  assert.deepEqual(ev.payload, { negocio_id: IDS.olaAzul, ciclo: HOY });
  // El favorito no recibe nada directamente desde la ruta: lo hará el despachador.
  assert.equal(fake.tabla('notificaciones').filter(n => n.usuario_id === IDS.cliente).length, 0);
});

test('aprobar una publicación que el cliente no verá no encola el aviso', async () => {
  const p = await crear(promo());
  // El restaurante la ocultó mientras esperaba revisión.
  fake.tabla('bolsas').find(b => b.id === p.id).activo = false;
  const r = await aprobar(p.id);
  assert.equal(r.body.visible_cliente, false);
  assert.equal(visibles(p.id).length, 0);
});

test('re-aprobar tras rechazo con la misma fecha no genera un segundo aviso', async () => {
  const p = await crear(promo());
  await aprobar(p.id);
  await pedir('PUT', `/api/admin/bolsas/${p.id}/rechazar`, { como: IDS.admin, body: { motivo: 'foto' } });
  await pedir('PUT', `/api/bolsas/${p.id}`, { como: IDS.restaurante, body: { descripcion: 'corregida' } });
  await aprobar(p.id);
  assert.equal(fake.tabla('eventos_dominio').filter(e => e.event_type === 'publicacion.aprobada' && e.aggregate_id === p.id).length, 2);
  assert.equal(visibles(p.id).length, 1, 'mismo ciclo: el evento colapsa por su clave');
});

test('una publicación creada por el admin (nace aprobada) encola el aviso', async () => {
  const p = await crear(promo(), IDS.admin);
  assert.equal(p.estado_aprobacion, 'aprobado');
  assert.equal(visibles(p.id).length, 1);
});
