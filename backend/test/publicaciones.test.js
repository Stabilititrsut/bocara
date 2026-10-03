const test = require('node:test');
const assert = require('node:assert/strict');
const {
  motivosNoVisible, esVisibleParaCliente, filtrarVisiblesParaCliente, camposCambiados, decidirRevision,
} = require('../services/publicaciones');

// Mediodía en Guatemala: ventanas 08:00–22:00 de hoy están abiertas.
const AHORA = { fecha: '2026-10-03', hora: '12:00:00' };

const BASE = {
  id: 'b1', tipo: 'cupon', activo: true, estado_aprobacion: 'aprobado', cantidad_disponible: 3,
  hora_recogida_inicio: '08:00', hora_recogida_fin: '22:00', fecha_caducidad: null,
};

// ── Visibilidad ─────────────────────────────────────────────────────────────

test('visible: aprobada, activa, con unidades y vigente', () => {
  assert.deepEqual(motivosNoVisible(BASE, { ahora: AHORA }), []);
  assert.equal(esVisibleParaCliente(BASE, { ahora: AHORA }), true);
});

test('visible: legado sin estado_aprobacion cuenta como aprobada', () => {
  assert.equal(esVisibleParaCliente({ ...BASE, estado_aprobacion: null }, { ahora: AHORA }), true);
});

for (const [caso, extra, motivo] of [
  ['pendiente', { estado_aprobacion: 'pendiente' }, 'no_aprobada'],
  ['rechazada', { estado_aprobacion: 'rechazado' }, 'no_aprobada'],
  ['estado desconocido', { estado_aprobacion: 'borrador' }, 'no_aprobada'],
  ['inactiva', { activo: false }, 'inactiva'],
  ['activo ausente', { activo: undefined }, 'inactiva'],
  ['sin unidades', { cantidad_disponible: 0 }, 'sin_unidades'],
  ['vencida por fecha', { fecha_caducidad: '2026-10-02' }, 'vencida'],
  ['vencida por horario de hoy', { hora_recogida_fin: '11:00' }, 'vencida'],
  ['negocio suspendido', { negocios: { activo: false } }, 'negocio_no_disponible'],
  ['negocio pendiente de verificación', { negocios: { activo: true, estado_verificacion: 'pendiente' } }, 'negocio_no_disponible'],
]) {
  test(`no visible: ${caso} → ${motivo}`, () => {
    assert.deepEqual(motivosNoVisible({ ...BASE, ...extra }, { ahora: AHORA }), [motivo]);
  });
}

test('no visible: acumula todos los motivos (lo usa el aviso del admin)', () => {
  const m = motivosNoVisible({ ...BASE, activo: false, estado_aprobacion: 'rechazado', fecha_caducidad: '2026-01-01' }, { ahora: AHORA });
  assert.deepEqual(m, ['no_aprobada', 'inactiva', 'vencida']);
});

test('detalle: exigirUnidades=false deja consultar una agotada', () => {
  assert.deepEqual(motivosNoVisible({ ...BASE, cantidad_disponible: 0 }, { ahora: AHORA, exigirUnidades: false }), []);
});

test('filtrarVisiblesParaCliente: solo deja las visibles, tolera null', () => {
  const lista = [BASE, { ...BASE, id: 'p', estado_aprobacion: 'pendiente' }, { ...BASE, id: 'r', estado_aprobacion: 'rechazado' }];
  assert.deepEqual(filtrarVisiblesParaCliente(lista, { ahora: AHORA }).map(b => b.id), ['b1']);
  assert.deepEqual(filtrarVisiblesParaCliente(null), []);
});

// ── Cambios reales ──────────────────────────────────────────────────────────

test('camposCambiados ignora diferencias de formato', () => {
  const actual = { precio_original: 120, hora_recogida_inicio: '08:00:00', fecha_caducidad: '2026-10-04',
    descripcion: 'x', es_promocion: null, imagen_url: null };
  const updates = { precio_original: '120', hora_recogida_inicio: '08:00', fecha_caducidad: '2026-10-04',
    descripcion: ' x ', es_promocion: false, imagen_url: '' };
  assert.deepEqual(camposCambiados(actual, updates), []);
});

test('camposCambiados detecta cambios reales', () => {
  assert.deepEqual(camposCambiados({ precio_descuento: 60, tipo: 'cupon' }, { precio_descuento: 50, tipo: 'bolsa' }),
    ['precio_descuento', 'tipo']);
});

// ── Re-revisión ─────────────────────────────────────────────────────────────

test('rechazada + guardar → pendiente, sin motivo y reactivada', () => {
  const r = decidirRevision({ ...BASE, estado_aprobacion: 'rechazado', activo: false, motivo_rechazo: 'mal' }, { precio_descuento: 50 });
  assert.deepEqual(r.cambios, { estado_aprobacion: 'pendiente', motivo_rechazo: null, activo: true });
  assert.equal(r.reenvio, true);
});

test('rechazada + guardar con activo=false explícito → pendiente pero sigue oculta', () => {
  const r = decidirRevision({ ...BASE, estado_aprobacion: 'rechazado', activo: false }, { descripcion: 'y', activo: false });
  assert.deepEqual(r.cambios, { estado_aprobacion: 'pendiente', motivo_rechazo: null });
});

test('rechazada + solo el switch → no se reenvía', () => {
  const r = decidirRevision({ ...BASE, estado_aprobacion: 'rechazado' }, { activo: true });
  assert.deepEqual(r.cambios, {});
  assert.equal(r.reenvio, false);
});

test('aprobada + cambio relevante → pendiente', () => {
  const r = decidirRevision(BASE, { nombre: 'nuevo' });
  assert.deepEqual(r.cambios, { estado_aprobacion: 'pendiente', motivo_rechazo: null });
  assert.deepEqual(r.campos, ['nombre']);
});

test('aprobada + solo unidades o switch → sigue aprobada', () => {
  assert.deepEqual(decidirRevision(BASE, { cantidad_disponible: 10 }).cambios, {});
  assert.deepEqual(decidirRevision(BASE, { cantidad_disponible: 10, activo: false }).cambios, {});
  assert.deepEqual(decidirRevision(BASE, { activo: false }).cambios, {});
});

test('aprobada + formulario reenviado sin cambios → sigue aprobada', () => {
  assert.deepEqual(decidirRevision(BASE, { tipo: 'cupon', cantidad_disponible: '3', hora_recogida_fin: '22:00:00' }).cambios, {});
});

test('legado (estado null) + cambio relevante → pendiente', () => {
  assert.equal(decidirRevision({ ...BASE, estado_aprobacion: null }, { precio_original: 1 }).cambios.estado_aprobacion, 'pendiente');
});

test('pendiente con "pedir cambios" + guardar → limpia motivo, sigue pendiente', () => {
  const r = decidirRevision({ ...BASE, estado_aprobacion: 'pendiente', motivo_rechazo: 'corrige' }, { descripcion: 'z' });
  assert.deepEqual(r.cambios, { motivo_rechazo: null });
  assert.equal(r.reenvio, true);
});
