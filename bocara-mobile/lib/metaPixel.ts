// Meta Pixel (Facebook) — solo web.
//
// La app no tiene app/+html.tsx: el script base se inyecta en tiempo de
// ejecución desde el layout raíz (iniciarMetaPixel). En nativo, durante el
// render estático de `expo export` (sin window) o con un adblocker que impide
// cargar fbevents.js, todas las funciones son no-ops silenciosos: el píxel
// nunca puede romper la app.

import { Platform } from 'react-native';

export const META_PIXEL_ID = '1034865056275972';
const SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push: Fbq;
  loaded: boolean;
  version: string;
};

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

const esWeb = () =>
  Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';

function llamar(...args: unknown[]) {
  if (!esWeb()) return;
  try {
    if (typeof window.fbq === 'function') window.fbq(...args);
  } catch { /* el píxel jamás interrumpe la UI */ }
}

// Equivalente tipado del snippet oficial de Meta: crea el stub `fbq` que
// encola llamadas hasta que fbevents.js termina de cargar, y dispara el
// PageView inicial. Idempotente.
export function iniciarMetaPixel() {
  if (!esWeb() || window.fbq) return;
  try {
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;

    const script = document.createElement('script');
    script.async = true;
    script.src = SCRIPT_URL;
    (document.head || document.body).appendChild(script);

    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  } catch { /* sin píxel, la app sigue igual */ }
}

export function trackPageView() {
  llamar('track', 'PageView');
}

// `eventID` permite a Meta deduplicar el mismo evento (p. ej. un Purchase
// repetido al recargar la pantalla de confirmación).
export function trackEvent(eventName: string, params?: Record<string, any>, eventID?: string) {
  if (eventID) llamar('track', eventName, params ?? {}, { eventID });
  else if (params) llamar('track', eventName, params);
  else llamar('track', eventName);
}
