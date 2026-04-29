import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as Location from 'expo-location';

export interface Coords {
  lat: number;
  lng: number;
}

interface LocationContextType {
  coords: Coords | null;
  locationName: string;
  permissionStatus: 'undetermined' | 'granted' | 'denied';
  loading: boolean;
  requestPermission: () => Promise<void>;
  formatDistancia: (km: number | null | undefined) => string | null;
  haversine: (lat2: number, lng2: number) => number | null;
}

const LocationContext = createContext<LocationContextType>({
  coords: null,
  locationName: 'Guatemala',
  permissionStatus: 'undetermined',
  loading: true,
  requestPermission: async () => {},
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

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [locationName, setLocationName] = useState('Guatemala');
  const [permissionStatus, setPermissionStatus] = useState<'undetermined' | 'granted' | 'denied'>('undetermined');
  const [loading, setLoading] = useState(true);

  const fetchLocation = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = pos.coords;
      setCoords({ lat: latitude, lng: longitude });

      // Reverse geocode for human-readable zone name
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (place) {
          const name = place.district || place.subregion || place.city || place.region || 'Guatemala';
          setLocationName(name);
        }
      } catch {
        // Reverse geocode not critical — keep default
      }
    } catch {
      // Location fetch failed — app works without coords
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setPermissionStatus(granted ? 'granted' : 'denied');
      if (granted) await fetchLocation();
    } catch {
      setPermissionStatus('denied');
    } finally {
      setLoading(false);
    }
  }, [fetchLocation]);

  useEffect(() => {
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        setPermissionStatus('granted');
        await fetchLocation();
      } else if (status === 'denied') {
        setPermissionStatus('denied');
        setLoading(false);
      } else {
        // Undetermined — request automatically on first load
        await requestPermission();
      }
    })();
  }, []);

  function formatDistancia(km: number | null | undefined): string | null {
    if (km === null || km === undefined) return null;
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(1)} km`;
  }

  function haversineFromUser(lat2: number, lng2: number): number | null {
    if (!coords) return null;
    return Math.round(calcHaversine(coords.lat, coords.lng, lat2, lng2) * 10) / 10;
  }

  return (
    <LocationContext.Provider value={{
      coords,
      locationName,
      permissionStatus,
      loading,
      requestPermission,
      formatDistancia,
      haversine: haversineFromUser,
    }}>
      {children}
    </LocationContext.Provider>
  );
}

export const useLocation = () => useContext(LocationContext);
