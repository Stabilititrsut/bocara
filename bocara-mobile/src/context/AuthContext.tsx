import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authAPI } from '../services/api';
import { Usuario } from '../types';

const PERFIL_KEY = 'bocara_perfil_cache';

interface AuthContextType {
  usuario: Usuario | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
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

  async function login(email: string, password: string) {
    const res = await authAPI.login(email, password);
    const { token: t, usuario: u } = res.data;
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
    } finally {
      setToken(null);
      setUsuario(null);
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
