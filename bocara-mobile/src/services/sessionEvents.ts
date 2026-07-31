// Bus mínimo para que services/api.ts (fuera del árbol de React) pueda avisarle
// a AuthContext que la sesión dejó de ser válida, sin acoplarlos directamente.

type SessionInvalidListener = (message: string) => void;

let listeners: SessionInvalidListener[] = [];
let lastEmittedAt = 0;

export function onSessionInvalid(listener: SessionInvalidListener): () => void {
  listeners.push(listener);
  return () => { listeners = listeners.filter(l => l !== listener); };
}

// Si varias requests fallan casi al mismo tiempo (ej. varias pantallas pidiendo
// datos cuando el token expira), solo la primera dispara el logout/mensaje.
export function emitSessionInvalid(message: string) {
  const now = Date.now();
  if (now - lastEmittedAt < 3000) return;
  lastEmittedAt = now;
  listeners.forEach(l => l(message));
}
