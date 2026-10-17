// Suspensión desde el panel Admin. Son dos conceptos distintos, cada uno con
// su endpoint, y no se mezclan:
//
//  - NEGOCIO  → PUT /admin/negocios/:id/toggle. Apaga/enciende negocios.activo:
//    el restaurante deja de mostrarse a los clientes, pero la cuenta del dueño
//    sigue funcionando. Motivo opcional: si viene, se notifica al propietario.
//  - CUENTA   → PUT /admin/usuarios/:id/suspender (y /rehabilitar). Pasa el rol
//    a 'suspendido': no puede iniciar sesión; si es dueño, el backend apaga
//    también su negocio. Motivo obligatorio (va en el email al usuario).
//
// La confirmación la pinta cada pantalla con un <Modal>: Alert.alert con
// botones no hace nada en web (react-native-web lo implementa vacío), que es
// justo lo que dejaba muerto el botón "Suspender" del detalle del negocio.
//
// Sin imports a propósito: scripts/test-suspension-admin.cjs lo carga aislado.

type Respuesta = Promise<{ data?: any }>;

export type ApiSuspensionNegocio = {
  toggleNegocio: (id: string, motivo?: string) => Respuesta;
};

export type ApiSuspensionCuenta = {
  suspenderUsuario: (id: string, motivo?: string) => Respuesta;
  rehabilitarUsuario: (id: string, rol_restaurar: string) => Respuesta;
};

export type AccionNegocio = 'suspender' | 'reactivar';

export type ResultadoAccion =
  | { ok: true; mensaje: string; activo?: boolean }
  | { ok: false; error: string };

export const MENSAJE_MOTIVO_OBLIGATORIO = 'El motivo es obligatorio para suspender';

function mensajeError(e: any, porDefecto: string): string {
  const msg = typeof e?.message === 'string' ? e.message.trim() : '';
  return msg || porDefecto;
}

// Qué acción tiene sentido mostrar para un negocio. Solo los aprobados se
// suspenden/reactivan; los pendientes o rechazados se gestionan con
// Aprobar/Rechazar.
export function accionDisponibleNegocio(negocio: any): AccionNegocio | null {
  if (!negocio || !negocio.verificado) return null;
  return negocio.activo === false ? 'reactivar' : 'suspender';
}

export function textosAccionNegocio(accion: AccionNegocio, nombre: string) {
  if (accion === 'suspender') {
    return {
      titulo: 'Suspender negocio',
      pregunta: `¿Seguro que deseas suspender el negocio "${nombre}"?`,
      detalle: 'El restaurante dejará de mostrarse a los clientes. La cuenta del propietario no se suspende.',
      boton: 'Suspender negocio',
    };
  }
  return {
    titulo: 'Reactivar negocio',
    pregunta: `¿Seguro que deseas reactivar el negocio "${nombre}"?`,
    detalle: 'El restaurante volverá a mostrarse a los clientes.',
    boton: 'Reactivar negocio',
  };
}

// El endpoint es un toggle: llamarlo sobre un estado desactualizado haría lo
// contrario de lo que el admin pidió. Por eso se valida la acción contra el
// estado conocido antes de llamar, y el estado final se toma de la respuesta.
export async function ejecutarAccionNegocio(
  api: ApiSuspensionNegocio,
  negocio: any,
  accion: AccionNegocio,
  motivo?: string,
): Promise<ResultadoAccion> {
  const disponible = accionDisponibleNegocio(negocio);
  if (disponible !== accion) {
    if (!disponible) return { ok: false, error: 'Solo se puede suspender o reactivar un negocio aprobado.' };
    return { ok: false, error: accion === 'suspender' ? 'El negocio ya está suspendido.' : 'El negocio ya está activo.' };
  }
  try {
    const motivoLimpio = accion === 'suspender' ? (motivo || '').trim() || undefined : undefined;
    const res = await api.toggleNegocio(negocio.id, motivoLimpio);
    const activo = typeof res?.data?.activo === 'boolean' ? res.data.activo : accion === 'reactivar';
    const nombre = negocio.nombre || 'El negocio';
    return {
      ok: true,
      activo,
      mensaje: activo ? `"${nombre}" fue reactivado.` : `"${nombre}" fue suspendido.`,
    };
  } catch (e: any) {
    return {
      ok: false,
      error: mensajeError(e, accion === 'suspender' ? 'No se pudo suspender el negocio.' : 'No se pudo reactivar el negocio.'),
    };
  }
}

// ── Foto del negocio ─────────────────────────────────────────────────────────
// Reactivar un negocio sin foto responde 409 ("No se puede activar el negocio
// porque no tiene foto.", backend/routes/admin.js). En vez de ofrecer un
// "Reactivar" que va a fallar, la lista y el detalle lo detectan antes y
// llevan al admin a subir la foto (caso "Sabor Casero").

// Mismo criterio que tieneFoto() del backend (services/fotoObligatoria.js).
export function negocioTieneFoto(negocio: any): boolean {
  const url = negocio?.imagen_url;
  return typeof url === 'string' && url.trim() !== '';
}

export type AccionTarjetaSuspendido = 'reactivar' | 'agregar_foto';

// Botón de la tarjeta de un negocio suspendido; null si no está suspendido.
export function accionTarjetaSuspendido(negocio: any): AccionTarjetaSuspendido | null {
  if (accionDisponibleNegocio(negocio) !== 'reactivar') return null;
  return negocioTieneFoto(negocio) ? 'reactivar' : 'agregar_foto';
}

export function rutaAgregarFotoNegocio(id: string): string {
  return `/admin/restaurante-detalle?id=${encodeURIComponent(id)}&accion=foto`;
}

export type ApiFotoNegocio = {
  uploadBase64: (base64: string, path: string, contentType?: string) => Respuesta;
  actualizarNegocio: (id: string, data: any) => Respuesta;
};

export type ResultadoFoto =
  | { ok: true; imagen_url: string; negocio: any }
  | { ok: false; error: string };

// Extensiones que acepta POST /uploads/base64 (backend/routes/uploads.js).
const EXTENSIONES_FOTO = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic']);

export function extensionFoto(mimeType: string | undefined): string {
  const ext = String(mimeType || '').split('/')[1]?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
  return EXTENSIONES_FOTO.has(ext) ? ext : 'jpg';
}

// Sube la foto (mismo path que usa el restaurante en restaurante/perfil.tsx) y
// la escribe en el negocio. Como admin, PUT /negocios/:id la aplica directo,
// sin pasar por cambios-perfil. No reactiva: eso sigue siendo una decisión
// explícita del admin (ejecutarAccionNegocio).
export async function subirFotoNegocio(
  api: ApiFotoNegocio,
  negocioId: string,
  imagen: { base64: string; mimeType?: string },
  ahora: number = Date.now(),
): Promise<ResultadoFoto> {
  try {
    const mime = imagen.mimeType || 'image/jpeg';
    const path = `negocios/${negocioId}/imagen_${ahora}.${extensionFoto(mime)}`;
    const subida = await api.uploadBase64(imagen.base64, path, mime);
    const url = subida?.data?.publicUrl;
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'No se pudo subir la foto del negocio.' };
    const res = await api.actualizarNegocio(negocioId, { imagen_url: url });
    if (res?.data?.cambio_foto_pendiente) {
      return { ok: false, error: 'La foto quedó en revisión en lugar de aplicarse. Apruébala en Cambios de perfil.' };
    }
    return { ok: true, imagen_url: url, negocio: res?.data || null };
  } catch (e: any) {
    return { ok: false, error: mensajeError(e, 'No se pudo subir la foto del negocio.') };
  }
}

// Solicitud de cambio de perfil PENDIENTE de este negocio que trae una foto
// (la que subió el restaurante y está esperando revisión), o null.
export function solicitudFotoPendiente(solicitudes: any[] | null | undefined, negocioId: string): any | null {
  if (!Array.isArray(solicitudes)) return null;
  return solicitudes.find((s) =>
    s?.negocio_id === negocioId && s?.estado === 'pendiente' &&
    typeof s?.cambios?.imagen_url === 'string' && s.cambios.imagen_url.trim() !== '') || null;
}

export async function suspenderCuenta(
  api: ApiSuspensionCuenta,
  usuario: { id: string; nombre?: string; rol?: string },
  motivo: string,
): Promise<ResultadoAccion> {
  const motivoLimpio = (motivo || '').trim();
  if (!motivoLimpio) return { ok: false, error: MENSAJE_MOTIVO_OBLIGATORIO };
  if (usuario.rol === 'admin') return { ok: false, error: 'No se puede suspender a un administrador' };
  if (usuario.rol === 'suspendido') return { ok: false, error: 'La cuenta ya está suspendida.' };
  try {
    await api.suspenderUsuario(usuario.id, motivoLimpio);
    return { ok: true, mensaje: `La cuenta de "${usuario.nombre || 'el usuario'}" fue suspendida.` };
  } catch (e: any) {
    return { ok: false, error: mensajeError(e, 'Error al suspender') };
  }
}

export async function rehabilitarCuenta(
  api: ApiSuspensionCuenta,
  usuario: { id: string; nombre?: string },
  rol: string,
): Promise<ResultadoAccion> {
  try {
    await api.rehabilitarUsuario(usuario.id, rol || 'cliente');
    return { ok: true, mensaje: `La cuenta de "${usuario.nombre || 'el usuario'}" fue rehabilitada.` };
  } catch (e: any) {
    return { ok: false, error: mensajeError(e, 'Error al rehabilitar') };
  }
}
