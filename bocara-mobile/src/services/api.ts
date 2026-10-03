import { create } from 'axios';
import { Platform } from 'react-native';
import { emitSessionInvalid } from './sessionEvents';
import { getAuthToken } from './authTokenStorage';
import type { CrearBolsaPayload, ActualizarBolsaPayload } from '../types';

// Puerto donde corre el backend local (ver docs/ENTORNO_LOCAL.md). Ajustable sin
// tocar código si algún día el backend local cambia de puerto.
const PUERTO_API_LOCAL = process.env.EXPO_PUBLIC_LOCAL_API_PORT || '3000';

// Mismo patrón que usan solo literales de IPv4 (ej. "198.168.21.19"), nunca
// nombres de dominio — así nunca puede confundirse con bocarafood.com o
// *.vercel.app, que son nombres, no IPs.
const IP_LITERAL_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// En web, el JS bundle que sirve `expo start --web` es EL MISMO para cualquiera
// que lo abra — por laptop local (http://localhost:8085) o por otra máquina de
// la misma red (http://198.168.21.19:8085) — porque EXPO_PUBLIC_API_URL se
// "hornea" una sola vez al arrancar el bundler, no por visitante. Si se deja
// fija en "http://localhost:3000/api", la laptop remota de la LAN termina
// pidiéndole a SU PROPIO localhost (que no tiene nada corriendo), no al backend
// real. La solución: en vez de confiar en el valor horneado, se deriva el
// backend del origen con el que el navegador cargó la página en ese momento
// (window.location), y solo cuando ese origen es localhost o una IP literal —
// nunca un nombre de dominio real — para que esto jamás pueda activarse en un
// build de producción servido desde bocarafood.com o un preview de Vercel.
function resolverApiBaseUrlLocalWeb(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const { hostname, protocol } = window.location;
  const esLocal = hostname === 'localhost' || hostname === '127.0.0.1' || IP_LITERAL_RE.test(hostname);
  if (!esLocal) return null;
  return `${protocol}//${hostname}:${PUERTO_API_LOCAL}/api`;
}

// La URL de producción es siempre el fallback — __DEV__ nunca se usa para la URL
// para evitar que bocara.vercel.app apunte a localhost por error de bundler.
// resolverApiBaseUrlLocalWeb() tiene prioridad sobre EXPO_PUBLIC_API_URL en web
// local/LAN: ese env var queda fijo en el bundle y no puede variar por
// visitante, así que si no se le da prioridad, un valor horneado como
// "http://localhost:3000/api" seguiría rompiendo el acceso por LAN.
export const API_BASE_URL: string =
  resolverApiBaseUrlLocalWeb() || process.env.EXPO_PUBLIC_API_URL || 'https://bocara.onrender.com/api';

const api = create({
  baseURL: API_BASE_URL,
  // 75 s: el cold start de Render free tier puede superar los 90 s medidos
  // en producción (no los ~20-50 s asumidos originalmente), y encima algunos
  // endpoints además esperan un envío de correo (Nodemailer/Gmail).
  timeout: 75000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
  const token = await getAuthToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (!err.response) {
      // Sin respuesta del servidor puede ser falta de red real, pero también
      // timeout o bloqueo CORS — no asumir "sin internet" para todos los casos,
      // porque eso oculta el error real (ej. al aprobar/rechazar en el panel admin).
      let msg = 'Sin conexión a internet. Verifica tu red e intenta de nuevo.';
      if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
        msg = 'El servidor tardó demasiado en responder. Intenta de nuevo.';
      } else if (err.message && !/network error/i.test(err.message)) {
        msg = err.message;
      }
      const error = new Error(msg) as any;
      error.status = null;
      return Promise.reject(error);
    }
    // backend/middleware/auth.js (y su duplicado en backend/routes/bolsas.js) son los únicos
    // lugares del backend que devuelven estos dos mensajes exactos con 401 —
    // ambos significan que SÍ se mandó un token y el backend lo rechazó
    // (expirado, secreto rotado, firma inválida, o cuenta suspendida/inactiva
    // detectada en el propio request). Es la señal correcta de "la sesión murió".
    //
    // A propósito NO reaccionamos a "No autenticado" (no se mandó token) ni a
    // ningún otro 401 del backend (ej. /auth/login con credenciales incorrectas,
    // /auth/reset-password con código vencido, /auth/oauth-complete con token de
    // Google inválido) — esos son 401 de endpoints públicos que no implican que
    // había una sesión activa, y tratarlos igual causaría que un login fallido
    // redirija a /login con un mensaje engañoso de "tu sesión expiró".
    //
    // Estos dos strings deben coincidir EXACTO con backend/middleware/auth.js — son
    // proyectos/bundles separados (backend Node vs. app Expo), no se pueden
    // importar directo, así que si cambian allá hay que actualizarlos acá.
    const MENSAJES_SESION_MUERTA: Record<string, string> = {
      'Token inválido': 'Tu sesión expiró, inicia sesión de nuevo.',
      'Tu cuenta fue suspendida. Contáctanos al +502 5107-7949':
        'Tu cuenta fue suspendida. Contáctanos al +502 5107-7949',
    };
    if (err.response.status === 401) {
      const uiMessage = MENSAJES_SESION_MUERTA[err.response?.data?.error];
      if (uiMessage) emitSessionInvalid(uiMessage);
    }

    const msg = err.response?.data?.error || err.message || 'Error del servidor';
    const error = new Error(msg) as any;
    error.responseData = err.response.data;
    error.status = err.response.status;
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  registroCliente: (data: any) =>
    api.post('/auth/registro', { ...data, rol: 'cliente' }),
  registroCompleto: (data: any) =>
    api.post('/auth/registro-completo', data),
  registroRestaurante: (data: any) =>
    api.post('/auth/registro', { ...data, rol: 'restaurante' }),
  perfil: () => api.get('/auth/perfil'),
  actualizarPerfil: (data: any) => api.put('/auth/perfil', data),
  sendPhoneOtp: (telefono: string) =>
    api.post('/auth/send-phone-otp', { telefono }),
  verifyPhoneOtp: (data: { telefono: string; codigo: string; nombre?: string; apellido?: string }) =>
    api.post('/auth/verify-phone-otp', data),
  oauthComplete: (supabase_access_token: string) =>
    api.post('/auth/oauth-complete', { supabase_access_token }),
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }),
  resetPassword: (data: { email: string; codigo: string; new_password: string }) =>
    api.post('/auth/reset-password', data),
  checkEmail: (email: string) =>
    api.get('/auth/check-email', { params: { email } }),
  enviarOtpEmail: (email: string) =>
    api.post('/auth/enviar-otp-email', { email }),
  verificarOtpRegistro: (data: { email: string; codigo: string; nombre: string; apellido?: string; password: string; telefono?: string }) =>
    api.post('/auth/verificar-otp-email', data),
  // Persiste la ubicación del cliente autenticado (backend/routes/auth.js —
  // migración 202609171200_ubicacion_usuario.sql). Nunca manda un id de
  // usuario: el backend siempre escribe sobre el dueño del token.
  actualizarUbicacion: (latitud: number, longitud: number) =>
    api.patch('/auth/ubicacion', { latitud, longitud }),
};

export const negociosAPI = {
  listar: (params?: any) => api.get('/negocios', { params }),
  feed: (params?: any) => api.get('/negocios/feed', { params }),
  detalle: (id: string) => api.get(`/negocios/${id}`),
  detalleCompleto: (id: string) => api.get(`/negocios/${id}/detalle`),
  bolsas: (id: string) => api.get(`/negocios/${id}/bolsas`),
  miNegocio: () => api.get('/negocios/mi-negocio'),
  actualizar: (id: string, data: any) => api.put(`/negocios/${id}`, data),
  estadisticas: (id: string) => api.get(`/negocios/${id}/estadisticas`),
  ganancias: (periodo?: string) => api.get('/negocios/mi-negocio/ganancias', { params: { periodo } }),
  solicitarCambios: (data: any) => api.post('/negocios/mi-negocio/solicitar-cambios', data),
  cambiosPendientes: () => api.get('/negocios/mi-negocio/cambios-pendientes'),
  impacto: (id: string) => api.get(`/negocios/${id}/impacto`),
};

export const bolsasAPI = {
  listar: (params?: any) => api.get('/bolsas', { params }),
  detalle: (id: string) => api.get(`/bolsas/${id}`),
  crear: (data: CrearBolsaPayload) => api.post('/bolsas', data),
  actualizar: (id: string, data: ActualizarBolsaPayload) => api.put(`/bolsas/${id}`, data),
  eliminar: (id: string) => api.delete(`/bolsas/${id}`),
};

export const pedidosAPI = {
  listar: () => api.get('/pedidos'),
  detalle: (id: string) => api.get(`/pedidos/${id}`),
  restaurante: () => api.get('/pedidos/restaurante'),
  previosEnNegocio: (negocioId: string) => api.get(`/pedidos/previos/${negocioId}`),
  actualizarEstado: (id: string, estado: string) =>
    api.put(`/pedidos/${id}/estado`, { estado }),
  crear: (data: { bolsa_id: string; tipo_entrega: string; direccion_envio?: any }) =>
    api.post('/pedidos/crear', data),
  factura: (pedidoId: string, data: { tipo: 'cf' | 'nit'; nit?: string; nombre_fiscal?: string }) =>
    api.post(`/pedidos/${pedidoId}/factura`, data),
  getResumenCliente: () => api.get('/pedidos/resumen-cliente'),
  cancelar: (id: string) => api.patch(`/pedidos/${id}/cancelar`, {}),
};

export const pagosAPI = {
  crearIntent: (data: { bolsa_id: string; tipo_entrega: string; direccion_envio?: any }) =>
    api.post('/pagos/crear-intent', data),
  cubopago: (data: {
    items?: { bolsa_id: string; cantidad: number }[];
    bolsa_id?: string;
    cantidad?: number;
    tipo_entrega: string;
    direccion_envio?: any;
    propina?: number;
  }) => api.post('/pagos/cubopago', data),
  preparar: (data: {
    items?: { bolsa_id: string; cantidad: number }[];
    bolsa_id?: string;
    cantidad?: number;
    tipo_entrega: string;
    propina?: number;
    cupon_id?: string;
  }) => api.post('/pagos/preparar', data),
  generarLink: (data: { pedidoId: string }) =>
    api.post('/pagos/generar-link', data),
  actualizarBorrador: (id: string, data: { propina: number }) =>
    api.patch(`/pagos/borrador/${id}`, data),
  actualizarCuponBorrador: (id: string, data: { cupon_id: string | null }) =>
    api.patch(`/pagos/borrador/${id}/cupon`, data),
  estado: (id: string) => api.get(`/pagos/estado/${id}`),
};

export const resenasAPI = {
  listarPorNegocio: (negocioId: string) => api.get(`/resenas/${negocioId}`),
  crear: (data: any) => api.post('/resenas', data),
};

export const notificacionesAPI = {
  listar: () => api.get('/notificaciones'),
  marcarLeida: (id: string) => api.put(`/notificaciones/${id}/leer`),
  guardarToken: (token: string) =>
    api.post('/notificaciones/token', { expo_push_token: token }),
};

export const favoritosAPI = {
  listar:       () => api.get('/favoritos/negocios'),
  listarBolsas: () => api.get('/favoritos/bolsas'),
  check:        (negocio_id: string) => api.get(`/favoritos/check/negocio/${negocio_id}`),
  checkBolsa:   (bolsa_id: string)   => api.get(`/favoritos/check/bolsa/${bolsa_id}`),
  agregar:      (negocio_id: string) => api.post('/favoritos', { tipo: 'negocio', referencia_id: negocio_id }),
  agregarBolsa: (bolsa_id: string)   => api.post('/favoritos', { tipo: 'bolsa',   referencia_id: bolsa_id }),
  quitar:       (negocio_id: string) => api.delete(`/favoritos/${negocio_id}`, { params: { tipo: 'negocio' } }),
  quitarBolsa:  (bolsa_id: string)   => api.delete(`/favoritos/${bolsa_id}`,   { params: { tipo: 'bolsa' } }),
};

export const uploadsAPI = {
  getSignedUrl: (path: string) => api.post('/uploads/signed-url', { path }),
  uploadBase64: (base64: string, path: string, contentType = 'image/jpeg') =>
    api.post('/uploads/base64', { base64, path, contentType }),
};

export const adminAPI = {
  stats: () => api.get('/admin/stats'),
  negocioDetalle: (id: string) => api.get(`/negocios/${id}`),
  usuarios: (params?: any) => api.get('/admin/usuarios', { params }),
  gestionarUsuario: (id: string, data: any) => api.put(`/admin/usuarios/${id}`, data),
  suspenderUsuario: (id: string, motivo?: string) => api.put(`/admin/usuarios/${id}/suspender`, { motivo }),
  rehabilitarUsuario: (id: string, rol_restaurar?: string) =>
    api.put(`/admin/usuarios/${id}/rehabilitar`, { rol_restaurar }),
  negocios: (params?: any) => api.get('/admin/negocios', { params }),
  negociosPendientes: () => api.get('/admin/negocios/pendientes'),
  verificarNegocio: (id: string) => api.put(`/admin/negocios/${id}/verificar`),
  aprobarNegocio: (id: string) => api.put(`/admin/negocios/${id}/aprobar`),
  rechazarNegocio: (id: string, motivo?: string, campos_incorrectos?: string[]) =>
    api.put(`/admin/negocios/${id}/rechazar`, { motivo, campos_incorrectos }),
  toggleNegocio: (id: string, motivo?: string) => api.put(`/admin/negocios/${id}/toggle`, { motivo }),
  financiero: (periodo?: string) => api.get('/admin/financiero', { params: { periodo } }),
  pedidosTodos: (params?: any) => api.get('/admin/pedidos-todos', { params }),
  getConfig: () => api.get('/admin/config'),
  updateConfig: (data: any) => api.put('/admin/config', data),
  datosPrueba: () => api.get('/admin/datos-prueba'),
  geocodificarNegociosCount: () => api.get('/admin/geocodificar-negocios/count'),
  geocodificarNegocios: () => api.post('/admin/geocodificar-negocios', {}, { timeout: 600000 }),
  liquidaciones: () => api.get('/admin/liquidaciones'),
  pagarLiquidacion: (restaurante_id: string, data?: any) =>
    api.post(`/admin/liquidaciones/${restaurante_id}/pagar`, data || {}),
  contenidoPendiente: () => api.get('/admin/contenido/pendiente'),
  aprobarBolsa: (id: string) => api.put(`/admin/bolsas/${id}/aprobar`),
  rechazarBolsa: (id: string, motivo?: string) =>
    api.put(`/admin/bolsas/${id}/rechazar`, { motivo }),
  pedirCambiosBolsa: (id: string, motivo?: string) =>
    api.put(`/admin/bolsas/${id}/pedir-cambios`, { motivo }),
  cambiosPerfil: () => api.get('/admin/cambios-perfil'),
  aprobarCambioPerfil: (id: string) => api.put(`/admin/cambios-perfil/${id}/aprobar`),
  rechazarCambioPerfil: (id: string, motivo?: string) =>
    api.put(`/admin/cambios-perfil/${id}/rechazar`, { motivo }),
  pedirCambiosCambioPerfil: (id: string, motivo?: string) =>
    api.put(`/admin/cambios-perfil/${id}/pedir-cambios`, { motivo }),
  cuboStatus: () => api.get('/admin/cubo-status'),
  cupones: () => api.get('/admin/cupones'),
  crearCupon: (data: any) => api.post('/admin/cupones', data),
  actualizarCupon: (id: string, data: any) => api.put(`/admin/cupones/${id}`, data),
  patchEstadoCupon: (id: string, activo: boolean) => api.patch(`/admin/cupones/${id}/estado`, { activo }),
  eliminarCupon: (id: string) => api.delete(`/admin/cupones/${id}`),
  usosCupon: (id: string) => api.get(`/admin/cupones/${id}/usos`),
  reservasCupon: (id: string) => api.get(`/admin/cupones/${id}/reservas`),
};

export const promocionesAPI = {
  listar: (params?: any) => api.get('/bolsas', { params: { tipo: 'cupon', activo: true, ...params } }),
};

export const cuponesAPI = {
  validar: (codigo: string, montoTotal: number) =>
    api.post('/cupones/validar', { codigo, monto_total: montoTotal }),
  misCupones: () => api.get('/cupones/mis-cupones'),
  miReferido: () => api.get('/cupones/mi-referido'),
};

export default api;
