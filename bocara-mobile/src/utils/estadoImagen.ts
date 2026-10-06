// Estado de la mejora automática de una foto (pipeline de imágenes del
// backend, ver docs/PIPELINE_IMAGENES.md) traducido a lo que el restaurante
// necesita saber. Pura: la usan EstadoImagenIA y scripts/test-estado-imagen.cjs.
export type AccionImagen = 'reintentar' | 'usar-original' | 'usar-mejorada';

export interface FilaImagen {
  imagen_url?: string | null;
  imagen_original_url?: string | null;
  imagen_mejorada_url?: string | null;
  estado_procesamiento_imagen?: string | null;
  proveedor_imagen_ia?: string | null;
}

export interface EstadoImagen {
  clave: 'sin_procesar' | 'pendiente' | 'procesando' | 'completada' | 'fallida' | 'descartada';
  etiqueta: string;
  accion: AccionImagen | null;
  textoAccion: string | null;
  enCurso: boolean;
  // Hay original y mejorada guardadas: se puede abrir la comparación.
  puedeComparar: boolean;
}

// Proveedores de IA real (OpenAI GPT Image, Replicate FLUX Kontext). El
// ajuste técnico local nunca se presenta como IA ante el restaurante.
const PROVEEDORES_IA = new Set(['openai', 'replicate']);
export function esMejoraConIA(fila: FilaImagen | null | undefined): boolean {
  return PROVEEDORES_IA.has(String(fila?.proveedor_imagen_ia || ''));
}

export function estadoImagenIA(fila: FilaImagen | null | undefined): EstadoImagen {
  const puedeComparar = !!(fila?.imagen_original_url && fila?.imagen_mejorada_url);
  return { ...estadoBase(fila), puedeComparar };
}

function estadoBase(fila: FilaImagen | null | undefined): Omit<EstadoImagen, 'puedeComparar'> {
  switch (fila?.estado_procesamiento_imagen) {
    case 'pendiente':
      return { clave: 'pendiente', etiqueta: '⏳ Mejorando tu foto…', accion: null, textoAccion: null, enCurso: true };
    case 'procesando':
      return { clave: 'procesando', etiqueta: '✨ Mejorando tu foto…', accion: null, textoAccion: null, enCurso: true };
    case 'completada':
      return {
        clave: 'completada',
        etiqueta: esMejoraConIA(fila)
          ? '✨ Foto mejorada con IA · se muestra la mejorada'
          : '✨ Foto ajustada automáticamente · se muestra la ajustada',
        accion: 'usar-original', textoAccion: 'Usar mi original', enCurso: false,
      };
    case 'fallida':
      return { clave: 'fallida', etiqueta: '⚠️ No se pudo mejorar, se muestra tu original', accion: 'reintentar', textoAccion: 'Reintentar', enCurso: false };
    case 'descartada':
      return {
        clave: 'descartada', etiqueta: '📷 Se muestra tu foto original',
        accion: fila?.imagen_mejorada_url ? 'usar-mejorada' : null,
        textoAccion: fila?.imagen_mejorada_url ? 'Usar mejorada' : null, enCurso: false,
      };
    default:
      // Fotos anteriores al pipeline (o pipeline sin migración): no se muestra nada.
      return { clave: 'sin_procesar', etiqueta: '', accion: null, textoAccion: null, enCurso: false };
  }
}

// ¿Hay alguna foto en cola o procesándose? La pantalla refresca mientras tanto.
export function hayMejoraEnCurso(filas: FilaImagen[] | null | undefined): boolean {
  return (filas || []).some((f) => estadoImagenIA(f).enCurso);
}

// La foto que se ve siempre existe: imagen_url (mejor versión) y, si faltara,
// la original. Nunca devuelve vacío si hay alguna de las dos.
export function urlImagenVisible(fila: FilaImagen | null | undefined): string | null {
  return fila?.imagen_url || fila?.imagen_original_url || null;
}
