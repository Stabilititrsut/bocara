// Emisor de analítica del embudo de compra (módulo 03 · Indicadores y Embudo).
//
//   visita (session_start) → view_item → add_to_cart → begin_checkout → compra
//
// · anon_id persistente en AsyncStorage: identifica el dispositivo sin login.
// · sesion_id expira tras 30 min sin actividad; una sesión nueva emite
//   'session_start' (con utm_source/utm_campaign si la URL los trae, en web).
// · Cola en memoria con envío por lotes: al llenarse, cada 15 s, al pasar la
//   app a segundo plano y al desmontar. En web, `pagehide` manda lo pendiente
//   con fetch keepalive (p. ej. al redirigir a Cubo para pagar).
// · Nada de esto puede romper la app: todo error se traga. Un fallo de red o
//   5xx deja el lote en cola para el siguiente intento; un 4xx (el backend lo
//   rechazó por esquema) se descarta para no reintentarlo para siempre. El
//   backend deduplica por client_event_id, así que un reenvío es inofensivo.
//
// Las compras para KPIs se verifican en el backend contra pedidos pagados:
// lo que emite el cliente nunca cuenta como venta por sí solo.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { analiticaAPI, API_BASE_URL } from '../services/api';
import type { EventoAnalitica, EventoAnaliticaPayload } from '../services/api';

export const INACTIVIDAD_SESION_MS = 30 * 60 * 1000;
export const INTERVALO_ENVIO_MS = 15 * 1000;
export const UMBRAL_ENVIO = 20;
export const MAX_POR_LOTE = 50; // límite del backend por petición
export const MAX_COLA = 500;
export const CLAVE_ANON = 'bocara_analitica_anon_id';
export const CLAVE_SESION = 'bocara_analitica_sesion';

const RE_ID = /^[A-Za-z0-9_.:-]{8,100}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DatosEvento {
  bolsa_id?: string | null;
  negocio_id?: string | null;
  pedido_id?: string | null;
}

export interface Atribucion {
  utm_source?: string;
  utm_campaign?: string;
}

interface Sesion extends Atribucion {
  id: string;
  ultima_actividad: number;
}

interface Almacen {
  getItem(clave: string): Promise<string | null>;
  setItem(clave: string, valor: string): Promise<void>;
}

export interface DependenciasAnalitica {
  almacen: Almacen;
  enviar: (eventos: EventoAnaliticaPayload[]) => Promise<unknown>;
  enviarUrgente?: (eventos: EventoAnaliticaPayload[]) => void;
  ahora?: () => number;
  aleatorio?: () => string;
  atribucion?: () => Atribucion | null;
}

function idAleatorio(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

// El backend acepta [\w .:/+-]{1,100} en los UTM: se limpia en vez de perder
// la sesión entera por un carácter raro en la URL de la campaña.
export function limpiarUtm(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const limpio = valor.replace(/[^\w .:/+-]/g, '').trim().slice(0, 100);
  return limpio || undefined;
}

export function atribucionDeUrl(busqueda: string): Atribucion | null {
  try {
    const params = new URLSearchParams(busqueda);
    const utm_source = limpiarUtm(params.get('utm_source'));
    const utm_campaign = limpiarUtm(params.get('utm_campaign'));
    return utm_source || utm_campaign ? { utm_source, utm_campaign } : null;
  } catch {
    return null;
  }
}

function estadoHttp(error: any): number | null {
  const s = error?.status ?? error?.response?.status;
  return typeof s === 'number' ? s : null;
}

const reintentable = (status: number | null) =>
  status == null || status === 408 || status === 429 || status >= 500;

export function crearEmisorAnalitica(deps: DependenciasAnalitica) {
  const ahora = deps.ahora ?? Date.now;
  const aleatorio = deps.aleatorio ?? idAleatorio;

  let cola: EventoAnaliticaPayload[] = [];
  let anonId: string | null = null;
  let sesion: Sesion | null = null;
  let carga: Promise<void> | null = null;
  let cadena: Promise<void> = Promise.resolve();
  let enviando: Promise<void> | null = null;
  let habilitada = true;
  let secuencia = 0;

  async function cargar() {
    try {
      const guardado = await deps.almacen.getItem(CLAVE_ANON);
      if (guardado && RE_ID.test(guardado)) anonId = guardado;
    } catch { /* se genera uno nuevo */ }
    if (!anonId) {
      anonId = `anon-${aleatorio()}${aleatorio()}`;
      deps.almacen.setItem(CLAVE_ANON, anonId).catch(() => {});
    }
    try {
      const crudo = await deps.almacen.getItem(CLAVE_SESION);
      const s = crudo ? JSON.parse(crudo) : null;
      if (s && RE_ID.test(String(s.id)) && Number.isFinite(s.ultima_actividad)) sesion = s;
    } catch { /* sesión nueva */ }
  }

  function encolar(fila: EventoAnaliticaPayload) {
    cola.push(fila);
    // Sin red durante mucho tiempo: se conservan los más recientes.
    if (cola.length > MAX_COLA) cola.splice(0, cola.length - MAX_COLA);
  }

  function fila(evento: EventoAnalitica, datos: DatosEvento, instante: number, extra: Atribucion = {}): EventoAnaliticaPayload {
    secuencia += 1;
    const f: EventoAnaliticaPayload = {
      client_event_id: `ev-${instante.toString(36)}-${secuencia.toString(36)}-${aleatorio()}`,
      anon_id: anonId as string,
      sesion_id: (sesion as Sesion).id,
      evento,
      ocurrido_en: new Date(instante).toISOString(),
    };
    for (const campo of ['bolsa_id', 'negocio_id', 'pedido_id'] as const) {
      const v = datos[campo];
      if (v && RE_UUID.test(v)) f[campo] = v;
    }
    if (extra.utm_source) f.utm_source = extra.utm_source;
    if (extra.utm_campaign) f.utm_campaign = extra.utm_campaign;
    return f;
  }

  async function procesar(evento: EventoAnalitica, datos: DatosEvento, instante: number) {
    if (!carga) carga = cargar();
    await carga;
    if (!sesion || instante - sesion.ultima_actividad > INACTIVIDAD_SESION_MS) {
      const atribucion = (() => { try { return deps.atribucion?.() || {}; } catch { return {}; } })();
      sesion = { id: `ses-${instante.toString(36)}-${aleatorio()}`, ultima_actividad: instante, ...atribucion };
      encolar(fila('session_start', {}, instante, atribucion));
    }
    sesion.ultima_actividad = Math.max(sesion.ultima_actividad, instante);
    if (evento !== 'session_start') encolar(fila(evento, datos, instante));
    deps.almacen.setItem(CLAVE_SESION, JSON.stringify(sesion)).catch(() => {});
    if (cola.length >= UMBRAL_ENVIO) void enviarCola();
  }

  // Un solo envío a la vez; lotes de MAX_POR_LOTE hasta vaciar o fallar.
  function enviarCola(): Promise<void> {
    if (enviando) return enviando;
    enviando = (async () => {
      while (cola.length > 0) {
        const lote = cola.slice(0, MAX_POR_LOTE);
        try {
          await deps.enviar(lote);
          cola.splice(0, lote.length);
        } catch (e) {
          if (reintentable(estadoHttp(e))) break;
          cola.splice(0, lote.length);
        }
      }
    })().catch(() => {}).finally(() => { enviando = null; });
    return enviando;
  }

  return {
    // Síncrona y segura de llamar desde cualquier handler de UI.
    registrarEvento(evento: EventoAnalitica, datos: DatosEvento = {}) {
      if (!habilitada) return;
      const instante = ahora();
      cadena = cadena.then(() => procesar(evento, datos, instante)).catch(() => {});
    },
    // Espera a que lo registrado hasta ahora esté en cola y lo envía.
    async vaciar() {
      await cadena;
      await enviarCola();
    },
    // Envío de último recurso (la página se está cerrando): no espera respuesta.
    vaciarUrgente() {
      if (!deps.enviarUrgente || cola.length === 0) return;
      const lote = cola.splice(0, MAX_POR_LOTE);
      try { deps.enviarUrgente(lote); } catch { /* la página ya se va */ }
    },
    establecerHabilitada(valor: boolean) {
      habilitada = valor;
    },
    // Solo para pruebas y diagnóstico.
    estado() {
      return { cola: [...cola], anonId, sesion: sesion ? { ...sesion } : null, habilitada };
    },
  };
}

// ── Instancia de la app ──────────────────────────────────────────────────────

function enviarConKeepalive(eventos: EventoAnaliticaPayload[]) {
  if (typeof fetch !== 'function') return;
  // keepalive permite que el POST sobreviva a la navegación (sin token: el
  // backend registra anónimo, la sesión sigue enlazada por sesion_id).
  fetch(`${API_BASE_URL}/analitica/eventos`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventos }),
  }).catch(() => {});
}

const emisor = crearEmisorAnalitica({
  almacen: AsyncStorage,
  enviar: (eventos) => analiticaAPI.enviarEventos(eventos),
  enviarUrgente: Platform.OS === 'web' ? enviarConKeepalive : undefined,
  atribucion: () => (Platform.OS === 'web' && typeof window !== 'undefined'
    ? atribucionDeUrl(window.location?.search || '')
    : null),
});

export const registrarEvento = emisor.registrarEvento;
export const vaciarAnalitica = emisor.vaciar;
export const establecerAnaliticaHabilitada = emisor.establecerHabilitada;

// Arranca el envío periódico y los disparadores de ciclo de vida. Devuelve la
// limpieza para el useEffect del layout raíz: al desmontar envía lo pendiente.
export function iniciarAnalitica(): () => void {
  const intervalo = setInterval(() => { void emisor.vaciar(); }, INTERVALO_ENVIO_MS);
  const subAppState = AppState.addEventListener('change', (estado) => {
    if (estado !== 'active') void emisor.vaciar();
  });

  let quitarWeb = () => {};
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined') {
    const alOcultar = () => { if (document.visibilityState === 'hidden') emisor.vaciarUrgente(); };
    const alSalir = () => emisor.vaciarUrgente();
    document.addEventListener('visibilitychange', alOcultar);
    window.addEventListener('pagehide', alSalir);
    quitarWeb = () => {
      document.removeEventListener('visibilitychange', alOcultar);
      window.removeEventListener('pagehide', alSalir);
    };
  }

  return () => {
    clearInterval(intervalo);
    subAppState?.remove?.();
    quitarWeb();
    void emisor.vaciar();
  };
}
