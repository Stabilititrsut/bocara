import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { publicacionesVigentes, type HorarioPublicacion } from './horarioRecogida';

// Solo reloj local; no realiza consultas ni modifica el almacenamiento.
export function useRelojPublicaciones() {
  const [ahora, setAhora] = useState(() => new Date());
  useFocusEffect(useCallback(() => {
    setAhora(new Date());
    const timer = setInterval(() => setAhora(new Date()), 30000);
    return () => clearInterval(timer);
  }, []));
  return ahora;
}

export function usePublicacionesVigentes<T extends HorarioPublicacion>(items: T[]) {
  const ahora = useRelojPublicaciones();
  return useMemo(() => publicacionesVigentes(items, ahora), [items, ahora]);
}
