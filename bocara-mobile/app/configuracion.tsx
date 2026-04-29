import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Switch, Alert, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/context/AuthContext';
import { Colors } from '@/constants/Colors';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionCard}>{children}</View>
    </View>
  );
}

function RowItem({
  emoji, label, sublabel, value, onToggle, onPress, isSwitch = false, isLast = false,
}: {
  emoji: string; label: string; sublabel?: string;
  value?: boolean; onToggle?: (v: boolean) => void;
  onPress?: () => void; isSwitch?: boolean; isLast?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[s.row, !isLast && s.rowBorder]}
      onPress={onPress}
      activeOpacity={isSwitch ? 1 : 0.7}
      disabled={!onPress && !onToggle}
    >
      <View style={s.rowIcon}><Text style={{ fontSize: 18 }}>{emoji}</Text></View>
      <View style={s.rowContent}>
        <Text style={s.rowLabel}>{label}</Text>
        {sublabel && <Text style={s.rowSublabel}>{sublabel}</Text>}
      </View>
      {isSwitch && onToggle ? (
        <Switch
          value={value}
          onValueChange={onToggle}
          trackColor={{ true: Colors.orange, false: Colors.border }}
          thumbColor={Colors.white}
        />
      ) : onPress ? (
        <Text style={s.rowArrow}>›</Text>
      ) : null}
    </TouchableOpacity>
  );
}

export default function ConfiguracionScreen() {
  const { usuario } = useAuth();
  const router = useRouter();
  const [notifPedidos, setNotifPedidos] = useState(true);
  const [notifPromos, setNotifPromos] = useState(true);
  const [notifNuevasBolsas, setNotifNuevasBolsas] = useState(false);

  function handlePrivacidad() {
    Alert.alert(
      'Política de Privacidad',
      'Bocara Food respeta tu privacidad. Tus datos son usados únicamente para ofrecerte la mejor experiencia en la plataforma.',
      [{ text: 'Entendido' }]
    );
  }

  function handleTerminos() {
    Alert.alert(
      'Términos y Condiciones',
      'Al usar Bocara Food aceptas nuestros términos de servicio. Bocara actúa como intermediario entre restaurantes y consumidores para reducir el desperdicio alimentario.',
      [{ text: 'Entendido' }]
    );
  }

  function handleEliminarCuenta() {
    Alert.alert(
      'Eliminar cuenta',
      '¿Estás seguro? Esta acción no se puede deshacer. Se eliminarán todos tus datos, puntos e historial de pedidos.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: () => Alert.alert('Solicitud enviada', 'Contacta a soporte@bocara.gt para confirmar la eliminación de tu cuenta.') },
      ]
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Cuenta */}
        <Section title="👤 Mi cuenta">
          <RowItem
            emoji="✏️"
            label="Editar perfil"
            sublabel={`${usuario?.nombre} ${usuario?.apellido || ''}`}
            onPress={() => router.push('/(tabs)/perfil')}
          />
          <RowItem
            emoji="📧"
            label="Correo electrónico"
            sublabel={usuario?.email}
            isLast
          />
        </Section>

        {/* Notificaciones */}
        <Section title="🔔 Notificaciones">
          <RowItem
            emoji="📦"
            label="Actualizaciones de pedidos"
            sublabel="Recibe avisos cuando tu pedido esté listo"
            isSwitch
            value={notifPedidos}
            onToggle={setNotifPedidos}
          />
          <RowItem
            emoji="🎫"
            label="Promociones y cupones"
            sublabel="Ofertas especiales y descuentos"
            isSwitch
            value={notifPromos}
            onToggle={setNotifPromos}
          />
          <RowItem
            emoji="🥡"
            label="Nuevas bolsas disponibles"
            sublabel="Alertas cuando aparezcan bolsas cercanas"
            isSwitch
            value={notifNuevasBolsas}
            onToggle={setNotifNuevasBolsas}
            isLast
          />
        </Section>

        {/* Idioma y región */}
        <Section title="🌎 Idioma y región">
          <RowItem emoji="🇬🇹" label="Idioma" sublabel="Español (Guatemala)" isLast />
        </Section>

        {/* Legal */}
        <Section title="📋 Legal">
          <RowItem emoji="🔒" label="Política de privacidad" onPress={handlePrivacidad} />
          <RowItem emoji="📄" label="Términos y condiciones" onPress={handleTerminos} isLast />
        </Section>

        {/* Zona peligrosa */}
        <Section title="⚠️ Zona de riesgo">
          <RowItem
            emoji="🗑️"
            label="Eliminar mi cuenta"
            sublabel="Borra todos tus datos de forma permanente"
            onPress={handleEliminarCuenta}
            isLast
          />
        </Section>

        {/* Info de la app */}
        <View style={s.appInfo}>
          <Text style={s.appName}>Bocara Food</Text>
          <Text style={s.appVersion}>Versión 1.0.0 · Guatemala</Text>
          <Text style={s.appMission}>Reduciendo el desperdicio alimentario, una bolsa a la vez 🌱</Text>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 16 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 4 },
  sectionCard: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden', elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  rowIcon: { backgroundColor: Colors.brownLight, borderRadius: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowContent: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  rowSublabel: { fontSize: 12, color: Colors.textSecondary, marginTop: 1 },
  rowArrow: { fontSize: 20, color: Colors.textLight },
  appInfo: { alignItems: 'center', paddingVertical: 24, gap: 4 },
  appName: { fontSize: 18, fontWeight: '900', color: Colors.brown },
  appVersion: { fontSize: 12, color: Colors.textLight },
  appMission: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 4, lineHeight: 20 },
});
