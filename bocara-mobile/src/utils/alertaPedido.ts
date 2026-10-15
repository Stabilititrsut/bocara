// Alerta sonora + vibración cuando entra un pedido confirmado nuevo al panel
// del restaurante (app/restaurante/pedidos.tsx).
//
//   · Nativo: vibración [0, 500, 200, 500] y el tono de notificación del
//     sistema vía una notificación local inmediata en el canal 'pedidos'
//     (creado en app/_layout.tsx con sonido) — sin expo-av ni archivos de
//     audio, así que no requiere recompilar el binario.
//   · Web: tres beeps sintéticos con Web Audio API. Si el navegador bloquea el
//     audio (autoplay sin interacción previa), falla en silencio: nunca rompe
//     la pantalla. prepararAudioWeb() desbloquea el audio con el primer toque.
import { Platform, Vibration } from 'react-native';

export const PATRON_VIBRACION = [0, 500, 200, 500];

let Notifications: any = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Notifications = require('expo-notifications');
  } catch { }
}

// ── Detección (pura) ─────────────────────────────────────────────────────────

// `vistos` = ids de todos los pedidos ya conocidos por la pantalla; null en la
// primera carga. Devuelve los confirmados que no estaban antes y el conjunto
// actualizado. En la primera carga nunca hay "nuevos": los pedidos que ya
// existían al abrir la pantalla no deben sonar.
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

// ── Web Audio ────────────────────────────────────────────────────────────────

let audioCtx: any = null;

function contextoAudio(): any {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

// Los navegadores solo permiten audio después de un gesto del usuario: con el
// primer toque/tecla en la página se crea y reanuda el contexto, para que los
// pedidos que entren después ya puedan sonar. Devuelve la función de limpieza.
export function prepararAudioWeb(): () => void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return () => {};
  const desbloquear = () => {
    try { contextoAudio()?.resume?.(); } catch { }
    quitar();
  };
  const quitar = () => {
    document.removeEventListener('pointerdown', desbloquear);
    document.removeEventListener('keydown', desbloquear);
  };
  document.addEventListener('pointerdown', desbloquear);
  document.addEventListener('keydown', desbloquear);
  return quitar;
}

async function beepsWeb() {
  const ctx = contextoAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { return; }
    if (ctx.state !== 'running') return; // autoplay bloqueado: el aviso visual queda igual
  }
  const inicio = ctx.currentTime + 0.02;
  [0, 0.28, 0.56].forEach((desfase, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 1175 : 880;
    const t = inicio + desfase;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  });
}

// Mismos beeps para los avisos del cliente (cambios de fase, ofertas). Nunca
// lanza: si el navegador bloquea el audio, el aviso visual queda igual.
export async function sonarAvisoWeb() {
  if (Platform.OS !== 'web') return;
  try { (navigator as any)?.vibrate?.(PATRON_VIBRACION); } catch { }
  try { await beepsWeb(); } catch { }
}

// ── Alerta ───────────────────────────────────────────────────────────────────

export async function reproducirAlertaNuevoPedido(cantidad: number, codigo?: string) {
  if (Platform.OS === 'web') {
    try { (navigator as any)?.vibrate?.(PATRON_VIBRACION); } catch { }
    try { await beepsWeb(); } catch { }
    return;
  }
  try { Vibration.vibrate(PATRON_VIBRACION); } catch { }
  try {
    await Notifications?.scheduleNotificationAsync({
      content: {
        title: cantidad > 1 ? `🛎️ ${cantidad} pedidos nuevos` : '🛎️ Nuevo pedido confirmado',
        body: codigo && cantidad === 1 ? `Pedido ${codigo} listo para preparar.` : 'Revisa la pestaña Confirmado.',
        sound: 'default',
        data: { screen: 'restaurante/pedidos' },
      },
      // Inmediata; en Android, por el canal 'pedidos' (urgente, con sonido).
      trigger: Platform.OS === 'android' ? { channelId: 'pedidos' } : null,
    });
  } catch { }
}
