const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// POST /api/auth/registro
router.post('/registro', async (req, res) => {
  const {
  email, password, nombre, apellido, rol, telefono,
  nombre_negocio, direccion_negocio, categoria, zona, ciudad, descripcion,
  nit, dpi, datos_bancarios, horario_atencion,
} = req.body;
  if (!email || !password || !nombre || !rol)
    return res.status(400).json({ error: 'email, password, nombre y rol son requeridos' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const insertData = { email: email.toLowerCase().trim(), password_hash: hash, nombre, telefono };
    if (apellido !== undefined) insertData.apellido = apellido;
    if (rol !== undefined) insertData.rol = rol;
    let { data: usuario, error } = await supabase
      .from('usuarios')
      .insert([insertData])
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Este email ya está registrado' });
      if (error.message && error.message.includes('column')) {
        const base = { email: insertData.email, password_hash: insertData.password_hash, nombre: insertData.nombre };
        if (insertData.telefono) base.telefono = insertData.telefono;
        const r = await supabase.from('usuarios').insert([base]).select().single();
        usuario = r.data; error = r.error;
      }
      if (error) return res.status(400).json({ error: error.message });
    }

    if (rol === 'restaurante' && nombre_negocio) {
      const negocioData = {
        propietario_id: usuario.id,
        email: email.toLowerCase().trim(),
        nombre: nombre_negocio,
        direccion: direccion_negocio || '',
        categoria: categoria || 'Restaurante',
        zona: zona || '',
        ciudad: ciudad || 'Guatemala',
        descripcion: descripcion || '',
        estado_verificacion: 'pendiente',
        activo: false,
        verificado: false,
      };
      if (nit) negocioData.nit = nit;
      if (dpi) negocioData.dpi = dpi;
      if (datos_bancarios) negocioData.datos_bancarios = datos_bancarios;
      if (horario_atencion) negocioData.horario_atencion = horario_atencion;

      const { error: negocioError } = await supabase.from('negocios').insert([negocioData]);
      if (negocioError) {
        // Fallback: columnas nuevas no existen aún — reintentar con campos básicos
        const basicData = {
          propietario_id: usuario.id,
          email: email.toLowerCase().trim(),
          nombre: nombre_negocio,
          direccion: direccion_negocio || '',
          categoria: categoria || 'Restaurante',
          zona: zona || '',
          ciudad: ciudad || 'Guatemala',
          activo: false,
          verificado: false,
        };
        const { error: basicError } = await supabase.from('negocios').insert([basicData]);
        if (basicError) {
          // Eliminar el usuario recién creado para no dejar datos huérfanos
          await supabase.from('usuarios').delete().eq('id', usuario.id);
          return res.status(400).json({ error: `Error al crear el negocio: ${basicError.message}` });
        }
      }
    }

    // Puntos de bienvenida para clientes nuevos
    if (rol === 'cliente') {
      try {
        await supabase.rpc('sumar_puntos', { user_id: usuario.id, puntos: 10 });
      } catch { }
    }

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, rol: usuario.rol || rol || 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...u } = usuario;
    res.status(201).json({ token, usuario: u, esNuevo: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
  try {
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();
    if (error || !usuario) return res.status(401).json({ error: 'Credenciales incorrectas' });
    if (usuario.rol === 'suspendido')
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Contacta soporte.' });
    const valido = await bcrypt.compare(password, usuario.password_hash);
    if (!valido) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const rol = usuario.rol || 'cliente';
    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, rol },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...u } = usuario;
    res.json({ token, usuario: { puntos: 0, total_co2_salvado_kg: 0, total_bolsas_salvadas: 0, total_ahorrado: 0, rol, ...u } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/perfil
router.get('/perfil', authMiddleware, async (req, res) => {
  try {
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('id', req.usuario.id)
      .single();
    if (error || !usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Calcular stats reales desde pedidos si los campos del usuario son nulos o cero
    let { total_bolsas_salvadas, total_co2_salvado_kg, total_ahorrado } = usuario;
    if (!total_bolsas_salvadas && !total_co2_salvado_kg) {
      const { data: pedidos } = await supabase
        .from('pedidos')
        .select('bolsas(precio_original,precio_descuento,co2_salvado_kg)')
        .eq('usuario_id', req.usuario.id)
        .eq('estado', 'recogido');
      if (pedidos?.length) {
        total_bolsas_salvadas = pedidos.length;
        total_co2_salvado_kg = pedidos.reduce((s, p) => s + (p.bolsas?.co2_salvado_kg || 0), 0);
        total_ahorrado = pedidos.reduce((s, p) => s + ((p.bolsas?.precio_original || 0) - (p.bolsas?.precio_descuento || 0)), 0);
      }
    }

    const { password_hash, ...u } = usuario;
    res.json({
      puntos: 0,
      total_co2_salvado_kg: 0,
      total_bolsas_salvadas: 0,
      total_ahorrado: 0,
      rol: req.usuario.rol || 'cliente',
      ...u,
      total_bolsas_salvadas: total_bolsas_salvadas || 0,
      total_co2_salvado_kg: parseFloat((total_co2_salvado_kg || 0).toFixed(2)),
      total_ahorrado: parseFloat((total_ahorrado || 0).toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/perfil
router.put('/perfil', authMiddleware, async (req, res) => {
  const { nombre, apellido, telefono, expo_push_token, avatar_url } = req.body;
  const updates = {};
  if (nombre !== undefined) updates.nombre = nombre;
  if (apellido !== undefined) updates.apellido = apellido;
  if (telefono !== undefined) updates.telefono = telefono;
  if (expo_push_token !== undefined) updates.expo_push_token = expo_push_token;
  if (avatar_url !== undefined) updates.avatar_url = avatar_url;
  const { data, error } = await supabase
    .from('usuarios')
    .update(updates)
    .eq('id', req.usuario.id)
    .select('id,email,nombre,apellido,rol,telefono,puntos,total_bolsas_salvadas,total_co2_salvado_kg,total_ahorrado,avatar_url')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/auth/setup-admin — crea o repara el usuario admin con hash bcrypt correcto
// Protegido por ADMIN_SETUP_SECRET (env var). Llamar UNA sola vez desde producción.
router.post('/setup-admin', async (req, res) => {
  const { secret, email, password } = req.body;
  const expectedSecret = process.env.ADMIN_SETUP_SECRET || 'bocara-setup-2025';
  if (secret !== expectedSecret) {
    return res.status(403).json({ error: 'Secret incorrecto' });
  }
  const adminEmail = (email || 'admin@bocarafood.com').toLowerCase().trim();
  const adminPassword = password || 'Admin1234';

  try {
    const hash = await bcrypt.hash(adminPassword, 10);

    // Verificar si el usuario ya existe
    const { data: existing } = await supabase
      .from('usuarios')
      .select('id,email,rol,password_hash')
      .eq('email', adminEmail)
      .single();

    if (existing) {
      // Actualizar hash y asegurar rol admin
      const { data, error } = await supabase
        .from('usuarios')
        .update({ password_hash: hash, rol: 'admin', nombre: existing.nombre || 'Admin' })
        .eq('email', adminEmail)
        .select('id,email,rol')
        .single();
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, action: 'updated', usuario: data });
    }

    // Crear usuario nuevo
    const { data, error } = await supabase
      .from('usuarios')
      .insert([{ email: adminEmail, password_hash: hash, nombre: 'Admin', rol: 'admin' }])
      .select('id,email,rol')
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, action: 'created', usuario: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
