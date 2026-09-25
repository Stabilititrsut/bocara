import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import * as Location from 'expo-location';
import { useAuth } from './AuthContext';
import { authAPI } from '../services/api';

export interface Coords {
  lat: number;
  lng: number;
}

// 'bloqueado': el usuario denegó permanentemente (canAskAgain=false) — pedir
// de nuevo no hace nada, hay que mandarlo a Ajustes. 'servicio_desactivado':
// el GPS/localización del dispositivo está apagado a nivel sistema, distinto
// de que la app no tenga permiso.
export type PermissionStatus = 'undetermined' | 'granted' | 'denied' | 'bloqueado' | 'servicio_desactivado';
// De dónde salieron las `coords` actuales — la UI puede usarlo para avisar
// "usando tu última ubicación guardada" en vez de asumir que es en vivo.
export type OrigenCoords = 'dispositivo' | 'backend' | 'ninguna';

interface LocationContextType {
  coords: Coords | null;
  origenCoords: OrigenCoords;
  locationName: string;
  permissionStatus: PermissionStatus;
  loading: boolean;
  actualizando: boolean;
  requestPermission: () => Promise<void>;
  // Refresca la ubicación explícitamente (botón "Actualizar ubicación") — a
  // diferencia de requestPermission, no vuelve a pedir permiso si ya lo tiene.
  actualizarUbicacion: () => Promise<void>;
  formatDistancia: (km: number | null | undefined) => string | null;
  haversine: (lat2: number, lng2: number) => number | null;
}

const LocationContext = createContext<LocationContextType>({
  coords: null,
  origenCoords: 'ninguna',
  locationName: 'Guatemala',
  permissionStatus: 'undetermined',
  loading: true,
  actualizando: false,
  requestPermission: async () => {},
  actualizarUbicacion: async () => {},
  formatDistancia: () => null,
  haversine: () => null,
});

function calcHaversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Pura y exportada para test-location-ux.cjs — misma clasificación que usa
// expo-location, sin acoplarla a un mock del módulo nativo.
export function clasificarPermiso(resultado: { status: string; canAskAgain?: boolean }): PermissionStatus {
  if (resultado.status === 'granted') return 'granted';
  if (resultado.status === 'denied' && resultado.canAskAgain === false) return 'bloqueado';
  if (resultado.status === 'denied') return 'denied';
  return 'undetermined';
}

// Válida como la del backend (utils/geo.js#coordenadasValidas) — evita usar
// como fallback un valor corrupto (NaN, fuera de rango) que llegara en el
// perfil por cualquier motivo.
function coordenadasValidas(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Formato legible único ("1.2 km" / "850 m") — nunca NaN ni valores absurdos:
// null/undefined/NaN/Infinity/negativo se tratan como "no hay distancia que
// mostrar", no como 0.
export function formatDistancia(km: number | null | undefined): string | null {
  if (km === null || km === undefined || !Number.isFinite(km) || km < 0) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// Pura y exportada para tests: decide qué coordenadas usar para presentar
// distancia cuando el dispositivo no tiene una ubicación fresca — nunca
// inventa una ubicación si no hay ninguna fuente válida.
export function resolverCoordsFallback(
  { coordsDispositivo, usuarioLat, usuarioLng }: { coordsDispositivo: Coords | null; usuarioLat?: unknown; usuarioLng?: unknown }
): { coords: Coords | null; origen: OrigenCoords } {
  if (coordsDispositivo) return { coords: coordsDispositivo, origen: 'dispositivo' };
  if (coordenadasValidas(usuarioLat, usuarioLng)) {
    return { coords: { lat: usuarioLat as number, lng: usuarioLng as number }, origen: 'backend' };
  }
  return { coords: null, origen: 'ninguna' };
}

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { usuario } = useAuth();
  const [coordsDispositivo, setCoordsDispositivo] = useState<Coords | null>(null);
  const [locationName, setLocationName] = useState('Guatemala');
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus>('undetermined');
  const [loading, setLoading] = useState(true);
  const [actualizando, setActualizando] = useState(false);
  const montado = useRef(true);
  useEffect(() => () => { montado.current = false; }, []);

  // No persistir la misma coordenada dos veces en la misma sesión — evita un
  // PATCH de más si algo dispara fetchLocation repetidamente.
  const ultimaPersistida = useRef<string | null>(null);

  const persistirEnBackend = useCallback(async (lat: number, lng: number) => {
    if (!usuario) return; // el endpoint requiere sesión — sin usuario no hay a quién guardársela
    // La clave incluye el usuario: mismas coords para un usuario distinto (p.ej.
    // cambio de cuenta en el mismo dispositivo, sin reobtener GPS) deben
    // volver a persistirse, no quedarse "ya guardadas" por el usuario anterior.
    const clave = `${usuario.id}:${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (ultimaPersistida.current === clave) return;
    // Se marca ANTES del await (chequeo-y-marcado síncrono, JS es de un solo
    // hilo): si fetchLocation dispara el PATCH inline y, en el mismo tick, el
    // efecto de reintento de abajo también intenta persistir las mismas
    // coords, solo la primera llamada pasa el guard — la segunda ve la clave
    // ya marcada y no duplica la petición real.
    ultimaPersistida.current = clave;
    try {
      await authAPI.actualizarUbicacion(lat, lng);
    } catch {
      // Best-effort: si falla (offline, backend caído, migración pendiente en
      // el servidor) la app sigue funcionando con la coordenada en memoria.
      // Se libera la marca para permitir reintentar en el próximo disparo
      // (cambio de coords/usuario) en vez de quedar "por siempre" sin guardar.
      ultimaPersistida.current = null;
    }
  }, [usuario]);

  // Cierra la race condition del diagnóstico QA #4: fetchLocation puede
  // resolver GPS antes de que AuthContext termine de cargar `usuario` (arranque
  // en frío), y en ese momento persistirEnBackend hace `return` temprano sin
  // reintento. Este efecto reintenta en cuanto `usuario` (o las coords) cambian;
  // persistirEnBackend ya deduplica por clave usuario+coords, así que no genera
  // PATCH de más cuando ambos ya estaban listos y el PATCH original sí salió.
  useEffect(() => {
    if (usuario && coordsDispositivo) {
      void persistirEnBackend(coordsDispositivo.lat, coordsDispositivo.lng);
    }
  }, [usuario, coordsDispositivo, persistirEnBackend]);

  const fetchLocation = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (!montado.current) return;
      const { latitude, longitude } = pos.coords;
      setCoordsDispositivo({ lat: latitude, lng: longitude });
      void persistirEnBackend(latitude, longitude);

      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (place && montado.current) {
          const name = place.district || place.subregion || place.city || place.region || 'Guatemala';
          setLocationName(name);
        }
      } catch {
        // Reverse geocode no crítico — se conserva el nombre por defecto
      }
    } catch {
      // Fallo al leer el GPS — la app sigue funcionando sin coords de dispositivo
      // (resolverCoordsFallback cae al backend o a "ninguna").
    } finally {
      if (montado.current) setLoading(false);
    }
  }, [persistirEnBackend]);

  const requestPermission = useCallback(async () => {
    setLoading(true);
    try {
      // Android puede tener el permiso de la app concedido pero el servicio de
      // ubicación del sistema apagado — expo-location no lo reporta como
      // "denied", simplemente getCurrentPositionAsync fallaría. Se revisa
      // antes de gastar un ciclo de permiso pidiendo algo que no puede cumplirse.
      // No existe en web — se protege con try/catch, nunca rompe el build web.
      let serviciosActivos = true;
      try { serviciosActivos = await Location.hasServicesEnabledAsync(); } catch { /* no soportado en esta plataforma */ }
      if (!serviciosActivos) {
        setPermissionStatus('servicio_desactivado');
        setLoading(false);
        return;
      }

      const resultado = await Location.requestForegroundPermissionsAsync();
      const clasificado = clasificarPermiso(resultado);
      setPermissionStatus(clasificado);
      if (clasificado === 'granted') await fetchLocation();
    } catch {
      setPermissionStatus('denied');
    } finally {
      setLoading(false);
    }
  }, [fetchLocation]);

  // Botón "Actualizar ubicación": no vuelve a solicitar permiso si ya está
  // denegado/bloqueado (eso sería el pedido repetido y molesto que el criterio
  // de Sábado prohíbe) — solo refresca coords cuando el permiso YA es 'granted'.
  const actualizarUbicacionManual = useCallback(async () => {
    if (permissionStatus !== 'granted') { await requestPermission(); return; }
    setActualizando(true);
    try { await fetchLocation(); } finally { if (montado.current) setActualizando(false); }
  }, [permissionStatus, requestPermission, fetchLocation]);

  useEffect(() => {
    (async () => {
      let serviciosActivos = true;
      try { serviciosActivos = await Location.hasServicesEnabledAsync(); } catch { /* no soportado (web) */ }
      if (!serviciosActivos) { setPermissionStatus('servicio_desactivado'); setLoading(false); return; }

      const resultado = await Location.getForegroundPermissionsAsync();
      const clasificado = clasificarPermiso(resultado);
      if (clasificado === 'granted') {
        setPermissionStatus('granted');
        await fetchLocation();
      } else if (clasificado === 'denied' || clasificado === 'bloqueado') {
        // Denegado (temporal o permanente): no se vuelve a pedir solo — el
        // usuario decide desde el botón manual o los Ajustes del sistema.
        setPermissionStatus(clasificado);
        setLoading(false);
      } else {
        // Undetermined — primera vez que se pregunta, es la única situación
        // en la que se solicita automáticamente sin acción del usuario.
        await requestPermission();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback: sin coords de dispositivo (denegado, bloqueado, apagado, o
  // simplemente aún cargando), usar la última ubicación que este usuario
  // guardó en el backend — GET /auth/perfil ya la trae en `usuario`. Nunca al
  // revés: una coordenada fresca del dispositivo siempre gana.
  const { coords, origen: origenCoords } = resolverCoordsFallback({
    coordsDispositivo, usuarioLat: usuario?.latitud, usuarioLng: usuario?.longitud,
  });

  function haversineFromUser(lat2: number, lng2: number): number | null {
    if (!coords || !Number.isFinite(lat2) || !Number.isFinite(lng2)) return null;
    return Math.round(calcHaversine(coords.lat, coords.lng, lat2, lng2) * 10) / 10;
  }

  return (
    <LocationContext.Provider value={{
      coords,
      origenCoords,
      locationName,
      permissionStatus,
      loading,
      actualizando,
      requestPermission,
      actualizarUbicacion: actualizarUbicacionManual,
      formatDistancia,
      haversine: haversineFromUser,
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export const useLocation = () => useContext(LocationContext);
