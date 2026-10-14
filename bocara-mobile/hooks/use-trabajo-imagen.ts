import { useEffect, useRef, useState } from 'react';
import { imagenesAPI } from '@/src/services/api';
import { crearSondeoTrabajo, type EstadoSondeo } from '@/src/utils/procesoImagen';

// Trabajo de imagen de la foto del formulario: iniciar(url) tras subirla,
// consulta su estado cada ~1.5 s hasta lista/rechazada/fallida. La lógica
// vive en crearSondeoTrabajo (src/utils/procesoImagen.ts, probada aparte).
export function useTrabajoImagen() {
  const [estado, setEstado] = useState<EstadoSondeo>({ trabajo: null, error: null, errorRed: false });
  const sondeo = useRef(crearSondeoTrabajo({
    crear: imagenesAPI.crearTrabajo,
    obtener: imagenesAPI.obtenerTrabajo,
    reintentar: imagenesAPI.reintentarTrabajo,
  }, setEstado)).current;
  useEffect(() => () => sondeo.cancelar(), [sondeo]);
  return {
    ...estado,
    iniciar: (url: string) => { sondeo.iniciar(url); },
    reintentar: () => { sondeo.reintentar(); },
    reiniciar: () => { sondeo.cancelar(); setEstado({ trabajo: null, error: null, errorRed: false }); },
  };
}
