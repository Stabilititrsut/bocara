// URLs de "Cómo llegar" (Google Maps / Waze) hacia un negocio. Única fuente
// para todas las pantallas que ofrecen navegación: qr-recogida, negocio/[id],
// tienda/[id], producto/[id] y las tarjetas de (tabs)/pedidos.
//
//   · Siempre gana la URL que el restaurante guardó a mano (google_maps_url /
//     waze_url): apunta a la entrada exacta, no al centroide de la dirección.
//   · Si no hay URL manual, se arma con latitud/longitud. Las coordenadas se
//     validan con != null, no por "truthy": 0 es una coordenada válida.
//   · Sin URL manual ni coordenadas completas → null (la pantalla oculta el
//     botón en vez de ofrecer uno que no lleva a ningún lado).
//
// Sin imports a propósito: scripts/test-navegacion-negocio.cjs lo carga aislado.

type NegocioNavegable = {
  google_maps_url?: string | null;
  waze_url?: string | null;
  latitud?: number | string | null;
  longitud?: number | string | null;
} | null | undefined;

function urlManual(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

// '' o un texto no numérico no son coordenadas; 0 sí lo es.
function coordenada(valor: unknown): number | null {
  if (valor == null || (typeof valor === 'string' && valor.trim() === '')) return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function coordenadas(negocio: NegocioNavegable): { lat: number; lng: number } | null {
  const lat = coordenada(negocio?.latitud);
  const lng = coordenada(negocio?.longitud);
  return lat != null && lng != null ? { lat, lng } : null;
}

export function urlGoogleMaps(negocio: NegocioNavegable): string | null {
  const manual = urlManual(negocio?.google_maps_url);
  if (manual) return manual;
  const c = coordenadas(negocio);
  return c ? `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}` : null;
}

export function urlWaze(negocio: NegocioNavegable): string | null {
  const manual = urlManual(negocio?.waze_url);
  if (manual) return manual;
  const c = coordenadas(negocio);
  return c ? `https://waze.com/ul?ll=${c.lat},${c.lng}&navigate=yes` : null;
}
