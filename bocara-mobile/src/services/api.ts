import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// Web usa localhost; móvil usa la IP local de la máquina
export const API_BASE_URL =
  Platform.OS === 'web'
    ? 'http://localhost:3000/api'
    : 'http://192.168.1.34:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
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
    const msg = err.response?.data?.error || err.message || 'Error de red';
    return Promise.reject(new Error(msg));
  }
);

export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  registroCliente: (data: any) =>
    api.post('/auth/registro', { ...data, rol: 'cliente' }),
  registroRestaurante: (data: any) =>
    api.post('/auth/registro', { ...data, rol: 'restaurante' }),
  perfil: () => api.get('/auth/perfil'),
  actualizarPerfil: (data: any) => api.put('/auth/perfil', data),
};

export const negociosAPI = {
  listar: (params?: any) => api.get('/negocios', { params }),
  detalle: (id: string) => api.get(`/negocios/${id}`),
  miNegocio: () => api.get('/negocios/mi-negocio'),
  actualizar: (id: string, data: any) => api.put(`/negocios/${id}`, data),
  estadisticas: (id: string) => api.get(`/negocios/${id}/estadisticas`),
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
  actualizarEstado: (id: string, estado: string) =>
    api.put(`/pedidos/${id}/estado`, { estado }),
  crear: (data: { bolsa_id: string; tipo_entrega: string; direccion_envio?: any }) =>
    api.post('/pedidos/crear', data),
};

export const pagosAPI = {
  crearIntent: (data: any) => api.post('/pagos/crear-intent', data),
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

export const adminAPI = {
  stats: () => api.get('/admin/stats'),
  usuarios: (params?: any) => api.get('/admin/usuarios', { params }),
  gestionarUsuario: (id: string, data: any) => api.put(`/admin/usuarios/${id}`, data),
  suspenderUsuario: (id: string) => api.put(`/admin/usuarios/${id}/suspender`),
  rehabilitarUsuario: (id: string, rol_restaurar?: string) =>
    api.put(`/admin/usuarios/${id}/rehabilitar`, { rol_restaurar }),
  negocios: (params?: any) => api.get('/admin/negocios', { params }),
  verificarNegocio: (id: string) => api.put(`/admin/negocios/${id}/verificar`),
  rechazarNegocio: (id: string, motivo?: string) =>
    api.put(`/admin/negocios/${id}/rechazar`, { motivo }),
  toggleNegocio: (id: string) => api.put(`/admin/negocios/${id}/toggle`),
  financiero: (periodo?: string) => api.get('/admin/financiero', { params: { periodo } }),
  pedidosTodos: (params?: any) => api.get('/admin/pedidos-todos', { params }),
  getConfig: () => api.get('/admin/config'),
  updateConfig: (data: any) => api.put('/admin/config', data),
  geocodificarNegocios: () => api.post('/admin/geocodificar-negocios'),
};

export default api;
