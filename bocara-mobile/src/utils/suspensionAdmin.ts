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
