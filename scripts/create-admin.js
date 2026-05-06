/**
 * Script para crear/reparar el usuario admin en la tabla pública `usuarios`.
 * Usa bcryptjs (compatible con el sistema de autenticación del backend).
 *
 * Uso local:
 *   node scripts/create-admin.js
 *
 * Variables de entorno requeridas: SUPABASE_URL, SUPABASE_SERVICE_KEY (o SUPABASE_ANON_KEY)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const EMAIL    = process.env.ADMIN_EMAIL    || 'admin@bocarafood.com';
const PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234';

async function main() {
  console.log(`\n🔑 Configurando usuario admin: ${EMAIL}\n`);

  const hash = await bcrypt.hash(PASSWORD, 10);
  console.log('✓ Hash bcrypt generado');

  // Verificar si ya existe
  const { data: existing, error: fetchErr } = await supabase
    .from('usuarios')
    .select('id,email,rol,password_hash')
    .eq('email', EMAIL)
    .single();

  if (existing) {
    const esBcrypt = existing.password_hash && existing.password_hash.startsWith('$2');
    console.log(`✓ Usuario encontrado (ID: ${existing.id})`);
    console.log(`  Rol actual: ${existing.rol}`);
    console.log(`  Hash válido: ${esBcrypt ? 'Sí' : 'NO — necesita reparación'}`);

    const { data, error } = await supabase
      .from('usuarios')
      .update({ password_hash: hash, rol: 'admin', nombre: 'Admin' })
      .eq('email', EMAIL)
      .select('id,email,rol')
      .single();

    if (error) {
      console.error('✗ Error actualizando:', error.message);
      process.exit(1);
    }
    console.log('\n✅ Usuario admin actualizado correctamente');
    console.log('   Email :', data.email);
    console.log('   Rol   :', data.rol);
    console.log('   Pass  :', PASSWORD);
  } else {
    if (fetchErr && !fetchErr.message.includes('No rows')) {
      console.error('✗ Error consultando:', fetchErr.message);
    }

    console.log('  No existe — creando...');
    const { data, error } = await supabase
      .from('usuarios')
      .insert([{ email: EMAIL, password_hash: hash, nombre: 'Admin', rol: 'admin' }])
      .select('id,email,rol')
      .single();

    if (error) {
      console.error('✗ Error creando:', error.message);
      process.exit(1);
    }
    console.log('\n✅ Usuario admin creado correctamente');
    console.log('   Email :', data.email);
    console.log('   Rol   :', data.rol);
    console.log('   Pass  :', PASSWORD);
  }

  console.log('\n🚀 Ya puedes hacer login en bocara.vercel.app con esas credenciales.\n');
}

main().catch(err => {
  console.error('Error inesperado:', err.message);
  process.exit(1);
});
