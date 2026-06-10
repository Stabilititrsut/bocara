import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/Colors';

function TabIcon({ name, label, focused }: { name: any; label: string; focused: boolean }) {
  return (
    <View style={ts.iconWrap}>
      <Ionicons
        name={focused ? name : `${name}-outline` as any}
        size={22}
        color={focused ? Colors.primary : Colors.textLight}
      />
      <Text style={[ts.label, focused && ts.labelActive]}>{label}</Text>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: ts.tabBar,
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="home" label="Inicio" focused={focused} /> }}
      />
      <Tabs.Screen
        name="tiendas"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="storefront" label="Tiendas" focused={focused} /> }}
      />
      <Tabs.Screen
        name="promociones"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="pricetag" label="Promos" focused={focused} /> }}
      />
      <Tabs.Screen
        name="buscar"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="search" label="Buscar" focused={focused} /> }}
      />
      <Tabs.Screen
        name="pedidos"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="receipt" label="Actividad" focused={focused} /> }}
      />
      <Tabs.Screen
        name="perfil"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="person" label="Perfil" focused={focused} /> }}
      />
      {/* Hidden screens — accessible via deep link / header buttons */}
      <Tabs.Screen name="carrito"        options={{ href: null }} />
      <Tabs.Screen name="notificaciones" options={{ href: null }} />
      <Tabs.Screen name="explore"        options={{ href: null }} />
    </Tabs>
  );
}

const ts = StyleSheet.create({
  tabBar: {
    backgroundColor: Colors.white,
    borderTopColor: Colors.border,
    borderTopWidth: 1,
    height: 72,
    paddingBottom: 12,
    paddingTop: 8,
    elevation: 0,
    shadowOpacity: 0,
  },
  iconWrap: { alignItems: 'center', gap: 4 },
  label: { fontSize: 10, color: Colors.textLight, fontWeight: '500' },
  labelActive: { color: Colors.primary, fontWeight: '700' },
});
