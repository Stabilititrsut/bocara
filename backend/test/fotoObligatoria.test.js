// Foto obligatoria (services/fotoObligatoria.js) por HTTP, con los routers
// reales de bolsas/negocios/admin sobre Supabase en memoria:
//   PHOTO-PUB-3..8  publicaciones (POST/PUT /api/bolsas)
//   PHOTO-BIZ-1..4  negocios (POST/PUT /api/negocios, aprobar/toggle admin)
//   PHOTO-LEGACY-1  datos históricos sin foto: se leen igual, no se rompen.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala,
} = require('./helpers/appPublicaciones');
const { HORA_INICIO_PRUEBA, horaFinVigente } = require('./helpers/horarioPrueba');

const HOY = fechaGuatemala(0);
const MANANA = fechaGuatemala(1);
const FOTO = 'https://cdn.bocara.test/publicaciones/foto.jpg';
const FOTO_NEGOCIO = 'https://cdn.bocara.test/negocios/foto.jpg';
const MSG_PUB = 'La foto es obligatoria';
const MSG_NEGOCIO = 'Debes agregar una foto del negocio para continuar.';
const MSG_APROBAR = 'No se puede aprobar el negocio porque no tiene foto.';

const HORARIO = {
  hora_recogida_inicio: HORA_INICIO_PRUEBA, hora_recogida_fin: horaFinVigente(), fecha_disponible: HOY, fecha_caducidad: MANANA,
};
const promo = (extra = {}) => ({
  nombre: '2x1 Ceviche', contenido: 'OLA2X1', tipo: 'cupon', categoria: '2x1', descripcion: 'Dos por uno',
  precio_original: 120, precio_descuento: 60, cantidad_disponible: 5, imagen_url: FOTO, ...HORARIO, ...extra,
});
const tiempoLimitado = (extra = {}) => ({
  nombre: 'Bolsa sorpresa', tipo: 'bolsa', descripcion: 'Pan del día', precio_original: 80, precio_descuento: 35,
  cantidad_disponible: 3, peso_estimado_kg: 1.2, categoria_alimento: 'cereales', imagen_url: FOTO, ...HORARIO, ...extra,
});

const crear = (body, como = IDS.restaurante) => pedir('POST', '/api/bolsas', { como, body });
const editar = (id, body, como = IDS.restaurante) => pedir('PUT', `/api/bolsas/${id}`, { como, body });
const aprobar = (id) => pedir('PUT', `/api/admin/bolsas/${id}/aprobar`, { como: IDS.admin });
const fila = (tabla, id) => fake.tabla(tabla).find(x => x.id === id);
const sinFoto = (body) => { const b = { ...body }; delete b.imagen_url; return b; };

async function creadaYAprobada(body) {
  const r = await crear(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await aprobar(r.body.id);
  return r.body.id;
}

// Publicación heredada (creada antes de esta regla): aprobada, visible y sin foto.
function sembrarHeredada(extra = {}) {
  const b = {
    id: `legacy-${Math.random().toString(16).slice(2)}`, negocio_id: IDS.olaAzul, nombre: 'Heredada',
    tipo: 'cupon', contenido: 'VIEJO', categoria: '2x1', precio_original: 100, precio_descuento: 50,
    cantidad_disponible: 4, activo: true, estado_aprobacion: 'aprobado', motivo_rechazo: null,
    imagen_url: null, created_at: new Date().toISOString(), ...HORARIO, ...extra,
  };
  fake.tabla('bolsas').push(b);
  return b.id;
}

function sembrarNegocio(extra = {}) {
  const n = {
    id: `neg-${Math.random().toString(16).slice(2)}`, nombre: 'Nuevo', propietario_id: IDS.otroRestaurante,
    activo: false, verificado: false, estado_verificacion: 'pendiente', zona: '10', ciudad: 'Guatemala',
    categoria: 'Restaurante', imagen_url: null, ...extra,
  };
  fake.tabla('negocios').push(n);
  return n.id;
}

test.before(iniciar);
test.after(detener);
test.beforeEach(() => fake.reiniciar(datosBase()));

// ── Publicaciones ────────────────────────────────────────────────────────────

test('PHOTO-PUB-3: POST Promoción sin imagen_url → 400 "La foto es obligatoria"', async () => {
  const antes = fake.tabla('bolsas').length;
  const r = await crear(sinFoto(promo()));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, MSG_PUB);
  assert.equal(fake.tabla('bolsas').length, antes, 'no se crea nada');
});

test('PHOTO-PUB-4: POST Tiempo limitado sin imagen_url → 400', async () => {
  const r = await crear(sinFoto(tiempoLimitado()));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, MSG_PUB);
});

test('PHOTO-PUB-5: imagen_url "", solo espacios o null → 400 (ambos tipos)', async () => {
  for (const valor of ['', '   ', null]) {
    for (const body of [promo({ imagen_url: valor }), tiempoLimitado({ imagen_url: valor })]) {
      const r = await crear(body);
      assert.equal(r.status, 400, `${body.tipo} con imagen_url=${JSON.stringify(valor)}`);
      assert.equal(r.body.error, MSG_PUB);
    }
  }
});

test('PHOTO-PUB-6: con foto se crea normalmente (y se guarda sin espacios sobrantes)', async () => {
  const p = await crear(promo({ imagen_url: `  ${FOTO}  ` }));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(fila('bolsas', p.body.id).imagen_url, FOTO);
  const t = await crear(tiempoLimitado());
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(fila('bolsas', t.body.id).imagen_url, FOTO);
});

test('PHOTO-PUB-7: editar sin tocar la imagen conserva la foto', async () => {
  const id = await creadaYAprobada(promo());
  const ed = await editar(id, { nombre: '3x2 Ceviche', precio_original: 150 });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(fila('bolsas', id).imagen_url, FOTO);
  assert.equal(fila('bolsas', id).nombre, '3x2 Ceviche');
});

test('PHOTO-PUB-8: vaciar la foto en edición se rechaza y la foto sigue ahí', async () => {
  const id = await creadaYAprobada(tiempoLimitado());
  for (const valor of ['', '   ', null]) {
    const ed = await editar(id, { imagen_url: valor });
    assert.equal(ed.status, 400, `imagen_url=${JSON.stringify(valor)}`);
    assert.equal(ed.body.error, MSG_PUB);
    const ed2 = await editar(id, { nombre: 'Otro', imagen_url: valor });
    assert.equal(ed2.status, 400, 'tampoco junto con otros cambios');
  }
  assert.equal(fila('bolsas', id).imagen_url, FOTO);
  assert.equal(fila('bolsas', id).nombre, 'Bolsa sorpresa');
  // Reemplazar por otra foto sí se puede.
  const otra = 'https://cdn.bocara.test/publicaciones/otra.jpg';
  const ok = await editar(id, { imagen_url: otra });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(fila('bolsas', id).imagen_url, otra);
});

test('PHOTO-PUB-8: tampoco el admin puede dejar una publicación sin foto', async () => {
  const id = await creadaYAprobada(promo());
  const ed = await editar(id, { imagen_url: '' }, IDS.admin);
  assert.equal(ed.status, 400);
  assert.equal(fila('bolsas', id).imagen_url, FOTO);
});

// ── Negocios ─────────────────────────────────────────────────────────────────

test('PHOTO-BIZ-1: POST /api/negocios sin foto → 400 con mensaje claro', async () => {
  for (const valor of [undefined, '', '  ', null]) {
    const body = { nombre: 'Panadería Nueva', direccion: 'Zona 10', latitud: 14.6, longitud: -90.5 };
    if (valor !== undefined) body.imagen_url = valor;
    const r = await pedir('POST', '/api/negocios', { como: IDS.otroRestaurante, body });
    assert.equal(r.status, 400, `imagen_url=${JSON.stringify(valor)}`);
    assert.equal(r.body.error, MSG_NEGOCIO);
  }
  const ok = await pedir('POST', '/api/negocios', {
    como: IDS.otroRestaurante,
    body: { nombre: 'Panadería Nueva', direccion: 'Zona 10', latitud: 14.6, longitud: -90.5, imagen_url: FOTO_NEGOCIO },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.imagen_url, FOTO_NEGOCIO);
});

test('PHOTO-BIZ-2: admin no puede aprobar (ni verificar) un negocio sin foto', async () => {
  const id = sembrarNegocio();
  for (const ruta of ['aprobar', 'verificar']) {
    const r = await pedir('PUT', `/api/admin/negocios/${id}/${ruta}`, { como: IDS.admin });
    assert.equal(r.status, 409, `${ruta}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, MSG_APROBAR);
  }
  const n = fila('negocios', id);
  assert.equal(n.estado_verificacion, 'pendiente');
  assert.equal(n.activo, false);
});

test('PHOTO-BIZ-3: un negocio con foto se aprueba normalmente', async () => {
  const id = sembrarNegocio({ imagen_url: FOTO_NEGOCIO });
  const r = await pedir('PUT', `/api/admin/negocios/${id}/aprobar`, { como: IDS.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = fila('negocios', id);
  assert.equal(n.estado_verificacion, 'aprobado');
  assert.equal(n.activo, true);
});

test('PHOTO-BIZ-4: no se puede borrar la foto del negocio ni activarlo sin foto', async () => {
  const id = sembrarNegocio({ imagen_url: FOTO_NEGOCIO, activo: true, estado_verificacion: 'aprobado' });
  for (const valor of ['', '   ', null]) {
    const r = await pedir('PUT', `/api/negocios/${id}`, { como: IDS.otroRestaurante, body: { imagen_url: valor } });
    assert.equal(r.status, 400, `imagen_url=${JSON.stringify(valor)}`);
    assert.equal(r.body.error, MSG_NEGOCIO);
  }
  assert.equal(fila('negocios', id).imagen_url, FOTO_NEGOCIO);

  // Negocio sin foto: el admin no lo activa ni por PUT ni por el toggle.
  // (El restaurante no puede tocar `activo` en absoluto — ver negociosSeguridad.test.js.)
  const sinFotoId = sembrarNegocio();
  const put = await pedir('PUT', `/api/negocios/${sinFotoId}`, { como: IDS.admin, body: { activo: true } });
  assert.equal(put.status, 400);
  assert.equal(put.body.error, MSG_NEGOCIO);
  const toggle = await pedir('PUT', `/api/admin/negocios/${sinFotoId}/toggle`, { como: IDS.admin });
  assert.equal(toggle.status, 409);
  assert.equal(fila('negocios', sinFotoId).activo, false);

  // El restaurante sube la foto; después el admin sí puede activarlo.
  const foto = await pedir('PUT', `/api/negocios/${sinFotoId}`, { como: IDS.otroRestaurante, body: { imagen_url: FOTO_NEGOCIO } });
  assert.equal(foto.status, 200, JSON.stringify(foto.body));
  const conFoto = await pedir('PUT', `/api/negocios/${sinFotoId}`, { como: IDS.admin, body: { activo: true } });
  assert.equal(conFoto.status, 200, JSON.stringify(conFoto.body));
});

// ── Datos heredados ──────────────────────────────────────────────────────────

test('PHOTO-LEGACY-1: publicación heredada sin foto se sigue leyendo y admite cambios menores', async () => {
  const id = sembrarHeredada();
  const feed = await pedir('GET', '/api/bolsas');
  assert.equal(feed.status, 200);
  assert.ok(feed.body.some(b => b.id === id), 'sigue visible en el feed');
  const panel = await pedir('GET', '/api/bolsas?mi_negocio=true', { como: IDS.restaurante });
  assert.ok(panel.body.some(b => b.id === id), 'sigue en el panel del restaurante');

  // Cambios que no vuelven a revisión: permitidos (también con el vacío reenviado).
  assert.equal((await editar(id, { cantidad_disponible: 9 })).status, 200);
  assert.equal((await editar(id, { cantidad_disponible: 8, imagen_url: null })).status, 200);
  assert.equal((await editar(id, { activo: false })).status, 200);
  assert.equal(fila('bolsas', id).estado_aprobacion, 'aprobado');

  // Un cambio de contenido (vuelve a revisión) exige completar la foto.
  const sinFotoEd = await editar(id, { nombre: 'Heredada v2' });
  assert.equal(sinFotoEd.status, 400);
  assert.equal(sinFotoEd.body.error, MSG_PUB);
  const conFotoEd = await editar(id, { nombre: 'Heredada v2', imagen_url: FOTO });
  assert.equal(conFotoEd.status, 200, JSON.stringify(conFotoEd.body));
  assert.equal(fila('bolsas', id).estado_aprobacion, 'pendiente');
});

test('PHOTO-LEGACY-1: negocio heredado sin foto se sigue leyendo y editando (sin activarse)', async () => {
  // Ola Azul (datosBase) es un negocio aprobado y activo sin imagen_url.
  // El feed lista negocios con publicaciones visibles: se le siembra una
  // heredada (también sin foto) para que aparezca.
  assert.ok(!fila('negocios', IDS.olaAzul).imagen_url);
  sembrarHeredada();
  const feed = await pedir('GET', '/api/negocios/feed');
  assert.equal(feed.status, 200);
  assert.ok(feed.body.some(n => n.id === IDS.olaAzul), 'el feed no se rompe ni lo esconde');
  const ficha = await pedir('GET', `/api/negocios/${IDS.olaAzul}`);
  assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
  const ed = await pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.restaurante, body: { descripcion: 'Mariscos' } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const vacioOtraVez = await pedir('PUT', `/api/negocios/${IDS.olaAzul}`, { como: IDS.restaurante, body: { telefono: '5555', imagen_url: '' } });
  assert.equal(vacioOtraVez.status, 200, 'vacío sobre vacío no es "borrar la foto"');
  // Suspender sí; volver a activarlo exige foto.
  assert.equal((await pedir('PUT', `/api/admin/negocios/${IDS.olaAzul}/toggle`, { como: IDS.admin })).status, 200);
  assert.equal((await pedir('PUT', `/api/admin/negocios/${IDS.olaAzul}/toggle`, { como: IDS.admin })).status, 409);
});
