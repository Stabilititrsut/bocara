import { useState } from 'react';
import { Tabs } from 'expo-router';
import { Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

const GOLD     = '#C8960C';
const INACTIVE = '#6B7280';
const WHITE    = '#FFFFFF';
const BORDER   = '#E5E7EB';
const DARK_GREEN = '#0A2A2A';
const GOLD_SOFT  = '#FBF3DC';

// Orden por frecuencia de uso: es el orden del sidebar de escritorio.
// cupones está en posición 4 para garantizar visibilidad en pantallas estrechas.
// indicadores (módulo 03 de la guía) va justo después, dentro de los 7 visibles.
const TABS = [
  { name: 'index',             label: 'Dashboard',  icon: 'stats-chart'       },
  { name: 'verificacion',      label: 'Verificar',  icon: 'checkmark-circle'  },
  { name: 'contenido',         label: 'Contenido',  icon: 'document-text'     },
  { name: 'cupones',           label: 'Cupones',    icon: 'ticket-outline'    },
  { name: 'indicadores',       label: 'Indicadores', icon: 'analytics'        },
  { name: 'cambios-perfil',    label: 'Perfiles',   icon: 'person-circle'     },
  { name: 'liquidaciones',     label: 'Pagos',      icon: 'cash'              },
  { name: 'negocios',          label: 'Negocios',   icon: 'storefront'        },
  { name: 'financiero',        label: 'Finanzas',   icon: 'wallet'            },
  { name: 'usuarios',          label: 'Usuarios',   icon: 'people'            },
  { name: 'config',            label: 'Config',     icon: 'settings'          },
  { name: 'cubo-status',       label: 'Cubo Pago',  icon: 'card'              },
] as const;

type TabName = (typeof TABS)[number]['name'];

// Móvil: 4 accesos directos + "Más", que abre una hoja con el resto de secciones.
const MOBILE_PRIMARY: readonly TabName[] = ['index', 'negocios', 'financiero', 'indicadores'];
const MOBILE_MORE = TABS.filter((t) => !MOBILE_PRIMARY.includes(t.name));

// Rutas ocultas: qué pestaña debe verse activa mientras se está en ellas.
const HIDDEN_PARENT: Record<string, TabName> = {
  'restaurante-detalle': 'negocios',
  'datos-prueba':        'config',
};

const MIN_TOUCH = 44;

function AdminMobileTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const [moreOpen, setMoreOpen] = useState(false);

  const currentName = state.routes[state.index]?.name ?? 'index';
  const activeName = HIDDEN_PARENT[currentName] ?? currentName;
  const moreActive = !MOBILE_PRIMARY.includes(activeName as TabName);

  const goTo = (name: string) => {
    setMoreOpen(false);
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (currentName !== name && !event.defaultPrevented) {
      navigation.navigate(name);
    }
  };

  return (
    <>
      <View style={[st.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
        {MOBILE_PRIMARY.map((name) => {
          const tab = TABS.find((t) => t.name === name)!;
          const focused = activeName === name;
          return (
            <BarItem
              key={name}
              label={tab.label}
              icon={tab.icon}
              focused={focused}
              onPress={() => goTo(name)}
            />
          );
        })}
        <BarItem
          label="Más"
          icon="grid"
          focused={moreActive || moreOpen}
          onPress={() => setMoreOpen(true)}
          accessibilityHint="Abre el menú con el resto de secciones"
        />
      </View>

      <Modal
        visible={moreOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setMoreOpen(false)}
        statusBarTranslucent
      >
        <View style={st.modalRoot}>
          <Pressable
            style={st.backdrop}
            onPress={() => setMoreOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Cerrar menú"
          />
          <View style={[st.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <View style={st.handle} />
            <View style={st.sheetHeader}>
              <Text style={st.sheetTitle}>Más secciones</Text>
              <Pressable
                onPress={() => setMoreOpen(false)}
                style={st.closeBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Cerrar"
              >
                <Ionicons name="close" size={22} color={DARK_GREEN} />
              </Pressable>
            </View>
            <View style={st.grid}>
              {MOBILE_MORE.map(({ name, label, icon }) => {
                const focused = activeName === name;
                return (
                  <Pressable
                    key={name}
                    onPress={() => goTo(name)}
                    style={({ pressed }) => [st.gridItem, pressed && st.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: focused }}
                  >
                    <View style={[st.gridIcon, focused && st.gridIconActive]}>
                      <Ionicons name={icon as any} size={24} color={DARK_GREEN} />
                    </View>
                    <Text style={[st.gridLabel, focused && st.gridLabelActive]} numberOfLines={1}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function BarItem({ label, icon, focused, onPress, accessibilityHint }: {
  label: string;
  icon: string;
  focused: boolean;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  const color = focused ? DARK_GREEN : INACTIVE;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [st.item, pressed && st.pressed]}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: focused }}
    >
      <View style={[st.indicator, focused && st.indicatorActive]} />
      <Ionicons name={icon as any} size={22} color={color} />
      <Text style={[st.itemLabel, { color }, focused && st.itemLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function AdminLayout() {
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === 'web' && width >= 768;

  return (
    <Tabs
      tabBar={isDesktop ? undefined : (props) => <AdminMobileTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: GOLD,
        tabBarInactiveTintColor: 'rgba(255,255,255,0.5)',
        tabBarStyle: {
          backgroundColor: DARK_GREEN,
          borderTopColor: 'transparent',
          height: '100%',
          paddingBottom: 0,
          paddingTop: 16,
          width: 200,
          borderTopWidth: 0,
          borderRightWidth: 0,
        },
        tabBarPosition: (isDesktop ? 'left' : 'bottom') as any,
        tabBarShowLabel: true,
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
      <Tabs.Screen name="datos-prueba" options={{ href: null }} />
    </Tabs>
  );
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: WHITE,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingTop: 4,
  },
  item: {
    flex: 1,
    minHeight: 52,
    minWidth: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 2,
  },
  pressed: { opacity: 0.6 },
  indicator: {
    position: 'absolute',
    top: -4,
    width: 28,
    height: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: 'transparent',
  },
  indicatorActive: { backgroundColor: GOLD },
  itemLabel: { fontSize: 11, fontWeight: '600' },
  itemLabelActive: { fontWeight: '800' },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: BORDER,
    marginBottom: 8,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: DARK_GREEN },
  closeBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  gridItem: {
    width: '25%',
    minHeight: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  gridIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3F4F6',
  },
  gridIconActive: { backgroundColor: GOLD_SOFT, borderWidth: 1.5, borderColor: GOLD },
  gridLabel: { fontSize: 12, fontWeight: '600', color: DARK_GREEN },
  gridLabelActive: { fontWeight: '800' },
});
