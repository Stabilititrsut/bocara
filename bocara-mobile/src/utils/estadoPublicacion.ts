import { publicacionVencida, type HorarioPublicacion } from './horarioRecogida';

// Estado de una publicación tal como lo ve el RESTAURANTE en su panel
// (restaurante/bolsas.tsx y restaurante/cupones.tsx). Refleja las reglas del
// backend (backend/services/publicaciones.js) — no inventa ninguna:
//   · rechazado → no visible; se corrige editando y guardando (vuelve a pendiente)
//   · pendiente → no visible hasta que el admin apruebe
//   · aprobado (o null, legado) → visible solo si está activa, vigente y con unidades
export interface PublicacionConEstado extends HorarioPublicacion {
  estado_aprobacion?: 'pendiente' | 'aprobado' | 'rechazado' | null;
  motivo_rechazo?: string | null;
  activo?: boolean;
  cantidad_disponible?: number;
}

export type ClaveEstado = 'pendiente' | 'cambios' | 'rechazada' | 'inactiva' | 'vencida' | 'agotada' | 'aprobada';

export interface EstadoPublicacion {
  clave: ClaveEstado;
  etiqueta: string;
  // ¿La ve el cliente ahora mismo?
  visible: boolean;
  // Qué hacer para que se vea (null si ya se ve).
  ayuda: string | null;
}

export function estadoPublicacion(b: PublicacionConEstado, now = new Date()): EstadoPublicacion {
  if (b.estado_aprobacion === 'rechazado') {
    return { clave: 'rechazada', etiqueta: '✕ Rechazada', visible: false,
      ayuda: 'Corrígela y guárdala para enviarla de nuevo a revisión.' };
  }
  if (b.estado_aprobacion === 'pendiente') {
    return b.motivo_rechazo
      ? { clave: 'cambios', etiqueta: 'Pendiente · cambios solicitados', visible: false,
        ayuda: 'El administrador pidió cambios — corrige y guarda para reenviar a revisión.' }
      : { clave: 'pendiente', etiqueta: 'Pendiente', visible: false,
        ayuda: 'En revisión del administrador. No se puede editar hasta que la revise.' };
  }
  if (b.activo === false) {
    return { clave: 'inactiva', etiqueta: 'Inactiva', visible: false, ayuda: 'Está oculta: actívala para que los clientes la vean.' };
  }
  if (publicacionVencida(b, now)) {
    return { clave: 'vencida', etiqueta: 'Vencida', visible: false, ayuda: 'Su horario o fecha ya pasó: edítala para actualizarlos.' };
  }
  if (b.cantidad_disponible != null && Number(b.cantidad_disponible) <= 0) {
    return { clave: 'agotada', etiqueta: 'Agotada', visible: false, ayuda: 'Sin unidades: agrégalas para que vuelva a verse.' };
  }
  return { clave: 'aprobada', etiqueta: '✓ Aprobada', visible: true, ayuda: null };
}

// Pendiente de la PRIMERA decisión del admin: el backend responde 409 a
// cualquier edición (el admin puede estar revisando esa misma versión).
export function bloqueadaParaEditar(b: PublicacionConEstado): boolean {
  return b.estado_aprobacion === 'pendiente' && !b.motivo_rechazo;
}

// El switch "Visible / No visible" del restaurante: una publicación que no
// está aprobada (pendiente o rechazada) nunca puede activarse con el switch,
// sin importar en qué paso de la revisión esté. Mismo criterio que el backend
// (backend/services/publicaciones.js → activarSinAprobacionEsInvalido): "no
// aprobada" nunca se hace públicamente visible por esta vía. El backend lo
// exige igual aunque el frontend fallara en deshabilitarlo (defensa en
// profundidad, no solo visual).
export function toggleVisibilidadBloqueado(b: PublicacionConEstado): boolean {
  return b.estado_aprobacion === 'pendiente' || b.estado_aprobacion === 'rechazado';
}

export function textoBotonEditar(b: PublicacionConEstado): string {
  return b.estado_aprobacion === 'rechazado' ? 'Corregir' : 'Editar';
}

// Aviso dentro del formulario de edición: qué pasará al guardar.
export function avisoAlEditar(b: PublicacionConEstado | null | undefined): string | null {
  if (!b) return null;
  if (b.estado_aprobacion === 'rechazado' || b.estado_aprobacion === 'pendiente') {
    return 'Al guardar, la publicación se envía de nuevo a revisión del administrador.';
  }
  return 'Si cambias el contenido (texto, precio, tipo, horario, fecha o imagen) volverá a revisión y dejará de verse hasta que el administrador la apruebe. Cambiar solo las unidades no requiere revisión.';
}

// Payload de una edición. Para una publicación aprobada solo viajan los campos
// que el usuario cambió respecto de lo que el formulario cargó: el formulario
// completa valores derivados (p. ej. es_descuento a partir de los precios,
// peso por defecto) que no son cambios del usuario, y si viajaran el backend
// los vería como cambios de contenido y la mandaría a revisión aunque solo se
// hubieran cambiado las unidades. Una rechazada o con cambios solicitados
// manda el formulario completo: guardar ES reenviar a revisión.
export function payloadDeEdicion<T extends object>(
  b: PublicacionConEstado | null | undefined, payload: T, payloadInicial: T | null,
): Partial<T> {
  const esReenvio = b?.estado_aprobacion === 'rechazado' || b?.estado_aprobacion === 'pendiente';
  if (esReenvio || !payloadInicial) return payload;
  const cambios: Partial<T> = {};
  for (const clave of Object.keys(payload) as (keyof T)[]) {
    if (JSON.stringify(payload[clave]) !== JSON.stringify(payloadInicial[clave])) cambios[clave] = payload[clave];
  }
  return cambios;
}

export function mensajeTrasGuardar(estadoResultante: string | null | undefined, esEdicion: boolean): string {
  if (estadoResultante === 'pendiente') {
    return esEdicion
      ? 'Cambios guardados. La publicación quedó Pendiente: no será visible hasta que el administrador la apruebe.'
      : 'Publicación creada y enviada a revisión del administrador.';
  }
  return esEdicion ? 'Publicación actualizada. Sigue aprobada.' : 'Publicación creada correctamente.';
}

// Hora tal como viene de la BD → texto para el formulario de edición. Una
// columna `time` devuelve '18:00:00' (o '18:00:00+00'), que normalizarHora
// (src/utils/hora.ts) NO acepta a propósito: el usuario nunca escribe segundos.
// Sin esto, abrir "Editar" sobre una publicación existente y pulsar Guardar
// fallaba con "Hora de inicio inválida" sin llegar al backend — el "modificar
// no funciona" del caso Ola Azul (BACK-1).
export function horaParaFormulario(valor: string | null | undefined, porDefecto: string): string {
  if (!valor) return porDefecto;
  const m = /^(\d{1,2}:\d{2})(?::\d{2})?/.exec(String(valor).trim());
  return m ? m[1] : String(valor);
}

// ── Foto obligatoria ─────────────────────────────────────────────────────────
// Toda publicación nueva (Promoción y Tiempo limitado) necesita foto — el
// backend la exige igual (backend/services/fotoObligatoria.js). Una heredada
// sin foto puede seguir editándose en lo que no vuelve a revisión (unidades,
// visibilidad), pero un cambio de contenido exige completarla — mismo criterio
// que decidirRevision en backend/services/publicaciones.js.
export const MENSAJE_FOTO_PUBLICACION = 'Debes agregar una foto antes de publicar.';

export function tieneFoto(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.trim() !== '';
}

const CAMPOS_SIN_REVISION = new Set(['activo', 'cantidad_disponible']);

// ¿Guardar esta edición la manda (o reenvía) a revisión?
export function edicionVuelveARevision(b: PublicacionConEstado | null | undefined, cambios: object): boolean {
  const claves = Object.keys(cambios);
  if (claves.length === 0 || claves.every(c => c === 'activo')) return false;
  if (b?.estado_aprobacion === 'rechazado') return true;
  if (b?.estado_aprobacion === 'pendiente') return !!b.motivo_rechazo;
  return claves.some(c => !CAMPOS_SIN_REVISION.has(c));
}

// ¿Falta la foto para guardar? `edicion` null = crear (siempre la exige).
export function faltaFotoParaGuardar(
  imagenUrl: string | null | undefined,
  edicion: { bolsa: PublicacionConEstado | null | undefined; cambios: object } | null,
): boolean {
  if (tieneFoto(imagenUrl)) return false;
  return edicion ? edicionVuelveARevision(edicion.bolsa, edicion.cambios) : true;
}
