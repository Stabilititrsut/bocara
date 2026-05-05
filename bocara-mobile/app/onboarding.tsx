import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Colors } from '@/constants/Colors';

const { width } = Dimensions.get('window');

const SLIDES = [
  {
    emoji: '🛍️',
    titulo: '¡Bienvenido a Bocara!',
    texto: 'Rescata bolsas de comida de alta calidad a precios increíbles. Ayudas al planeta y ahorras dinero al mismo tiempo.',
  },
  {
    emoji: '🌍',
    titulo: 'Salva comida, salva el planeta',
    texto: 'Cada bolsa que rescatas evita que comida buena termine en la basura. Acumula puntos y sube de nivel: Bronce, Plata, Oro y Embajador.',
  },
  {
    emoji: '⭐',
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
  const { emoji, titulo, texto } = SLIDES[slide];

  return (
    <SafeAreaView style={s.root}>
      <View style={s.content}>
        <Text style={s.emoji}>{emoji}</Text>
        <Text style={s.titulo}>{titulo}</Text>
        <Text style={s.texto}>{texto}</Text>
      </View>

      {/* Indicadores */}
      <View style={s.dots}>
        {SLIDES.map((_, i) => (
          <View key={i} style={[s.dot, i === slide && s.dotActive]} />
        ))}
      </View>

      {/* Botones */}
      <View style={s.footer}>
        {esUltimo ? (
          <TouchableOpacity style={s.btnPrimary} onPress={terminar}>
            <Text style={s.btnPrimaryText}>¡Empezar a rescatar! 🚀</Text>
          </TouchableOpacity>
        ) : (
          <View style={s.btnRow}>
            <TouchableOpacity style={s.btnSkip} onPress={terminar}>
              <Text style={s.btnSkipText}>Omitir</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.btnPrimary} onPress={() => setSlide(slide + 1)}>
              <Text style={s.btnPrimaryText}>Siguiente →</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36 },
  emoji: { fontSize: 96, marginBottom: 28 },
  titulo: { fontSize: 28, fontWeight: '900', color: Colors.brown, textAlign: 'center', marginBottom: 16, lineHeight: 34 },
  texto: { fontSize: 16, color: Colors.textSecondary, textAlign: 'center', lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 24 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.border },
  dotActive: { width: 24, backgroundColor: Colors.orange },
  footer: { paddingHorizontal: 24, paddingBottom: 32 },
  btnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  btnPrimary: { backgroundColor: Colors.orange, borderRadius: 16, paddingHorizontal: 28, paddingVertical: 16, flex: 1 },
  btnPrimaryText: { color: Colors.white, fontWeight: '800', fontSize: 16, textAlign: 'center' },
  btnSkip: { paddingHorizontal: 16, paddingVertical: 16, marginRight: 12 },
  btnSkipText: { color: Colors.textSecondary, fontSize: 14, fontWeight: '600' },
});
