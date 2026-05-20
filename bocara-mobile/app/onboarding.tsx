import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors } from '@/constants/Colors';

const { width } = Dimensions.get('window');

const SLIDES = [
  {
    icon: 'bag-handle' as const,
    color: Colors.primary,
    bg: Colors.accentLight,
    titulo: '¡Bienvenido a Bocara!',
    texto: 'Rescata bolsas de comida de alta calidad a precios increíbles. Ayudas al planeta y ahorras dinero al mismo tiempo.',
  },
  {
    icon: 'leaf' as const,
    color: Colors.accent,
    bg: Colors.accentLight,
    titulo: 'Salva comida, salva el planeta',
    texto: 'Cada bolsa que rescatas evita que comida buena termine en la basura. Acumula puntos y sube de nivel: Bronce, Plata, Oro y Embajador.',
  },
  {
    icon: 'star' as const,
    color: Colors.primary,
    bg: Colors.surface,
    titulo: 'Empieza con 10 puntos',
    texto: 'Te damos 10 puntos de bienvenida. Úsalos para canjear descuentos. ¡Rescata tu primera bolsa y gana más!',
  },
];

export default function OnboardingScreen() {
  const [slide, setSlide] = useState(0);
  const router = useRouter();

  async function terminar() {
    await AsyncStorage.setItem('bocara_onboarding_done', 'true');
    router.replace('/(tabs)/');
  }

  const esUltimo = slide === SLIDES.length - 1;
  const { icon, color, bg, titulo, texto } = SLIDES[slide];

  return (
    <SafeAreaView style={s.root}>
      {/* Skip */}
      {!esUltimo && (
        <TouchableOpacity style={s.skipBtn} onPress={terminar}>
          <Text style={s.skipText}>Omitir</Text>
        </TouchableOpacity>
      )}

      <View style={s.content}>
        {/* Ilustración */}
        <View style={[s.ilustracion, { backgroundColor: bg }]}>
          <Ionicons name={icon} size={72} color={color} />
        </View>

        {/* Dots */}
        <View style={s.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[s.dot, i === slide && { width: 28, backgroundColor: color }]} />
          ))}
        </View>

        <Text style={s.titulo}>{titulo}</Text>
        <Text style={s.texto}>{texto}</Text>
      </View>

      {/* Footer */}
      <View style={s.footer}>
        {esUltimo ? (
          <TouchableOpacity style={[s.btnPrimary, { backgroundColor: color }]} onPress={terminar}>
            <Text style={s.btnPrimaryText}>¡Empezar a rescatar!</Text>
            <Ionicons name="arrow-forward" size={18} color={Colors.white} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.btnPrimary, { backgroundColor: color }]} onPress={() => setSlide(slide + 1)}>
            <Text style={s.btnPrimaryText}>Siguiente</Text>
            <Ionicons name="arrow-forward" size={18} color={Colors.white} />
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  skipBtn: { position: 'absolute', top: 56, right: 24, zIndex: 10, padding: 8 },
  skipText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },

  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36 },

  ilustracion: { width: 160, height: 160, borderRadius: 50, alignItems: 'center', justifyContent: 'center', marginBottom: 44 },

  dots: { flexDirection: 'row', gap: 8, marginBottom: 32 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.border },

  titulo: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary, textAlign: 'center', marginBottom: 16, lineHeight: 34 },
  texto: { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', lineHeight: 26 },

  footer: { paddingHorizontal: 24, paddingBottom: 36 },
  btnPrimary: { borderRadius: 18, paddingVertical: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  btnPrimaryText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
