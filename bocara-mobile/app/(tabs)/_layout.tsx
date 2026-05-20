import { useEffect, useState } from 'react';
import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/Colors';
import { useCart } from '@/src/context/CartContext';
import { notificacionesAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';

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

function CartTabIcon({ focused }: { focused: boolean }) {
  const { cantidad } = useCart();
  return (
    <View style={ts.iconWrap}>
      <View>
        <Ionicons
          name={focused ? 'bag' : 'bag-outline'}
          size={22}
          color={focused ? Colors.primary : Colors.textLight}
        />
        {cantidad > 0 && (
          <View style={ts.badge}>
            <Text style={ts.badgeText}>{cantidad > 9 ? '9+' : cantidad}</Text>
          </View>
        )}
      </View>
      <Text style={[ts.label, focused && ts.labelActive]}>Carrito</Text>
    </View>
  );
}

function BellTabIcon({ focused }: { focused: boolean }) {
  const [sinLeer, setSinLeer] = useState(0);
  const { usuario } = useAuth();

  useEffect(() => {
    if (!usuario) return;
    notificacionesAPI.listar().then((res) => {
      setSinLeer((res.data || []).filter((n: any) => !n.leida).length);
    }).catch(() => {});
  }, [usuario, focused]);

  return (
    <View style={ts.iconWrap}>
      <View>
        <Ionicons
          name={focused ? 'notifications' : 'notifications-outline'}
          size={22}
          color={focused ? Colors.primary : Colors.textLight}
        />
        {sinLeer > 0 && (
          <View style={ts.badge}>
            <Text style={ts.badgeText}>{sinLeer > 9 ? '9+' : sinLeer}</Text>
          </View>
        )}
      </View>
      <Text style={[ts.label, focused && ts.labelActive]}>Alertas</Text>
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
        name="carrito"
        options={{ tabBarIcon: ({ focused }) => <CartTabIcon focused={focused} /> }}
      />
      <Tabs.Screen
        name="pedidos"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="receipt" label="Pedidos" focused={focused} /> }}
      />
      <Tabs.Screen
        name="notificaciones"
        options={{ tabBarIcon: ({ focused }) => <BellTabIcon focused={focused} /> }}
      />
      <Tabs.Screen
        name="perfil"
        options={{ tabBarIcon: ({ focused }) => <TabIcon name="person" label="Perfil" focused={focused} /> }}
      />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}

const ts = StyleSheet.create({
  tabBar: {
    backgroundColor: Colors.white,
    borderTopColor: Colors.border,
    borderTopWidth: 1,
    height: 68,
    paddingBottom: 10,
    paddingTop: 8,
    elevation: 0,
    shadowOpacity: 0,
  },
  iconWrap: { alignItems: 'center', gap: 3 },
  label: { fontSize: 10, color: Colors.textLight, fontWeight: '500' },
  labelActive: { color: Colors.primary, fontWeight: '700' },
  badge: {
    position: 'absolute', top: -4, right: -8,
    backgroundColor: Colors.error, borderRadius: 8,
    minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 8, fontWeight: '800' },
});
