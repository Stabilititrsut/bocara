const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// Twilio client — solo si las vars de entorno están configuradas
const twilio = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// OTP de teléfono en memoria (TTL: 10 min)
const phoneOtpStore = new Map();

function cleanExpiredOtps() {
  const now = Date.now();
  for (const [key, val] of phoneOtpStore.entries()) {
    if (val.expiresAt < now) phoneOtpStore.delete(key);
  }
}

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
          await supabase.from('usuarios').delete().eq('id', usuario.id);
          return res.status(400).json({ error: `Error al crear el negocio: ${basicError.message}` });
        }
      }
    }

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

// POST /api/auth/registro-completo — crea cuenta de cliente después de verificar email con Supabase OTP
router.post('/registro-completo', async (req, res) => {
  const { email, password, nombre, apellido, telefono, supabase_access_token } = req.body;
  if (!email || !password || !nombre || !supabase_access_token)
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  // Verificar el token de Supabase Auth (prueba que el email fue verificado)
  const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(supabase_access_token);
  if (authError || !supabaseUser)
    return res.status(401).json({ error: 'Verificación de email inválida. Solicita un nuevo código.' });
  if (supabaseUser.email?.toLowerCase() !== email.toLowerCase().trim())
    return res.status(401).json({ error: 'El email no coincide con la verificación.' });
  if (!supabaseUser.email_confirmed_at)
    return res.status(401).json({ error: 'El email aún no ha sido verificado.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const insertData = {
      email: email.toLowerCase().trim(),
      password_hash: hash,
      nombre: nombre.trim(),
      rol: 'cliente',
    };
    if (apellido) insertData.apellido = apellido.trim();
    if (telefono) insertData.telefono = telefono.trim();

    let { data: usuario, error } = await supabase
      .from('usuarios')
      .insert([insertData])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Este email ya está registrado' });
      return res.status(400).json({ error: error.message });
    }

    try { await supabase.rpc('sumar_puntos', { user_id: usuario.id, puntos: 10 }); } catch { }

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, rol: 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...u } = usuario;
    res.status(201).json({ token, usuario: u, esNuevo: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/send-phone-otp — envía SMS de verificación vía Twilio
router.post('/send-phone-otp', async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Teléfono requerido' });

  const digits = telefono.replace(/\D/g, '');
  if (!/^[234567]\d{7}$/.test(digits))
    return res.status(400).json({ error: 'Número guatemalteco inválido (8 dígitos, inicia con 2-7)' });

  if (!twilio || !process.env.TWILIO_PHONE_NUMBER)
    return res.status(503).json({ error: 'Servicio de SMS no configurado' });

  cleanExpiredOtps();

  // Límite: 3 intentos por número en 10 min
  const existing = phoneOtpStore.get(digits);
  if (existing && existing.expiresAt > Date.now() && (existing.attempts || 0) >= 3)
    return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  phoneOtpStore.set(digits, { code, expiresAt, attempts: (existing?.attempts || 0) + 1 });

  // Revisar si el usuario ya existe con este teléfono
  const { data: existingUser } = await supabase
    .from('usuarios')
    .select('id,email,nombre')
    .eq('telefono', digits)
    .maybeSingle();

  try {
    await twilio.messages.create({
      body: `Tu código de verificación Bocara es: ${code}. Válido por 10 minutos.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+502${digits}`,
    });
    res.json({ ok: true, isNewUser: !existingUser });
  } catch (err) {
    phoneOtpStore.delete(digits);
    res.status(500).json({ error: `Error al enviar SMS: ${err.message}` });
  }
});

// POST /api/auth/verify-phone-otp — verifica código SMS y crea/busca usuario
router.post('/verify-phone-otp', async (req, res) => {
  const { telefono, codigo, nombre, apellido } = req.body;
  if (!telefono || !codigo) return res.status(400).json({ error: 'Teléfono y código requeridos' });

  const digits = telefono.replace(/\D/g, '');
  const stored = phoneOtpStore.get(digits);

  if (!stored) return res.status(400).json({ error: 'No hay código activo para este número. Solicita uno nuevo.' });
  if (stored.expiresAt < Date.now()) {
    phoneOtpStore.delete(digits);
    return res.status(400).json({ error: 'El código expiró. Solicita uno nuevo.' });
  }
  if (stored.code !== String(codigo).trim())
    return res.status(400).json({ error: 'Código incorrecto.' });

  phoneOtpStore.delete(digits);

  try {
    // Buscar usuario existente por teléfono
    let { data: usuario } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telefono', digits)
      .maybeSingle();

    if (!usuario) {
      if (!nombre) return res.status(400).json({ error: 'Nombre requerido para crear la cuenta', needsProfile: true });
      // Crear usuario nuevo
      const hash = await bcrypt.hash(crypto.randomUUID(), 10);
      const insertData = { telefono: digits, nombre: nombre.trim(), rol: 'cliente', password_hash: hash };
      if (apellido) insertData.apellido = apellido.trim();
      const { data: newUser, error: createErr } = await supabase
        .from('usuarios')
        .insert([insertData])
        .select()
        .single();
      if (createErr) return res.status(400).json({ error: createErr.message });
      usuario = newUser;
      try { await supabase.rpc('sumar_puntos', { user_id: usuario.id, puntos: 10 }); } catch { }
    }

    if (usuario.rol === 'suspendido')
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Contacta soporte.' });

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email || '', rol: usuario.rol || 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...u } = usuario;
    res.json({ token, usuario: { puntos: 0, total_co2_salvado_kg: 0, total_bolsas_salvadas: 0, total_ahorrado: 0, ...u } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/oauth-complete — finaliza login con Google OAuth (Supabase session → JWT propio)
router.post('/oauth-complete', async (req, res) => {
  const { supabase_access_token } = req.body;
  if (!supabase_access_token) return res.status(400).json({ error: 'Token OAuth requerido' });

  const { data: { user: supabaseUser }, error } = await supabase.auth.getUser(supabase_access_token);
  if (error || !supabaseUser) return res.status(401).json({ error: 'Token OAuth inválido o expirado' });

  const email = supabaseUser.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'No se pudo obtener el email de Google' });

  const nombre = supabaseUser.user_metadata?.full_name
    || supabaseUser.user_metadata?.name
    || email.split('@')[0];
  const avatar_url = supabaseUser.user_metadata?.avatar_url
    || supabaseUser.user_metadata?.picture
    || null;

  try {
    let { data: usuario } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
    let esNuevo = false;

    if (!usuario) {
      esNuevo = true;
      const hash = await bcrypt.hash(crypto.randomUUID(), 10);
      const { data: newUser, error: createErr } = await supabase
        .from('usuarios')
        .insert([{ email, nombre, avatar_url, rol: 'cliente', password_hash: hash }])
        .select()
        .single();
      if (createErr) return res.status(400).json({ error: createErr.message });
      usuario = newUser;
      try { await supabase.rpc('sumar_puntos', { user_id: usuario.id, puntos: 10 }); } catch { }
    } else if (avatar_url && !usuario.avatar_url) {
      await supabase.from('usuarios').update({ avatar_url }).eq('id', usuario.id);
      usuario.avatar_url = avatar_url;
    }

    if (usuario.rol === 'suspendido')
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Contacta soporte.' });

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, rol: usuario.rol || 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const { password_hash, ...u } = usuario;
    res.json({
      token,
      usuario: { puntos: 0, total_co2_salvado_kg: 0, total_bolsas_salvadas: 0, total_ahorrado: 0, ...u },
      esNuevo,
    });
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
    if (!usuario.password_hash)
      return res.status(401).json({ error: 'Esta cuenta usa otro método de inicio de sesión (Google o teléfono).' });
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

// POST /api/auth/setup-demo — crea o resetea el usuario demo@bocara.gt (rol: cliente)
router.post('/setup-demo', async (req, res) => {
  const { secret } = req.body;
  const expectedSecret = process.env.ADMIN_SETUP_SECRET || 'bocara-setup-2025';
  if (secret !== expectedSecret) return res.status(403).json({ error: 'Secret incorrecto' });

  const demoEmail = 'demo@bocara.gt';
  const demoPassword = 'Demo1234!';

  try {
    const hash = await bcrypt.hash(demoPassword, 10);
    const { data: existing } = await supabase
      .from('usuarios')
      .select('id,email,rol')
      .eq('email', demoEmail)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from('usuarios')
        .update({ password_hash: hash, rol: 'cliente', nombre: 'Usuario Demo' })
        .eq('email', demoEmail)
        .select('id,email,rol')
        .single();
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, action: 'updated', usuario: data, password: demoPassword });
    }

    const { data, error } = await supabase
      .from('usuarios')
      .insert([{ email: demoEmail, password_hash: hash, nombre: 'Usuario Demo', rol: 'cliente' }])
      .select('id,email,rol')
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, action: 'created', usuario: data, password: demoPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/setup-admin
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

    const { data: existing } = await supabase
      .from('usuarios')
      .select('id,email,rol,password_hash')
      .eq('email', adminEmail)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from('usuarios')
        .update({ password_hash: hash, rol: 'admin', nombre: existing.nombre || 'Admin' })
        .eq('email', adminEmail)
        .select('id,email,rol')
        .single();
      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, action: 'updated', usuario: data });
    }

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
