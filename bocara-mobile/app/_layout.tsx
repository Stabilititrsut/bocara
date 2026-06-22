import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/src/context/AuthContext';
import { CartProvider } from '@/src/context/CartContext';
import { LocationProvider } from '@/src/context/LocationContext';
import { Colors } from '@/constants/Colors';
import { notificacionesAPI } from '@/src/services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SplashScreen from 'expo-splash-screen';

// Mantener el splash nativo visible hasta que la app esté lista
SplashScreen.preventAutoHideAsync().catch(() => {});

// Vincula el carrito al userId del token activo para evitar que se comparta entre cuentas
function CartProviderWithUser({ children }: { children: React.ReactNode }) {
  const { usuario } = useAuth();
  return <CartProvider userId={usuario?.id ?? null}>{children}</CartProvider>;
}

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

// ── Splash animado de Bocara ──────────────────────────────────────────────────
function BocaraSplash({ fast, onDone }: { fast: boolean; onDone: () => void }) {
  const textOpacity   = useRef(new Animated.Value(0)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (fast) {
      // Sesión en caché: aparición rápida ≈ 600ms total
      Animated.sequence([
        Animated.timing(textOpacity,   { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(150),
        Animated.timing(screenOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(() => onDone());
    } else {
      // Primera vez / sesión expirada: intro completo ≈ 1.5s
      Animated.sequence([
        Animated.timing(textOpacity,   { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.delay(700),
        Animated.timing(screenOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => onDone());
    }
  }, []);

  return (
    <Animated.View style={[ss.splash, { opacity: screenOpacity }]}>
      <Animated.View style={[ss.center, { opacity: textOpacity }]}>
        <Text style={ss.title}>Bocara</Text>
        <Text style={ss.sub}>Food</Text>
      </Animated.View>
    </Animated.View>
  );
}

const ss = StyleSheet.create({
  splash: { ...StyleSheet.absoluteFillObject, backgroundColor: '#1A1A1A', zIndex: 999, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center' },
  title:  { fontSize: 42, fontWeight: 'bold', color: '#FFFFFF', letterSpacing: -1 },
  sub:    { fontSize: 18, color: '#C8A97E', marginTop: 8, fontWeight: '600' },
});

// ── Auth guard + routing ──────────────────────────────────────────────────────
function AuthGuard() {
  const { usuario, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const pushRegistered = useRef(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [onboardingDone, setOnboardingDone]       = useState(true);
  const [splashDone, setSplashDone]               = useState(false);

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

  // Ocultar splash nativo cuando la app esté lista; luego el JS splash toma el relevo
  useEffect(() => {
    if (!loading && onboardingChecked) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [loading, onboardingChecked]);

  useEffect(() => {
    if (usuario && !pushRegistered.current) {
      pushRegistered.current = true;
      registrarPushToken().catch(() => { });
    }
    if (!usuario) pushRegistered.current = false;
  }, [usuario]);

  useEffect(() => {
    if (loading || !onboardingChecked) return;
    const inAuth = segments[0] === 'login' || segments[0] === 'auth' || segments[0] === 'registro-cliente' || segments[0] === 'registro-restaurante' || segments[0] === 'registro-telefono' || segments[0] === 'forgot-password' || segments[0] === 'verificar-email' || segments[0] === 'socios';
    const inOnboarding = segments[0] === 'onboarding';

    if (!usuario && !inAuth && !inOnboarding) {
      router.replace('/login');
      return;
    }

    if (usuario) {
      if (Platform.OS !== 'web' && usuario.rol === 'cliente' && !onboardingDone && !inOnboarding) {
        router.replace('/onboarding');
        return;
      }

      const inCorrectSection =
        (usuario.rol === 'cliente'     && segments[0] === '(tabs)')     ||
        (usuario.rol === 'restaurante' && segments[0] === 'restaurante') ||
        (usuario.rol === 'admin'       && segments[0] === 'admin');

      const allowedSections = ['producto', 'pago', 'pago-exitoso', 'qr-recogida', 'configuracion', 'soporte', 'onboarding', 'registro-restaurante', 'registro-cliente', 'socios', 'tienda', 'negocio'];

      if (!inCorrectSection && !allowedSections.includes(segments[0] as string)) {
        let rutaDestino = '/(tabs)/';
        if (usuario.rol === 'restaurante') rutaDestino = '/restaurante';
        else if (usuario.rol === 'admin')  rutaDestino = '/admin';
        router.replace(rutaDestino as any);
      }
    }
  }, [usuario, loading, segments, onboardingChecked, onboardingDone]);

  // El splash nativo cubre la UI mientras carga la sesión
  if (loading || !onboardingChecked) return null;

  return (
    <>
      <StatusBar style={splashDone ? 'dark' : 'light'} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="restaurante" />
        <Stack.Screen name="admin" />
        <Stack.Screen name="onboarding"   options={{ animation: 'fade' }} />
        <Stack.Screen name="login"        options={{ animation: 'fade' }} />
        <Stack.Screen name="auth/callback" options={{ animation: 'none' }} />
        <Stack.Screen name="registro-cliente" />
        <Stack.Screen name="registro-restaurante" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="verificar-email" />
        <Stack.Screen name="tienda/[id]"   options={{ headerShown: false }} />
        <Stack.Screen name="negocio/[id]"  options={{ headerShown: false }} />
        <Stack.Screen name="producto/[id]" options={{ headerShown: true, headerTitle: '', headerBackTitle: 'Volver', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
        <Stack.Screen name="pago"          options={{ headerShown: false }} />
        <Stack.Screen name="pago-exitoso"  options={{ headerShown: false }} />
        <Stack.Screen name="qr-recogida"   options={{ headerShown: true, headerTitle: '¡Pedido confirmado!', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
        <Stack.Screen name="configuracion" options={{ headerShown: true, headerTitle: 'Configuración', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
        <Stack.Screen name="soporte"       options={{ headerShown: true, headerTitle: 'Ayuda y soporte', headerTintColor: Colors.primary, headerStyle: { backgroundColor: Colors.background } }} />
        <Stack.Screen name="socios"        options={{ headerShown: false }} />
      </Stack>

      {!splashDone && (
        <BocaraSplash
          fast={!!usuario}
          onDone={() => setSplashDone(true)}
        />
      )}
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <LocationProvider>
        <CartProviderWithUser>
          <AuthGuard />
        </CartProviderWithUser>
      </LocationProvider>
    </AuthProvider>
  );
}
