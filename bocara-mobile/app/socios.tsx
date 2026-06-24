import { useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Linking, Animated, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

const PRIMARY = '#0A2A2A';
const ACCENT = '#C8960C';
const SURFACE = '#F4F7F7';
const WHITE = '#FFFFFF';
const SUBTLE = '#5A7070';

const PASOS = [
  {
    num: '01',
    icon: 'storefront-outline',
    titulo: 'Registra tu negocio',
    desc: 'Crea tu cuenta en minutos: datos del negocio, horarios, foto y cuenta bancaria.',
  },
  {
    num: '02',
    icon: 'add-circle-outline',
    titulo: 'Sube tus ofertas',
    desc: 'Publica bolsas sorpresa o promociones con precio rebajado. Tú decides el contenido y la hora.',
  },
  {
    num: '03',
    icon: 'notifications-outline',
    titulo: 'Recibe pedidos en tiempo real',
    desc: 'Te avisamos al instante. Escanea el QR del cliente con tu panel y confirma la entrega.',
  },
  {
    num: '04',
    icon: 'cash-outline',
    titulo: 'Cobra cada semana',
    desc: 'Transferimos el 75% de tus ventas directo a tu cuenta bancaria cada viernes.',
  },
];

const BENEFICIOS = [
  { icon: 'wallet-outline',       titulo: 'Solo 25% de comisión',      desc: 'Sin cargos fijos. Solo pagamos cuando vendes.' },
  { icon: 'bar-chart-outline',    titulo: 'Panel de control propio',   desc: 'Ve tus pedidos, ganancias y estadísticas en tiempo real.' },
  { icon: 'shield-checkmark-outline', titulo: 'Pagos seguros',         desc: 'Cubo Pago procesa cada transacción de forma encriptada.' },
  { icon: 'leaf-outline',         titulo: 'Reduce el desperdicio',      desc: 'Rescata comida que de otro modo se desperdiciaría.' },
  { icon: 'people-outline',       titulo: 'Comunidad activa',           desc: 'Miles de clientes listos para descubrir tu negocio.' },
  { icon: 'phone-portrait-outline', titulo: 'Siempre disponible',      desc: 'Tu panel funciona en móvil y web, sin instalar nada.' },
];

const PREGUNTAS = [
  {
    q: '¿Cuánto cuesta unirme?',
    a: 'Registrarse es completamente gratis. Solo cobramos el 25% de comisión cuando completas una venta.',
  },
  {
    q: '¿Cuándo recibo mi dinero?',
    a: 'Transferimos el 75% de tus ventas todos los viernes a la cuenta bancaria que registres.',
  },
  {
    q: '¿Cómo se verifica mi negocio?',
    a: 'Nuestro equipo revisa tu DPI y datos bancarios en un plazo de 24 a 48 horas hábiles.',
  },
  {
    q: '¿Qué tipo de negocios pueden unirse?',
    a: 'Restaurantes, panaderías, cafeterías, supermercados, y cualquier negocio de alimentos con excedente.',
  },
];

export default function SociosScreen() {
  const router = useRouter();
  const scrollY = useRef(new Animated.Value(0)).current;

  function registrarNegocio() {
    router.push('/registro-restaurante' as any);
  }

  function contactarWhatsApp() {
    Linking.openURL('https://wa.me/50200000000?text=Hola%2C%20quiero%20unirme%20a%20Bocara%20como%20socio%20restaurante').catch(() => {});
  }

  return (
    <SafeAreaView style={s.root}>
      <Animated.ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
      >
        {/* ── HERO ── */}
        <View style={s.hero}>
          <View style={s.heroBadge}>
            <Text style={s.heroBadgeText}>🇬🇹 Hecho en Guatemala</Text>
          </View>
          <Text style={s.heroTitle}>
            Empieza a vender{'\n'}en <Text style={s.heroAccent}>Bocara</Text>
          </Text>
          <Text style={s.heroSub}>
            Convierte el excedente de tu negocio en ingresos reales. Sin cargos fijos, sin complicaciones.
          </Text>
          <TouchableOpacity style={s.heroBtn} onPress={registrarNegocio} activeOpacity={0.85}>
            <Text style={s.heroBtnText}>Registrar mi negocio gratis</Text>
            <Ionicons name="arrow-forward" size={18} color={PRIMARY} />
          </TouchableOpacity>
          <TouchableOpacity style={s.heroSecondaryBtn} onPress={contactarWhatsApp}>
            <Ionicons name="logo-whatsapp" size={16} color={WHITE} />
            <Text style={s.heroSecondaryText}>Hablar con un asesor</Text>
          </TouchableOpacity>

          {/* Métricas hero */}
          <View style={s.heroMetrics}>
            {[
              { val: '500+', label: 'Clientes activos' },
              { val: '24h',  label: 'Aprobación' },
              { val: '75%',  label: 'Para ti' },
            ].map(({ val, label }) => (
              <View key={label} style={s.heroMetric}>
                <Text style={s.heroMetricVal}>{val}</Text>
                <Text style={s.heroMetricLabel}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── CÓMO FUNCIONA ── */}
        <View style={s.section}>
          <Text style={s.sectionTag}>PROCESO</Text>
          <Text style={s.sectionTitle}>¿Cómo funciona?</Text>
          <Text style={s.sectionSub}>En 4 pasos simples empiezas a generar ingresos extra</Text>

          <View style={s.pasosList}>
            {PASOS.map((paso, i) => (
              <View key={paso.num} style={s.pasoCard}>
                <View style={s.pasoLeft}>
                  <View style={s.pasoNumWrap}>
                    <Text style={s.pasoNum}>{paso.num}</Text>
                  </View>
                  {i < PASOS.length - 1 && <View style={s.pasoLinea} />}
                </View>
                <View style={s.pasoContent}>
                  <View style={s.pasoIconWrap}>
                    <Ionicons name={paso.icon as any} size={22} color={ACCENT} />
                  </View>
                  <Text style={s.pasoTitulo}>{paso.titulo}</Text>
                  <Text style={s.pasoDesc}>{paso.desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* ── BENEFICIOS ── */}
        <View style={[s.section, s.sectionDark]}>
          <Text style={[s.sectionTag, { color: ACCENT }]}>VENTAJAS</Text>
          <Text style={[s.sectionTitle, { color: WHITE }]}>Todo lo que necesitas</Text>
          <Text style={[s.sectionSub, { color: 'rgba(255,255,255,0.6)' }]}>
            Herramientas profesionales sin costo extra
          </Text>

          <View style={s.beneficiosGrid}>
            {BENEFICIOS.map((b) => (
              <View key={b.titulo} style={s.beneficioCard}>
                <View style={s.beneficioIcon}>
                  <Ionicons name={b.icon as any} size={24} color={ACCENT} />
                </View>
                <Text style={s.beneficioTitulo}>{b.titulo}</Text>
                <Text style={s.beneficioDesc}>{b.desc}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── COMISIÓN DESTACADA ── */}
        <View style={s.comisionSection}>
          <View style={s.comisionCard}>
            <Text style={s.comisionNumero}>75%</Text>
            <Text style={s.comisionLabel}>de tus ventas es para ti</Text>
            <View style={s.comisionDivider} />
            <Text style={s.comisionDesc}>
              Bocara solo retiene el 25% de cada venta como comisión de plataforma. Sin mensualidades, sin sorpresas.
            </Text>
          </View>
          <View style={s.comisionVsWrap}>
            <View style={s.comisionVsCard}>
              <Text style={s.comisionVsPlat}>Otras plataformas</Text>
              <Text style={s.comisionVsNum}>30–40%</Text>
              <Text style={s.comisionVsSub}>de comisión</Text>
            </View>
            <View style={[s.comisionVsCard, s.comisionVsCardBocara]}>
              <Text style={[s.comisionVsPlat, { color: ACCENT }]}>Bocara</Text>
              <Text style={[s.comisionVsNum, { color: ACCENT }]}>25%</Text>
              <Text style={[s.comisionVsSub, { color: 'rgba(200,150,12,0.7)' }]}>de comisión</Text>
            </View>
          </View>
        </View>

        {/* ── PREGUNTAS FRECUENTES ── */}
        <View style={s.section}>
          <Text style={s.sectionTag}>FAQ</Text>
          <Text style={s.sectionTitle}>Preguntas frecuentes</Text>
          {PREGUNTAS.map((faq) => (
            <View key={faq.q} style={s.faqCard}>
              <Text style={s.faqQ}>{faq.q}</Text>
              <Text style={s.faqA}>{faq.a}</Text>
            </View>
          ))}
        </View>

        {/* ── CTA FINAL ── */}
        <View style={s.ctaSection}>
          <Text style={s.ctaTitle}>Listo para empezar</Text>
          <Text style={s.ctaSub}>
            El registro toma 10 minutos. Tu negocio podría estar activo mañana.
          </Text>
          <TouchableOpacity style={s.ctaBtn} onPress={registrarNegocio} activeOpacity={0.85}>
            <Text style={s.ctaBtnText}>Registrar mi negocio gratis →</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.ctaWaBtn} onPress={contactarWhatsApp}>
            <Ionicons name="logo-whatsapp" size={16} color='#25D366' />
            <Text style={s.ctaWaText}>¿Tienes dudas? Escríbenos por WhatsApp</Text>
          </TouchableOpacity>
          <Text style={s.ctaLegal}>
            Al registrarte aceptas los{' '}
            <Text style={{ textDecorationLine: 'underline' }}>Términos de servicio</Text>
            {' '}de Bocara. Aprobación sujeta a verificación.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </Animated.ScrollView>

      {/* ── Navbar top ── */}
      <View style={s.navbar}>
        <TouchableOpacity onPress={() => router.back()} style={s.navBack}>
          <Ionicons name="arrow-back" size={20} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={s.navLogo}>bocara</Text>
        <TouchableOpacity style={s.navCta} onPress={registrarNegocio}>
          <Text style={s.navCtaText}>Registrarme</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: WHITE },
  scroll: { paddingTop: 64 },

  // Navbar
  navbar:      { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 52 : 14, paddingBottom: 12, backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: '#F0EDE8', zIndex: 10 },
  navBack:     { width: 36, height: 36, borderRadius: 18, backgroundColor: SURFACE, alignItems: 'center', justifyContent: 'center' },
  navLogo:     { fontSize: 20, fontWeight: '900', color: PRIMARY, letterSpacing: -0.5 },
  navCta:      { backgroundColor: PRIMARY, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  navCtaText:  { color: WHITE, fontWeight: '700', fontSize: 13 },

  // Hero
  hero:          { backgroundColor: PRIMARY, padding: 28, paddingTop: 32, paddingBottom: 36 },
  heroBadge:     { backgroundColor: 'rgba(200,150,12,0.2)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, alignSelf: 'flex-start', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(200,150,12,0.3)' },
  heroBadgeText: { fontSize: 12, fontWeight: '700', color: ACCENT, letterSpacing: 0.3 },
  heroTitle:     { fontSize: 38, fontWeight: '900', color: WHITE, lineHeight: 44, marginBottom: 14, letterSpacing: -0.5 },
  heroAccent:    { color: ACCENT },
  heroSub:       { fontSize: 15, color: 'rgba(255,255,255,0.65)', lineHeight: 23, marginBottom: 28 },
  heroBtn:       { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: ACCENT, borderRadius: 50, paddingVertical: 16, paddingHorizontal: 24, justifyContent: 'center', marginBottom: 12 },
  heroBtnText:   { fontSize: 15, fontWeight: '900', color: PRIMARY },
  heroSecondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', paddingVertical: 14, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.2)', borderRadius: 50, marginBottom: 28 },
  heroSecondaryText: { fontSize: 14, fontWeight: '700', color: WHITE },
  heroMetrics:   { flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)', paddingTop: 20, gap: 0 },
  heroMetric:    { flex: 1, alignItems: 'center' },
  heroMetricVal: { fontSize: 26, fontWeight: '900', color: ACCENT },
  heroMetricLabel: { fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 3, fontWeight: '600' },

  // Sections
  section:     { padding: 28 },
  sectionDark: { backgroundColor: PRIMARY },
  sectionTag:  { fontSize: 10, fontWeight: '800', color: ACCENT, letterSpacing: 2, marginBottom: 6 },
  sectionTitle:{ fontSize: 26, fontWeight: '900', color: PRIMARY, marginBottom: 8, letterSpacing: -0.3 },
  sectionSub:  { fontSize: 14, color: SUBTLE, lineHeight: 21, marginBottom: 24 },

  // Pasos
  pasosList:   { gap: 0 },
  pasoCard:    { flexDirection: 'row', gap: 16, marginBottom: 0 },
  pasoLeft:    { alignItems: 'center', width: 40 },
  pasoNumWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: PRIMARY, alignItems: 'center', justifyContent: 'center' },
  pasoNum:     { fontSize: 13, fontWeight: '900', color: ACCENT },
  pasoLinea:   { width: 2, flex: 1, backgroundColor: '#E8E4DE', marginVertical: 4 },
  pasoContent: { flex: 1, paddingBottom: 28 },
  pasoIconWrap:{ width: 44, height: 44, borderRadius: 22, backgroundColor: SURFACE, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  pasoTitulo:  { fontSize: 17, fontWeight: '800', color: PRIMARY, marginBottom: 6 },
  pasoDesc:    { fontSize: 14, color: SUBTLE, lineHeight: 21 },

  // Beneficios
  beneficiosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  beneficioCard:  { width: '47.5%', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  beneficioIcon:  { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(200,150,12,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  beneficioTitulo:{ fontSize: 14, fontWeight: '800', color: WHITE, marginBottom: 6 },
  beneficioDesc:  { fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 18 },

  // Comisión
  comisionSection:{ backgroundColor: SURFACE, padding: 28 },
  comisionCard:   { backgroundColor: PRIMARY, borderRadius: 24, padding: 28, alignItems: 'center', marginBottom: 16 },
  comisionNumero: { fontSize: 72, fontWeight: '900', color: ACCENT, lineHeight: 76 },
  comisionLabel:  { fontSize: 16, fontWeight: '700', color: WHITE, marginBottom: 16 },
  comisionDivider:{ width: 40, height: 2, backgroundColor: 'rgba(255,255,255,0.15)', marginBottom: 16 },
  comisionDesc:   { fontSize: 14, color: 'rgba(255,255,255,0.55)', textAlign: 'center', lineHeight: 21 },
  comisionVsWrap: { flexDirection: 'row', gap: 10 },
  comisionVsCard: { flex: 1, backgroundColor: WHITE, borderRadius: 18, padding: 18, alignItems: 'center', borderWidth: 1.5, borderColor: '#E8E4DE' },
  comisionVsCardBocara: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  comisionVsPlat: { fontSize: 11, fontWeight: '700', color: SUBTLE, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  comisionVsNum:  { fontSize: 34, fontWeight: '900', color: PRIMARY },
  comisionVsSub:  { fontSize: 12, color: SUBTLE, marginTop: 2 },

  // FAQ
  faqCard: { backgroundColor: SURFACE, borderRadius: 16, padding: 18, marginBottom: 10 },
  faqQ:    { fontSize: 15, fontWeight: '800', color: PRIMARY, marginBottom: 8 },
  faqA:    { fontSize: 13, color: SUBTLE, lineHeight: 20 },

  // CTA
  ctaSection: { backgroundColor: PRIMARY, padding: 32, alignItems: 'center' },
  ctaTitle:   { fontSize: 30, fontWeight: '900', color: WHITE, textAlign: 'center', marginBottom: 10, letterSpacing: -0.3 },
  ctaSub:     { fontSize: 15, color: 'rgba(255,255,255,0.6)', textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  ctaBtn:     { backgroundColor: ACCENT, borderRadius: 50, paddingVertical: 18, paddingHorizontal: 28, alignSelf: 'stretch', alignItems: 'center', marginBottom: 14 },
  ctaBtnText: { fontSize: 16, fontWeight: '900', color: PRIMARY },
  ctaWaBtn:   { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, marginBottom: 20 },
  ctaWaText:  { fontSize: 14, color: 'rgba(255,255,255,0.6)', fontWeight: '600' },
  ctaLegal:   { fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center', lineHeight: 17 },
});
