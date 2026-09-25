// Normaliza texto de hora escrito a mano (ej. "8:00", "8", "8:00 pm", "20:5")
// al formato estricto HH:MM de 24 horas que exige el backend (ver
// validarDatosBolsa en backend/routes/bolsas.js). El backend rechaza "8:00"
// porque su regex exige la hora con dos dígitos (08:00); esta función evita
// que ese detalle de formato bloquee una hora que el usuario sí escribió bien.
// Devuelve null si el texto no representa una hora válida.
export function normalizarHora(valor: string): string | null {
  if (!valor) return null;
  const texto = valor.trim().toLowerCase();
  const m = texto.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let horas = parseInt(m[1], 10);
  const minutos = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const sufijo = m[3];

  if (minutos < 0 || minutos > 59) return null;

  if (sufijo) {
    if (horas < 1 || horas > 12) return null;
    if (sufijo === 'am') horas = horas === 12 ? 0 : horas;
    else horas = horas === 12 ? 12 : horas + 12;
  } else if (horas < 0 || horas > 23) {
    return null;
  }

  return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`;
}
