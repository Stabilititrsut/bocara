// Encola la mejora de fotos que existían antes del pipeline (estado NULL).
// Por lotes y bajo demanda — nunca automático — para controlar costo/carga:
//
//   node scripts/encolar-imagenes-existentes.js            # simulacro (no escribe)
//   node scripts/encolar-imagenes-existentes.js --aplicar --limite 50 --tabla bolsas
//
// Solo encola (estado pendiente); el job del backend las procesa a su ritmo.
require('dotenv').config();
const { solicitarMejora } = require('../services/imagenes/pipeline');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const limite = Number(args[args.indexOf('--limite') + 1]) || 20;
const tablas = args.includes('--tabla') ? [args[args.indexOf('--tabla') + 1]] : ['bolsas', 'negocios'];

(async () => {
  const supabase = require('../config/supabase');
  for (const tabla of tablas) {
    let q = supabase.from(tabla).select('id, imagen_url').is('estado_procesamiento_imagen', null)
      .not('imagen_url', 'is', null).limit(limite);
    if (tabla === 'bolsas') q = q.is('eliminado_en', null);
    const { data, error } = await q;
    if (error) { console.error(`[${tabla}] ${error.message}`); process.exitCode = 1; continue; }
    console.log(`[${tabla}] ${data.length} foto(s) sin procesar${aplicar ? '' : ' (simulacro: usa --aplicar)'}`);
    if (!aplicar) continue;
    let ok = 0;
    for (const fila of data) if ((await solicitarMejora(tabla, fila.id, fila.imagen_url)).ok) ok += 1;
    console.log(`[${tabla}] encoladas: ${ok}`);
  }
})();
