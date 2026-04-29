import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { Colors } from '@/constants/Colors';

const ADMIN_COLOR = '#1E293B';

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

export default function AdminLayout() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarStyle: { backgroundColor: ADMIN_COLOR, borderTopColor: '#334155', height: 64, paddingBottom: 8 },
      tabBarShowLabel: false,
    }}>
      <Tabs.Screen name="index"      options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📊" label="Dashboard" focused={focused} /> }} />
      <Tabs.Screen name="negocios"   options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🏪" label="Negocios" focused={focused} /> }} />
      <Tabs.Screen name="financiero" options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="💰" label="Finanzas" focused={focused} /> }} />
      <Tabs.Screen name="usuarios"   options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="👥" label="Usuarios" focused={focused} /> }} />
      <Tabs.Screen name="config"     options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="⚙️" label="Config" focused={focused} /> }} />
    </Tabs>
  );
}
