import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authAPI } from '../services/api';
import { Usuario } from '../types';

interface AuthContextType {
  usuario: Usuario | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  registroCliente: (data: any) => Promise<void>;
  registroRestaurante: (data: any) => Promise<void>;
  logout: () => Promise<void>;
  actualizarUsuario: (data: Partial<Usuario>) => void;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    cargarSesion();
  }, []);

  async function cargarSesion() {
    try {
      const t = await AsyncStorage.getItem('bocara_token');
      if (t) {
        setToken(t);
        const res = await authAPI.perfil();
        setUsuario(res.data);
      }
    } catch {
      await AsyncStorage.removeItem('bocara_token');
    } finally {
      setLoading(false);
    }
  }

  async function login(email: string, password: string) {
    const res = await authAPI.login(email, password);
    const { token: t, usuario: u } = res.data;
    await AsyncStorage.setItem('bocara_token', t);
    setToken(t);
    setUsuario(u);
  }

  async function registroCliente(data: any) {
    const res = await authAPI.registroCliente(data);
    const { token: t, usuario: u } = res.data;
    await AsyncStorage.setItem('bocara_token', t);
    setToken(t);
    setUsuario(u);
  }

  async function registroRestaurante(data: any) {
    const res = await authAPI.registroRestaurante(data);
    const { token: t, usuario: u } = res.data;
    await AsyncStorage.setItem('bocara_token', t);
    setToken(t);
    setUsuario(u);
  }

  async function logout() {
    await AsyncStorage.removeItem('bocara_token');
    setToken(null);
    setUsuario(null);
  }

  function actualizarUsuario(data: Partial<Usuario>) {
    setUsuario((prev) => (prev ? { ...prev, ...data } : null));
  }

  return (
    <AuthContext.Provider
      value={{ usuario, token, loading, login, registroCliente, registroRestaurante, logout, actualizarUsuario }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
