// Prueba MANUAL de la descripción con IA contra el proveedor real (usa
// GEMINI_API_KEY de backend/.env). No la ejecutan los tests ni CI.
//   node scripts/probar-descripcion-ia.js
//   node scripts/probar-descripcion-ia.js '{"tipo":"cupon","nombre":"Descuento miércoles"}'
// Solo manda datos de ejemplo: nunca uses datos reales de clientes.
require('dotenv').config();
const textoIA = require('../services/text-ai');

const EJEMPLOS = [
  { tipo: 'bolsa', nombre: 'Hamburguesa con papas', descripcion: 'Hamburguesa con papas', precio_original: 60, precio_descuento: 35, hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00' },
  { tipo: 'bolsa', nombre: 'Bolsa de panadería', contenido: 'Pan, croissants, galletas', categoria_alimento: 'cereales', precio_original: 80, precio_descuento: 30 },
  { tipo: 'cupon', nombre: 'Descuento miércoles', descripcion: 'promo de miercoles', precio_original: 100, precio_descuento: 75 },
];

async function main() {
  const proveedor = textoIA.obtenerProveedorTexto();
  if (!proveedor) {
    console.error('IA de texto apagada o sin credencial: revisa TEXT_AI_PROVIDER y GEMINI_API_KEY en backend/.env');
    process.exit(1);
  }
  console.log(`Proveedor: ${proveedor.nombre} · modelo: ${proveedor.modelo}\n`);
  const entradas = process.argv[2] ? [JSON.parse(process.argv[2])] : EJEMPLOS;
  for (const entrada of entradas) {
    const { datos, error } = textoIA.validarEntrada(entrada);
    if (error) { console.log(`✖ ${entrada.nombre}: ${error}\n`); continue; }
    try {
      const { descripcion, meta } = await textoIA.generarDescripcion(datos, { proveedor });
      console.log(`▸ ${entrada.nombre}\n  ${descripcion}\n  (${descripcion.length} caracteres · ${meta.ms} ms · tokens ${meta.uso?.entrada}/${meta.uso?.salida})\n`);
    } catch (err) {
      console.log(`✖ ${entrada.nombre}: ${err.codigo || ''} ${err.message}\n`);
    }
  }
}

main();
