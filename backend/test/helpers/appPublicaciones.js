// Monta los routers REALES de publicaciones (bolsas, admin, negocios) sobre el
// doble en memoria de Supabase, para probar el ciclo completo de una
// publicación por HTTP — exactamente las rutas que usan el restaurante, el
// panel admin y la app del cliente — sin tocar ninguna base de datos real.
//
// Debe requerirse ANTES que cualquier módulo que cargue config/supabase.

const path = require('node:path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { crearFakeSupabase } = require('./fakeSupabase');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-publicaciones';

const fake = crearFakeSupabase();
const rutaSupabase = require.resolve(path.join(__dirname, '..', '..', 'config', 'supabase'));
require.cache[rutaSupabase] = { id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: fake };

const IDS = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  restaurante: '00000000-0000-4000-8000-0000000000b1',
  otroRestaurante: '00000000-0000-4000-8000-0000000000b2',
  cliente: '00000000-0000-4000-8000-0000000000c1',
  olaAzul: '00000000-0000-4000-8000-00000000aa01',
  otroNegocio: '00000000-0000-4000-8000-00000000aa02',
};

function datosBase() {
  return {
    usuarios: [
      { id: IDS.admin, rol: 'admin', activo: true, nombre: 'Admin' },
      { id: IDS.restaurante, rol: 'restaurante', activo: true, nombre: 'Dueña Ola Azul' },
      { id: IDS.otroRestaurante, rol: 'restaurante', activo: true, nombre: 'Otro dueño' },
      { id: IDS.cliente, rol: 'cliente', activo: true, nombre: 'Cliente' },
    ],
    negocios: [
      {
        id: IDS.olaAzul, nombre: 'Ola Azul', propietario_id: IDS.restaurante,
        activo: true, estado_verificacion: 'aprobado', zona: '10', ciudad: 'Guatemala',
        categoria: 'Restaurante', latitud: 14.6, longitud: -90.5, calificacion_promedio: 4.5,
        // Sin los dos enlaces POST /api/bolsas rechaza crear (services/enlacesMapa.js).
        google_maps_url: 'https://maps.app.goo.gl/olaazul', waze_url: 'https://waze.com/ul?ll=14.6,-90.5',
      },
      {
        id: IDS.otroNegocio, nombre: 'Otro', propietario_id: IDS.otroRestaurante,
        activo: true, estado_verificacion: 'aprobado', zona: '4', ciudad: 'Guatemala',
        categoria: 'Cafetería', calificacion_promedio: 4,
        google_maps_url: 'https://maps.app.goo.gl/otro', waze_url: 'https://waze.com/ul?ll=14.6,-90.5',
      },
    ],
    bolsas: [],
    pedidos: [],
    pedido_items: [],
    eventos_dominio: [],
    notificaciones: [],
    favoritos: [],
    configuracion: [],
    trabajos_imagen: [],
  };
}

function token(id) {
  const usuario = Object.entries(IDS).find(([, v]) => v === id);
  const rol = { admin: 'admin', cliente: 'cliente' }[usuario?.[0]] || 'restaurante';
  return jwt.sign({ id, rol }, process.env.JWT_SECRET);
}

let servidor = null;
let base = null;

async function iniciar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use('/api/bolsas', require('../../routes/bolsas'));
  app.use('/api/negocios', require('../../routes/negocios'));
  app.use('/api/admin', require('../../routes/admin'));
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function detener() {
  if (!servidor) return;
  await new Promise((resolve) => servidor.close(resolve));
  servidor = null;
}

// Trabajo de imagen 'lista' (services/imagenes/trabajos.js) en la BD en
// memoria: lo que la app obtiene al subir una foto y esperar la mejora con IA.
function trabajoListo({ negocioId, usuarioId, url, original = url, ...extra }) {
  const t = {
    id: `trabajo-${Math.random().toString(16).slice(2)}`, usuario_id: usuarioId, negocio_id: negocioId,
    original_url: original, mejorada_url: url, estado: 'lista', proveedor: 'openai', modelo: 'gpt-image-1-mini',
    calidad_original: { brillo: 120 }, calidad_resultado: { similitud: 0.9 }, revision_ia: { apta: true },
    bolsa_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra,
  };
  (fake._db.tablas.trabajos_imagen ||= []).push(t);
  return t.id;
}

// Igual que la app: una foto NUEVA en POST/PUT /api/bolsas viaja con su
// trabajo de imagen validado. { sinTrabajo: true } prueba la regla en sí.
function adjuntarTrabajo(metodo, ruta, como, body) {
  if (!body || typeof body.imagen_url !== 'string' || !body.imagen_url.trim() || body.imagen_trabajo_id !== undefined) return body;
  const url = body.imagen_url.trim();
  if (metodo === 'POST' && ruta === '/api/bolsas') {
    const negocioId = body.negocio_id || fake.tabla('negocios').find(n => n.propietario_id === como)?.id;
    if (!negocioId) return body;
    return { ...body, imagen_trabajo_id: trabajoListo({ negocioId, usuarioId: como, url }) };
  }
  const m = /^\/api\/bolsas\/([^/]+)$/.exec(ruta);
  if (metodo === 'PUT' && m) {
    const b = fake.tabla('bolsas').find(x => x.id === m[1]);
    if (!b || [b.imagen_url, b.imagen_original_url, b.imagen_mejorada_url].includes(url)) return body;
    return { ...body, imagen_trabajo_id: trabajoListo({ negocioId: b.negocio_id, usuarioId: como, url }) };
  }
  return body;
}

async function pedir(metodo, ruta, { como, body, sinTrabajo = false } = {}) {
  if (!sinTrabajo) body = adjuntarTrabajo(metodo, ruta, como, body);
  const headers = { 'Content-Type': 'application/json' };
  if (como) headers.Authorization = `Bearer ${token(como)}`;
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }
  return { status: r.status, body: json };
}

// Fecha YYYY-MM-DD en Guatemala desplazada `dias` respecto de hoy.
function fechaGuatemala(dias = 0) {
  const { hoyGuatemala } = require('../../services/horarioGuatemala');
  const [a, m, d] = hoyGuatemala().split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + dias));
  return f.toISOString().slice(0, 10);
}

module.exports = { fake, IDS, datosBase, iniciar, detener, pedir, fechaGuatemala, trabajoListo };
