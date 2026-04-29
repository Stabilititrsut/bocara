import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { pedidosAPI, resenasAPI } from '@/src/services/api';
import { Pedido } from '@/src/types';
import { Colors } from '@/constants/Colors';

const ESTADO_CONFIG: Record<string, { label: string; color: string; emoji: string }> = {
  pendiente: { label: 'Pendiente', color: Colors.textLight, emoji: '⏳' },
  confirmado: { label: 'Confirmado', color: Colors.orange, emoji: '✅' },
  listo: { label: 'Listo para recoger', color: Colors.green, emoji: '🔔' },
  recogido: { label: 'Recogido', color: Colors.textSecondary, emoji: '🎉' },
  cancelado: { label: 'Cancelado', color: Colors.error, emoji: '❌' },
};

interface ResenaState {
  visible: boolean;
  pedido: Pedido | null;
  calificacion: number;
  comentario: string;
  enviando: boolean;
}

function PedidoCard({ pedido, onResena }: { pedido: Pedido; onResena: (p: Pedido) => void }) {
  const estado = ESTADO_CONFIG[pedido.estado] || ESTADO_CONFIG.pendiente;
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View>
          <Text style={s.cardNegocio}>{pedido.negocios?.nombre}</Text>
          <Text style={s.cardNombre}>{pedido.bolsas?.nombre}</Text>
        </View>
        <View style={[s.estadoBadge, { backgroundColor: estado.color + '20' }]}>
          <Text style={[s.estadoText, { color: estado.color }]}>{estado.emoji} {estado.label}</Text>
        </View>
      </View>

      <View style={s.infoRow}>
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Total</Text>
          <Text style={s.infoVal}>Q{pedido.total?.toFixed(2)}</Text>
        </View>
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Tipo</Text>
          <Text style={s.infoVal}>{pedido.tipo_entrega === 'recogida' ? '🏪 Recogida' : '🏍️ Envío'}</Text>
        </View>
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Fecha</Text>
          <Text style={s.infoVal}>{new Date(pedido.created_at).toLocaleDateString('es-GT')}</Text>
        </View>
      </View>

      {pedido.tipo_entrega === 'recogida' && pedido.estado === 'confirmado' && (
        <View style={s.codigoBox}>
          <Text style={s.codigoLabel}>Código de recogida</Text>
          <Text style={s.codigo}>{pedido.codigo_recogida}</Text>
          <Text style={s.codigoHora}>⏰ {pedido.hora_recogida_inicio?.slice(0, 5)} - {pedido.hora_recogida_fin?.slice(0, 5)}</Text>
        </View>
      )}

      {pedido.estado === 'recogido' && (
        <TouchableOpacity style={s.btnResena} onPress={() => onResena(pedido)}>
          <Text style={s.btnResenaText}>⭐ Dejar reseña</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function ResenaModal({ state, onClose, onEnviar, onChange }: {
  state: ResenaState;
  onClose: () => void;
  onEnviar: () => void;
  onChange: (key: 'calificacion' | 'comentario', val: any) => void;
}) {
  return (
    <Modal visible={state.visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>⭐ Dejar reseña</Text>
          <Text style={s.modalSub}>{state.pedido?.negocios?.nombre}</Text>

          {/* Estrellas */}
          <View style={s.estrellas}>
            {[1, 2, 3, 4, 5].map((n) => (
              <TouchableOpacity key={n} onPress={() => onChange('calificacion', n)}>
                <Text style={[s.estrella, n <= state.calificacion && s.estrellaActive]}>★</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.estrellaLabel}>{['', 'Muy malo', 'Malo', 'Regular', 'Bueno', 'Excelente'][state.calificacion]}</Text>

          <TextInput
            style={s.comentarioInput}
            placeholder="Cuéntanos tu experiencia (opcional)..."
            placeholderTextColor={Colors.textLight}
            value={state.comentario}
            onChangeText={(v) => onChange('comentario', v)}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[s.btnEnviar, state.enviando && s.btnDisabled]}
            onPress={onEnviar}
            disabled={state.enviando}
          >
            <Text style={s.btnEnviarText}>{state.enviando ? 'Enviando...' : 'Enviar reseña'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.btnCancelar} onPress={onClose}>
            <Text style={s.btnCancelarText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function PedidosScreen() {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resena, setResena] = useState<ResenaState>({
    visible: false, pedido: null, calificacion: 5, comentario: '', enviando: false,
  });

  const cargar = useCallback(async () => {
    try {
      const res = await pedidosAPI.listar();
      setPedidos(res.data || []);
    } catch { setPedidos([]); } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function handleResena(pedido: Pedido) {
    setResena({ visible: true, pedido, calificacion: 5, comentario: '', enviando: false });
  }

  function handleChange(key: 'calificacion' | 'comentario', val: any) {
    setResena((r) => ({ ...r, [key]: val }));
  }

  async function enviarResena() {
    if (!resena.pedido) return;
    setResena((r) => ({ ...r, enviando: true }));
    try {
      await resenasAPI.crear({
        pedido_id: resena.pedido.id,
        negocio_id: resena.pedido.negocio_id,
        calificacion: resena.calificacion,
        comentario: resena.comentario,
      });
      setResena({ visible: false, pedido: null, calificacion: 5, comentario: '', enviando: false });
      Alert.alert('¡Gracias!', 'Tu reseña fue enviada 🌟');
    } catch (e: any) {
      setResena((r) => ({ ...r, enviando: false }));
      Alert.alert('Error', e.message);
    }
  }

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>Mis pedidos</Text></View>

      {pedidos.length === 0 ? (
        <View style={s.empty}>
          <Text style={{ fontSize: 48 }}>📦</Text>
          <Text style={s.emptyTitle}>Sin pedidos aún</Text>
          <Text style={s.emptyText}>Tus pedidos aparecerán aquí una vez que hagas tu primera compra</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {pedidos.map((p) => <PedidoCard key={p.id} pedido={p} onResena={handleResena} />)}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}

      <ResenaModal
        state={resena}
        onClose={() => setResena((r) => ({ ...r, visible: false }))}
        onEnviar={enviarResena}
        onChange={handleChange}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 20, paddingTop: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scroll: { padding: 16 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  cardNegocio: { fontSize: 11, color: Colors.textLight, fontWeight: '600', textTransform: 'uppercase' },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginTop: 2, maxWidth: 180 },
  estadoBadge: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  estadoText: { fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', backgroundColor: Colors.background, borderRadius: 10, padding: 10, marginBottom: 10 },
  infoItem: { flex: 1, alignItems: 'center' },
  infoLabel: { fontSize: 10, color: Colors.textLight, fontWeight: '600' },
  infoVal: { fontSize: 13, fontWeight: '800', color: Colors.textPrimary, marginTop: 2, textAlign: 'center' },
  codigoBox: { backgroundColor: Colors.brownLight, borderRadius: 12, padding: 14, alignItems: 'center' },
  codigoLabel: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  codigo: { fontSize: 28, fontWeight: '900', color: Colors.brown, letterSpacing: 3, marginTop: 4 },
  codigoHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  btnResena: { borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 10, padding: 10, alignItems: 'center', marginTop: 8 },
  btnResenaText: { color: Colors.orange, fontWeight: '700', fontSize: 13 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
  // Modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: Colors.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36 },
  modalTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown, textAlign: 'center' },
  modalSub: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 20 },
  estrellas: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 8 },
  estrella: { fontSize: 36, color: Colors.border },
  estrellaActive: { color: '#F5A623' },
  estrellaLabel: { textAlign: 'center', fontSize: 13, color: Colors.textSecondary, fontWeight: '600', marginBottom: 16 },
  comentarioInput: {
    backgroundColor: Colors.inputBg, borderRadius: 12, padding: 14,
    fontSize: 14, color: Colors.textPrimary, height: 100,
    marginBottom: 16, textAlignVertical: 'top',
  },
  btnEnviar: { backgroundColor: Colors.orange, borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnEnviarText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnCancelar: { alignItems: 'center', padding: 10 },
  btnCancelarText: { color: Colors.textSecondary, fontSize: 14 },
});
