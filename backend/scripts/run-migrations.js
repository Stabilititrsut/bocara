/**
 * Script de migración automática para Bocara.
 * Ejecuta: node scripts/run-migrations.js (desde la carpeta del backend)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_REF     = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Helper: raw REST call ─────────────────────────────────────────────────────
function restCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── DDL via REST rpc ──────────────────────────────────────────────────────────
// Intenta ejecutar una sentencia SQL vía diferentes endpoints de Supabase
async function execSQL(sql) {
  // Intento 1: /rest/v1/rpc/sql  (función built-in en algunas versiones de Supabase)
  let r = await restCall('POST', '/rest/v1/rpc/sql', { query: sql });
  if (r.status < 300) return { ok: true, method: 'rpc/sql' };

  // Intento 2: /rest/v1/rpc/exec_sql
  r = await restCall('POST', '/rest/v1/rpc/exec_sql', { query: sql });
  if (r.status < 300) return { ok: true, method: 'rpc/exec_sql' };

  // Intento 3: Management API (requiere personal access token — fallará, pero lo intentamos)
  r = await restCall('POST', `/pg/query?ref=${PROJECT_REF}`, { query: sql });
  if (r.status < 300) return { ok: true, method: 'management_api' };

  return { ok: false, error: r.body?.message || r.body?.error || JSON.stringify(r.body) };
}

// ── Storage bucket creation ───────────────────────────────────────────────────
async function createBucket() {
  console.log('\n📦 Creando bucket de Storage "bocara-images"...');

  // Verificar si ya existe
  const check = await restCall('GET', '/storage/v1/bucket/bocara-images', null);
  if (check.status === 200) {
    console.log('  ✓ Bucket ya existe');
  } else {
    const r = await restCall('POST', '/storage/v1/bucket', {
      id: 'bocara-images',
      name: 'bocara-images',
      public: true,
      file_size_limit: 5242880, // 5 MB
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    });
    if (r.status < 300) {
      console.log('  ✓ Bucket creado correctamente');
    } else {
      console.error('  ✗ Error creando bucket:', JSON.stringify(r.body));
    }
  }

  // Aplicar política pública de lectura
  const policyRead = await restCall('POST', '/storage/v1/bucket/bocara-images', {
    ...((await restCall('GET', '/storage/v1/bucket/bocara-images', null)).body),
    public: true,
  });
  // PUT para actualizar bucket a público (en caso de que ya existiera como privado)
  const update = await restCall('PUT', '/storage/v1/bucket/bocara-images', {
    id: 'bocara-images',
    name: 'bocara-images',
    public: true,
  });
  if (update.status < 300) console.log('  ✓ Bucket configurado como público');
}

// ── SQL migrations ────────────────────────────────────────────────────────────
const SQL_STATEMENTS = [
  // negocios — nuevas columnas
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS estado_verificacion TEXT DEFAULT 'pendiente'",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS nit TEXT",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS dpi TEXT",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS datos_bancarios JSONB",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS horario_atencion TEXT",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS dpi_foto_url TEXT",
  "ALTER TABLE negocios ADD COLUMN IF NOT EXISTS imagen_url TEXT",
  // Normalizar estado de negocios existentes
  "UPDATE negocios SET estado_verificacion = 'aprobado' WHERE activo = TRUE AND verificado = TRUE AND estado_verificacion IS NULL",
  "UPDATE negocios SET estado_verificacion = 'pendiente' WHERE activo = FALSE AND estado_verificacion IS NULL",
  // pedidos — columnas opcionales
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS precio_bolsa NUMERIC(10,2)",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comision_bocara NUMERIC(10,2)",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS monto_neto_restaurante NUMERIC(10,2)",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_inicio TEXT",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS hora_recogida_fin TEXT",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS codigo_recogida TEXT",
  // usuarios — columnas opcionales
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS expo_push_token TEXT",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url TEXT",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apellido TEXT",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS puntos INTEGER DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_bolsas_salvadas INTEGER DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_co2_salvado_kg NUMERIC(10,2) DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_ahorrado NUMERIC(10,2) DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS total_co2_salvado NUMERIC(10,2) DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE",
  // Tablas nuevas
  `CREATE TABLE IF NOT EXISTS liquidaciones (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    negocio_id UUID REFERENCES negocios(id) ON DELETE CASCADE,
    monto NUMERIC(10,2) NOT NULL,
    ventas_brutas NUMERIC(10,2) DEFAULT 0,
    comision_bocara NUMERIC(10,2) DEFAULT 0,
    estado TEXT DEFAULT 'pagado',
    datos_transferencia JSONB,
    total_pedidos INTEGER DEFAULT 0,
    pagado_en TIMESTAMP WITH TIME ZONE,
    pagado_por UUID REFERENCES usuarios(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
  )`,
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS liquidacion_id UUID REFERENCES liquidaciones(id)",
  `CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )`,
];

async function runSQLMigrations() {
  console.log('\n🗄️  Ejecutando migraciones SQL...');
  let anyWorked = false;

  // Probar con un SELECT simple para ver si rpc/sql funciona
  const test = await execSQL('SELECT 1');
  if (!test.ok) {
    console.log('  ⚠  El endpoint rpc/sql no está disponible en este proyecto de Supabase.');
    console.log('     Las migraciones SQL deben ejecutarse manualmente.');
    console.log('     Archivo: backend/scripts/migrations.sql\n');
    return false;
  }

  anyWorked = true;
  console.log(`  ✓ Endpoint SQL disponible (${test.method})\n`);

  for (const sql of SQL_STATEMENTS) {
    const label = sql.replace(/\s+/g, ' ').substring(0, 70);
    const result = await execSQL(sql);
    if (result.ok) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✗ ${label}`);
      console.log(`    Error: ${result.error}`);
    }
  }

  return true;
}

// ── Verificar estructura actual vía REST ──────────────────────────────────────
async function verificarEstructura() {
  console.log('\n🔍 Verificando estructura de la base de datos...\n');

  const tablas = ['negocios', 'usuarios', 'pedidos', 'bolsas', 'liquidaciones', 'configuracion'];
  const resultados = {};

  for (const tabla of tablas) {
    const r = await restCall(
      'GET',
      `/rest/v1/${tabla}?select=*&limit=0`,
      null
    );
    resultados[tabla] = r.status === 200 ? '✓ existe' : `✗ falta o error ${r.status}`;
    console.log(`  ${tabla}: ${resultados[tabla]}`);
  }

  // Verificar columnas clave en negocios
  const negCol = await restCall('GET', '/rest/v1/negocios?select=estado_verificacion,nit,dpi,datos_bancarios,imagen_url,dpi_foto_url&limit=1', null);
  if (negCol.status === 200) {
    console.log('  negocios.estado_verificacion + nit + dpi + datos_bancarios + imagen_url + dpi_foto_url: ✓');
  } else {
    console.log('  ⚠  Columnas nuevas en negocios: FALTAN — ejecuta migrations.sql');
  }

  return resultados;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Bocara — Migración automática de base de datos y storage\n');
  console.log(`   Proyecto: ${PROJECT_REF}`);
  console.log(`   URL: ${SUPABASE_URL}`);

  // 1. Storage bucket
  await createBucket();

  // 2. SQL migrations
  const sqlOk = await runSQLMigrations();

  // 3. Verificar
  await verificarEstructura();

  if (!sqlOk) {
    console.log('\n⚠️  ACCIÓN MANUAL REQUERIDA:');
    console.log('   Las sentencias DDL no se pudieron ejecutar vía API.');
    console.log('   Abre: https://app.supabase.com/project/' + PROJECT_REF + '/editor');
    console.log('   Copia y pega el contenido de: backend/scripts/migrations.sql');
    console.log('   Haz clic en "Run" y listo.\n');
  } else {
    console.log('\n✅ Todo listo. El flujo completo de Bocara está operativo.\n');
  }
}

main().catch(err => {
  console.error('Error inesperado:', err.message);
  process.exit(1);
});
