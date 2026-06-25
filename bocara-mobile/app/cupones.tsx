import { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { cuponesAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const TEAL = '#1A5C5C';
const ERR  = '#C0392B';
const CARD_BG   = '#F4F7F7';
const CARD_BORDER = '#D8E4E4';

interface Cupon {
  id: string;
  codigo: string;
  tipo: 'porcentaje' | 'monto_fijo' | 'referido';
  valor: number;
  fecha_vencimiento?: string;
}

export default function CuponesScreen() {
  const router = useRouter();
  const [codigo, setCodigo] = useState('');
  const [loading, setLoading] = useState(false);
  const [msgOk, setMsgOk] = useState('');
  const [msgErr, setMsgErr] = useState('');
  const [cupones, setCupones] = useState<Cupon[]>([]);
  const [loadingCupones, setLoadingCupones] = useState(true);

  useEffect(() => {
    cuponesAPI.misCupones()
      .then(res => setCupones(res.data || []))
      .catch(() => {})
      .finally(() => setLoadingCupones(false));
  }, []);

  async function validar() {
    if (!codigo.trim()) return;
    setLoading(true);
    setMsgOk('');
    setMsgErr('');
    try {
      const res = await cuponesAPI.validar(codigo.trim(), 0);
      setMsgOk(res.data.mensaje || 'Cupón válido');
      // Refresh lista
      const lista = await cuponesAPI.misCupones();
      setCupones(lista.data || []);
    } catch (e: any) {
      setMsgErr(e.message || 'Cupón no válido');
    } finally {
      setLoading(false);
    }
  }

  function labelCupon(c: Cupon) {
    if (c.tipo === 'porcentaje') return `${c.valor}% de descuento`;
    return `Q${c.valor.toFixed(2)} de descuento`;
  }

  function motivoCupon(c: Cupon) {
    if (c.tipo === 'referido' || c.codigo.startsWith('REF-')) return 'Por ser referido';
    return 'Descuento especial Bocara';
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={22} color={TEAL} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Cupones</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        <View style={s.card}>
          <Text style={s.cardTitle}>¿Tienes un código?</Text>
          <View style={s.inputRow}>
            <TextInput
              style={s.input}
              placeholder="Ej. BOCARA-BIENVENIDA"
              placeholderTextColor="#AAB0B0"
              value={codigo}
              onChangeText={v => { setCodigo(v.toUpperCase()); setMsgOk(''); setMsgErr(''); }}
              autoCapitalize="characters"
            />
          </View>
          <TouchableOpacity
            style={[s.btn, (!codigo.trim() || loading) && s.btnOff]}
            onPress={validar}
            disabled={!codigo.trim() || loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#FFF" size="small" />
              : <Text style={s.btnText}>Validar cupón</Text>
            }
          </TouchableOpacity>

          {msgOk ? (
            <View style={s.msgOk}>
              <Ionicons name="checkmark-circle" size={18} color={TEAL} />
              <Text style={s.msgOkText}>{msgOk}</Text>
            </View>
          ) : null}
          {msgErr ? (
            <View style={s.msgErr}>
              <Ionicons name="close-circle" size={18} color={ERR} />
              <Text style={s.msgErrText}>{msgErr}</Text>
            </View>
          ) : null}
        </View>

        <Text style={s.sectionTitle}>Mis cupones disponibles</Text>

        {loadingCupones ? (
          <ActivityIndicator color={TEAL} style={{ marginTop: 24 }} />
        ) : cupones.length === 0 ? (
          <View style={s.emptyBox}>
            <Ionicons name="ticket-outline" size={40} color="#B0BEBE" />
            <Text style={s.emptyText}>No tienes cupones disponibles</Text>
          </View>
        ) : (
          cupones.map(c => (
            <View key={c.id} style={s.cuponCard}>
              <View style={s.cuponIconBox}>
                <Ionicons name="ticket" size={24} color={TEAL} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.cuponCodigo}>{c.codigo}</Text>
                <Text style={s.cuponValor}>{labelCupon(c)}</Text>
                <Text style={s.cuponMotivo}>{motivoCupon(c)}</Text>
              </View>
            </View>
          ))
        )}

        <View style={{ height: 32 }} />
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

  card:      { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, marginBottom: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: TEAL, marginBottom: 14 },
  inputRow:  { marginBottom: 12 },
  input:     { backgroundColor: CARD_BG, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, fontWeight: '700', color: '#1A2E2E', borderWidth: 1.5, borderColor: CARD_BORDER },
  btn:       { backgroundColor: TEAL, borderRadius: 50, paddingVertical: 16, alignItems: 'center' },
  btnOff:    { backgroundColor: '#B0BEBE' },
  btnText:   { color: '#FFFFFF', fontWeight: '900', fontSize: 15 },

  msgOk:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  msgOkText: { fontSize: 14, fontWeight: '600', color: TEAL, flex: 1 },
  msgErr:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  msgErrText:{ fontSize: 14, fontWeight: '600', color: ERR, flex: 1 },

  sectionTitle: { fontSize: 16, fontWeight: '800', color: TEAL, marginBottom: 12 },

  emptyBox:  { alignItems: 'center', paddingVertical: 32, gap: 12 },
  emptyText: { fontSize: 14, color: '#8A9FA0' },

  cuponCard:    { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: CARD_BG, borderRadius: 18, padding: 16, marginBottom: 10, borderWidth: 1.5, borderColor: CARD_BORDER },
  cuponIconBox: { width: 48, height: 48, borderRadius: 16, backgroundColor: '#E8F2F2', alignItems: 'center', justifyContent: 'center' },
  cuponCodigo:  { fontSize: 15, fontWeight: '800', color: TEAL, letterSpacing: 0.5 },
  cuponValor:   { fontSize: 13, fontWeight: '700', color: '#1A2E2E', marginTop: 2 },
  cuponMotivo:  { fontSize: 12, color: '#6A8080', marginTop: 2 },
});
