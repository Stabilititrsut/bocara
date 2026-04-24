// ── App.js ───────────────────────────────────
// Punto de entrada de la app
// Configura: Stripe, Navegación, Autenticación, Push
import React, { useEffect, useRef } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StripeProvider } from "@stripe/stripe-react-native";
import { Text, View, ActivityIndicator } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { usarListenerNotificaciones } from "./src/services/pushNotifications";

// Pantallas
import ExplorarScreen from "./src/screens/ExplorarScreen";
import DetalleNegocioScreen from "./src/screens/DetalleNegocioScreen";
import PagoScreen from "./src/screens/PagoScreen";
import PedidosScreen from "./src/screens/PedidosScreen";
import TrackingScreen from "./src/screens/TrackingScreen";
import PerfilScreen from "./src/screens/PerfilScreen";
import LoginScreen from "./src/screens/LoginScreen";
import RegistroScreen from "./src/screens/RegistroScreen";

// ⚠️ Reemplaza con tu clave PUBLICABLE de Stripe (pk_test_... o pk_live_...)
const STRIPE_PUBLISHABLE_KEY = "pk_test_TU_CLAVE_PUBLICA_STRIPE";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// ── Navegación principal (tabs) ───────────────
function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#fff",
          borderTopColor: "#e2e8f0",
          paddingBottom: 8,
          paddingTop: 8,
          height: 70,
        },
        tabBarActiveTintColor: "#16a34a",
        tabBarInactiveTintColor: "#94a3b8",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tab.Screen
        name="Explorar"
        component={ExplorarStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 22 }}>🔍</Text> }}
      />
      <Tab.Screen
        name="Pedidos"
        component={PedidosStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 22 }}>🛍️</Text> }}
      />
      <Tab.Screen
        name="Perfil"
        component={PerfilScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 22 }}>👤</Text> }}
      />
    </Tab.Navigator>
  );
}

// ── Stack de Explorar ─────────────────────────
function ExplorarStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="ExplorarHome" component={ExplorarScreen} />
      <Stack.Screen name="DetalleNegocio" component={DetalleNegocioScreen} />
      <Stack.Screen name="Pago" component={PagoScreen} />
    </Stack.Navigator>
  );
}

// ── Stack de Pedidos ──────────────────────────
function PedidosStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="PedidosList" component={PedidosScreen} />
      <Stack.Screen name="Tracking" component={TrackingScreen} />
    </Stack.Navigator>
  );
}

// ── Navegación con autenticación ──────────────
function AppNavigator() {
  const { usuario, cargando } = useAuth();
  const navigationRef = useRef(null);

  // Escuchar notificaciones push
  useEffect(() => {
    const cleanup = usarListenerNotificaciones(
      (notif) => console.log("Notificación recibida:", notif),
      (response) => {
        // Navegar a la pantalla correcta cuando el usuario toca la notificación
        const data = response.notification.request.content.data;
        if (data.tipo === "pedido_confirmado" || data.tipo === "envio_en_camino") {
          navigationRef.current?.navigate("Pedidos");
        }
      }
    );
    return cleanup;
  }, []);

  if (cargando) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1a1a2e" }}>
        <Text style={{ color: "#4ade80", fontSize: 32, fontWeight: "800", marginBottom: 20 }}>Bocara</Text>
        <ActivityIndicator color="#4ade80" size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {usuario ? (
          <Stack.Screen name="Main" component={TabNavigator} />
        ) : (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="Registro" component={RegistroScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ── App raíz ──────────────────────────────────
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY} merchantIdentifier="merchant.gt.bocara.app">
          <AuthProvider>
            <AppNavigator />
          </AuthProvider>
        </StripeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
