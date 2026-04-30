import { useEffect, useState } from 'react';
import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { Colors } from '@/constants/Colors';
import { useCart } from '@/src/context/CartContext';
import { notificacionesAPI } from '@/src/services/api';
import { useAuth } from '@/src/context/AuthContext';

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

function CartIcon({ focused }: { focused: boolean }) {
  const { cantidad } = useCart();
  return (
    <View style={{ alignItems: 'center', paddingTop: 4 }}>
      <View>
        <Text style={{ fontSize: 20 }}>🛒</Text>
        {cantidad > 0 && (
          <View style={{ position: 'absolute', top: -4, right: -6, backgroundColor: Colors.orange, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{cantidad}</Text>
          </View>
        )}
      </View>
      <Text style={{ fontSize: 10, fontWeight: focused ? '700' : '500', color: focused ? Colors.orange : Colors.textLight, marginTop: 2 }}>Carrito</Text>
    </View>
  );
}

function BellIcon({ focused }: { focused: boolean }) {
  const [sinLeer, setSinLeer] = useState(0);
  const { usuario } = useAuth();

  useEffect(() => {
    if (!usuario) return;
    notificacionesAPI.listar().then((res) => {
      const n = (res.data || []).filter((n: any) => !n.leida).length;
      setSinLeer(n);
    }).catch(() => { });
  }, [usuario, focused]); // re-fetch when tab gains focus

  return (
    <View style={{ alignItems: 'center', paddingTop: 4 }}>
      <View>
        <Text style={{ fontSize: 20 }}>🔔</Text>
        {sinLeer > 0 && (
          <View style={{ position: 'absolute', top: -4, right: -6, backgroundColor: Colors.orange, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{sinLeer > 9 ? '9+' : sinLeer}</Text>
          </View>
        )}
      </View>
      <Text style={{ fontSize: 10, fontWeight: focused ? '700' : '500', color: focused ? Colors.orange : Colors.textLight, marginTop: 2 }}>Alertas</Text>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarStyle: { backgroundColor: Colors.white, borderTopColor: Colors.border, borderTopWidth: 1, height: 64, paddingBottom: 8 }, tabBarShowLabel: false }}>
      <Tabs.Screen name="index" options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🏠" label="Inicio" focused={focused} /> }} />
      <Tabs.Screen name="carrito" options={{ tabBarIcon: ({ focused }) => <CartIcon focused={focused} /> }} />
      <Tabs.Screen name="pedidos" options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📦" label="Pedidos" focused={focused} /> }} />
      <Tabs.Screen name="notificaciones" options={{ tabBarIcon: ({ focused }) => <BellIcon focused={focused} /> }} />
      <Tabs.Screen name="perfil" options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="👤" label="Perfil" focused={focused} /> }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}
