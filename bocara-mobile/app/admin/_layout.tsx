import { Tabs } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const GOLD     = '#C8A97E';
const INACTIVE = '#9CA3AF';
const WHITE    = '#FFFFFF';
const BORDER   = '#E5E7EB';

const TABS = [
  { name: 'index',             label: 'Dashboard',  icon: 'stats-chart'       },
  { name: 'verificacion',      label: 'Verificar',  icon: 'checkmark-circle'  },
  { name: 'contenido',         label: 'Contenido',  icon: 'document-text'     },
  { name: 'cambios-perfil',    label: 'Perfiles',   icon: 'person-circle'     },
  { name: 'liquidaciones',     label: 'Pagos',      icon: 'cash'              },
  { name: 'negocios',          label: 'Negocios',   icon: 'storefront'        },
  { name: 'financiero',        label: 'Finanzas',   icon: 'wallet'            },
  { name: 'usuarios',          label: 'Usuarios',   icon: 'people'            },
  { name: 'config',            label: 'Config',     icon: 'settings'          },
] as const;

export default function AdminLayout() {
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: GOLD,
        tabBarInactiveTintColor: INACTIVE,
        tabBarStyle: {
          backgroundColor: WHITE,
          borderTopColor: BORDER,
          borderTopWidth: 1,
          height: isDesktop ? '100%' : 64,
          paddingBottom: isDesktop ? 0 : 8,
          paddingTop: isDesktop ? 16 : 0,
          ...(isDesktop ? {
            width: 200,
            borderTopWidth: 0,
            borderRightWidth: 1,
            borderRightColor: BORDER,
          } : {}),
        },
        tabBarPosition: (isDesktop ? 'left' : 'bottom') as any,
        tabBarShowLabel: isDesktop,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      {TABS.map(({ name, label, icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            tabBarLabel: label,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name={icon as any} size={size ?? 22} color={color} />
            ),
          }}
        />
      ))}
      <Tabs.Screen name="restaurante-detalle" options={{ href: null }} />
    </Tabs>
  );
}
