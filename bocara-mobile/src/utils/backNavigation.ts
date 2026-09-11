// router.back() de expo-router es un no-op silencioso si no hay historial al que
// volver (entrada por URL directa, deep link, o refresh en web) — el botón queda
// visible pero inerte. Todo botón de volver personalizado debe usar esto en vez
// de llamar router.back() directo, para caer a una ruta segura cuando no hay
// historial.
type RouterVolver = { back: () => void; replace: (href: any) => void; canGoBack: () => boolean };

export function volver(router: RouterVolver, fallback: string) {
  if (router.canGoBack()) router.back();
  else router.replace(fallback as any);
}
