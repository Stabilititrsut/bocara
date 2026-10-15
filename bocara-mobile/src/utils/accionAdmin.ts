// Ejecuta una acción confirmada del panel Admin y la traduce a un resultado
// que la pantalla pinta (éxito o el error real del backend). Reemplaza el
// patrón `Alert.alert(..., [botones])`: en web, react-native-web implementa
// Alert.alert vacío, así que ni la confirmación ni los errores se veían.
//
// Sin imports a propósito: scripts/test-confirmaciones-admin.cjs lo carga aislado.

export type ResultadoAccionAdmin<T> =
  | { ok: true; mensaje: string; data: T }
  | { ok: false; error: string };

export function mensajeErrorAdmin(e: any, porDefecto: string): string {
  const msg = typeof e?.message === 'string' ? e.message.trim() : '';
  return msg || porDefecto;
}

export async function ejecutarAccionAdmin<T>(
  accion: () => Promise<T>,
  textos: { exito: string; error: string },
): Promise<ResultadoAccionAdmin<T>> {
  try {
    const data = await accion();
    return { ok: true, mensaje: textos.exito, data };
  } catch (e: any) {
    return { ok: false, error: mensajeErrorAdmin(e, textos.error) };
  }
}
