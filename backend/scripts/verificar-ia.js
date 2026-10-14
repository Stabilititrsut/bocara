// Verificación de la IA de Bocara contra los servicios REALES (manual: no lo
// corren los tests ni CI). Usa backend/.env.
//   node scripts/verificar-ia.js            diagnóstico + Gemini (texto) + revisión OpenAI (visión)
//   node scripts/verificar-ia.js --imagen   además, una mejora completa con OpenAI GPT Image (~US$0.01–0.02)
//   node scripts/verificar-ia.js --imagen ruta/a/foto.jpg   con una foto propia
// Termina con código 1 si algo no está operativo.
require('dotenv').config();
const fs = require('fs');
const { diagnosticoIA } = require('../services/iaEstado');
const textoIA = require('../services/text-ai');
const { crearRevisorIA } = require('../services/imagenes/revisionIA');
const { obtenerProveedor } = require('../services/imagenes/proveedores');
const { analizarCalidad } = require('../services/imagenes/calidad');
const { prepararEntrada, validarResultado } = require('../services/imagenes/validacion');

const ok = (m) => console.log(`  ✅ ${m}`);
const mal = (m) => console.log(`  ❌ ${m}`);

async function fotoDePrueba() {
  const ruta = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
  if (ruta) return fs.readFileSync(ruta);
  const { escena, PLATO } = require('../test/helpers/escenaComida');
  return escena(PLATO);
}

async function main() {
  let fallas = 0;
  console.log('\n[1] Diagnóstico');
  const d = await diagnosticoIA();
  (d.texto.operativa ? ok : mal)(d.texto.mensaje);
  (d.imagen.operativa ? ok : mal)(d.imagen.mensaje);
  (d.migraciones.ok ? ok : mal)(d.migraciones.mensaje);
  if (!d.texto.operativa || !d.imagen.operativa || !d.migraciones.ok) fallas += 1;

  console.log('\n[2] Texto — Gemini (llamada real)');
  if (!d.texto.operativa) mal('omitido: IA de texto no configurada');
  else {
    try {
      const { datos } = textoIA.validarEntrada({ tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'Hamburguesa con papas', precio_original: 60, precio_descuento: 35 });
      const r = await textoIA.generarDescripcion(datos);
      ok(`"${r.descripcion}" (${r.meta.modelo}, ${r.meta.ms} ms)`);
    } catch (err) { mal(`${err.codigo || ''} ${err.message}`); fallas += 1; }
  }

  console.log('\n[3] Imagen — revisión con visión OpenAI (llamada real)');
  const foto = await fotoDePrueba();
  const calidad = await analizarCalidad(foto);
  (calidad.ok ? ok : mal)(`calidad técnica: ${calidad.ok ? 'pasa' : calidad.motivos.map((m) => m.codigo).join(', ')} ${JSON.stringify(calidad.metricas)}`);
  if (!d.imagen.operativa) mal('omitido: IA de imagen no configurada');
  else {
    try {
      const rev = await crearRevisorIA().revisar(foto);
      ok(`revisión (${process.env.OPENAI_VISION_MODEL || 'gpt-6-luna'}): apta=${rev.apta} ${rev.problemas.map((p) => p.codigo).join(', ')} — ${rev.resumen}`);
    } catch (err) { mal(err.message); fallas += 1; }

    if (process.argv.includes('--imagen')) {
      console.log('\n[4] Imagen — mejora completa con OpenAI GPT Image (llamada real, con costo)');
      try {
        const prep = await prepararEntrada(foto);
        const proveedor = obtenerProveedor();
        const r = await proveedor.mejorar({ buffer: prep.buffer });
        const val = await validarResultado(prep.buffer, r.buffer);
        const pub = await analizarCalidad(r.buffer, { nivel: 'publicable' });
        fs.writeFileSync('verificacion-mejorada.webp', r.buffer);
        ok(`mejorada con ${proveedor.nombre}/${proveedor.modelo}: similitud=${val.similitud}, publicable=${pub.ok} → verificacion-mejorada.webp`);
      } catch (err) { mal(err.message); fallas += 1; }
    }
  }
  console.log(fallas ? '\nResultado: HAY PIEZAS NO OPERATIVAS (ver ❌).\n' : '\nResultado: IA operativa.\n');
  process.exit(fallas ? 1 : 0);
}

main();
