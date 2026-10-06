// Expo push token de ESTE dispositivo, tal como se registró en el backend.
//
// Lo escribe el registro de push (app/_layout.tsx) y lo lee logout
// (AuthContext) para desvincular solo este dispositivo: DELETE
// /notificaciones/token con el token explícito no borra el de otro teléfono
// que la misma cuenta haya registrado después. En memoria a propósito: el
// registro corre en cada arranque con sesión, así que siempre está vigente
// antes de que el usuario pueda cerrar sesión.
let tokenActual: string | null = null;

export function recordarPushToken(token: string | null) {
  tokenActual = token;
}

export function pushTokenActual(): string | null {
  return tokenActual;
}
