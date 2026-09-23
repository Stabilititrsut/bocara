const test = require('node:test');
const assert = require('node:assert/strict');
const { actualizarUbicacionUsuario } = require('../services/ubicacionUsuario');

// Doble de Supabase en memoria: una fila por usuario, `update().eq('id', x)`
// solo toca la fila de `x` — así se demuestra que dos cuentas no se pisan.
function crearCliente(usuarios) {
  return {
    from(nombre) {
      assert.equal(nombre, 'usuarios');
      return {
        update(cambios) {
          let filtroId;
          const q = {
            eq(campo, valor) { assert.equal(campo, 'id'); filtroId = valor; return q; },
            select: () => ({
              single: async () => {
                const fila = usuarios.find((u) => u.id === filtroId);
                if (!fila) return { data: null, error: { message: 'no encontrado' } };
                Object.assign(fila, cambios);
                return { data: { ...fila }, error: null };
              },
            }),
          };
          return q;
        },
      };
    },
  };
}

const USUARIO_A = { id: 'user-a', latitud: null, longitud: null };
const USUARIO_B = { id: 'user-b', latitud: 15.5, longitud: -91.5 };

test('guarda una ubicación válida', async () => {
  const cliente = crearCliente([{ ...USUARIO_A }]);
  const r = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 14.6349, longitud: -90.5069, cliente });
  assert.equal(r.ok, true);
  assert.equal(r.data.latitud, 14.6349);
  assert.equal(r.data.longitud, -90.5069);
  assert.ok(r.data.ubicacion_actualizada_at);
});

test('rechaza latitud fuera de rango', async () => {
  const cliente = crearCliente([{ ...USUARIO_A }]);
  const r = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 91, longitud: -90, cliente });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.code, 'UBICACION_INVALIDA');
});

test('rechaza longitud fuera de rango', async () => {
  const cliente = crearCliente([{ ...USUARIO_A }]);
  const r = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 14, longitud: 181, cliente });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.code, 'UBICACION_INVALIDA');
});

test('rechaza null, undefined, string no numérico, NaN e Infinity', async () => {
  const cliente = crearCliente([{ ...USUARIO_A }]);
  for (const [latitud, longitud] of [
    [null, -90], [undefined, -90], [14, null], [14, undefined],
    ['no-es-numero', -90], [Number.NaN, -90], [Infinity, -90],
  ]) {
    const r = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud, longitud, cliente });
    assert.equal(r.ok, false, `debía rechazar lat=${latitud} lng=${longitud}`);
    assert.equal(r.status, 422);
  }
});

test('actualizar ubicación: una segunda llamada reemplaza la anterior', async () => {
  const fila = { ...USUARIO_A };
  const cliente = crearCliente([fila]);
  await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 14.6, longitud: -90.5, cliente });
  const r2 = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 15.0, longitud: -91.0, cliente });
  assert.equal(r2.data.latitud, 15.0);
  assert.equal(r2.data.longitud, -91.0);
  assert.equal(fila.latitud, 15.0);
});

test('un usuario no puede modificar la ubicación de otra cuenta', async () => {
  const filaA = { ...USUARIO_A };
  const filaB = { ...USUARIO_B };
  const cliente = crearCliente([filaA, filaB]);

  // La función solo recibe UN usuarioId — no hay parámetro por el que colar
  // el id de otra cuenta. Se llama como lo haría la ruta real: con el id que
  // vino del JWT de user-a.
  await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 1, longitud: 1, cliente });

  assert.equal(filaA.latitud, 1);
  assert.equal(filaB.latitud, 15.5, 'la fila de user-b no debía tocarse');
  assert.equal(filaB.longitud, -91.5, 'la fila de user-b no debía tocarse');
});

test('BD no disponible (columnas de la migración ausentes) responde 503, no 500 ni una excepción', async () => {
  const cliente = { from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'column "latitud" does not exist' } }) }) }) }) }) };
  const r = await actualizarUbicacionUsuario({ usuarioId: 'user-a', latitud: 14, longitud: -90, cliente });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'BD_NO_DISPONIBLE');
});
