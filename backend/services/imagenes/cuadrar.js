// Formato cuadrado SIN IA para la foto de perfil / logo del restaurante.
//
// Un logo válido pero no cuadrado no se rechaza por proporción ni se le pide a
// la IA que lo complete: se agrega relleno técnico (sharp.extend) alrededor.
//   · el logo queda completo, centrado y sin recortar ni reescalar (salvo que
//     supere LADO_MAX, y entonces se reduce entero, sin deformar);
//   · los píxeles del logo no cambian: salida WebP sin pérdida (letras,
//     colores, proporciones internas y símbolos idénticos);
//   · relleno, de forma segura:
//       transparente si el borde de la imagen ya es transparente (logo PNG);
//       el color de fondo dominante si el borde es (casi) uniforme;
//       blanco si el borde es variado (una foto): nunca se estira ni se
//       copia contenido de la imagen.
// Devuelve un archivo NUEVO: la original nunca se modifica.
function sharp() { return require('sharp'); }

const TOLERANCIA_CUADRADA = 1.02; // ≤ 2 % de diferencia ya se considera cuadrada
const LADO_MAX = 2048;
const BORDE = 2;                  // píxeles del marco que se miran
const DISTANCIA_UNIFORME = 24;    // distancia RGB al color dominante
const FRACCION_UNIFORME = 0.85;   // del marco cerca del dominante → borde uniforme
const FRACCION_TRANSPARENTE = 0.6;
const BLANCO = Object.freeze({ r: 255, g: 255, b: 255, alpha: 1 });

const mediana = (xs) => { const o = [...xs].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };

// Color de relleno a partir del marco de la imagen (ya orientada).
function elegirRelleno(data, ancho, alto, canales) {
  const marco = [];
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      if (x >= BORDE && x < ancho - BORDE && y >= BORDE && y < alto - BORDE) continue;
      const i = (y * ancho + x) * canales;
      marco.push([data[i], data[i + 1], data[i + 2], canales === 4 ? data[i + 3] : 255]);
    }
  }
  const transparentes = marco.filter((p) => p[3] < 16).length / marco.length;
  if (canales === 4 && transparentes >= FRACCION_TRANSPARENTE) {
    return { tipo: 'transparente', color: { r: 0, g: 0, b: 0, alpha: 0 } };
  }
  const opacos = marco.filter((p) => p[3] >= 16);
  const dominante = [0, 1, 2].map((c) => mediana(opacos.map((p) => p[c])));
  const cerca = opacos.filter((p) => Math.hypot(p[0] - dominante[0], p[1] - dominante[1], p[2] - dominante[2]) <= DISTANCIA_UNIFORME).length;
  if (cerca / opacos.length >= FRACCION_UNIFORME) {
    return { tipo: 'dominante', color: { r: dominante[0], g: dominante[1], b: dominante[2], alpha: 1 } };
  }
  return { tipo: 'blanco', color: BLANCO };
}

// → { aplicado, buffer, contentType, relleno?, ancho, alto }. Si ya es
// cuadrada devuelve la misma imagen (aplicado: false).
async function cuadrarConRelleno(buffer) {
  const meta = await sharp()(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('la imagen no se puede leer');
  const girada = (meta.orientation || 1) >= 5;
  const w0 = girada ? meta.height : meta.width;
  const h0 = girada ? meta.width : meta.height;
  if (Math.max(w0, h0) / Math.min(w0, h0) <= TOLERANCIA_CUADRADA) {
    return { aplicado: false, buffer, contentType: `image/${meta.format}`, ancho: w0, alto: h0 };
  }
  let base = sharp()(buffer, { failOn: 'none' }).rotate();
  if (Math.max(w0, h0) > LADO_MAX) base = base.resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside' });
  const conAlfa = !!meta.hasAlpha;
  const { data, info } = await (conAlfa ? base.ensureAlpha() : base.removeAlpha()).raw().toBuffer({ resolveWithObject: true });
  const relleno = elegirRelleno(data, info.width, info.height, info.channels);

  const lado = Math.max(info.width, info.height);
  const izquierda = Math.floor((lado - info.width) / 2);
  const arriba = Math.floor((lado - info.height) / 2);
  const salida = await sharp()(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extend({ top: arriba, bottom: lado - info.height - arriba, left: izquierda, right: lado - info.width - izquierda, background: relleno.color })
    .webp({ lossless: true })
    .toBuffer();
  return {
    aplicado: true, buffer: salida, contentType: 'image/webp', ancho: lado, alto: lado,
    relleno: { tipo: relleno.tipo, color: relleno.tipo === 'transparente' ? null : [relleno.color.r, relleno.color.g, relleno.color.b] },
    // Dónde quedó el logo dentro del cuadrado (para comprobar que no cambió).
    region: { left: izquierda, top: arriba, width: info.width, height: info.height },
  };
}

// Para la IA y el análisis: una versión opaca (el relleno transparente se ve
// blanco). La versión que se guarda conserva la transparencia.
async function opaca(buffer) {
  const meta = await sharp()(buffer, { failOn: 'none' }).metadata();
  if (!meta.hasAlpha) return buffer;
  return sharp()(buffer, { failOn: 'none' }).flatten({ background: '#ffffff' }).png().toBuffer();
}

module.exports = { TOLERANCIA_CUADRADA, LADO_MAX, cuadrarConRelleno, opaca, elegirRelleno };
