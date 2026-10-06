// Escena sintética "plato de comida" para probar la validación de imágenes
// sin fotos reales en el repo: fondo con textura, un plato, comida de varios
// colores y elementos asimétricos (así un espejo o un plato distinto se notan).
const sharp = require('sharp');

async function escena(blobs, { ancho = 900, alto = 675, semilla = 1 } = {}) {
  let s = semilla;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const raw = Buffer.alloc(ancho * alto * 3);
  const lim = (v) => Math.max(0, Math.min(255, v));
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 3;
      const n = (rnd() - 0.5) * 30;
      let c = [150 + n, 130 + n, 110 + n];
      for (const b of blobs) {
        const dx = x - b.x, dy = y - b.y;
        if (dx * dx + dy * dy < b.r * b.r) { const t = (rnd() - 0.5) * 40; c = [b.c[0] + t, b.c[1] + t, b.c[2] + t]; }
      }
      raw[i] = lim(c[0]); raw[i + 1] = lim(c[1]); raw[i + 2] = lim(c[2]);
    }
  }
  return sharp(raw, { raw: { width: ancho, height: alto, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

const PLATO = [
  { x: 330, y: 300, r: 220, c: [235, 232, 225] }, // plato
  { x: 300, y: 280, r: 120, c: [170, 90, 40] },   // carne
  { x: 420, y: 360, r: 60, c: [60, 140, 50] },    // ensalada
  { x: 720, y: 160, r: 80, c: [200, 40, 40] },    // salsa / bebida
  { x: 760, y: 560, r: 50, c: [230, 190, 60] },   // pan
];
const OTRO_PLATO = [
  { x: 600, y: 420, r: 200, c: [240, 240, 235] },
  { x: 620, y: 430, r: 110, c: [220, 180, 90] },
  { x: 200, y: 150, r: 70, c: [90, 60, 30] },
];

module.exports = { escena, PLATO, OTRO_PLATO };
