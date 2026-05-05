require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function createAdmin() {
  const EMAIL    = 'admin@bocarafood.com';
  const PASSWORD = 'Admin1234';

  // 1. Crear usuario en auth.users
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });

  if (authError) {
    if (authError.message.includes('already been registered') || authError.code === 'email_exists') {
      console.log('El usuario ya existe en auth. Buscando su UUID...');
      const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
      if (listErr) { console.error('Error listando usuarios:', listErr.message); process.exit(1); }
      const existing = list.users.find(u => u.email === EMAIL);
      if (!existing) { console.error('No se encontró el usuario existente.'); process.exit(1); }
      return upsertUsuariosRow(existing.id, EMAIL);
    }
    console.error('Error creando usuario en auth:', authError.message);
    process.exit(1);
  }

  console.log('Usuario auth creado:', authData.user.id);
  await upsertUsuariosRow(authData.user.id, EMAIL);
}

async function upsertUsuariosRow(id, email) {
  // 2. Insertar / actualizar fila en tabla pública usuarios
  const { error } = await supabase.from('usuarios').upsert({
    id,
    email,
    nombre: 'Admin',
    rol: 'admin',
    password_hash: 'SUPABASE_AUTH', // auth manejada por Supabase Auth, no usado
  }, { onConflict: 'id' });

  if (error) {
    console.error('Error insertando en tabla usuarios:', error.message);
    process.exit(1);
  }

  console.log('✓ Usuario admin creado correctamente');
  console.log('  Email   :', email);
  console.log('  UUID    :', id);
  console.log('  Rol     : admin');
}

createAdmin();
