// Monta el router REAL de pedidos (routes/pedidos.js) sobre el doble en
// memoria de Supabase, para probar los filtros por día/mes de
// GET /api/pedidos/restaurante por HTTP — igual que test/helpers/
// appPublicaciones.js hace para bolsas/admin/negocios, pero scopeado a
// pedidos para no mezclar sus fixtures.
//
// Debe requerirse ANTES que cualquier módulo que cargue config/supabase.

const path = require('node:path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { crearFakeSupabase } = require('./fakeSupabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-pedidos';

const fake = crearFakeSupabase();
const rutaSupabase = require.resolve(path.join(__dirname, '..', '..', 'config', 'supabase'));
require.cache[rutaSupabase] = { id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: fake };

const IDS = {
  restaurante: '00000000-0000-4000-8000-0000000000d1',
  olaAzul: '00000000-0000-4000-8000-00000000bb01',
};

function datosBase() {
  return {
    usuarios: [{ id: IDS.restaurante, rol: 'restaurante', activo: true, nombre: 'Dueña Ola Azul' }],
    negocios: [{ id: IDS.olaAzul, nombre: 'Ola Azul', propietario_id: IDS.restaurante, activo: true }],
    pedidos: [],
    eventos_dominio: [],
  };
}

function token(id) {
  return jwt.sign({ id, rol: 'restaurante' }, process.env.JWT_SECRET);
}

let servidor = null;
let base = null;

async function iniciar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use('/api/pedidos', require('../../routes/pedidos'));
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function detener() {
  if (!servidor) return;
  await new Promise((resolve) => servidor.close(resolve));
  servidor = null;
}

async function pedir(metodo, ruta, { como, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (como) headers.Authorization = `Bearer ${token(como)}`;
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }
  return { status: r.status, body: json };
}

// Crea un pedido ya "pagado y verificado por Cubo" (pasa
// filtrarSoloPagosCuboVerificados) con `created_at` en el instante dado.
function pedidoPagado({ id, negocioId = IDS.olaAzul, createdAtISO, estado = 'completado' }) {
  return {
    id, negocio_id: negocioId, usuario_id: 'cliente-1', estado,
    estado_pago: 'pagado', total: 100,
    cubo_payment_intent_token: `tok-${id}`, cubo_identifier: `cubo-${id}`,
    created_at: createdAtISO,
  };
}

module.exports = { fake, IDS, datosBase, iniciar, detener, pedir, pedidoPagado };
