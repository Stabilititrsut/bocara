// "Mejorar descripción con IA" en el formulario de Promoción / Tiempo limitado.
// Pura (sin React ni red): la usan BotonDescripcionIA y
// scripts/test-descripcion-ia.cjs. El backend (POST /api/ia/descripcion)
// valida igual; esto evita viajes inútiles y fija qué datos salen de la app.
export type TipoFormIA = 'bolsa' | 'cupon';

// Solo los datos públicos del producto que ya están en el formulario.
export interface DatosDescripcionIA {
  tipo_form: TipoFormIA;
  nombre: string;
  descripcion: string;
  contenido: string;
  categoria_alimento: string;
  precio_original: string;
  precio_descuento: string;
  hora_recogida_inicio: string;
  hora_recogida_fin: string;
  fecha_disponible: string;
  fecha_caducidad: string;
}

export interface PayloadDescripcionIA {
  tipo: TipoFormIA;
  nombre: string;
  descripcion?: string;
  contenido?: string;
  categoria_alimento?: string;
  precio_original?: string;
  precio_descuento?: string;
  hora_recogida_inicio?: string;
  hora_recogida_fin?: string;
  fecha_disponible?: string;
  fecha_caducidad?: string;
}

export const MENSAJE_FALLO_IA = 'No pudimos mejorar la descripción. Intenta nuevamente.';
export const MENSAJE_FALTA_NOMBRE = 'Escribe al menos el nombre del producto para mejorar la descripción.';
export const TEXTO_BOTON = '✨ Mejorar descripción con IA';
export const TEXTO_GENERANDO = '✨ Mejorando descripción con IA…';
export const TEXTO_LISTO = '✅ Descripción sugerida';
export const TEXTO_LISTO_AYUDA = 'Revísala y edítala antes de guardar.';
export const TEXTO_DESHACER = 'Deshacer';
export const TEXTO_EDITAR = 'Editar sugerencia';
export const MENSAJE_NO_CONFIGURADA = 'La mejora de descripción con IA no está configurada en el servidor.';
const MAX_NOMBRE = 120;
const MAX_DESCRIPCION = 600;
const MAX_CONTENIDO = 400;

// null = se puede pedir; si no, el motivo para mostrar.
export function motivoNoMejorable(d: Pick<DatosDescripcionIA, 'nombre' | 'descripcion' | 'contenido'>): string | null {
  const nombre = (d.nombre || '').trim();
  if (nombre.length < 2) return MENSAJE_FALTA_NOMBRE;
  if (nombre.length > MAX_NOMBRE) return `El nombre admite máximo ${MAX_NOMBRE} caracteres.`;
  if ((d.descripcion || '').length > MAX_DESCRIPCION) return `La descripción admite máximo ${MAX_DESCRIPCION} caracteres para mejorarla con IA.`;
  if ((d.contenido || '').length > MAX_CONTENIDO) return `"¿Qué puede contener?" admite máximo ${MAX_CONTENIDO} caracteres para usar la IA.`;
  return null;
}

// Lista blanca: nada del negocio, del usuario, de la foto ni del stock. En una
// Promoción `contenido` es el código del cupón y no se envía.
export function payloadDescripcionIA(d: DatosDescripcionIA): PayloadDescripcionIA {
  const p: PayloadDescripcionIA = { tipo: d.tipo_form, nombre: d.nombre.trim() };
  const poner = (k: Exclude<keyof PayloadDescripcionIA, 'tipo' | 'nombre'>, v: string | undefined) => {
    const t = (v || '').trim();
    if (t) p[k] = t;
  };
  poner('descripcion', d.descripcion);
  if (d.tipo_form === 'bolsa') poner('contenido', d.contenido);
  poner('categoria_alimento', d.categoria_alimento);
  poner('precio_original', d.precio_original);
  poner('precio_descuento', d.precio_descuento);
  poner('hora_recogida_inicio', d.hora_recogida_inicio);
  poner('hora_recogida_fin', d.hora_recogida_fin);
  poner('fecha_disponible', d.fecha_disponible);
  if (d.tipo_form === 'bolsa') poner('fecha_caducidad', d.fecha_caducidad);
  return p;
}

// Mensaje para el restaurante según el error del backend: validación y
// límites traen su propio texto; IA sin configurar lo dice explícitamente
// (en desarrollo, además, el detalle del servidor: qué variable falta); todo lo
// demás (502/504/red) el genérico.
export function mensajeError(e: any, { dev = false }: { dev?: boolean } = {}): string {
  const status = e?.status;
  const datos = e?.responseData;
  if (status === 503 && datos?.codigo === 'IA_TEXTO_NO_CONFIGURADA') {
    return dev && datos.detalle ? `${MENSAJE_NO_CONFIGURADA} ${datos.detalle}` : MENSAJE_NO_CONFIGURADA;
  }
  if ((status === 400 || status === 429 || status === 503) && typeof e?.message === 'string' && e.message) return e.message;
  return MENSAJE_FALLO_IA;
}

export type ResultadoMejora =
  | { estado: 'ok'; descripcion: string; anterior: string }
  | { estado: 'error'; error: string; descripcion: string }
  | { estado: 'ignorada' };

// Una sola petición a la vez por formulario: toques repetidos mientras hay una
// en curso se ignoran. Ante cualquier fallo devuelve la descripción que había
// (el formulario no se toca).
export function crearMejorador(llamar: (p: PayloadDescripcionIA) => Promise<{ descripcion?: unknown }>, { dev = false }: { dev?: boolean } = {}) {
  let enCurso = false;
  return {
    get enCurso() { return enCurso; },
    async mejorar(d: DatosDescripcionIA): Promise<ResultadoMejora> {
      if (enCurso) return { estado: 'ignorada' };
      const anterior = d.descripcion;
      const motivo = motivoNoMejorable(d);
      if (motivo) return { estado: 'error', error: motivo, descripcion: anterior };
      enCurso = true;
      try {
        const r = await llamar(payloadDescripcionIA(d));
        const texto = typeof r?.descripcion === 'string' ? r.descripcion.trim() : '';
        if (!texto) return { estado: 'error', error: MENSAJE_FALLO_IA, descripcion: anterior };
        return { estado: 'ok', descripcion: texto, anterior };
      } catch (e) {
        return { estado: 'error', error: mensajeError(e, { dev }), descripcion: anterior };
      } finally {
        enCurso = false;
      }
    },
  };
}
