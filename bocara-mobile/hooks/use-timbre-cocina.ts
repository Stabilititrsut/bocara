// Timbre de cocina global del panel del restaurante (app/restaurante/_layout.tsx):
// acompaña al personal en Dashboard, Pedidos o cualquier pestaña.
//
//   · Suena mientras haya pedidos 'confirmado' (pagados, sin aceptar) —
//     también en la primera carga— y se calla solo cuando ya no queda ninguno.
//   · Estado de pedidos: polling propio cada 5 s (se salta si
//     restaurante/pedidos.tsx acaba de publicar su lista), Realtime para
//     acelerar, y la lista que publica pedidos.tsx tras aceptar/cancelar.
//   · `activado` es la preferencia del personal (persistida). En web además
//     hace falta `audioDesbloqueado`: el navegador exige un gesto antes de
//     sonar, por eso activarTimbre() se llama desde un onPress.
//   · Con el timbre armado, Wake Lock (si el navegador lo soporta) evita que
//     la pantalla se apague y deje de sonar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pedidosAPI } from '@/src/services/api';
import { useRealtime } from '@/src/context/RealtimeContext';
import {
  audioWebListo, debeSonarTimbre, desbloquearAudio, detenerTimbre, iniciarTimbre,
  prepararAudioWeb, suscribirPedidosRestaurante,
} from '@/src/utils/alertaPedido';

export const TIMBRE_PREFERENCIA_KEY = 'bocara_timbre_cocina';
const TIMBRE_POLL_MS = 5000;

export type EstadoTimbreCocina = {
  activado: boolean;
  audioDesbloqueado: boolean;
  armado: boolean;
  hayPendientes: boolean;
  pendientes: number;
  sonando: boolean;
  activarTimbre: () => Promise<void>;
  alternarTimbre: () => Promise<void>;
};

function guardarPreferencia(activado: boolean) {
  AsyncStorage.setItem(TIMBRE_PREFERENCIA_KEY, activado ? '1' : '0').catch(() => {});
}

export function useTimbreCocina(): EstadoTimbreCocina {
  const [activado, setActivado] = useState(true);
  const [audioDesbloqueado, setAudioDesbloqueado] = useState(() => audioWebListo());
  const [hayPendientes, setHayPendientes] = useState(false);
  const [pendientes, setPendientes] = useState(0);
  const ultimaListaRef = useRef(0);
  const enCursoRef = useRef(false);

  const aplicar = useCallback((lista: any[]) => {
    ultimaListaRef.current = Date.now();
    const pedidos = Array.isArray(lista) ? lista : [];
    setHayPendientes(debeSonarTimbre(pedidos));
    setPendientes(pedidos.filter((p) => p?.estado === 'confirmado').length);
  }, []);

  // `forzar` = Realtime o arranque. Sin forzar, si pedidos.tsx publicó hace
  // menos de un ciclo no se repite la consulta. Un fallo de red conserva el
  // último estado: no se calla un timbre por un error puntual.
  const cargar = useCallback(async (forzar = false) => {
    if (enCursoRef.current) return;
    if (!forzar && Date.now() - ultimaListaRef.current < TIMBRE_POLL_MS - 1000) return;
    enCursoRef.current = true;
    try {
      const res = await pedidosAPI.restaurante();
      aplicar(res.data || []);
    } catch { } finally { enCursoRef.current = false; }
  }, [aplicar]);

  useEffect(() => {
    AsyncStorage.getItem(TIMBRE_PREFERENCIA_KEY)
      .then((v) => { if (v === '0') setActivado(false); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    cargar(true);
    const id = setInterval(() => {
      // Un AudioContext puede volver a suspenderse (p. ej. iOS al bloquear la
      // pantalla): así reaparece el aviso para reactivarlo con un toque.
      setAudioDesbloqueado(audioWebListo());
      cargar();
    }, TIMBRE_POLL_MS);
    return () => clearInterval(id);
  }, [cargar]);

  const { onPedidoCambiado } = useRealtime();
  useEffect(() => onPedidoCambiado(() => { cargar(true); }), [onPedidoCambiado, cargar]);
  useEffect(() => suscribirPedidosRestaurante(aplicar), [aplicar]);
  // Web: cualquier primer toque en el panel desbloquea el audio.
  useEffect(() => prepararAudioWeb(() => setAudioDesbloqueado(true)), []);

  const armado = activado && audioDesbloqueado;
  const sonando = armado && hayPendientes;

  useEffect(() => {
    if (sonando) iniciarTimbre();
    else detenerTimbre();
  }, [sonando]);
  useEffect(() => () => { detenerTimbre(); }, []);

  // Wake Lock mientras el timbre está armado (no solo sonando: la pantalla
  // tiene que seguir encendida para oír el PRÓXIMO pedido). El navegador lo
  // suelta al ocultar la pestaña; se vuelve a pedir al regresar.
  useEffect(() => {
    if (Platform.OS !== 'web' || !armado || typeof document === 'undefined') return;
    const wakeLock = (navigator as any)?.wakeLock;
    if (!wakeLock?.request) return;
    let vigente = true;
    let lock: any = null;
    const pedir = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const nuevo = await wakeLock.request('screen');
        if (vigente) lock = nuevo;
        else nuevo?.release?.().catch?.(() => {});
      } catch { }
    };
    const alCambiarVisibilidad = () => { if (document.visibilityState === 'visible') pedir(); };
    pedir();
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    return () => {
      vigente = false;
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      try { lock?.release?.().catch?.(() => {}); } catch { }
    };
  }, [armado]);

  // Llamar desde un onPress: el gesto es lo que habilita el audio en web.
  const activarTimbre = useCallback(async () => {
    const promesa = desbloquearAudio();
    setActivado(true);
    guardarPreferencia(true);
    setAudioDesbloqueado(await promesa);
  }, []);

  const alternarTimbre = useCallback(async () => {
    if (armado) {
      setActivado(false);
      guardarPreferencia(false);
      return;
    }
    await activarTimbre();
  }, [armado, activarTimbre]);

  return { activado, audioDesbloqueado, armado, hayPendientes, pendientes, sonando, activarTimbre, alternarTimbre };
}
