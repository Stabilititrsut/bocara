import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// La URL de producción es siempre el fallback — __DEV__ nunca se usa para la URL
// para evitar que bocara.vercel.app apunte a localhost por error de bundler.
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL || 'https://bocara.onrender.com/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  // 35 s cubre el cold start de Render free tier (~20-50 s)
  timeout: 35000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('bocara_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (!err.response) {
      return Promise.reject(new Error('Sin conexión a internet. Verifica tu red e intenta de nuevo.'));
    }
    const msg = err.response?.data?.error || err.message || 'Error del servidor';
    return Promise.reject(new Error(msg));
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
};

export const bolsasAPI = {
  listar: (params?: any) => api.get('/bolsas', { params }),
  detalle: (id: string) => api.get(`/bolsas/${id}`),
  crear: (data: any) => api.post('/bolsas', data),
  actualizar: (id: string, data: any) => api.put(`/bolsas/${id}`, data),
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
};

export const pagosAPI = {
  crearIntent: (data: { bolsa_id: string; tipo_entrega: string; direccion_envio?: any }) =>
    api.post('/pagos/crear-intent', data),
  cubopago: (data: {
    items?: Array<{ bolsa_id: string; cantidad: number }>;
    bolsa_id?: string;
    cantidad?: number;
    tipo_entrega: string;
    direccion_envio?: any;
    propina?: number;
  }) => api.post('/pagos/cubopago', data),
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
  listar: () => api.get('/favoritos'),
  check: (negocio_id: string) => api.get(`/favoritos/check/${negocio_id}`),
  agregar: (negocio_id: string) => api.post('/favoritos', { negocio_id }),
  quitar: (negocio_id: string) => api.delete(`/favoritos/${negocio_id}`),
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
  geocodificarNegociosCount: () => api.get('/admin/geocodificar-negocios/count'),
  geocodificarNegocios: () => api.post('/admin/geocodificar-negocios', {}, { timeout: 600000 }),
  liquidaciones: () => api.get('/admin/liquidaciones'),
  pagarLiquidacion: (restaurante_id: string, data?: any) =>
    api.post(`/admin/liquidaciones/${restaurante_id}/pagar`, data || {}),
  contenidoPendiente: () => api.get('/admin/contenido/pendiente'),
  aprobarBolsa: (id: string) => api.put(`/admin/bolsas/${id}/aprobar`),
  rechazarBolsa: (id: string, motivo?: string) =>
    api.put(`/admin/bolsas/${id}/rechazar`, { motivo }),
};

export const promocionesAPI = {
  listar: (params?: any) => api.get('/bolsas', { params: { tipo: 'cupon', activo: true, ...params } }),
};

export default api;
