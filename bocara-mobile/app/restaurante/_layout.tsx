import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { Colors } from '@/constants/Colors';

function TabIcon({ emoji, label, focused }: { emoji: string; label: string; focused: boolean }) {
  return (
    <View style={{ alignItems: 'center', paddingTop: 4 }}>
      <Text style={{ fontSize: 20 }}>{emoji}</Text>
      <Text style={{ fontSize: 10, fontWeight: focused ? '700' : '500', color: focused ? Colors.orange : Colors.textLight, marginTop: 2 }}>
        {label}
      </Text>
    </View>
  );
}

export default function RestauranteLayout() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarStyle: { backgroundColor: Colors.white, borderTopColor: Colors.border, height: 64, paddingBottom: 8 },
      tabBarShowLabel: false,
    }}>
      <Tabs.Screen name="index"     options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📊" label="Dashboard" focused={focused} /> }} />
      <Tabs.Screen name="bolsas"    options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🥡" label="Sabores" focused={focused} /> }} />
      <Tabs.Screen name="cupones"   options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🎫" label="Cupones" focused={focused} /> }} />
      <Tabs.Screen name="pedidos"   options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📋" label="Pedidos" focused={focused} /> }} />
      <Tabs.Screen name="historial" options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="💰" label="Historial" focused={focused} /> }} />
      <Tabs.Screen name="perfil"    options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🏪" label="Mi negocio" focused={focused} /> }} />
    </Tabs>
  );
}
