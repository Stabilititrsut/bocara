// Prueba manual de calidad de la mejora con IA REAL (Replicate / FLUX.1
// Kontext [pro]) sobre fotos reales de comida. NO toca la base de datos ni el
// Storage: lee fotos locales (o URLs https), llama al proveedor y genera una
// página de comparación ORIGINAL vs MEJORADA con las métricas de validación.
//
//   REPLICATE_API_TOKEN=r8_... node scripts/probar-mejora-ia.js foto1.jpg foto2.jpg ... [--salida carpeta]
//   node scripts/probar-mejora-ia.js fotos/*.jpg --local     # ajuste técnico gratis (NO es IA), para comparar
//
// Cada foto con Replicate es una ejecución de pago (ver docs/PIPELINE_IMAGENES.md §Costos).
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const { crearProveedorReplicate, proveedorLocal, PROMPT_COMIDA } = require('../services/imagenes/proveedores');
const { prepararEntrada, validarResultado } = require('../services/imagenes/validacion');

const args = process.argv.slice(2);
const usarLocal = args.includes('--local');
const iSalida = args.indexOf('--salida');
const salida = iSalida >= 0 ? args[iSalida + 1] : path.join(os.tmpdir(), `bocara-prueba-ia-${Date.now()}`);
const entradas = args.filter((a, i) => !a.startsWith('--') && !(iSalida >= 0 && i === iSalida + 1));

if (!entradas.length) {
  console.error('Uso: node scripts/probar-mejora-ia.js foto1.jpg [foto2.jpg ...] [--local] [--salida carpeta]');
  process.exit(1);
}
if (!usarLocal && !process.env.REPLICATE_API_TOKEN) {
  console.error('Falta REPLICATE_API_TOKEN (o usa --local para el ajuste técnico gratuito, que NO es IA).');
  process.exit(1);
}

const proveedor = usarLocal ? proveedorLocal : crearProveedorReplicate();
const CRITERIOS = ['Luz', 'Color', 'Nitidez', 'Aspecto comercial', 'Fidelidad', 'Ingredientes', 'Logos/textos', 'Proporciones', 'Naturalidad'];

async function leer(entrada) {
  if (/^https:\/\//.test(entrada)) {
    const { data } = await axios.get(entrada, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024 });
    return { buffer: Buffer.from(data), url: entrada };
  }
  return { buffer: fs.readFileSync(entrada), url: null };
}

(async () => {
  fs.mkdirSync(salida, { recursive: true });
  const filas = [];
  for (const [i, entrada] of entradas.entries()) {
    const n = String(i + 1).padStart(2, '0');
    process.stdout.write(`[${n}] ${entrada} … `);
    try {
      const { buffer, url } = await leer(entrada);
      const prep = await prepararEntrada(buffer);
      // Archivo local → data URI de una copia ≤ 1536 px (JPEG 85) para no
      // depender de subirlo a ningún lado. Una URL https se pasa tal cual.
      let urlEntrada = url;
      if (!urlEntrada || prep.requiereCopia) {
        const chica = await sharp(prep.buffer).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        urlEntrada = `data:image/jpeg;base64,${chica.toString('base64')}`;
      }
      const inicio = Date.now();
      const r = await proveedor.mejorar({ buffer: prep.buffer, urlEntrada, urlOriginal: url });
      let metricas, veredicto;
      try { metricas = await validarResultado(prep.buffer, r.buffer); veredicto = 'PASA validación automática'; }
      catch (err) { metricas = err.metricas || {}; veredicto = `RECHAZADA: ${err.message}`; }
      fs.writeFileSync(path.join(salida, `${n}-original.jpg`), await sharp(prep.buffer).jpeg({ quality: 92 }).toBuffer());
      fs.writeFileSync(path.join(salida, `${n}-mejorada.webp`), r.buffer);
      filas.push({ n, entrada, metricas, veredicto, ms: Date.now() - inicio, meta: r.meta });
      console.log(`${veredicto} (${Date.now() - inicio} ms)`);
    } catch (err) {
      filas.push({ n, entrada, error: err.message });
      console.log(`ERROR: ${err.message}`);
    }
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>Bocara — prueba de mejora</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#f6f5f2;color:#222}
.par{display:grid;grid-template-columns:1fr 1fr;gap:12px}.par img{width:100%;border-radius:8px;background:#ddd}
section{background:#fff;padding:16px;border-radius:12px;margin-bottom:24px}table{border-collapse:collapse;margin-top:8px}
td,th{border:1px solid #ddd;padding:4px 10px;font-size:13px}code{font-size:12px}</style>
<h1>Prueba de mejora — ${usarLocal ? 'ajuste técnico local (NO es IA)' : `IA: ${esc(proveedor.modelo)}`}</h1>
<p>${new Date().toISOString()} · La prueba NO pasa porque la API respondió: pasa si la foto se ve mejor <b>y</b> el producto sigue siendo el mismo.</p>
${filas.map((f) => `<section><h2>${f.n}. ${esc(path.basename(f.entrada))}</h2>${f.error ? `<p>Error: ${esc(f.error)}</p>` : `
<div class="par"><figure><img src="${f.n}-original.jpg"><figcaption>ORIGINAL</figcaption></figure>
<figure><img src="${f.n}-mejorada.webp"><figcaption>MEJORADA</figcaption></figure></div>
<p><b>${esc(f.veredicto)}</b> · ${f.ms} ms · similitud ${f.metricas.similitud ?? '–'} · saturación ${f.metricas.saturacion_original ?? '–'} → ${f.metricas.saturacion_resultado ?? '–'} · diferencia ${f.metricas.diferencia_media ?? '–'}${f.meta?.prediccion ? ` · predicción <code>${esc(f.meta.prediccion)}</code>` : ''}</p>
<table><tr><th>Criterio</th><th>Mejor</th><th>Igual</th><th>Peor / infiel</th><th>Nota</th></tr>
${CRITERIOS.map((c) => `<tr><td>${c}</td><td>☐</td><td>☐</td><td>☐</td><td></td></tr>`).join('')}</table>`}</section>`).join('')}
<details><summary>Prompt usado</summary><p>${esc(PROMPT_COMIDA)}</p></details>`;
  fs.writeFileSync(path.join(salida, 'index.html'), html);
  console.log(`\nComparación: ${path.join(salida, 'index.html')}`);
})();
