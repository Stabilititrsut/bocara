import { useEffect, useState } from 'react';
import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { notificacionesAPI } from '@/src/services/api';

const PRIMARY = '#4A2C12';
const GOLD    = '#E8820C';
const WHITE   = '#FFFFFF';
const DIM     = 'rgba(255,255,255,0.4)';
const BORDER  = '#2E1A0A';

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
  const [sinLeer, setSinLeer] = useState(0);

  useEffect(() => {
    const cargar = async () => {
      try {
        const res = await notificacionesAPI.listar();
        setSinLeer((res.data || []).filter((n: any) => !n.leida).length);
      } catch {}
    };
    cargar();
    const interval = setInterval(cargar, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
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
  );
}
