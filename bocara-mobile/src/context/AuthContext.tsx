import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authAPI } from '../services/api';
import { onSessionInvalid } from '../services/sessionEvents';
import { CART_KEY_PREFIX } from './CartContext';
import { Usuario } from '../types';

const PERFIL_KEY = 'bocara_perfil_cache';
export const SESSION_MESSAGE_KEY = 'bocara_session_message';

interface AuthContextType {
  usuario: Usuario | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string, rolEsperado?: string) => Promise<void>;
  registroCliente: (data: any) => Promise<void>;
  registroRestaurante: (data: any) => Promise<void>;
  setSession: (token: string, usuario: Usuario) => Promise<void>;
  logout: () => Promise<void>;
  actualizarUsuario: (data: Partial<Usuario>) => void;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { cargarSesion(); }, []);

  // Se dispara cuando el interceptor de api.ts detecta un 401 "Token inválido"
  // (sesión muerta: expiró, la cuenta usaba un secreto viejo tras una rotación, etc.)
  // Se resuscribe en cada cambio de `usuario` para no usar un id de carrito viejo.
  useEffect(() => {
    const unsubscribe = onSessionInvalid((message) => { handleSessionInvalid(message); });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuario]);

  async function handleSessionInvalid(message: string) {
    const keysToRemove = ['bocara_token', PERFIL_KEY];
    if (usuario?.id) keysToRemove.push(`${CART_KEY_PREFIX}${usuario.id}`);
    try {
      await AsyncStorage.multiRemove(keysToRemove);
      await AsyncStorage.setItem(SESSION_MESSAGE_KEY, message);
    } catch (error) {
      console.warn('handleSessionInvalid: fallo al limpiar AsyncStorage', error);
    } finally {
      setToken(null);
      setUsuario(null);
      if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
        window.location.replace('/login');
      }
    }
  }

  async function cargarSesion() {
    try {
      const [t, perfilJson] = await Promise.all([
        AsyncStorage.getItem('bocara_token'),
        AsyncStorage.getItem(PERFIL_KEY),
      ]);
      if (!t) return;
      setToken(t);
      if (perfilJson) {
        // Cache hit — show UI immediately, refresh silently in background
        setUsuario(JSON.parse(perfilJson));
        setLoading(false);
        authAPI.perfil()
          .then(res => {
            setUsuario(res.data);
            AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(res.data)).catch(() => {});
          })
          .catch(() => {}); // Keep cached version if refresh fails
        return;
      }
      // First launch — must wait for network
      const res = await authAPI.perfil();
      setUsuario(res.data);
      await AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(res.data));
    } catch {
      await Promise.all([
        AsyncStorage.removeItem('bocara_token'),
        AsyncStorage.removeItem(PERFIL_KEY),
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function login(email: string, password: string, rolEsperado?: string) {
    const res = await authAPI.login(email, password);
    const { token: t, usuario: u } = res.data;
    if (rolEsperado && u.rol !== rolEsperado) {
      throw new Error(
        rolEsperado === 'restaurante'
          ? 'Esta cuenta no es de negocio. Usa la opción "Soy cliente".'
          : 'Acceso denegado para este tipo de cuenta.'
      );
    }
    await Promise.all([
      AsyncStorage.setItem('bocara_token', t),
      AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(u)),
    ]);
    setToken(t);
    setUsuario(u);
  }

  async function registroCliente(data: any) {
    const res = await authAPI.registroCliente(data);
    const { token: t, usuario: u } = res.data;
    await Promise.all([
      AsyncStorage.setItem('bocara_token', t),
      AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(u)),
    ]);
    setToken(t);
    setUsuario(u);
  }

  async function registroRestaurante(data: any) {
    const res = await authAPI.registroRestaurante(data);
    const { token: t, usuario: u } = res.data;
    await Promise.all([
      AsyncStorage.setItem('bocara_token', t),
      AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(u)),
    ]);
    setToken(t);
    setUsuario(u);
  }

  async function setSession(t: string, u: Usuario) {
    await Promise.all([
      AsyncStorage.setItem('bocara_token', t),
      AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(u)),
    ]);
    setToken(t);
    setUsuario(u);
  }

 async function logout() {
    try {
      await Promise.all([
        AsyncStorage.removeItem('bocara_token'),
        AsyncStorage.removeItem(PERFIL_KEY),
      ]);
    } catch (error) {
      console.warn('logout: fallo al limpiar AsyncStorage', error);
    } finally {
      setToken(null);
      setUsuario(null);

      if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
        window.location.replace('/login');
      }
    }
  }

  function actualizarUsuario(data: Partial<Usuario>) {
    setUsuario(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...data };
      AsyncStorage.setItem(PERFIL_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  }

  return (
    <AuthContext.Provider
      value={{ usuario, token, loading, login, registroCliente, registroRestaurante, setSession, logout, actualizarUsuario }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
