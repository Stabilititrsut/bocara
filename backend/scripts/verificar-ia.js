// Verificación de la IA de Bocara contra los servicios REALES (manual: no lo
// corren los tests ni CI). Usa backend/.env.
//   node scripts/verificar-ia.js                          infraestructura: diagnóstico + prueba en vivo
//                                                         de Gemini y OpenAI + una descripción real
//   node scripts/verificar-ia.js --imagen "C:\ruta\comida.jpg"
//                                                         además, procesa ESA foto con el flujo real
//                                                         de la app (~US$0.015 por foto)
//   node scripts/verificar-ia.js --imagen                 igual, con una escena sintética interna
//                                                         (no es una foto real: la revisión puede
//                                                         rechazarla como no_es_comida, y está bien)
//
// Separa dos cosas que no son lo mismo:
//   · Infraestructura IA: ¿responden Gemini y OpenAI? ¿hay claves y migraciones?
//   · Resultado de la foto: lista / rechazada / no publicable según las reglas
//     de calidad. Un rechazo (p. ej. no_es_comida) NO es una falla de la IA.
// La foto se procesa con trabajos.procesarTrabajo (las MISMAS reglas que la
// app) sobre una tabla en memoria: no toca la base de datos ni el Storage.
// Código de salida: 1 solo si la infraestructura falla.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { estadoCompleto } = require('../services/iaEstado');
const textoIA = require('../services/text-ai');
const trabajos = require('../services/imagenes/trabajos');

const linea = (nombre, estado, motivo) => console.log(`  ${estado === 'OK' ? '✅' : '❌'} ${nombre}: ${estado}${motivo ? ` — ${motivo}` : ''}`);

// Fallos del trabajo que son de infraestructura; el resto es veredicto sobre la foto.
const FALLOS_INFRA = new Set(['ia_no_configurada', 'proveedor', 'proveedor_sin_credito', 'proveedor_clave', 'proveedor_modelo', 'interno', 'interrumpido']);

function rutaFoto() {
  return process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
}

async function fotoDePrueba(ruta) {
  if (ruta) return fs.readFileSync(ruta);
  const { escena, PLATO } = require('../test/helpers/escenaComida');
  return escena(PLATO);
}

// Corre el flujo real de la app sobre la foto, en memoria.
async function procesarFoto(foto) {
  const { crearFakeSupabase } = require('../test/helpers/fakeSupabase');
  const HOST = 'verificacion.local';
  const cliente = crearFakeSupabase({
    trabajos_imagen: [{ id: 'verificacion', estado: 'subida', original_url: `https://${HOST}/original`, intentos: 0, usuario_id: 'local', negocio_id: 'local' }],
  });
  let mejorada = null;
  const estado = await trabajos.procesarTrabajo('verificacion', {
    cliente,
    hosts: new Set([HOST]),
    descargar: async () => ({ buffer: foto, contentType: 'application/octet-stream' }),
    almacenamiento: { subir: async (ruta, buffer) => { mejorada = buffer; return `https://${HOST}/${ruta}`; } },
  });
  return { estado, trabajo: trabajos.serializar(cliente.tabla('trabajos_imagen')[0], { expone: true }), mejorada };
}

async function main() {
  const infra = []; // motivos de falla de infraestructura

  console.log('\n[1] Infraestructura (configuración + prueba en vivo)');
  const e = await estadoCompleto({ probar: true });
  linea('Gemini texto ', e.resumen.gemini_texto, e.texto.prueba?.motivo || e.texto.mensaje);
  linea('OpenAI imagen', e.resumen.openai_imagen, e.imagen.prueba?.motivo || e.imagen.mensaje);
  linea('Migraciones  ', e.resumen.migraciones === 'OK' ? 'OK' : 'ERROR', e.migraciones.mensaje);
  console.log(`     modelos: texto=${e.modelos.texto} (respaldo ${e.modelos.texto_respaldo || '-'}) imagen=${e.modelos.imagen} revisión=${e.modelos.revision_imagen}`);
  if (e.faltan_claves.length) console.log(`     faltan en backend/.env: ${e.faltan_claves.join(', ')}`);
  if (e.resumen.gemini_texto !== 'OK') infra.push(`Gemini: ${e.texto.prueba?.motivo || e.texto.mensaje}`);
  if (e.resumen.openai_imagen !== 'OK') infra.push(`OpenAI: ${e.imagen.prueba?.motivo || e.imagen.mensaje}`);
  if (e.resumen.migraciones !== 'OK') infra.push(e.migraciones.mensaje);

  console.log('\n[2] Descripción — Gemini (llamada real)');
  if (e.resumen.gemini_texto !== 'OK') console.log('  ⏭️  omitida: Gemini no está operativo (ver [1])');
  else {
    try {
      const { datos } = textoIA.validarEntrada({ tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'hamburguesa de res con papas fritas', precio_original: 60, precio_descuento: 35 });
      const r = await textoIA.generarDescripcion(datos);
      console.log(`  ✅ "${r.descripcion}" (${r.meta.modelo}, ${r.meta.ms} ms)`);
    } catch (err) {
      console.log(`  ❌ ${err.codigo || ''} ${err.message}`);
      infra.push(`Gemini (descripción): ${err.message}`);
    }
  }

  let resultadoFoto = null;
  if (process.argv.includes('--imagen')) {
    const ruta = rutaFoto();
    console.log(`\n[3] Foto — flujo real de la app con OpenAI (llamadas reales, con costo)`);
    console.log(`     foto: ${ruta ? path.resolve(ruta) : 'escena sintética interna (no es una foto real; pasa una ruta para probar comida real)'}`);
    if (e.resumen.openai_imagen !== 'OK') {
      console.log('  ⏭️  omitida: OpenAI no está operativo (ver [1])');
      resultadoFoto = 'NO EVALUADA — OpenAI no operativo';
    } else {
      let foto;
      try { foto = await fotoDePrueba(ruta); } catch (err) {
        console.log(`  ❌ no se pudo leer la foto: ${err.message}`);
        resultadoFoto = `NO EVALUADA — no se pudo leer ${ruta}`;
      }
      if (foto) {
        const { estado, trabajo: t, mejorada } = await procesarFoto(foto);
        const codigos = (t.motivos || []).map((m) => m.codigo).join(', ');
        const mensajes = (t.motivos || []).map((m) => `       · ${m.mensaje}`).join('\n');
        if (t.problemas_corregidos.length) console.log(`     problemas detectados en la original (a corregir con IA): ${t.problemas_corregidos.join(', ')}`);
        if (estado === 'lista') {
          if (mejorada) fs.writeFileSync('verificacion-mejorada.webp', mejorada);
          resultadoFoto = t.usa_original
            ? 'LISTA PARA PUBLICAR — se usa la original (ya cumplía; la versión IA no pasó la validación)'
            : 'LISTA PARA PUBLICAR — mejorada guardada en verificacion-mejorada.webp';
        } else if (estado === 'rechazada') {
          resultadoFoto = `RECHAZADA en "${t.paso_error}" — ${codigos}`;
          if (mensajes) console.log(mensajes);
        } else if (estado === 'fallida' && FALLOS_INFRA.has(t.error_codigo)) {
          infra.push(`OpenAI durante el procesamiento (${t.error_codigo}): ${t.detalle || t.error}`);
          resultadoFoto = `NO EVALUADA — falla de infraestructura (${t.error_codigo})`;
        } else {
          // validacion / calidad_resultado / descarga: veredicto sobre la foto o el resultado.
          resultadoFoto = `NO PUBLICABLE en "${t.paso_error}" (${t.error_codigo}) — ${t.error}${t.detalle ? ` [${t.detalle}]` : ''}`;
          if (mensajes) console.log(mensajes);
        }
      }
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`Infraestructura IA: ${infra.length ? 'ERROR' : 'OPERATIVA'}`);
  for (const m of infra) console.log(`  · ${m}`);
  if (resultadoFoto) console.log(`Resultado de la foto: ${resultadoFoto}`);
  console.log('');
  process.exit(infra.length ? 1 : 0);
}

main().catch((err) => { console.error('Error inesperado:', err); process.exit(1); });
