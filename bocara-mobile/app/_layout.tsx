import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/src/context/AuthContext';
import { CartProvider } from '@/src/context/CartContext';
import { LocationProvider } from '@/src/context/LocationContext';
import { ActivityIndicator, View } from 'react-native';
import { Colors } from '@/constants/Colors';

function AuthGuard() {
  const { usuario, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === 'login' || segments[0] === 'registro-cliente' || segments[0] === 'registro-restaurante';
    if (!usuario && !inAuth) {
      router.replace('/login');
    } else if (usuario) {
      const inCorrectSection =
        (usuario.rol === 'cliente' && segments[0] === '(tabs)') ||
        (usuario.rol === 'restaurante' && segments[0] === 'restaurante') ||
        (usuario.rol === 'admin' && segments[0] === 'admin');
      if (!inCorrectSection && !['producto', 'pago', 'qr-recogida', 'configuracion', 'soporte'].includes(segments[0] as string)) {
        if (usuario.rol === 'restaurante') router.replace('/restaurante');
        else if (usuario.rol === 'admin') router.replace('/admin');
        else router.replace('/(tabs)/');
      }
    }
  }, [usuario, loading, segments]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <ActivityIndicator color={Colors.orange} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="restaurante" />
      <Stack.Screen name="admin" />
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
