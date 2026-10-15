// Ejecutar: node scripts/test-confirmaciones-admin.cjs. Sin red ni dispositivo.
// Confirmaciones del panel Admin que usaban Alert.alert con botones (no-op en
// web): Aprobar negocio, Desactivar cupón, Eliminar cupón y Restaurar valores.
// Se montan las pantallas reales con Alert vacío, como en react-native-web.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { read, cargarModulo, montar, tick, walk, textOf } = require('./harness-pantallas-admin.cjs');

const { ejecutarAccionAdmin } = cargarModulo('src/utils/accionAdmin.ts');
const plano = (o) => JSON.parse(JSON.stringify(o));

test('CONF-0: ejecutarAccionAdmin devuelve éxito o el error real del backend', async () => {
  const ok = await ejecutarAccionAdmin(async () => ({ data: 1 }), { exito: 'listo', error: 'falló' });
  assert.deepEqual(plano(ok), { ok: true, mensaje: 'listo', data: { data: 1 } });
  const err = await ejecutarAccionAdmin(async () => { throw new Error('Negocio no encontrado'); }, { exito: 'x', error: 'falló' });
  assert.deepEqual(plano(err), { ok: false, error: 'Negocio no encontrado' });
  const sinMsg = await ejecutarAccionAdmin(async () => { throw {}; }, { exito: 'x', error: 'falló' });
  assert.equal(sinMsg.error, 'falló');
});

// ── Aprobar negocio (restaurante-detalle) ────────────────────────────────────
// negocio(0), propietario(1), loading(2), tab(3), procesando(4), rechazarModal(5), motivo(6),
// suspensionModal(7), motivoSuspension(8), errorSuspension(9), aviso(10), aprobarModal(11), errorAprobar(12)
const DETALLE = 'app/admin/restaurante-detalle.tsx';
const PENDIENTE = { id: 'n1', nombre: 'Ola Azul', verificado: false, activo: false, estado_verificacion: 'pendiente', imagen_url: 'https://cdn/x.jpg' };

function apiAprobar({ falla } = {}) {
  const llamadas = [];
  return {
    llamadas,
    negocios: async () => ({ data: [] }), usuarios: async () => ({ data: [] }),
    verificarNegocio: async (id) => {
      llamadas.push(id);
      if (falla) throw new Error(falla);
      return { data: { ...PENDIENTE, verificado: true, activo: true, estado_verificacion: 'aprobado', motivo_rechazo: null } };
    },
  };
}

test('CONF-1: "Aprobar" pide confirmación, llama a PUT /admin/negocios/:id/verificar y actualiza al instante', async () => {
  const api = apiAprobar();
  const app = montar(DETALLE, { forzados: { 0: { ...PENDIENTE }, 2: false }, api });
  app.boton(/✓ Aprobar/).props.onPress();
  assert.equal(app.estado(11), true, 'abre el modal (antes: Alert.alert, no-op en web)');
  assert.equal(app.modalesVisibles().length, 1);
  assert.match(app.texto(), /¿Seguro que deseas aprobar "Ola Azul"\?/);
  assert.equal(api.llamadas.length, 0, 'no aprueba sin confirmar');

  await app.boton(/^Aprobar$/).props.onPress(); await tick();
  assert.deepEqual(api.llamadas, ['n1']);
  assert.equal(app.estado(11), false, 'cierra el modal');
  assert.equal(app.estado(0).verificado, true);
  assert.equal(app.estado(0).estado_verificacion, 'aprobado');
  const texto = app.texto();
  assert.match(texto, /"Ola Azul" fue aprobado y notificado\./);
  assert.match(texto, /Verificado/);
  assert.match(texto, /⏸ Suspender negocio/, 'ya aprobado: la barra muestra suspender');
  assert.ok(!/✓ Aprobar/.test(texto));
  assert.equal(app.alerts.length, 0);
});

test('CONF-2: si el backend bloquea la aprobación, el modal sigue abierto con el error real', async () => {
  const api = apiAprobar({ falla: 'No se puede aprobar el negocio porque no tiene foto.' });
  const app = montar(DETALLE, { forzados: { 0: { ...PENDIENTE }, 2: false }, api });
  app.boton(/✓ Aprobar/).props.onPress();
  await app.boton(/^Aprobar$/).props.onPress(); await tick();
  assert.equal(app.estado(11), true);
  assert.equal(app.estado(0).verificado, false);
  assert.match(app.texto(), /No se puede aprobar el negocio porque no tiene foto\./);
});

test('CONF-2: cancelar no aprueba', () => {
  const api = apiAprobar();
  const app = montar(DETALLE, { forzados: { 0: { ...PENDIENTE }, 2: false }, api });
  app.boton(/✓ Aprobar/).props.onPress();
  app.nodos().filter((n) => n.type === 'Button' && textOf(n) === 'Cancelar' && !n.props.disabled)
    .forEach((b) => b.props.onPress());
  assert.equal(app.estado(11), false);
  assert.equal(api.llamadas.length, 0);
});

// ── Cupones ───────────────────────────────────────────────────────────────────
// cupones(0), loading(1), refreshing(2), modalVisible(3), editando(4), form(5), guardando(6),
// errForm(7), vista(8), cuponDetalle(9), detalleData(10), loadingDetalle(11),
// confirmacion(12), procesandoConfirmacion(13), errorConfirmacion(14), aviso(15)
const CUPONES = 'app/admin/cupones.tsx';
const cupon = (extra = {}) => ({
  id: 'c1', codigo: 'BOCARA20', tipo: 'porcentaje', valor: 20, descripcion: null, uso_maximo: 100, uso_por_usuario: 1,
  usos_actuales: 3, activo: true, fecha_vencimiento: null, usuario_id_exclusivo: null, usuario_exclusivo: null,
  created_at: '2026-10-01T00:00:00Z', ...extra,
});
function apiCupones({ fallaEstado, fallaEliminar } = {}) {
  let servidor = [cupon()];
  const llamadas = [];
  return {
    llamadas,
    cupones: async () => ({ data: servidor.map((c) => ({ ...c })) }),
    patchEstadoCupon: async (id, activo) => {
      llamadas.push(['estado', id, activo]);
      if (fallaEstado) throw new Error(fallaEstado);
      servidor = servidor.map((c) => (c.id === id ? { ...c, activo } : c));
      return { data: servidor.find((c) => c.id === id) };
    },
    eliminarCupon: async (id) => {
      llamadas.push(['eliminar', id]);
      if (fallaEliminar) throw new Error(fallaEliminar);
      servidor = servidor.filter((c) => c.id !== id);
      return { data: { ok: true } };
    },
  };
}
// El primer Switch es el del formulario crear/editar; el de la tarjeta va después.
const switchDe = (app) => app.nodos().filter((n) => n.type === 'Switch').at(-1);
const botonPapelera = (app) => app.nodos().find((n) => n.type === 'Button'
  && walk(n).some((c) => c.type === 'Icon' && c.props.name === 'trash-outline'));

test('CONF-3: "Desactivar cupón" confirma, llama a PATCH /admin/cupones/:id/estado y actualiza la tarjeta', async () => {
  const api = apiCupones();
  const app = montar(CUPONES, { forzados: { 0: [cupon()], 1: false }, api });
  switchDe(app).props.onValueChange(false);
  assert.equal(app.estado(12).tipo, 'desactivar', 'abre la confirmación');
  assert.equal(app.modalesVisibles().length, 1);
  assert.match(app.texto(), /¿Seguro que deseas desactivar "BOCARA20"\?/);
  assert.equal(api.llamadas.length, 0, 'no desactiva sin confirmar');

  await app.boton(/^Desactivar$/).props.onPress(); await tick();
  assert.deepEqual(api.llamadas, [['estado', 'c1', false]]);
  assert.equal(app.estado(0)[0].activo, false, 'actualiza al instante');
  assert.equal(app.estado(12), null, 'cierra el modal');
  assert.equal(switchDe(app).props.value, false);
  assert.match(app.texto(), /"BOCARA20" fue desactivado\./);
  assert.equal(app.alerts.length, 0);
});

test('CONF-4: error al desactivar → el modal muestra el error real y el cupón sigue activo', async () => {
  const api = apiCupones({ fallaEstado: 'Cupón no encontrado' });
  const app = montar(CUPONES, { forzados: { 0: [cupon()], 1: false }, api });
  switchDe(app).props.onValueChange(false);
  await app.boton(/^Desactivar$/).props.onPress(); await tick();
  assert.equal(app.estado(12).tipo, 'desactivar');
  assert.equal(app.estado(0)[0].activo, true);
  assert.match(app.texto(), /Cupón no encontrado/);
});

test('CONF-5: activar sigue sin confirmación (como antes) y muestra éxito o error', async () => {
  const api = apiCupones();
  const app = montar(CUPONES, { forzados: { 0: [cupon({ activo: false })], 1: false }, api });
  await switchDe(app).props.onValueChange(true); await tick();
  assert.deepEqual(api.llamadas, [['estado', 'c1', true]]);
  assert.equal(app.estado(12), null);
  assert.equal(app.estado(0)[0].activo, true);
  assert.match(app.texto(), /"BOCARA20" fue activado\./);

  const fallo = montar(CUPONES, { forzados: { 0: [cupon({ activo: false })], 1: false }, api: apiCupones({ fallaEstado: 'Sin permiso' }) });
  await switchDe(fallo).props.onValueChange(true); await tick();
  assert.equal(fallo.estado(0)[0].activo, false);
  assert.match(fallo.texto(), /Sin permiso/, 'el error ya no se pierde en un Alert');
});

test('CONF-6: "Eliminar cupón" confirma, llama a DELETE /admin/cupones/:id y lo quita de la lista', async () => {
  const api = apiCupones();
  const app = montar(CUPONES, { forzados: { 0: [cupon()], 1: false }, api });
  botonPapelera(app).props.onPress();
  assert.equal(app.estado(12).tipo, 'eliminar');
  assert.match(app.texto(), /¿Seguro que deseas eliminar "BOCARA20"\?/);
  assert.match(app.texto(), /no se puede deshacer/);
  assert.equal(api.llamadas.length, 0);

  await app.boton(/^Eliminar$/).props.onPress(); await tick();
  assert.deepEqual(api.llamadas, [['eliminar', 'c1']]);
  assert.equal(app.estado(0).length, 0, 'sale de la lista al instante');
  assert.equal(app.estado(12), null);
  assert.match(app.texto(), /"BOCARA20" fue eliminado\./);
});

test('CONF-7: eliminar con reservas activas (409) muestra el mensaje del backend y conserva el cupón', async () => {
  const msg = 'Este cupón tiene 2 reserva(s) activa(s). Desactívalo primero.';
  const api = apiCupones({ fallaEliminar: msg });
  const app = montar(CUPONES, { forzados: { 0: [cupon()], 1: false }, api });
  botonPapelera(app).props.onPress();
  await app.boton(/^Eliminar$/).props.onPress(); await tick();
  assert.equal(app.estado(0).length, 1);
  assert.equal(app.estado(12).tipo, 'eliminar', 'el modal queda abierto');
  assert.ok(app.texto().includes(msg));
});

// ── Restaurar valores (config) ────────────────────────────────────────────────
// config(0), loading(1), saving(2), hasTable(3), showSQL(4), geoLoading(5), geoMsg(6),
// geoSinResultado(7), confirmarRestaurar(8), avisoRestaurar(9)
const CONFIG = 'app/admin/config.tsx';
const EDITADO = { comision_porcentaje: '30', puntos_por_pedido: '5', costo_envio_fijo: '15', max_bolsas_por_restaurante: '3' };
function apiConfig() {
  const llamadas = [];
  return { llamadas, getConfig: async () => ({ data: {} }), updateConfig: async (p) => { llamadas.push(p); return { data: p }; } };
}
const botonRestaurarHeader = (app) => app.nodos().find((n) => n.type === 'Button' && /Restaurar/.test(textOf(n)));

test('CONF-8: "Restaurar valores" confirma y rellena exactamente los mismos DEFAULTS, sin guardar', () => {
  const api = apiConfig();
  const app = montar(CONFIG, { forzados: { 0: { ...EDITADO }, 1: false }, api });
  botonRestaurarHeader(app).props.onPress();
  assert.equal(app.estado(8), true, 'abre la confirmación');
  assert.deepEqual(app.estado(0), EDITADO, 'nada cambia antes de confirmar');

  app.boton(/^Restaurar$/).props.onPress();
  assert.deepEqual(plano(app.estado(0)), {
    comision_porcentaje: '25', puntos_por_pedido: '10', min_puntos_canje: '100',
    puntos_a_quetzales: '0.1', costo_envio_fijo: '25', max_bolsas_por_restaurante: '10',
  });
  assert.equal(app.estado(8), false);
  assert.equal(api.llamadas.length, 0, 'restaurar no llama al backend (se aplica con Guardar)');
  assert.match(app.texto(), /Valores por defecto cargados/);
  assert.equal(app.alerts.length, 0);
});

test('CONF-9: cancelar "Restaurar valores" conserva lo editado', () => {
  const app = montar(CONFIG, { forzados: { 0: { ...EDITADO }, 1: false }, api: apiConfig() });
  botonRestaurarHeader(app).props.onPress();
  app.boton(/^Cancelar$/).props.onPress();
  assert.equal(app.estado(8), false);
  assert.deepEqual(app.estado(0), EDITADO);
});

test('CONF-10: ningún Alert.alert del panel Admin se usa como confirmación con botones', () => {
  const dir = path.join(__dirname, '..', 'app/admin');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
    const src = read(`app/admin/${f}`);
    assert.ok(!/Alert\.alert\([^;]*?\[\s*\{\s*text:/s.test(src), `${f} confirma con Alert.alert (no-op en web)`);
  }
});
