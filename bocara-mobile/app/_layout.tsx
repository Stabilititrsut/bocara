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
    AsyncStorage.getItem('bocara_onboarding_done').then((val) => {
      setOnboardingDone(val === 'true');
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
    const inAuth = segments[0] === 'login' || segments[0] === 'registro-cliente' || segments[0] === 'registro-restaurante';
    const inOnboarding = segments[0] === 'onboarding';

    if (!usuario && !inAuth && !inOnboarding) {
      router.replace('/login');
      return;
    }

    if (usuario) {
      // Mostrar onboarding a clientes nuevos que no lo han visto
      if (usuario.rol === 'cliente' && !onboardingDone && !inOnboarding) {
        router.replace('/onboarding');
        return;
      }

      const inCorrectSection =
        (usuario.rol === 'cliente' && segments[0] === '(tabs)') ||
        (usuario.rol === 'restaurante' && segments[0] === 'restaurante') ||
        (usuario.rol === 'admin' && segments[0] === 'admin');

      if (!inCorrectSection && !['producto', 'pago', 'qr-recogida', 'configuracion', 'soporte', 'onboarding'].includes(segments[0] as string)) {
        if (usuario.rol === 'restaurante') router.replace('/restaurante');
        else if (usuario.rol === 'admin') router.replace('/admin');
        else router.replace('/(tabs)/');
      }
    }
  }, [usuario, loading, segments, onboardingChecked, onboardingDone]);

  if (loading || !onboardingChecked) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <Text style={{ fontSize: 40, marginBottom: 12 }}>🛍️</Text>
        <ActivityIndicator color={Colors.orange} size="large" />
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
      <Stack.Screen name="registro-cliente" />
      <Stack.Screen name="registro-restaurante" />
      <Stack.Screen name="producto/[id]" options={{ headerShown: true, headerTitle: '', headerBackTitle: 'Volver', headerTintColor: Colors.orange, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="pago" options={{ headerShown: true, headerTitle: 'Confirmar pedido', headerTintColor: Colors.brown, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="qr-recogida" options={{ headerShown: true, headerTitle: '¡Pedido listo!', headerTintColor: Colors.brown, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="configuracion" options={{ headerShown: true, headerTitle: 'Configuración', headerTintColor: Colors.brown, headerStyle: { backgroundColor: Colors.background } }} />
      <Stack.Screen name="soporte" options={{ headerShown: true, headerTitle: 'Ayuda y soporte', headerTintColor: Colors.brown, headerStyle: { backgroundColor: Colors.background } }} />
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
