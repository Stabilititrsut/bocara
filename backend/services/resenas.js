// Validaciones de reseñas verificadas (Fase B, Semana 2).
//
// El promedio y el total del negocio ya NO se calculan aquí ni en las rutas:
// los recalcula el trigger resenas_recalcular_calificacion (migración
// 202610061200) bajo lock de la fila del negocio y solo con reseñas visibles.

const MAX_COMENTARIO = 500;
const MAX_RESPUESTA = 500;
const MAX_MOTIVO = 300;

// Largo en caracteres (code points), igual que char_length() en Postgres:
// '😀'.length es 2 en JS pero 1 para el CHECK de la base.
function largo(texto) {
  return [...texto].length;
}

// Entero 1–5. Acepta 5 o '5' (formularios), rechaza 4.5, '4.5', '', true, NaN.
function validarCalificacion(valor) {
  const numero = typeof valor === 'string' && /^\d+$/.test(valor.trim()) ? Number(valor) : valor;
  if (typeof numero !== 'number' || !Number.isInteger(numero) || numero < 1 || numero > 5) {
    return { error: 'La calificación debe ser un número entero entre 1 y 5' };
  }
  return { valor: numero };
}

// Texto opcional; vacío o solo espacios → null.
function validarTextoOpcional(valor, maximo, nombre) {
  if (valor == null) return { valor: null };
  if (typeof valor !== 'string') return { error: `${nombre} debe ser texto` };
  const limpio = valor.trim();
  if (!limpio) return { valor: null };
  if (largo(limpio) > maximo) return { error: `${nombre} no puede superar ${maximo} caracteres` };
  return { valor: limpio };
}

function validarComentario(valor) {
  return validarTextoOpcional(valor, MAX_COMENTARIO, 'El comentario');
}

function validarRespuesta(valor) {
  const r = validarTextoOpcional(valor, MAX_RESPUESTA, 'La respuesta');
  if (r.error) return r;
  if (r.valor == null) return { error: 'La respuesta no puede estar vacía' };
  return r;
}

// { visible: boolean, motivo } — ocultar exige motivo (queda en auditoría).
function validarModeracion({ visible, motivo } = {}) {
  if (typeof visible !== 'boolean') return { error: 'visible debe ser true o false' };
  const m = validarTextoOpcional(motivo, MAX_MOTIVO, 'El motivo');
  if (m.error) return m;
  if (!visible && !m.valor) return { error: 'Indica el motivo para ocultar la reseña' };
  return { valor: { visible, motivo: m.valor } };
}

function esDuplicado(error) {
  return error?.code === '23505';
}

module.exports = {
  MAX_COMENTARIO,
  MAX_RESPUESTA,
  MAX_MOTIVO,
  largo,
  validarCalificacion,
  validarComentario,
  validarRespuesta,
  validarModeracion,
  esDuplicado,
};
