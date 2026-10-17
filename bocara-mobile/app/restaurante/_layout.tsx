import { Tabs, useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { NotificacionesRestauranteProvider, useNotificacionesRestaurante } from '@/src/context/NotificacionesRestauranteContext';
import { useTimbreCocina } from '@/hooks/use-timbre-cocina';
import BarraTimbreCocina from '@/components/BarraTimbreCocina';

const PRIMARY = '#0A2A2A';
const GOLD    = '#C8960C';
const DIM     = 'rgba(255,255,255,0.4)';
const BORDER  = 'rgba(255,255,255,0.08)';

function TabIcon({ emoji, label, focused }: { emoji: string; label: string; focused: boolean }) {
  return (
    <View style={{ alignItems: 'center', paddingTop: 4 }}>
      <Text style={{ fontSize: 20 }}>{emoji}</Text>
      <Text style={{ fontSize: 10, fontWeight: focused ? '700' : '500', color: focused ? GOLD : DIM, marginTop: 2 }}>
        {label}
      </Text>
    </View>
  );
}

export default function RestauranteLayout() {
  return (
    <NotificacionesRestauranteProvider>
      <RestauranteTabs />
    </NotificacionesRestauranteProvider>
  );
}

function RestauranteTabs() {
  const { sinLeer } = useNotificacionesRestaurante();
  // Timbre de cocina en el layout, no en la pestaña Pedidos: el panel abre en
  // Dashboard y el personal puede estar en cualquier pestaña cuando entra un
  // pedido pagado.
  const timbre = useTimbreCocina();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: PRIMARY }}>
      <BarraTimbreCocina timbre={timbre} onVerPedidos={() => router.navigate('/restaurante/pedidos' as any)} />
      <Tabs screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: PRIMARY, borderTopColor: BORDER, height: 64, paddingBottom: 8 },
        tabBarShowLabel: false,
      }}>
        <Tabs.Screen name="index"          options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📊" label="Dashboard" focused={focused} /> }} />
        <Tabs.Screen name="bolsas"         options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="⏱️" label="Disponibles" focused={focused} /> }} />
        <Tabs.Screen name="pedidos"        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📋" label="Pedidos" focused={focused} /> }} />
        <Tabs.Screen name="ganancias"      options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="💰" label="Ganancias" focused={focused} /> }} />
        <Tabs.Screen name="notificaciones" options={{
          tabBarBadge: sinLeer > 0 ? sinLeer : undefined,
          tabBarBadgeStyle: { backgroundColor: GOLD, fontSize: 10 },
          tabBarIcon: ({ focused }) => <TabIcon emoji="🔔" label="Avisos" focused={focused} />,
        }} />
        <Tabs.Screen name="perfil"         options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🏪" label="Mi negocio" focused={focused} /> }} />
        <Tabs.Screen name="cupones"        options={{ href: null }} />
        <Tabs.Screen name="historial"      options={{ href: null }} />
      </Tabs>
    </View>
  );
}
