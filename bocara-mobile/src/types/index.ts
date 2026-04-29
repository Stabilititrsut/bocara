export type Rol = 'cliente' | 'restaurante' | 'admin';

export interface Usuario {
  id: string;
  email: string;
  nombre: string;
  apellido?: string;
  rol: Rol;
  telefono?: string;
  avatar_url?: string;
  puntos: number;
  total_bolsas_salvadas: number;
  total_co2_salvado_kg: number;
  total_ahorrado: number;
  created_at: string;
}

export interface Negocio {
  id: string;
  propietario_id: string;
  nombre: string;
  descripcion?: string;
  direccion: string;
  zona: string;
  ciudad: string;
  telefono?: string;
  categoria: string;
  imagen_url?: string;
  logo_url?: string;
  activo: boolean;
  verificado: boolean;
  calificacion_promedio: number;
  total_resenas: number;
  total_bolsas_vendidas: number;
  latitud?: number | null;
  longitud?: number | null;
  permite_envio?: boolean;
}

export interface Bolsa {
  id: string;
  negocio_id: string;
  nombre: string;
  descripcion?: string;
  contenido?: string;
  precio_original: number;
  precio_descuento: number;
  cantidad_disponible: number;
  tipo: 'bolsa' | 'cupon';
  categoria?: string;
  imagen_url?: string;
  hora_recogida_inicio: string;
  hora_recogida_fin: string;
  fecha_disponible?: string;
  permite_envio: boolean;
  co2_salvado_kg: number;
  activo: boolean;
  negocios?: Negocio;
  distancia_km?: number | null;
}

export type EstadoPedido = 'pendiente' | 'confirmado' | 'listo' | 'recogido' | 'cancelado';

export interface Pedido {
  id: string;
  usuario_id: string;
  bolsa_id: string;
  negocio_id: string;
  estado: EstadoPedido;
  estado_pago: string;
  tipo_entrega: 'recogida' | 'envio';
  direccion_envio?: any;
  precio_bolsa: number;
  costo_envio: number;
  total: number;
  codigo_recogida: string;
  hora_recogida_inicio: string;
  hora_recogida_fin: string;
  created_at: string;
  bolsas?: Bolsa;
  negocios?: Negocio;
}

export interface CartItem {
  bolsa: Bolsa;
  cantidad: number;
}

export interface AuthState {
  usuario: Usuario | null;
  token: string | null;
  loading: boolean;
}
