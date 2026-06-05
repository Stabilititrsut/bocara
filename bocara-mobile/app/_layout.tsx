import { useEffect, useRef, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/src/context/AuthContext';
import { CartProvider } from '@/src/context/CartContext';
import { LocationProvider } from '@/src/context/LocationContext';
import { ActivityIndicator, View, Platform, Text } from 'react-native';
import { Colors } from '@/constants/Colors';
import { notificacionesAPI } from '@/src/services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Expo Notifications — solo nativo
let Notifications: any = null;
let Device: any = null;
if (Platform.OS !== 'web') {
  try {
    Notifications = require('expo-notifications');
    Device = require('expo-device');
  } catch { }
}

if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

async function registrarPushToken() {
  if (!Notifications || !Device) return;
  if (!Device.isDevice) return;

  const { status: existente } = await Notifications.getPermissionsAsync();
  let finalStatus = existente;
  if (existente !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return;

  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId: process.env.EXPO_PROJECT_ID,
  });
  const token = tokenData.data;
  if (token) {
    await notificacionesAPI.guardarToken(token).catch(() => { });
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Bocara',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: Colors.orange,
      sound: 'default',
    });
  }
}

function AuthGuard() {
  const { usuario, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const pushRegistered = useRef(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(true);

  useEffect(() => {
    if (Platform.OS === 'web') {
      setOnboardingDone(true);
      setOnboardingChecked(true);
      return;
    }
    AsyncStorage.getItem('bocara_onboarding_done').then((val) => {
      setOnboardingDone(val === 'true');
      setOnboardingChecked(true);
    }).catch(() => {
      setOnboardingDone(true);
      setOnboardingChecked(true);
    });
  }, []);

  useEffect(() => {
    if (usuario && !pushRegistered.current) {
      pushRegistered.current = true;
      registrarPushToken().catch(() => { });
    }
    if (!usuario) pushRegistered.current = false;
  }, [usuario]);

  useEffect(() => {
    if (loading || !onboardingChecked) return;
    const inAuth = segments[0] === 'login' || segments[0] === 'auth' || segments[0] === 'registro-cliente' || segments[0] === 'registro-restaurante' || segments[0] === 'registro-telefono' || segments[0] === 'forgot-password' || segments[0] === 'verificar-email';
    const inOnboarding = segments[0] === 'onboarding';

    if (!usuario && !inAuth && !inOnboarding) {
      console.log('[AUTH GUARD] sin sesión, redirigiendo a /login desde:', segments[0]);
      router.replace('/login');
      return;
    }

    if (usuario) {
      // Mostrar onboarding a clientes nuevos (solo en nativo, no en web)
      if (Platform.OS !== 'web' && usuario.rol === 'cliente' && !onboardingDone && !inOnboarding) {
        router.replace('/onboarding');
        return;
      }

      const inCorrectSection =
        (usuario.rol === 'cliente' && segments[0] === '(tabs)') ||
        (usuario.rol === 'restaurante' && segments[0] === 'restaurante') ||
        (usuario.rol === 'admin' && segments[0] === 'admin');

      const allowedSections = ['producto', 'pago', 'pago-exitoso', 'qr-recogida', 'configuracion', 'soporte', 'onboarding', 'registro-restaurante', 'registro-cliente'];

      if (!inCorrectSection && !allowedSections.includes(segments[0] as string)) {
        let rutaDestino = '/(tabs)/';
        if (usuario.rol === 'restaurante') rutaDestino = '/restaurante';
        else if (usuario.rol === 'admin') rutaDestino = '/admin';
        console.log('[AUTH GUARD] redirect decision:', rutaDestino, '| rol:', usuario.rol, '| segment:', segments[0]);
        router.replace(rutaDestino as any);
      }
    }
  }, [usuario, loading, segments, onboardingChecked, onboardingDone]);

  if (loading || !onboardingChecked) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <Text style={{ fontSize: 40, marginBottom: 12 }}>🛍️</Text>
        <ActivityIndicator color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="restaurante" />
      <Stack.Screen name="admin" />
      <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
      <Stack.Screen name="login" options={{ animation: 'fade' }} />
      <Stack.Screen name="auth/callback" options={{ animation: 'none' }} />
      <Stack.Screen name="registro-cliente" />
      <Stack.Screen name="registro-restaurante" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="verificar-email" />
      <Stack.Screen name="producto/[id]" options={{ headerShown: true, headerTitle: '', headerBackTitle: 'Volver', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="pago" options={{ headerShown: false }} />
      <Stack.Screen name="pago-exitoso" options={{ headerShown: false }} />
      <Stack.Screen name="qr-recogida" options={{ headerShown: true, headerTitle: '¡Pedido confirmado!', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="configuracion" options={{ headerShown: true, headerTitle: 'Configuración', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="soporte" options={{ headerShown: true, headerTitle: 'Ayuda y soporte', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <LocationProvider>
        <CartProvider>
          <AuthGuard />
          <StatusBar style="dark" />
        </CartProvider>
      </LocationProvider>
    </AuthProvider>
  );
}
