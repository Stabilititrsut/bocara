// Foto de publicación: procesamiento con IA ANTES de publicar
// (backend/services/imagenes/trabajos.js). Pura: la usan useTrabajoImagen,
// EstadoProcesoImagen, bolsas.tsx y scripts/test-proceso-imagen.cjs.
//
//   subida → analizando → mejorando → validando → lista | rechazada | fallida
//
// Una foto oscura, borrosa o pequeña NO se rechaza al analizarla: pasa por la
// mejora con IA y recién al validar el resultado se decide. Solo lo
// irreparable (no es imagen, resolución absurda, no es comida) se rechaza en
// "Analizando calidad".
//
// Regla de la app (el backend la aplica igual): una foto NUEVA solo se puede
// guardar con su trabajo en 'lista'.
export type EstadoTrabajo = 'subida' | 'analizando' | 'mejorando' | 'validando' | 'lista' | 'rechazada' | 'fallida';

export interface MotivoImagen { codigo: string; mensaje: string }

export interface TrabajoImagen {
  id: string;
  estado: EstadoTrabajo;
  original_url: string;
  mejorada_url: string | null;
  motivos: MotivoImagen[];
  error_codigo: string | null;
  error: string | null;
  detalle: string | null;
  puede_reintentar: boolean;
  // Lista con la foto original: la versión con IA no pasó la validación y la
  // original ya cumplía la calidad (fallback seguro del backend).
  usa_original?: boolean;
  // Problemas de la original que la IA corrigió (oscura, borrosa…).
  problemas_corregidos?: string[];
  // Paso donde terminó una rechazada/fallida (lo calcula el backend).
  paso_error?: 'analizando' | 'mejorando' | 'validando' | null;
}

export const TEXTOS_IMAGEN = Object.freeze({
  subiendo: 'Subiendo imagen…',
  subida: 'Imagen subida',
  analizando: '🔍 Analizando calidad…',
  mejorando: '✨ Mejorando imagen con IA…',
  validando: '🔍 Validando calidad de imagen…',
  lista: '✅ Imagen lista para publicar',
  procesando: 'Procesando imagen con IA, espera un momento…',
  fallida: '⚠️ No se pudo mejorar la imagen',
  rechazada: '❌ Esta imagen no cumple la calidad mínima para Bocara',
  rechazadaAntes: '❌ Imagen rechazada: no se puede usar esta foto',
  usaOriginal: 'Usaremos tu foto original: ya cumple la calidad de Bocara y la versión con IA no superó la validación.',
  reintentar: 'Reintentar',
  cambiarFoto: 'Cambiar foto',
});

const PASOS: { clave: EstadoTrabajo; texto: string }[] = [
  { clave: 'subida', texto: 'Imagen subida' },
  { clave: 'analizando', texto: 'Analizando calidad' },
  { clave: 'mejorando', texto: 'Mejorando con IA' },
  { clave: 'validando', texto: 'Validando resultado' },
];
const ORDEN: Record<string, number> = { subida: 0, analizando: 1, mejorando: 2, validando: 3, lista: 4 };
const EN_CURSO = new Set<EstadoTrabajo>(['subida', 'analizando', 'mejorando', 'validando']);

export function enCurso(estado: EstadoTrabajo | null | undefined): boolean {
  return !!estado && EN_CURSO.has(estado);
}
export function esTerminal(estado: EstadoTrabajo | null | undefined): boolean {
  return estado === 'lista' || estado === 'rechazada' || estado === 'fallida';
}

export type EstadoPaso = 'hecho' | 'activo' | 'pendiente' | 'error';

// Lista de pasos para mostrar. Un rechazo o fallo se marca en el paso donde
// ocurrió: paso_error del backend o, si no viene, se deduce del código.
export function pasosProceso(t: Pick<TrabajoImagen, 'estado' | 'error_codigo'> & Partial<Pick<TrabajoImagen, 'paso_error'>> | null): { texto: string; estado: EstadoPaso }[] {
  if (!t) return [];
  let pasoError = -1;
  if (t.estado === 'rechazada' || t.estado === 'fallida') {
    const paso = (t as Partial<TrabajoImagen>).paso_error;
    if (paso) pasoError = ORDEN[paso];
    else if (t.estado === 'rechazada') pasoError = 1;
    else {
      pasoError = t.error_codigo === 'validacion' || t.error_codigo === 'calidad_resultado' ? 3
        : String(t.error_codigo || '').startsWith('proveedor') ? 2 : 1;
    }
  }
  const actual = ORDEN[t.estado] ?? -1;
  return PASOS.map((p, i) => {
    if (pasoError >= 0) return { texto: p.texto, estado: i < pasoError ? 'hecho' : i === pasoError ? 'error' : 'pendiente' };
    if (t.estado === 'lista' || i < actual) return { texto: p.texto, estado: 'hecho' };
    if (i === actual) return { texto: p.texto, estado: i === 0 ? 'hecho' : 'activo' };
    return { texto: p.texto, estado: 'pendiente' };
  });
}

// Problemas de la original → lo que se le dice al restaurante que se corrigió.
const CORREGIDO: Record<string, string> = {
  oscura: 'iluminación', muy_oscura: 'iluminación', quemada: 'exposición', sin_contraste: 'contraste y color',
  borrosa: 'nitidez', resolucion: 'resolución', baja_calidad: 'calidad general', desordenada: 'presentación',
};

export interface ResumenProceso {
  titulo: string;
  tono: 'progreso' | 'ok' | 'error' | 'rechazo';
  mensajes: string[];
  puedeReintentar: boolean;
  puedeCambiar: boolean;
}

// Lo que se le dice al restaurante. `dev` agrega el detalle técnico (p. ej.
// "falta OPENAI_API_KEY") para que en desarrollo nada quede ambiguo.
export function resumenProceso(t: TrabajoImagen | null, { dev = false }: { dev?: boolean } = {}): ResumenProceso | null {
  if (!t) return null;
  if (enCurso(t.estado)) {
    return {
      titulo: TEXTOS_IMAGEN[t.estado as 'subida'], tono: 'progreso',
      mensajes: [TEXTOS_IMAGEN.procesando, 'Guardar se habilita cuando la imagen esté lista.'],
      puedeReintentar: false, puedeCambiar: true,
    };
  }
  if (t.estado === 'lista') {
    const corregidos = (t.problemas_corregidos || []).map((c) => CORREGIDO[c]).filter(Boolean);
    const mensajes = t.usa_original ? [TEXTOS_IMAGEN.usaOriginal]
      : corregidos.length ? [`La IA mejoró tu foto: ${[...new Set(corregidos)].join(', ')}.`] : [];
    return { titulo: TEXTOS_IMAGEN.lista, tono: 'ok', mensajes, puedeReintentar: false, puedeCambiar: true };
  }
  if (t.estado === 'rechazada') {
    const mensajes = (t.motivos || []).map((m) => m.mensaje);
    // Tras mejorar y validar: la versión final no llegó a la calidad mínima.
    const despuesDeMejorar = t.paso_error === 'validando';
    return {
      titulo: despuesDeMejorar ? TEXTOS_IMAGEN.rechazada : TEXTOS_IMAGEN.rechazadaAntes,
      tono: 'rechazo',
      mensajes: [
        ...(despuesDeMejorar ? ['La mejoramos con IA, pero el resultado final no se puede publicar:'] : []),
        ...(mensajes.length ? mensajes : ['Usa otra foto del producto.']),
      ],
      puedeReintentar: false, puedeCambiar: true,
    };
  }
  const mensajes = [t.error || 'Ocurrió un error al procesar la foto.'];
  for (const m of t.motivos || []) mensajes.push(m.mensaje);
  if (dev && t.detalle) mensajes.push(`Detalle técnico: ${t.detalle}`);
  return { titulo: TEXTOS_IMAGEN.fallida, tono: 'error', mensajes, puedeReintentar: !!t.puede_reintentar, puedeCambiar: true };
}

// ── Regla de guardado ───────────────────────────────────────────────────────
export const BLOQUEOS = Object.freeze({
  subiendo: 'Guardar bloqueado: la foto se está subiendo.',
  sinFoto: 'Guardar bloqueado: agrega una foto del producto.',
  sinProcesar: 'Guardar bloqueado: la foto debe pasar por la mejora con IA. Cámbiala para procesarla.',
  procesando: 'Procesando imagen con IA, espera un momento…',
  rechazada: 'Guardar bloqueado: la imagen no cumple la calidad mínima. Cambia la foto.',
  fallida: 'Guardar bloqueado: no se pudo mejorar la imagen. Reintenta o cambia la foto.',
  errorRed: 'Guardar bloqueado: no pudimos consultar el estado de la imagen. Reintenta.',
  sinValidar: 'Esta publicación necesita una foto validada por IA. Cambia la foto para guardar cambios de contenido.',
});

// La foto del formulario ¿es distinta de la que ya tiene la publicación?
export function esFotoNueva(url: string | null | undefined, bolsa: { imagen_url?: string | null; imagen_original_url?: string | null; imagen_mejorada_url?: string | null } | null | undefined): boolean {
  const u = (url || '').trim();
  if (!u) return false;
  if (!bolsa) return true;
  return u !== bolsa.imagen_url && u !== bolsa.imagen_original_url && u !== bolsa.imagen_mejorada_url;
}

export function bolsaConImagenValidada(bolsa: { estado_procesamiento_imagen?: string | null } | null | undefined): boolean {
  return bolsa?.estado_procesamiento_imagen === 'completada' || bolsa?.estado_procesamiento_imagen === 'descartada';
}

// Trabajo que corresponde a la foto actual del formulario (si el restaurante
// la cambió, el trabajo viejo ya no aplica).
export function trabajoDeLaFoto(trabajo: TrabajoImagen | null, url: string | null | undefined): TrabajoImagen | null {
  return trabajo && url && trabajo.original_url === url ? trabajo : null;
}

// Motivo por el que Guardar está bloqueado por la FOTO, o null.
//   · nueva publicación, o edición con foto nueva → trabajo 'lista' obligatorio.
//   · edición sin cambiar la foto → no bloquea aquí (si la foto no está
//     validada, bolsas.tsx avisa al guardar cambios de contenido: BLOQUEOS.sinValidar).
export function bloqueoPorFoto({ esEdicion, url, bolsa, trabajo, subiendo, errorRed }: {
  esEdicion: boolean;
  url: string | null | undefined;
  bolsa?: { imagen_url?: string | null; imagen_original_url?: string | null; imagen_mejorada_url?: string | null } | null;
  trabajo: TrabajoImagen | null;
  subiendo?: boolean;
  errorRed?: boolean;
}): string | null {
  if (subiendo) return BLOQUEOS.subiendo;
  if (!(url || '').trim()) return esEdicion ? null : BLOQUEOS.sinFoto;
  if (esEdicion && !esFotoNueva(url, bolsa)) return null;
  const t = trabajoDeLaFoto(trabajo, url);
  if (!t) return errorRed ? BLOQUEOS.errorRed : BLOQUEOS.sinProcesar;
  if (enCurso(t.estado)) return errorRed ? BLOQUEOS.errorRed : BLOQUEOS.procesando;
  if (t.estado === 'rechazada') return BLOQUEOS.rechazada;
  if (t.estado === 'fallida') return BLOQUEOS.fallida;
  return null;
}

// ── Sondeo del trabajo ──────────────────────────────────────────────────────
export interface ApiTrabajos {
  crear: (imagenUrl: string) => Promise<TrabajoImagen>;
  obtener: (id: string) => Promise<TrabajoImagen>;
  reintentar: (id: string) => Promise<TrabajoImagen>;
}
export interface EstadoSondeo { trabajo: TrabajoImagen | null; error: string | null; errorRed: boolean }

export const INTERVALO_SONDEO_MS = 1500;
const MAX_FALLOS_RED = 5;

// Motor del sondeo, independiente de React: el hook lo envuelve y las pruebas
// lo manejan con una API y un reloj falsos. Una sola foto activa: iniciar()
// con otra foto cancela la anterior (sus respuestas tardías se descartan).
export function crearSondeoTrabajo(api: ApiTrabajos, alCambiar: (e: EstadoSondeo) => void, {
  esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  intervalo = INTERVALO_SONDEO_MS,
}: { esperar?: (ms: number) => Promise<void>; intervalo?: number } = {}) {
  let generacion = 0;
  let estado: EstadoSondeo = { trabajo: null, error: null, errorRed: false };
  const emitir = (g: number, e: Partial<EstadoSondeo>) => {
    if (g !== generacion) return;
    estado = { ...estado, ...e };
    alCambiar(estado);
  };

  async function seguir(g: number, id: string) {
    let fallos = 0;
    while (g === generacion) {
      await esperar(intervalo);
      if (g !== generacion) return;
      try {
        const t = await api.obtener(id);
        fallos = 0;
        emitir(g, { trabajo: t, error: null, errorRed: false });
        if (esTerminal(t.estado)) return;
      } catch (e: any) {
        fallos += 1;
        if (fallos >= MAX_FALLOS_RED) {
          emitir(g, { errorRed: true, error: e?.message || 'No pudimos consultar el estado de la imagen.' });
          return;
        }
      }
    }
  }

  async function arrancar(g: number, obtenerPrimero: () => Promise<TrabajoImagen>) {
    try {
      const t = await obtenerPrimero();
      emitir(g, { trabajo: t, error: null, errorRed: false });
      if (!esTerminal(t.estado)) await seguir(g, t.id);
    } catch (e: any) {
      emitir(g, { error: e?.message || 'No se pudo iniciar el procesamiento de la imagen.', errorRed: !e?.status });
    }
  }

  return {
    get estado() { return estado; },
    iniciar(imagenUrl: string) {
      const g = ++generacion;
      estado = { trabajo: null, error: null, errorRed: false };
      alCambiar(estado);
      return arrancar(g, () => api.crear(imagenUrl));
    },
    reintentar() {
      const t = estado.trabajo;
      if (!t) return Promise.resolve();
      const g = ++generacion;
      // Si se perdió la conexión mientras procesaba, solo se vuelve a consultar.
      if (estado.errorRed && !esTerminal(t.estado)) {
        emitir(g, { errorRed: false, error: null });
        return seguir(g, t.id);
      }
      if (t.estado !== 'fallida') return Promise.resolve();
      return arrancar(g, () => api.reintentar(t.id));
    },
    cancelar() {
      generacion += 1;
      estado = { trabajo: null, error: null, errorRed: false };
    },
  };
}
