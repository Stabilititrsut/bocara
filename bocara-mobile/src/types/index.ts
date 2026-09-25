export type Rol = 'cliente' | 'restaurante' | 'admin' | 'suspendido';

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
  total_ahorrado: number;
  created_at: string;
  // Última ubicación persistida vía PATCH /api/auth/ubicacion (migración
  // 202609171200). Viaja en GET /auth/perfil (select('*')) — null/undefined
  // si el cliente nunca la compartió o la migración aún no corrió en la BD.
  latitud?: number | null;
  longitud?: number | null;
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
  punto_referencia?: string;
  google_maps_url?: string;
  waze_url?: string;
}

// Único campo contractual de backend para distinguir el tipo de publicación
// (ver destructuring de req.body en backend/routes/bolsas.js). Las banderas
// es_tiempo_limitado / es_promocion / es_descuento / ... son clasificación de
// menú (en qué sección/filtro de la tienda aparece) y son independientes del
// tipo — no deben usarse para decidir la etiqueta que ve el cliente.
export type TipoPublicacion = 'bolsa' | 'cupon';

export interface Bolsa {
  id: string;
  negocio_id: string;
  nombre: string;
  descripcion?: string;
  contenido?: string;
  precio_original: number;
  precio_descuento: number;
  cantidad_disponible: number;
  cantidad_disponible_real?: number;
  tipo: TipoPublicacion;
  categoria?: string;
  imagen_url?: string;
  hora_recogida_inicio: string;
  hora_recogida_fin: string;
  fecha_disponible?: string;
  fecha_caducidad?: string | null;
  permite_envio: boolean;
  peso_estimado_kg?: number;
  categoria_alimento?: string | null;
  // Clasificación de menú: en qué sección/filtro de la tienda aparece esta
  // publicación (backend/routes/bolsas.js). Independiente de `tipo` — no
  // decide la etiqueta de tipo que ve el cliente, solo dónde se lista.
  categoria_menu?: string | null;
  es_tiempo_limitado?: boolean;
  es_promocion?: boolean;
  es_descuento?: boolean;
  es_destacado?: boolean;
  es_mas_vendido?: boolean;
  es_precio_bajo?: boolean;
  activo: boolean;
  negocios?: Negocio;
  distancia_km?: number | null;
}

// Campos que POST /bolsas realmente acepta (fuente: destructuring de req.body
// en backend/routes/bolsas.js). negocio_id es opcional: el backend lo resuelve
// del negocio del restaurante autenticado; solo un admin puede especificarlo
// explícitamente. No incluye campos que el backend ignora en creación (p. ej.
// `activo`, que siempre nace según estado_aprobacion).
export interface CrearBolsaPayload {
  negocio_id?: string;
  nombre: string;
  descripcion?: string;
  contenido?: string;
  precio_original: number;
  precio_descuento: number;
  cantidad_disponible?: number;
  tipo?: TipoPublicacion;
  categoria?: string;
  hora_recogida_inicio?: string;
  hora_recogida_fin?: string;
  permite_envio?: boolean;
  imagen_url?: string | null;
  peso_estimado_kg?: number;
  fecha_caducidad?: string | null;
  categoria_alimento?: string | null;
  categoria_menu?: string | null;
  es_tiempo_limitado?: boolean;
  es_promocion?: boolean;
  es_descuento?: boolean;
  es_destacado?: boolean;
  es_mas_vendido?: boolean;
  es_precio_bajo?: boolean;
}

// PUT /bolsas/:id acepta una actualización parcial de los mismos campos, más
// `activo` (fuente: array `campos` en el handler de backend/routes/bolsas.js).
// negocio_id NO está en esa lista — mandarlo en una edición no lo cambiaría,
// así que no forma parte de este tipo.
export type ActualizarBolsaPayload = Partial<Omit<CrearBolsaPayload, 'negocio_id'>> & { activo?: boolean };

export type EstadoPedido = 'pendiente' | 'confirmado' | 'en_preparacion' | 'listo' | 'completado' | 'recogido' | 'cancelado';

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
  resena_id?: string | null;
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

export interface Favorito {
  id: string;
  usuario_id: string;
  negocio_id: string;
  created_at: string;
  negocios?: Negocio;
}
