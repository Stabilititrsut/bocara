import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bolsasAPI, notificacionesAPI } from '@/src/services/api';
import { useRealtime } from '@/src/context/RealtimeContext';
import { useLocation } from '@/src/context/LocationContext';
import { Colors } from '@/constants/Colors';
import { prepararAudioWeb } from '@/src/utils/alertaPedido';
import { resolverRutaNotificacion } from '@/src/utils/resolverRutaNotificacion';
import {
  detectarAvisosNuevos, detectarOfertasCercanas, emitirAvisoCliente, pedirPermisoNotificacionWeb,
  textoOfertaCercana, RADIO_OFERTA_CERCANA_KM, type AvisoBandeja,
} from '@/src/utils/avisosCliente';

const POLL_MS = 20000;
const POLL_OFERTAS_MS = 5 * 60 * 1000;
const DURACION_BANNER_MS = 7000;
const CLAVE_OFERTAS = 'bocara_ofertas_cercanas_avisadas';

type Banner = { titulo: string; cuerpo: string; data?: any };

// Vigilante global del cliente (montado en app/_layout.tsx solo con rol
// cliente): detecta avisos nuevos de su bandeja (cambios de fase del pedido,
// Tiempo limitado) y ofertas cercanas, muestra un banner y hace sonar el
// dispositivo/navegador. Ver src/utils/avisosCliente.ts.
export default function AvisosCliente() {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner | null>(null);
  const vistosRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<any>(null);
  const { onPedidoCambiado } = useRealtime();
  const { coords } = useLocation();

  const mostrar = useCallback((b: Banner) => {
    setBanner(b);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setBanner(null), DURACION_BANNER_MS);
  }, []);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Web: el audio y las notificaciones del navegador solo se habilitan tras un
  // gesto del usuario.
  useEffect(() => prepararAudioWeb(), []);
  useEffect(() => pedirPermisoNotificacionWeb(), []);

  const revisarBandeja = useCallback(async () => {
    try {
      const res = await notificacionesAPI.listar();
      const { nuevos, vistos } = detectarAvisosNuevos(vistosRef.current, (res.data || []) as AvisoBandeja[]);
      vistosRef.current = vistos;
      if (!nuevos.length) return;
      const ultimo = nuevos[0];
      const titulo = ultimo.titulo || 'Bocara';
      const cuerpo = nuevos.length > 1 ? `${ultimo.cuerpo || ''} (+${nuevos.length - 1} aviso${nuevos.length > 2 ? 's' : ''} más)` : (ultimo.cuerpo || '');
      mostrar({ titulo, cuerpo, data: ultimo.data });
      await emitirAvisoCliente({ titulo, cuerpo, data: ultimo.data, etiqueta: String(ultimo.id) });
    } catch { /* sin red: el siguiente ciclo reintenta */ }
  }, [mostrar]);

  // Polling + Realtime (cuando esté habilitado) + volver a la app.
  useEffect(() => {
    revisarBandeja();
    const id = setInterval(revisarBandeja, POLL_MS);
    return () => clearInterval(id);
  }, [revisarBandeja]);
  useEffect(() => onPedidoCambiado(() => { revisarBandeja(); }), [onPedidoCambiado, revisarBandeja]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') revisarBandeja(); });
    return () => sub.remove();
  }, [revisarBandeja]);

  // Ofertas cercanas: con ubicación conocida, cada 5 min y cuando cambia.
  const lat = coords?.lat;
  const lng = coords?.lng;
  const revisarOfertas = useCallback(async () => {
    if (lat == null || lng == null) return;
    try {
      const res = await bolsasAPI.listar({ lat, lng, max_distancia: RADIO_OFERTA_CERCANA_KM });
      let avisados: Record<string, number> = {};
      try { avisados = JSON.parse((await AsyncStorage.getItem(CLAVE_OFERTAS)) || '{}') || {}; } catch { }
      const ofertas = detectarOfertasCercanas(res.data || [], avisados);
      if (!ofertas.length) return;
      const ahora = Date.now();
      for (const o of ofertas) avisados[o.negocioId] = ahora;
      try { await AsyncStorage.setItem(CLAVE_OFERTAS, JSON.stringify(avisados)); } catch { }
      const o = ofertas[0];
      const { titulo, cuerpo } = textoOfertaCercana(o);
      const data = { bolsaId: o.bolsaId, negocioId: o.negocioId };
      mostrar({ titulo, cuerpo, data });
      await emitirAvisoCliente({ titulo, cuerpo, data, etiqueta: `oferta-${o.negocioId}` }, { local: true });
    } catch { }
  }, [lat, lng, mostrar]);
  useEffect(() => {
    revisarOfertas();
    const id = setInterval(revisarOfertas, POLL_OFERTAS_MS);
    return () => clearInterval(id);
  }, [revisarOfertas]);

  if (!banner) return null;
  return (
    <View pointerEvents="box-none" style={s.wrap}>
      <TouchableOpacity
        style={s.banner}
        activeOpacity={0.9}
        accessibilityRole="alert"
        onPress={() => {
          const ruta = resolverRutaNotificacion(banner.data, 'cliente');
          setBanner(null);
          if (ruta) router.push(ruta as any);
        }}
      >
        <View style={s.icono}>
          <Ionicons name="notifications" size={18} color={Colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.titulo} numberOfLines={1}>{banner.titulo}</Text>
          {!!banner.cuerpo && <Text style={s.cuerpo} numberOfLines={2}>{banner.cuerpo}</Text>}
        </View>
        <TouchableOpacity onPress={() => setBanner(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel="Cerrar aviso">
          <Ionicons name="close" size={18} color="rgba(255,255,255,0.8)" />
        </TouchableOpacity>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', left: 0, right: 0, top: Platform.OS === 'web' ? 12 : 48,
    alignItems: 'center', paddingHorizontal: 12, zIndex: 1000, elevation: 20,
  },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', maxWidth: 520,
    backgroundColor: Colors.primary, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 12,
  },
  icono: { width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.goldLight, alignItems: 'center', justifyContent: 'center' },
  titulo: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  cuerpo: { color: 'rgba(255,255,255,0.88)', fontSize: 12, marginTop: 2, lineHeight: 17 },
});
