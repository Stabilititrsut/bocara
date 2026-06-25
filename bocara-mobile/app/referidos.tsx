import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, SafeAreaView, Share, Clipboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { cuponesAPI } from '@/src/services/api';

const TEAL = '#1A5C5C';
const GOLD = '#E6A817';
const CARD_BG   = '#F4F7F7';
const CARD_BORDER = '#D8E4E4';

interface ReferidoData {
  codigo: string;
  credito: number;
  link_compartir: string;
}

const PASOS = [
  { num: '1', texto: 'Comparte tu código con amigos y familia' },
  { num: '2', texto: 'Ellos se registran en Bocara con tu código' },
  { num: '3', texto: 'Ambos ganan Q10 de crédito para sus próximos pedidos' },
];

export default function ReferidosScreen() {
  const router = useRouter();
  const [data, setData] = useState<ReferidoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    cuponesAPI.miReferido()
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function copiar() {
    if (!data?.codigo) return;
    Clipboard.setString(data.codigo);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  async function compartir() {
    if (!data) return;
    await Share.share({
      message: `¡Descarga Bocara Food! Usa mi código ${data.codigo} al registrarte y ambos ganamos Q10. 🌱 ${data.link_compartir}`,
      title: 'Bocara Food — Rescata comida',
    });
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={TEAL} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Referidos</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Hero */}
        <View style={s.heroCard}>
          <Text style={s.heroIcon}>🎁</Text>
          <Text style={s.heroTitle}>Comparte Bocara</Text>
          <Text style={s.heroSubtitle}>Invita a tus amigos y ambos ganan{'\n'}Q10 de crédito</Text>
        </View>

        {loading ? (
          <ActivityIndicator color={TEAL} style={{ marginTop: 32 }} />
        ) : !data ? (
          <View style={s.emptyBox}>
            <Ionicons name="alert-circle-outline" size={36} color="#B0BEBE" />
            <Text style={s.emptyText}>No se pudo cargar tu código</Text>
          </View>
        ) : (
          <>
            {/* Código */}
            <View style={s.codigoCard}>
              <Text style={s.codigoLabel}>Tu código de referido</Text>
              <View style={s.codigoRow}>
                <Text style={s.codigoText}>{data.codigo}</Text>
                <TouchableOpacity onPress={copiar} style={s.copiarBtn} activeOpacity={0.75}>
                  <Ionicons
                    name={copiado ? 'checkmark-circle' : 'copy-outline'}
                    size={22}
                    color={copiado ? '#22A86A' : TEAL}
                  />
                </TouchableOpacity>
              </View>
              {copiado && <Text style={s.copiadoText}>¡Código copiado!</Text>}
            </View>

            {/* Crédito acumulado */}
            {data.credito > 0 && (
              <View style={s.creditoCard}>
                <Text style={s.creditoLabel}>Crédito acumulado</Text>
                <Text style={s.creditoVal}>Q{data.credito.toFixed(2)} ✨</Text>
              </View>
            )}

            {/* Botón compartir */}
            <TouchableOpacity style={s.compartirBtn} onPress={compartir} activeOpacity={0.85}>
              <Ionicons name="share-social-outline" size={20} color="#FFF" />
              <Text style={s.compartirBtnText}>Compartir mi código</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ¿Cómo funciona? */}
        <Text style={s.sectionTitle}>¿Cómo funciona?</Text>
        {PASOS.map(p => (
          <View key={p.num} style={s.pasoRow}>
            <View style={s.pasoNumBox}>
              <Text style={s.pasoNum}>{p.num}</Text>
            </View>
            <Text style={s.pasoTexto}>{p.texto}</Text>
          </View>
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#FFFAF4' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: CARD_BORDER, gap: 12 },
  backBtn:{ width: 38, height: 38, borderRadius: 12, backgroundColor: '#F4F7F7', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '800', color: TEAL },

  scroll: { padding: 16 },

  heroCard:     { backgroundColor: TEAL, borderRadius: 28, padding: 28, alignItems: 'center', marginBottom: 20, shadowColor: TEAL, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 6 },
  heroIcon:     { fontSize: 48, marginBottom: 12 },
  heroTitle:    { fontSize: 26, fontWeight: '900', color: '#FFFFFF', marginBottom: 8 },
  heroSubtitle: { fontSize: 14, color: 'rgba(255,255,255,0.8)', textAlign: 'center', lineHeight: 22 },

  codigoCard:  { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, marginBottom: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  codigoLabel: { fontSize: 12, color: '#6A8080', fontWeight: '600', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 },
  codigoRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: CARD_BG, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 14, borderWidth: 1.5, borderColor: CARD_BORDER },
  codigoText:  { flex: 1, fontSize: 22, fontWeight: '900', color: TEAL, letterSpacing: 1.5 },
  copiarBtn:   { padding: 4 },
  copiadoText: { fontSize: 12, color: '#22A86A', fontWeight: '700', marginTop: 8, textAlign: 'center' },

  creditoCard:  { backgroundColor: GOLD + '18', borderRadius: 18, padding: 18, marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.5, borderColor: GOLD + '40' },
  creditoLabel: { fontSize: 14, color: '#7A5800', fontWeight: '700' },
  creditoVal:   { fontSize: 22, fontWeight: '900', color: '#7A5800' },

  compartirBtn:     { backgroundColor: TEAL, borderRadius: 50, paddingVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 28, shadowColor: TEAL, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 10, elevation: 4 },
  compartirBtnText: { color: '#FFFFFF', fontWeight: '900', fontSize: 16 },

  sectionTitle: { fontSize: 16, fontWeight: '800', color: TEAL, marginBottom: 16 },

  pasoRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginBottom: 14 },
  pasoNumBox: { width: 36, height: 36, borderRadius: 18, backgroundColor: TEAL, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  pasoNum:    { fontSize: 16, fontWeight: '900', color: '#FFFFFF' },
  pasoTexto:  { flex: 1, fontSize: 14, color: '#2A3A3A', lineHeight: 22, paddingTop: 6 },

  emptyBox:  { alignItems: 'center', paddingVertical: 32, gap: 12 },
  emptyText: { fontSize: 14, color: '#8A9FA0' },
});
