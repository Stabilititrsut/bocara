// Verificación de la IA de Bocara contra los servicios REALES (manual: no lo
// corren los tests ni CI). Usa backend/.env.
//   node scripts/verificar-ia.js            diagnóstico + prueba en vivo de Gemini y OpenAI
//                                           + una descripción real con Gemini (costo ~0)
//   node scripts/verificar-ia.js --imagen   además, el flujo completo de imagen con OpenAI
//                                           (analizar → mejorar → validar; ~US$0.01–0.02)
//   node scripts/verificar-ia.js --imagen ruta/a/foto.jpg   con una foto propia
// Lo mismo, sin la mejora de imagen, responde GET /api/ia/status?probar=1.
// Termina con código 1 si algo no está operativo.
require('dotenv').config();
const fs = require('fs');
const { estadoCompleto } = require('../services/iaEstado');
const textoIA = require('../services/text-ai');
const { crearRevisorIA } = require('../services/imagenes/revisionIA');
const { obtenerProveedor } = require('../services/imagenes/proveedores');
const { analizarCalidad, analizarRecuperable } = require('../services/imagenes/calidad');
const { prepararEntrada, validarResultado } = require('../services/imagenes/validacion');

const ok = (m) => console.log(`  ✅ ${m}`);
const mal = (m) => console.log(`  ❌ ${m}`);
const linea = (nombre, estado, motivo) => console.log(`  ${estado === 'OK' ? '✅' : '❌'} ${nombre}: ${estado}${motivo ? ` — ${motivo}` : ''}`);

async function fotoDePrueba() {
  const ruta = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
  if (ruta) return fs.readFileSync(ruta);
  const { escena, PLATO } = require('../test/helpers/escenaComida');
  return escena(PLATO);
}

async function main() {
  let fallas = 0;
  console.log('\n[1] Diagnóstico (configuración + prueba en vivo)');
  const e = await estadoCompleto({ probar: true });
  linea('Gemini texto ', e.resumen.gemini_texto, e.texto.prueba?.motivo || e.texto.mensaje);
  linea('OpenAI imagen', e.resumen.openai_imagen, e.imagen.prueba?.motivo || e.imagen.mensaje);
  linea('Migraciones  ', e.resumen.migraciones === 'OK' ? 'OK' : 'ERROR', e.migraciones.mensaje);
  console.log(`     modelos: texto=${e.modelos.texto} imagen=${e.modelos.imagen} revisión=${e.modelos.revision_imagen}`);
  if (e.faltan_claves.length) console.log(`     faltan en backend/.env: ${e.faltan_claves.join(', ')}`);
  if (Object.values(e.resumen).some((v) => v !== 'OK')) fallas += 1;

  console.log('\n[2] Descripción — Gemini (llamada real)');
  if (e.resumen.gemini_texto !== 'OK') mal('omitido: Gemini no está operativo (ver [1])');
  else {
    try {
      const { datos } = textoIA.validarEntrada({ tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'hamburguesa de res con papas fritas', precio_original: 60, precio_descuento: 35 });
      const r = await textoIA.generarDescripcion(datos);
      ok(`"${r.descripcion}" (${r.meta.modelo}, ${r.meta.ms} ms)`);
    } catch (err) { mal(`${err.codigo || ''} ${err.message}`); fallas += 1; }
  }

  if (process.argv.includes('--imagen')) {
    console.log('\n[3] Imagen — flujo completo con OpenAI (llamadas reales, con costo)');
    if (e.resumen.openai_imagen !== 'OK') mal('omitido: OpenAI no está operativo (ver [1])');
    else {
      try {
        const foto = await fotoDePrueba();
        const rec = await analizarRecuperable(foto);
        if (!rec.ok) throw new Error(`rechazada antes de mejorar (irreparable): ${rec.motivos.map((m) => m.codigo).join(', ')}`);
        ok(`analizada: recuperable; a corregir: [${rec.problemas.map((p) => p.codigo).join(', ')}]`);
        const prep = await prepararEntrada(foto);
        const revisor = crearRevisorIA();
        const rev = await revisor.revisar(prep.buffer, { modo: 'original' });
        if (rev.irreparable) throw new Error(`rechazada: ${rev.problemas.map((p) => p.codigo).join(', ')}`);
        ok(`revisión original: apta=${rev.apta} [${rev.problemas.map((p) => p.codigo).join(', ')}] — ${rev.resumen}`);
        const problemas = [...new Set([...rec.problemas, ...rev.problemas].map((p) => p.codigo))];
        const proveedor = obtenerProveedor();
        const r = await proveedor.mejorar({ buffer: prep.buffer, contexto: { problemas } });
        fs.writeFileSync('verificacion-mejorada.webp', r.buffer);
        ok(`mejorada con ${proveedor.nombre}/${proveedor.modelo} en ${r.meta?.ms} ms → verificacion-mejorada.webp`);
        const val = await validarResultado(prep.buffer, r.buffer);
        const pub = await analizarCalidad(r.buffer, { nivel: 'publicable' });
        const fin = await revisor.revisar(r.buffer, { modo: 'resultado' });
        const lista = pub.ok && fin.apta;
        (lista ? ok : mal)(`validación: similitud=${val.similitud} publicable=${pub.ok ? 'sí' : pub.motivos.map((m) => m.codigo).join(',')} revisión final apta=${fin.apta} → ${lista ? 'LISTA PARA PUBLICAR' : 'NO PUBLICABLE'}`);
        if (!lista) fallas += 1;
      } catch (err) { mal(err.message); fallas += 1; }
    }
  }
  console.log(fallas ? '\nResultado: HAY PIEZAS NO OPERATIVAS (ver ❌).\n' : '\nResultado: IA operativa.\n');
  process.exit(fallas ? 1 : 0);
}

main();
