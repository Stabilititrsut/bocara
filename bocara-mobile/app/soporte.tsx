import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Linking, Alert,
} from 'react-native';
import { Colors } from '@/constants/Colors';

const FAQS = [
  {
    pregunta: '¿Qué hay dentro de las bolsas?',
    respuesta: 'Las bolsas contienen productos del día que no pudieron venderse: panes, pasteles, comidas preparadas, etc. El contenido varía según el negocio. Consulta la descripción de cada bolsa para más detalles.',
  },
  {
    pregunta: '¿Cómo funciona el proceso de pago?',
    respuesta: 'Pagas directamente en la app con tarjeta de crédito o débito. El pago es seguro y procesado con Stripe. Una vez confirmado, recibes un código de recogida o tu pedido se envía a domicilio.',
  },
  {
    pregunta: '¿Puedo cancelar mi pedido?',
    respuesta: 'Los pedidos confirmados no pueden cancelarse directamente. Si tienes un problema, contáctanos vía WhatsApp o correo y lo resolveremos a la brevedad.',
  },
  {
    pregunta: '¿Qué hago si el restaurante está cerrado?',
    respuesta: 'Si el restaurante está cerrado al llegar, contáctanos inmediatamente. Gestionaremos un reembolso o crédito en tu cuenta.',
  },
  {
    pregunta: '¿Cómo gano puntos?',
    respuesta: 'Ganas puntos Bocara con cada compra. Los puntos se acumulan y desbloquean niveles: Rescatador Novato → Rescatador Activo → Héroe de la Comida → Guardián del Planeta.',
  },
  {
    pregunta: '¿Cómo puedo registrar mi negocio?',
    respuesta: 'Descarga Bocara y selecciona "Tengo un restaurante" en el login. Completa el formulario de registro y nuestro equipo verificará tu negocio en 24-48 horas.',
  },
];

function FaqItem({ item }: { item: typeof FAQS[0] }) {
  const [abierta, setAbierta] = useState(false);
  return (
    <View style={s.faqItem}>
      <TouchableOpacity style={s.faqHeader} onPress={() => setAbierta(!abierta)} activeOpacity={0.7}>
        <Text style={s.faqPregunta} numberOfLines={abierta ? undefined : 2}>{item.pregunta}</Text>
        <Text style={[s.faqArrow, abierta && s.faqArrowOpen]}>{abierta ? '−' : '+'}</Text>
      </TouchableOpacity>
      {abierta && <Text style={s.faqRespuesta}>{item.respuesta}</Text>}
    </View>
  );
}

export default function SoporteScreen() {
  function abrirWhatsApp() {
    const numero = '50200000000';
    const mensaje = 'Hola, necesito ayuda con Bocara Food.';
    const url = `whatsapp://send?phone=${numero}&text=${encodeURIComponent(mensaje)}`;
    Linking.canOpenURL(url).then((ok) => {
      if (ok) Linking.openURL(url);
      else Alert.alert('WhatsApp no disponible', 'Instala WhatsApp o contáctanos por email.');
    });
  }

  function abrirEmail() {
    Linking.openURL('mailto:soporte@bocara.gt?subject=Ayuda%20Bocara%20Food');
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Hero */}
        <View style={s.hero}>
          <Text style={{ fontSize: 40 }}>💬</Text>
          <Text style={s.heroTitle}>¿Cómo podemos ayudarte?</Text>
          <Text style={s.heroSub}>Estamos aquí para resolver tus dudas</Text>
        </View>

        {/* Canales de contacto */}
        <Text style={s.sectionTitle}>📞 Contáctanos</Text>

        <TouchableOpacity style={s.contactCard} onPress={abrirWhatsApp} activeOpacity={0.85}>
          <View style={[s.contactIcon, { backgroundColor: '#25D366' + '20' }]}>
            <Text style={{ fontSize: 28 }}>💬</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.contactLabel}>WhatsApp</Text>
            <Text style={s.contactSub}>Respuesta en menos de 2 horas</Text>
          </View>
          <View style={s.contactChip}>
            <Text style={s.contactChipText}>Rápido</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.contactCard} onPress={abrirEmail} activeOpacity={0.85}>
          <View style={[s.contactIcon, { backgroundColor: Colors.orangeLight }]}>
            <Text style={{ fontSize: 28 }}>📧</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.contactLabel}>Email</Text>
            <Text style={s.contactSub}>soporte@bocara.gt</Text>
          </View>
          <Text style={s.rowArrow}>›</Text>
        </TouchableOpacity>

        {/* Horario */}
        <View style={s.horarioCard}>
          <Text style={s.horarioTitle}>⏰ Horario de atención</Text>
          <Text style={s.horarioItem}>Lunes a Viernes: 8:00 – 20:00</Text>
          <Text style={s.horarioItem}>Sábados y Domingos: 9:00 – 17:00</Text>
          <Text style={s.horarioZona}>Hora de Guatemala (GMT-6)</Text>
        </View>

        {/* FAQs */}
        <Text style={s.sectionTitle}>❓ Preguntas frecuentes</Text>
        <View style={s.faqCard}>
          {FAQS.map((faq, i) => (
            <View key={i}>
              <FaqItem item={faq} />
              {i < FAQS.length - 1 && <View style={s.faqDivider} />}
            </View>
          ))}
        </View>

        {/* Misión */}
        <View style={s.misionCard}>
          <Text style={s.misionEmoji}>🌱</Text>
          <Text style={s.misionTitle}>Nuestra misión</Text>
          <Text style={s.misionText}>
            Bocara nació en Guatemala para combatir el desperdicio alimentario conectando restaurantes y panaderías con consumidores conscientes. Cada bolsa rescatada es una pequeña gran victoria para el planeta.
          </Text>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: 16 },
  hero: { backgroundColor: Colors.white, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 20, elevation: 1 },
  heroTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown, marginTop: 10, textAlign: 'center' },
  heroSub: { fontSize: 14, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  contactCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white,
    borderRadius: 16, padding: 16, marginBottom: 10, elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6,
  },
  contactIcon: { borderRadius: 12, width: 52, height: 52, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  contactLabel: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  contactSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  contactChip: { backgroundColor: Colors.greenLight, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  contactChipText: { fontSize: 11, color: Colors.green, fontWeight: '700' },
  rowArrow: { fontSize: 20, color: Colors.textLight },
  horarioCard: { backgroundColor: Colors.brownLight, borderRadius: 14, padding: 16, marginBottom: 20 },
  horarioTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 8 },
  horarioItem: { fontSize: 13, color: Colors.textPrimary, marginBottom: 4 },
  horarioZona: { fontSize: 11, color: Colors.textSecondary, marginTop: 4 },
  faqCard: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden', marginBottom: 20, elevation: 1 },
  faqItem: { padding: 16 },
  faqHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  faqPregunta: { flex: 1, fontSize: 14, fontWeight: '700', color: Colors.brown, lineHeight: 20 },
  faqArrow: { fontSize: 20, color: Colors.orange, fontWeight: '700', lineHeight: 22 },
  faqArrowOpen: { color: Colors.brown },
  faqRespuesta: { fontSize: 13, color: Colors.textSecondary, marginTop: 10, lineHeight: 20 },
  faqDivider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 16 },
  misionCard: { backgroundColor: Colors.greenLight, borderRadius: 20, padding: 20, alignItems: 'center', gap: 8 },
  misionEmoji: { fontSize: 32 },
  misionTitle: { fontSize: 16, fontWeight: '900', color: Colors.green },
  misionText: { fontSize: 13, color: Colors.brown, textAlign: 'center', lineHeight: 20 },
});
