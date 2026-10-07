import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

// Abre el comprobante PDF de una liquidación a partir de una URL firmada que
// expira (10 min), así que se pide justo al tocar el botón, nunca se guarda.
//
// Web: la pestaña se abre ANTES de esperar la URL. Si se abriera después del
// await, el navegador ya no la considera un gesto del usuario y el bloqueador
// de ventanas emergentes la cancela en silencio.
// Nativo: navegador in-app (SFSafariViewController / Custom Tabs).
type Deps = {
  plataforma?: string;
  abrirNavegador?: (url: string) => Promise<unknown>;
  abrirPestana?: () => { location: { href: string }; close: () => void } | null;
  navegarAqui?: (url: string) => void;
};

export async function abrirComprobante(obtenerUrl: () => Promise<string>, deps: Deps = {}): Promise<void> {
  const plataforma = deps.plataforma ?? Platform.OS;
  if (plataforma === 'web') {
    const abrirPestana = deps.abrirPestana ?? (() => (globalThis as any).window?.open('', '_blank') ?? null);
    const navegarAqui = deps.navegarAqui ?? ((url: string) => { (globalThis as any).window.location.href = url; });
    const pestana = abrirPestana();
    try {
      const url = await obtenerUrl();
      if (pestana) pestana.location.href = url;
      else navegarAqui(url); // pop-ups bloqueados: abrir en la misma pestaña
    } catch (e) {
      pestana?.close();
      throw e;
    }
    return;
  }
  const url = await obtenerUrl();
  await (deps.abrirNavegador ?? ((u: string) => WebBrowser.openBrowserAsync(u)))(url);
}
