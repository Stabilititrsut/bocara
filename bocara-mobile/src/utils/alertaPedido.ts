// Timbre de cocina del panel del restaurante + beeps de los avisos del cliente.
//
// Timbre (hooks/use-timbre-cocina.ts, montado en app/restaurante/_layout.tsx):
// suena POR ESTADO, no por evento — mientras exista algún pedido 'confirmado'
// (pagado, sin aceptar) repite una campana cada INTERVALO_TIMBRE_MS, también
// en la primera carga, y solo se calla cuando ya no queda ninguno (aceptado →
// 'en_preparacion', o cancelado).
//
//   · Web: campana sintética con Web Audio API. Los navegadores solo permiten
//     audio después de un gesto del usuario: desbloquearAudio() se llama desde
//     un onPress, y prepararAudioWeb() desbloquea con el primer toque en la
//     página. Si el contexto está suspendido, el toque se omite en silencio:
//     nunca rompe la pantalla.
//   · Nativo: vibración en cada toque y, cada ~20 s, el tono del sistema vía
//     una notificación local en el canal 'pedidos' (creado en app/_layout.tsx
//     con sonido) — sin expo-av ni archivos de audio, así que no requiere
//     recompilar el binario.
import { Platform, Vibration } from 'react-native';

export const PATRON_VIBRACION = [0, 500, 200, 500];
export const INTERVALO_TIMBRE_MS = 3000;
// Cada cuántos toques del timbre se repite la notificación nativa (~21 s): el
// tono del sistema cada 3 s llenaría la bandeja y no se distingue mejor.
const TOQUES_POR_NOTIFICACION_NATIVA = 7;
const ID_NOTIFICACION_TIMBRE = 'timbre-cocina';

let Notifications: any = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Notifications = require('expo-notifications');
  } catch { }
}

// ── Detección (pura) ─────────────────────────────────────────────────────────

// El timbre suena mientras haya al menos un pedido pagado sin aceptar. Sin
// memoria de "vistos": un pedido que entró con el panel cerrado suena igual
// en cuanto se abre.
export function debeSonarTimbre(pedidos: { estado?: string }[] | null | undefined): boolean {
  return Array.isArray(pedidos) && pedidos.some((p) => p?.estado === 'confirmado');
}

// `vistos` = ids de todos los pedidos ya conocidos por la pantalla; null en la
// primera carga. Devuelve los confirmados que no estaban antes y el conjunto
// actualizado. Solo alimenta el aviso VISUAL de app/restaurante/pedidos.tsx
// ("¡Nuevo pedido confirmado!"); el sonido lo decide debeSonarTimbre.
export function detectarNuevosConfirmados<T extends { id: string; estado: string }>(
  vistos: Set<string> | null,
  pedidos: T[],
): { nuevos: T[]; vistos: Set<string> } {
  const actualizados = new Set(vistos ?? []);
  for (const p of pedidos) actualizados.add(String(p.id));
  if (vistos === null) return { nuevos: [], vistos: actualizados };
  const nuevos = pedidos.filter((p) => p.estado === 'confirmado' && !vistos.has(String(p.id)));
  return { nuevos, vistos: actualizados };
}

// ── Pedidos compartidos ──────────────────────────────────────────────────────

// app/restaurante/pedidos.tsx publica cada lista que carga (incluida la de
// justo después de aceptar o cancelar): el timbre se apaga al instante, sin
// esperar a su propio polling.
type OyentePedidos = (pedidos: any[]) => void;
const oyentesPedidos = new Set<OyentePedidos>();

export function suscribirPedidosRestaurante(cb: OyentePedidos): () => void {
  oyentesPedidos.add(cb);
  return () => { oyentesPedidos.delete(cb); };
}

export function publicarPedidosRestaurante(pedidos: any[]) {
  oyentesPedidos.forEach((cb) => { try { cb(pedidos); } catch { } });
}

// ── Web Audio ────────────────────────────────────────────────────────────────

let audioCtx: any = null;

function contextoAudio(): any {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

// ¿El navegador ya deja sonar? En nativo siempre. En web, solo con el contexto
// en 'running' (tras un gesto); no crea el contexto si aún no existe.
export function audioWebListo(): boolean {
  if (Platform.OS !== 'web') return true;
  return audioCtx?.state === 'running';
}

// Debe llamarse DENTRO de un gesto (onPress): crea y reanuda el contexto.
// Devuelve si quedó listo para sonar. Nunca lanza, y nunca se queda colgada:
// con el autoplay bloqueado, resume() puede no resolverse jamás.
export async function desbloquearAudio(): Promise<boolean> {
  if (Platform.OS !== 'web') return true;
  let ctx: any = null;
  try { ctx = contextoAudio(); } catch { }
  if (!ctx) return false;
  try {
    if (ctx.state !== 'running') {
      await Promise.race([
        Promise.resolve(ctx.resume()),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  } catch { }
  return ctx.state === 'running';
}

// Con el primer toque/tecla en la página se crea y reanuda el contexto, para
// que lo que suene después ya pueda oírse. `alDesbloquear` avisa cuando quedó
// listo. Devuelve la función de limpieza.
export function prepararAudioWeb(alDesbloquear?: () => void): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => {};
  const desbloquear = () => {
    quitar();
    desbloquearAudio().then((ok) => { if (ok) alDesbloquear?.(); }, () => {});
  };
  const quitar = () => {
    document.removeEventListener('pointerdown', desbloquear);
    document.removeEventListener('keydown', desbloquear);
  };
  document.addEventListener('pointerdown', desbloquear);
  document.addEventListener('keydown', desbloquear);
  return quitar;
}

function tono(ctx: any, frecuencia: number, inicio: number, duracion: number, volumen: number, tipo = 'sine') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = tipo;
  osc.frequency.value = frecuencia;
  gain.gain.setValueAtTime(0.0001, inicio);
  gain.gain.exponentialRampToValueAtTime(volumen, inicio + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, inicio + duracion);
  osc.connect(gain).connect(ctx.destination);
  osc.start(inicio);
  osc.stop(inicio + duracion + 0.02);
}

async function beepsWeb() {
  const ctx = contextoAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { return; }
    if (ctx.state !== 'running') return; // autoplay bloqueado: el aviso visual queda igual
  }
  const inicio = ctx.currentTime + 0.02;
  [0, 0.28, 0.56].forEach((desfase, i) => tono(ctx, i === 2 ? 1175 : 880, inicio + desfase, 0.2, 0.35));
}

// Campana "ding-dong" doble del timbre. Si el contexto no está corriendo, se
// intenta reanudar SIN esperar (un resume() sin gesto puede quedar pendiente
// para siempre y se acumularía una promesa por toque) y este toque se omite.
function campanaWeb() {
  const ctx = audioCtx;
  if (!ctx) return;
  if (ctx.state !== 'running') {
    try { Promise.resolve(ctx.resume?.()).catch(() => {}); } catch { }
    return;
  }
  const inicio = ctx.currentTime + 0.02;
  [[1319, 0], [1047, 0.35], [1319, 0.9], [1047, 1.25]].forEach(([f, d]) =>
    tono(ctx, f, inicio + d, 0.55, 0.45, 'triangle'));
}

// Mismos beeps para los avisos del cliente (cambios de fase, ofertas). Nunca
// lanza: si el navegador bloquea el audio, el aviso visual queda igual.
export async function sonarAvisoWeb() {
  if (Platform.OS !== 'web') return;
  try { (navigator as any)?.vibrate?.(PATRON_VIBRACION); } catch { }
  try { await beepsWeb(); } catch { }
}

// ── Timbre de cocina ─────────────────────────────────────────────────────────

let intervaloTimbre: ReturnType<typeof setInterval> | null = null;
let toquesTimbre = 0;

function tocarTimbre() {
  toquesTimbre++;
  if (Platform.OS === 'web') {
    try { (navigator as any)?.vibrate?.(PATRON_VIBRACION); } catch { }
    try { campanaWeb(); } catch { }
    return;
  }
  try { Vibration.vibrate(PATRON_VIBRACION); } catch { }
  if ((toquesTimbre - 1) % TOQUES_POR_NOTIFICACION_NATIVA !== 0) return;
  try {
    Promise.resolve(Notifications?.scheduleNotificationAsync({
      identifier: ID_NOTIFICACION_TIMBRE,
      content: {
        title: '🛎️ Pedido por aceptar',
        body: 'Tienes pedidos pagados esperando. Acéptalos en la pestaña Pedidos.',
        sound: 'default',
        data: { screen: 'restaurante/pedidos' },
      },
      // Inmediata; en Android, por el canal 'pedidos' (urgente, con sonido).
      trigger: Platform.OS === 'android' ? { channelId: 'pedidos' } : null,
    })).catch(() => {});
  } catch { }
}

// Arranca el timbre (toca ya y luego cada INTERVALO_TIMBRE_MS). Idempotente:
// si ya suena, no crea otro intervalo. Devuelve si lo arrancó esta llamada.
export function iniciarTimbre(): boolean {
  if (intervaloTimbre != null) return false;
  toquesTimbre = 0;
  intervaloTimbre = setInterval(tocarTimbre, INTERVALO_TIMBRE_MS);
  tocarTimbre();
  return true;
}

// Detiene el timbre y libera el intervalo. Idempotente. Devuelve si estaba sonando.
export function detenerTimbre(): boolean {
  if (intervaloTimbre == null) return false;
  clearInterval(intervaloTimbre);
  intervaloTimbre = null;
  if (Platform.OS !== 'web') {
    try { Vibration.cancel(); } catch { }
    try { Promise.resolve(Notifications?.dismissNotificationAsync?.(ID_NOTIFICACION_TIMBRE)).catch(() => {}); } catch { }
  }
  return true;
}

export function timbreSonando(): boolean {
  return intervaloTimbre != null;
}
