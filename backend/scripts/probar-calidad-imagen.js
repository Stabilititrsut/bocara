// Calibrar la calidad mínima con fotos REALES (sin IA, sin costo, sin BD).
//   node scripts/probar-calidad-imagen.js <carpeta-o-archivo> [...]
// Imprime las métricas de cada foto y si pasaría los niveles 'original'
// (¿recuperable?) y 'publicable' (¿presentable tal cual?). Con eso se ajustan
// las variables IMAGE_QUALITY_* (services/imagenes/calidad.js).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { analizarCalidad, umbralesCalidad } = require('../services/imagenes/calidad');

const EXT = /\.(jpe?g|png|webp|heic)$/i;
function archivos(rutas) {
  return rutas.flatMap((r) => {
    const st = fs.statSync(r);
    if (st.isDirectory()) return fs.readdirSync(r).filter((f) => EXT.test(f)).map((f) => path.join(r, f));
    return [r];
  });
}

async function main() {
  const rutas = process.argv.slice(2);
  if (!rutas.length) {
    console.log('Uso: node scripts/probar-calidad-imagen.js <carpeta-o-archivo> [...]');
    process.exit(1);
  }
  console.log('Umbrales:', JSON.stringify(umbralesCalidad(), null, 2), '\n');
  for (const f of archivos(rutas)) {
    const buffer = fs.readFileSync(f);
    const o = await analizarCalidad(buffer, { nivel: 'original' });
    const p = await analizarCalidad(buffer, { nivel: 'publicable' });
    const m = o.metricas || {};
    console.log(`${path.basename(f)}\n  ${m.ancho}x${m.alto} prop=${m.proporcion} brillo=${m.brillo} contraste=${m.contraste} nitidez=${m.nitidez} oscuros=${m.oscuros} quemados=${m.quemados}`);
    console.log(`  original:   ${o.ok ? 'PASA' : 'RECHAZA → ' + o.motivos.map((x) => x.codigo).join(', ')}`);
    console.log(`  publicable: ${p.ok ? 'PASA' : 'NO → ' + p.motivos.map((x) => x.codigo).join(', ')}\n`);
  }
}

main();
