// Ejecutar: node scripts/test-reactivacion-foto-admin.cjs. Sin red, Expo ni dispositivo.
//
// Caso "Sabor Casero": negocio aprobado y suspendido SIN foto. Reactivarlo
// responde 409 ("No se puede activar el negocio porque no tiene foto."), y el
// admin no tenía cómo cargarla. Cubre:
//   · src/utils/suspensionAdmin.ts — detección de foto, botón de la tarjeta,
//     subida de la foto por el admin, solicitud de foto pendiente.
//   · app/admin/negocios.tsx — "📷 Sin foto" + "📷 Agregar foto para
//     reactivar" en vez de un "Reactivar" que falla; tarjeta sin área táctil anidada.
//   · app/admin/restaurante-detalle.tsx — "Subir foto del negocio" →
//     "Reactivar negocio ahora"; aprobar la foto que envió el restaurante.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cargarModulo, montar, tick, walk, textOf } = require('./harness-pantallas-admin.cjs');

const S = cargarModulo('src/utils/suspensionAdmin.ts');
const plano = (x) => JSON.parse(JSON.stringify(x));
const FOTO = 'https://cdn.bocara.test/negocios/n1/imagen_1.png';
const FOTO_RESTAURANTE = 'https://cdn.bocara.test/negocios/n1/imagen_propuesta.jpg';

const SUSPENDIDO_SIN_FOTO = { id: 'n1', nombre: 'Sabor Casero', verificado: true, activo: false, imagen_url: null };
const SUSPENDIDO_CON_FOTO = { id: 'n2', nombre: 'Tacos Don Pepe', verificado: true, activo: false, imagen_url: FOTO };
const ACTIVO = { id: 'n3', nombre: 'Ola Azul', verificado: true, activo: true, imagen_url: FOTO };

// ── 1. Lógica pura ───────────────────────────────────────────────────────────

test('negocioTieneFoto: null, vacía o solo espacios no son una foto (mismo criterio que el backend)', () => {
  for (const v of [null, undefined, '', '   ', 42]) assert.equal(S.negocioTieneFoto({ imagen_url: v }), false, String(v));
  assert.equal(S.negocioTieneFoto(null), false);
  assert.equal(S.negocioTieneFoto({ imagen_url: FOTO }), true);
});

test('accionTarjetaSuspendido: sin foto → agregar_foto; con foto → reactivar; activo/pendiente → nada', () => {
  assert.equal(S.accionTarjetaSuspendido(SUSPENDIDO_SIN_FOTO), 'agregar_foto');
  assert.equal(S.accionTarjetaSuspendido({ ...SUSPENDIDO_SIN_FOTO, imagen_url: '  ' }), 'agregar_foto');
  assert.equal(S.accionTarjetaSuspendido(SUSPENDIDO_CON_FOTO), 'reactivar');
  assert.equal(S.accionTarjetaSuspendido(ACTIVO), null);
  assert.equal(S.accionTarjetaSuspendido({ id: 'p', verificado: false, activo: false }), null, 'pendiente: Aprobar/Rechazar');
});

test('rutaAgregarFotoNegocio lleva al detalle con accion=foto', () => {
  assert.equal(S.rutaAgregarFotoNegocio('n1'), '/admin/restaurante-detalle?id=n1&accion=foto');
  assert.equal(S.rutaAgregarFotoNegocio('a b&c'), '/admin/restaurante-detalle?id=a%20b%26c&accion=foto');
});

test('extensionFoto: solo extensiones que acepta /uploads/base64; el resto cae a jpg', () => {
  assert.equal(S.extensionFoto('image/png'), 'png');
  assert.equal(S.extensionFoto('image/jpeg'), 'jpeg');
  assert.equal(S.extensionFoto('image/webp'), 'webp');
  assert.equal(S.extensionFoto('image/svg+xml'), 'jpg');
  assert.equal(S.extensionFoto(undefined), 'jpg');
});

function apiFoto({ publicUrl = FOTO, fallaSubida, fallaActualizar, respuestaActualizar } = {}) {
  const llamadas = [];
  return {
    llamadas,
    uploadBase64: async (base64, path, mime) => {
      llamadas.push(['upload', base64, path, mime]);
      if (fallaSubida) throw new Error(fallaSubida);
      return { data: { publicUrl } };
    },
    actualizarNegocio: async (id, data) => {
      llamadas.push(['actualizar', id, data]);
      if (fallaActualizar) throw new Error(fallaActualizar);
      return { data: respuestaActualizar || { id, ...data } };
    },
  };
}

test('subirFotoNegocio: sube al path del negocio y escribe imagen_url directo (sin reactivar)', async () => {
  const api = apiFoto();
  const r = await S.subirFotoNegocio(api, 'n1', { base64: 'QUJD', mimeType: 'image/png' }, 1700000000000);
  assert.equal(r.ok, true);
  assert.equal(r.imagen_url, FOTO);
  assert.deepEqual(plano(api.llamadas), [
    ['upload', 'QUJD', 'negocios/n1/imagen_1700000000000.png', 'image/png'],
    ['actualizar', 'n1', { imagen_url: FOTO }],
  ]);
  assert.ok(!api.llamadas.some(([t, , d]) => t === 'actualizar' && 'activo' in d), 'subir la foto nunca toca `activo`');
});

test('subirFotoNegocio: sin publicUrl no actualiza el negocio', async () => {
  const api = apiFoto({ publicUrl: '' });
  const r = await S.subirFotoNegocio(api, 'n1', { base64: 'x', mimeType: 'image/jpeg' });
  assert.deepEqual(plano(r), { ok: false, error: 'No se pudo subir la foto del negocio.' });
  assert.equal(api.llamadas.filter(([t]) => t === 'actualizar').length, 0);
});

test('subirFotoNegocio: el error real del backend llega a la pantalla', async () => {
  const r1 = await S.subirFotoNegocio(apiFoto({ fallaSubida: 'Ruta de archivo no permitida' }), 'n1', { base64: 'x' });
  assert.deepEqual(plano(r1), { ok: false, error: 'Ruta de archivo no permitida' });
  const r2 = await S.subirFotoNegocio(apiFoto({ fallaActualizar: 'No autorizado' }), 'n1', { base64: 'x' });
  assert.deepEqual(plano(r2), { ok: false, error: 'No autorizado' });
});

test('subirFotoNegocio: si la foto quedara en revisión (no aplicada), no se reporta como éxito', async () => {
  const r = await S.subirFotoNegocio(apiFoto({ respuestaActualizar: { cambio_foto_pendiente: true } }), 'n1', { base64: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Cambios de perfil/);
});

test('solicitudFotoPendiente: solo la pendiente de ESTE negocio y con foto', () => {
  const sols = [
    { id: 's0', negocio_id: 'n1', estado: 'aprobado', cambios: { imagen_url: FOTO } },
    { id: 's1', negocio_id: 'otro', estado: 'pendiente', cambios: { imagen_url: FOTO } },
    { id: 's2', negocio_id: 'n1', estado: 'pendiente', cambios: { telefono: '5555' } },
    { id: 's3', negocio_id: 'n1', estado: 'pendiente', cambios: { imagen_url: FOTO_RESTAURANTE } },
  ];
  assert.equal(S.solicitudFotoPendiente(sols, 'n1').id, 's3');
  assert.equal(S.solicitudFotoPendiente(sols.slice(0, 3), 'n1'), null);
  assert.equal(S.solicitudFotoPendiente(null, 'n1'), null);
});

// ── 2. Lista de negocios (app/admin/negocios.tsx) ────────────────────────────

const LISTA = 'app/admin/negocios.tsx';
const mocksLista = {
  '@/components/CalendarioPicker': { __esModule: true, default: 'Calendario' },
  '@/components/ListaResenas': { __esModule: true, default: () => null },
  '@/components/SelectorPeriodo': { mesEnCurso: () => '2026-10', nombreMes: (m) => `mes ${m}` },
};

function montarLista(negocios) {
  const llamadas = [];
  const rutas = [];
  const api = {
    negocios: async () => ({ data: negocios }),
    resenasResumen: async () => ({ data: { negocios: {} } }),
    toggleNegocio: async (id) => { llamadas.push(id); return { data: { id, activo: true } }; },
  };
  // negocios(0), loading(1), refreshing(2), busqueda(3), filtro(4)
  const app = montar(LISTA, { forzados: { 0: negocios, 1: false, 4: 'todos' }, api, rutas, mocks: mocksLista });
  return { app, llamadas, rutas };
}

test('LISTA: suspendido sin foto → "📷 Sin foto" y "📷 Agregar foto para reactivar" (no un Reactivar que da 409)', async () => {
  const { app, llamadas, rutas } = montarLista([SUSPENDIDO_SIN_FOTO]);
  const texto = app.texto();
  assert.match(texto, /📷 Sin foto/);
  assert.ok(!app.boton(/Reactivar negocio/), 'no ofrece el botón que el backend rechazaría');
  await app.boton(/📷 Agregar foto para reactivar/).props.onPress(); await tick();
  assert.deepEqual(rutas, ['/admin/restaurante-detalle?id=n1&accion=foto'], 'lleva directo a subir la foto');
  assert.deepEqual(llamadas, [], 'no llama al toggle');
  assert.ok(!/no tiene foto/.test(app.texto()), 'no aparece el error 409');
});

test('LISTA: suspendido con foto conserva "Reactivar negocio" y reactiva por el flujo compartido', async () => {
  const { app, llamadas } = montarLista([SUSPENDIDO_CON_FOTO]);
  assert.ok(!/📷 Sin foto/.test(app.texto()));
  assert.ok(!app.boton(/Agregar foto para reactivar/));
  await app.boton(/Reactivar negocio/).props.onPress(); await tick();
  assert.deepEqual(llamadas, ['n2'], 'PUT /admin/negocios/:id/toggle');
  assert.match(app.texto(), /"Tacos Don Pepe" fue reactivado\./);
});

test('LISTA: un negocio activo no muestra ni el chip ni acciones de reactivación', () => {
  const { app } = montarLista([ACTIVO]);
  const texto = app.texto();
  assert.ok(!/Sin foto|Reactivar negocio|Agregar foto/.test(texto));
});

test('LISTA: la tarjeta ya no es un área táctil — "Ver perfil" es la única navegación', async () => {
  const { app, rutas } = montarLista([SUSPENDIDO_SIN_FOTO, SUSPENDIDO_CON_FOTO]);
  const botonesConNombre = app.nodos().filter((n) => n.type === 'Button' && /Sabor Casero|Tacos Don Pepe/.test(textOf(n)));
  assert.deepEqual(botonesConNombre, [], 'ningún botón envuelve la tarjeta entera');
  const verPerfil = app.nodos().filter((n) => n.type === 'Button' && /Ver perfil/.test(textOf(n)));
  assert.equal(verPerfil.length, 2);
  verPerfil[0].props.onPress();
  assert.deepEqual(rutas, ['/admin/restaurante-detalle?id=n1']);
});

// ── 3. Detalle (app/admin/restaurante-detalle.tsx) ───────────────────────────

const DETALLE = 'app/admin/restaurante-detalle.tsx';
// negocio(0) … loading(2), tab(3), procesando(4), suspensionModal(7), aviso(10),
// subiendoFoto(13), errorFoto(14), fotoRecienSubida(15), solicitudFoto(16)

function montarDetalle(negocio, { solicitud = null, pick = { base64: 'QUJD', mimeType: 'image/png' }, fallaSubida, params } = {}) {
  const llamadas = [];
  const rutas = [];
  const api = {
    negocios: async () => ({ data: [negocio] }), usuarios: async () => ({ data: [] }),
    cambiosPerfil: async () => ({ data: solicitud ? [solicitud] : [] }),
    toggleNegocio: async (id) => { llamadas.push(['toggle', id]); return { data: { id, activo: true } }; },
    aprobarCambioPerfil: async (id) => { llamadas.push(['aprobarCambio', id]); return { data: { ok: true } }; },
  };
  const uploadsApi = {
    uploadBase64: async (base64, path, mime) => {
      llamadas.push(['upload', path, mime]);
      if (fallaSubida) throw new Error(fallaSubida);
      return { data: { publicUrl: FOTO } };
    },
  };
  const negociosApi = {
    actualizar: async (id, data) => { llamadas.push(['actualizar', id, data]); return { data: { ...negocio, ...data } }; },
  };
  const app = montar(DETALLE, {
    forzados: { 0: negocio, 2: false, ...(solicitud ? { 16: solicitud } : {}) },
    api, uploadsApi, negociosApi, rutas, pickImage: async () => pick,
    params: params || { id: negocio.id, accion: 'foto' },
  });
  return { app, llamadas, rutas };
}

test('DETALLE: sin foto y suspendido — aviso claro, "Subir foto del negocio" y sin "Reactivar" que falle', () => {
  const { app } = montarDetalle(SUSPENDIDO_SIN_FOTO);
  const texto = app.texto();
  assert.match(texto, /Sin foto del negocio cargada/);
  assert.match(texto, /Sin foto este negocio no se puede reactivar/);
  assert.ok(app.boton(/📷 Subir foto del negocio/));
  assert.ok(app.boton(/📷 Sube una foto para reactivar/), 'el botón inferior también lo explica');
  assert.ok(!app.boton(/▶ Reactivar negocio/), 'ni abajo ni arriba se ofrece un Reactivar que da 409');
});

test('DETALLE: subir foto → imagen_url directo → "Reactivar negocio ahora" → negocio activo', async () => {
  const { app, llamadas } = montarDetalle(SUSPENDIDO_SIN_FOTO);
  await app.boton(/📷 Subir foto del negocio/).props.onPress(); await tick();

  const [subida, actualizacion] = plano(llamadas);
  assert.equal(subida[0], 'upload');
  assert.match(subida[1], /^negocios\/n1\/imagen_\d+\.png$/, 'path permitido para admin y restaurante');
  assert.deepEqual(actualizacion, ['actualizar', 'n1', { imagen_url: FOTO }]);
  assert.equal(app.estado(0).imagen_url, FOTO, 'la foto se pinta sin recargar');
  assert.equal(app.estado(0).activo, false, 'subir la foto no reactiva sola');
  assert.match(app.texto(), /Foto del negocio actualizada\./);
  assert.ok(app.boton(/📷 Cambiar foto del negocio/));
  assert.ok(!/Sin foto este negocio no se puede reactivar/.test(app.texto()));

  await app.boton(/▶ Reactivar negocio ahora/).props.onPress(); await tick();
  assert.deepEqual(plano(llamadas.at(-1)), ['toggle', 'n1'], 'mismo endpoint PUT /admin/negocios/:id/toggle');
  assert.equal(app.estado(0).activo, true);
  assert.match(app.texto(), /"Sabor Casero" fue reactivado\./);
  assert.ok(!app.boton(/Reactivar negocio ahora/), 'el botón desaparece una vez activo');
  assert.ok(app.boton(/⏸ Suspender negocio/));
  assert.equal(app.alerts.length, 0, 'nada depende de Alert (no-op en web)');
});

test('DETALLE: cancelar el selector de imagen no sube nada', async () => {
  const { app, llamadas } = montarDetalle(SUSPENDIDO_SIN_FOTO, { pick: null });
  await app.boton(/📷 Subir foto del negocio/).props.onPress(); await tick();
  assert.deepEqual(llamadas, []);
  assert.equal(app.estado(0).imagen_url, null);
});

test('DETALLE: si la subida falla, se ve el error y no se ofrece reactivar', async () => {
  const { app, llamadas } = montarDetalle(SUSPENDIDO_SIN_FOTO, { fallaSubida: 'Archivo demasiado grande' });
  await app.boton(/📷 Subir foto del negocio/).props.onPress(); await tick();
  assert.match(app.texto(), /Archivo demasiado grande/);
  assert.ok(!app.boton(/Reactivar negocio ahora/));
  assert.equal(llamadas.filter(([t]) => t === 'actualizar').length, 0);
});

test('DETALLE: la foto que envió el restaurante (solo foto) se aprueba aquí y habilita reactivar', async () => {
  const solicitud = { id: 's1', negocio_id: 'n1', estado: 'pendiente', cambios: { imagen_url: FOTO_RESTAURANTE } };
  const { app, llamadas } = montarDetalle(SUSPENDIDO_SIN_FOTO, { solicitud });
  assert.match(app.texto(), /El restaurante envió una foto nueva que espera revisión/);
  await app.boton(/✓ Aprobar foto del restaurante/).props.onPress(); await tick();
  assert.deepEqual(plano(llamadas), [['aprobarCambio', 's1']], 'PUT /admin/cambios-perfil/:id/aprobar');
  assert.equal(app.estado(0).imagen_url, FOTO_RESTAURANTE);
  assert.equal(app.estado(16), null);
  assert.ok(app.boton(/▶ Reactivar negocio ahora/));
});

test('DETALLE: si la solicitud cambia más que la foto, se revisa completa en Cambios de perfil', () => {
  const solicitud = { id: 's2', negocio_id: 'n1', estado: 'pendiente', cambios: { imagen_url: FOTO_RESTAURANTE, telefono: '5555' } };
  const { app, rutas, llamadas } = montarDetalle(SUSPENDIDO_SIN_FOTO, { solicitud });
  assert.ok(!app.boton(/Aprobar foto del restaurante/), 'no se aprueban cambios ajenos a la foto a ciegas');
  app.boton(/Revisar la solicitud en Cambios de perfil/).props.onPress();
  assert.deepEqual(rutas, ['/admin/cambios-perfil']);
  assert.deepEqual(llamadas, []);
});

test('DETALLE: negocio activo con foto — "Cambiar foto", sin avisos ni reactivar', () => {
  const { app } = montarDetalle(ACTIVO, { params: { id: 'n3' } });
  const texto = app.texto();
  assert.ok(app.boton(/📷 Cambiar foto del negocio/));
  assert.ok(!/no se puede reactivar|Reactivar negocio ahora|Sube una foto para reactivar/.test(texto));
});
