import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Linking,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/Colors';

type IoniconName = keyof typeof Ionicons.glyphMap;

const PILARES: { icon: IoniconName; label: string }[] = [
  { icon: 'leaf-outline', label: 'Menos desperdicio' },
  { icon: 'storefront-outline', label: 'Comercio local' },
  { icon: 'earth-outline', label: 'Consumo consciente' },
];

const FAQS = [
  {
    pregunta: '¿Qué productos encuentro en Bocara?',
    respuesta: 'Productos del día que no pudieron venderse y promociones exclusivas que Bocara ofrece para sus clientes para ir a traer o consumo en el restaurante.',
  },
  {
    pregunta: '¿Cómo funciona el proceso de pago?',
    respuesta: 'Pagas con tarjeta de crédito o débito mediante la plataforma segura de Cubo. Bocara confirma el pago antes de generar tu código de recogida.',
  },
  {
    pregunta: '¿Puedo cancelar mi pedido?',
    respuesta: 'Para cualquier reclamo, cancelación o devolución escríbenos directamente al WhatsApp de Bocara (+502 5107-7949) y te atenderemos personalmente.',
  },
  {
    pregunta: '¿Qué hago si el restaurante está cerrado?',
    respuesta: 'Comunícate inmediatamente al WhatsApp de Bocara (+502 5107-7949).',
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
        <Ionicons
          name={abierta ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={abierta ? Colors.primary : Colors.aqua}
          style={s.faqArrow}
        />
      </TouchableOpacity>
      {abierta && <Text style={s.faqRespuesta}>{item.respuesta}</Text>}
    </View>
  );
}

function SectionTitle({ icon, children }: { icon: IoniconName; children: string }) {
  return (
    <View style={s.sectionRow}>
      <View style={s.sectionIcon}>
        <Ionicons name={icon} size={14} color={Colors.aqua} />
      </View>
      <Text style={s.sectionTitle}>{children}</Text>
    </View>
  );
}

export default function SoporteScreen() {
  function abrirWhatsApp() {
    Linking.openURL('https://wa.me/50251077949?text=Hola%20Bocara%2C%20necesito%20ayuda%20con%20mi%20pedido');
  }

  function abrirEmail() {
    Linking.openURL('mailto:bocara@bocarafood.com?subject=Ayuda%20Bocara%20Food');
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Hero */}
        <View style={s.hero}>
          <View style={s.heroIcon}>
            <Ionicons name="chatbubbles-outline" size={28} color={Colors.aqua} />
          </View>
          <Text style={s.heroTitle}>¿Cómo podemos ayudarte?</Text>
          <Text style={s.heroSub}>Estamos aquí para resolver tus dudas</Text>
        </View>

        {/* Canales de contacto */}
        <SectionTitle icon="call-outline">Contáctanos</SectionTitle>

        <TouchableOpacity style={s.contactCard} onPress={abrirWhatsApp} activeOpacity={0.85}>
          <View style={[s.contactIcon, { backgroundColor: '#25D366' + '1F' }]}>
            <Ionicons name="logo-whatsapp" size={26} color="#1DA851" />
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
          <View style={[s.contactIcon, { backgroundColor: Colors.goldSuave }]}>
            <Ionicons name="mail-outline" size={24} color={Colors.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.contactLabel}>Email</Text>
            <Text style={s.contactSub}>bocara@bocarafood.com</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
        </TouchableOpacity>

        {/* Horario */}
        <View style={s.horarioCard}>
          <View style={s.horarioHeader}>
            <View style={s.horarioIcon}>
              <Ionicons name="time-outline" size={18} color={Colors.aqua} />
            </View>
            <Text style={s.horarioTitle}>Horario de atención</Text>
          </View>
          <View style={s.horarioRow}>
            <Text style={s.horarioDia}>Lunes a Viernes</Text>
            <Text style={s.horarioHora}>8:00 – 20:00</Text>
          </View>
          <View style={s.horarioRow}>
            <Text style={s.horarioDia}>Sábados y Domingos</Text>
            <Text style={s.horarioHora}>9:00 – 17:00</Text>
          </View>
          <Text style={s.horarioZona}>Hora de Guatemala (GMT-6)</Text>
        </View>

        {/* FAQs */}
        <SectionTitle icon="help-circle-outline">Preguntas frecuentes</SectionTitle>
        <View style={s.faqCard}>
          {FAQS.map((faq, i) => (
            <View key={i}>
              <FaqItem item={faq} />
              {i < FAQS.length - 1 && <View style={s.faqDivider} />}
            </View>
          ))}
        </View>

        {/* Misión: bloque editorial de marca */}
        <View style={s.misionCard}>
          <View style={s.misionGlow} />
          <View style={s.misionHeader}>
            <View style={s.misionBadge}>
              <Image
                source={require('@/assets/images/logo.png')}
                style={s.misionLogo}
                contentFit="cover"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.misionEyebrow}>IMPACTO BOCARA · GUATEMALA</Text>
              <Text style={s.misionTitle}>Nuestra misión</Text>
            </View>
          </View>

          <View style={s.misionRule} />

          <Text style={s.misionText}>
            Bocara nació en Guatemala para combatir el desperdicio alimentario conectando restaurantes y panaderías con consumidores conscientes.
          </Text>
          <Text style={s.misionQuote}>
            Cada producto rescatado es una pequeña gran victoria para el planeta.
          </Text>

          <View style={s.pilares}>
            {PILARES.map((p) => (
              <View key={p.label} style={s.pilar}>
                <Ionicons name={p.icon} size={14} color={Colors.goldLight} />
                <Text style={s.pilarText}>{p.label}</Text>
              </View>
            ))}
          </View>
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
  heroIcon: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: Colors.greenLight,
    alignItems: 'center', justifyContent: 'center',
  },
  heroTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown, marginTop: 12, textAlign: 'center' },
  heroSub: { fontSize: 14, color: Colors.textSecondary, marginTop: 4, textAlign: 'center' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionIcon: {
    width: 26, height: 26, borderRadius: 8, backgroundColor: Colors.greenLight,
    alignItems: 'center', justifyContent: 'center',
  },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.brown },
  contactCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white,
    borderRadius: 16, padding: 16, marginBottom: 10, elevation: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6,
  },
  contactIcon: { borderRadius: 14, width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  contactLabel: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  contactSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  contactChip: { backgroundColor: Colors.greenLight, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  contactChipText: { fontSize: 11, color: Colors.green, fontWeight: '700' },
  horarioCard: {
    backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginTop: 6, marginBottom: 24,
    borderWidth: 1, borderColor: Colors.bordeSuave,
  },
  horarioHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  horarioIcon: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.greenLight,
    alignItems: 'center', justifyContent: 'center',
  },
  horarioTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown },
  horarioRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  horarioDia: { fontSize: 13, color: Colors.textPrimary },
  horarioHora: { fontSize: 13, fontWeight: '700', color: Colors.aqua },
  horarioZona: { fontSize: 11, color: Colors.textSecondary, marginTop: 6 },
  faqCard: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden', marginBottom: 24, elevation: 1 },
  faqItem: { padding: 16 },
  faqHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  faqPregunta: { flex: 1, fontSize: 14, fontWeight: '700', color: Colors.brown, lineHeight: 20 },
  faqArrow: { marginTop: 1 },
  faqRespuesta: { fontSize: 13, color: Colors.textSecondary, marginTop: 10, lineHeight: 20 },
  faqDivider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 16 },
  misionCard: {
    backgroundColor: Colors.primary, borderRadius: 22, padding: 22, overflow: 'hidden',
    elevation: 3, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18, shadowRadius: 14,
  },
  misionGlow: {
    position: 'absolute', top: -70, right: -60, width: 190, height: 190, borderRadius: 95,
    backgroundColor: Colors.aqua, opacity: 0.35,
  },
  misionHeader: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  misionBadge: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.white, overflow: 'hidden',
    borderWidth: 2, borderColor: Colors.goldLight,
  },
  misionLogo: { width: '100%', height: '100%' },
  misionEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4, color: Colors.goldLight },
  misionTitle: { fontSize: 20, fontWeight: '900', color: Colors.textoClaro, marginTop: 3 },
  misionRule: { height: 2, width: 36, borderRadius: 1, backgroundColor: Colors.gold, marginVertical: 16 },
  misionText: { fontSize: 14, color: 'rgba(255,255,255,0.86)', lineHeight: 22 },
  misionQuote: {
    fontSize: 14, color: Colors.goldSuave, lineHeight: 21, fontStyle: 'italic', fontWeight: '600', marginTop: 10,
  },
  pilares: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  pilar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(232,184,75,0.35)',
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6,
  },
  pilarText: { fontSize: 11, fontWeight: '700', color: Colors.textoClaro },
});
