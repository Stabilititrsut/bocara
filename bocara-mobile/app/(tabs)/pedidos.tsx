import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { pedidosAPI, resenasAPI } from '@/src/services/api';
import { Pedido } from '@/src/types';
import { Colors } from '@/constants/Colors';

const ESTADO_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  pendiente:  { label: 'Pendiente',          color: '#FF9800',         bg: '#FFF3E0', icon: 'time-outline' },
  confirmado: { label: 'Confirmado',          color: Colors.primary,    bg: Colors.accentLight, icon: 'checkmark-circle-outline' },
  listo:      { label: 'Listo para recoger', color: Colors.accent,     bg: Colors.accentLight, icon: 'storefront-outline' },
  recogido:   { label: 'Recogido',           color: Colors.textSecondary, bg: Colors.surface, icon: 'bag-check-outline' },
  cancelado:  { label: 'Cancelado',          color: Colors.error,      bg: Colors.errorLight, icon: 'close-circle-outline' },
};

const RESENAS_KEY = 'bocara_resenas_enviadas';

interface ResenaState {
  visible: boolean;
  pedido: Pedido | null;
  calificacion: number;
  comentario: string;
  enviando: boolean;
}

function PedidoCard({ pedido, yaReseno, onResena }: { pedido: Pedido; yaReseno: boolean; onResena: (p: Pedido) => void }) {
  const estado = ESTADO_CONFIG[pedido.estado] || ESTADO_CONFIG.pendiente;
  const activo = pedido.estado === 'confirmado' || pedido.estado === 'listo';

  return (
    <View style={[s.card, activo && { borderLeftColor: Colors.primary, borderLeftWidth: 3 }]}>
      <View style={s.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardNegocio} numberOfLines={1}>{pedido.negocios?.nombre}</Text>
          <Text style={s.cardNombre} numberOfLines={1}>{pedido.bolsas?.nombre}</Text>
        </View>
        <View style={[s.estadoBadge, { backgroundColor: estado.bg }]}>
          <Ionicons name={estado.icon as any} size={13} color={estado.color} />
          <Text style={[s.estadoText, { color: estado.color }]}>{estado.label}</Text>
        </View>
      </View>

      <View style={s.infoRow}>
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Total</Text>
          <Text style={s.infoVal}>Q{pedido.total?.toFixed(2)}</Text>
        </View>
        <View style={s.infoDivider} />
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Entrega</Text>
          <Text style={s.infoVal}>{pedido.tipo_entrega === 'recogida' ? 'Recogida' : 'Envío'}</Text>
        </View>
        <View style={s.infoDivider} />
        <View style={s.infoItem}>
          <Text style={s.infoLabel}>Fecha</Text>
          <Text style={s.infoVal}>{new Date(pedido.created_at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}</Text>
        </View>
      </View>

      {pedido.tipo_entrega === 'recogida' && (pedido.estado === 'confirmado' || pedido.estado === 'listo') && (
        <View style={[s.codigoBox, pedido.estado === 'listo' && s.codigoBoxListo]}>
          <Text style={s.codigoLabel}>{pedido.estado === 'listo' ? '¡Tu bolsa está lista!' : 'Código de recogida'}</Text>
          <Text style={s.codigo}>{pedido.codigo_recogida}</Text>
          <View style={s.codigoHoraRow}>
            <Ionicons name="time-outline" size={13} color={pedido.estado === 'listo' ? Colors.white : Colors.textSecondary} />
            <Text style={[s.codigoHora, pedido.estado === 'listo' && { color: 'rgba(255,255,255,0.8)' }]}>
              {pedido.hora_recogida_inicio?.slice(0, 5)} – {pedido.hora_recogida_fin?.slice(0, 5)}
            </Text>
          </View>
        </View>
      )}

      {pedido.estado === 'recogido' && !yaReseno && (
        <TouchableOpacity style={s.btnResena} onPress={() => onResena(pedido)}>
          <Ionicons name="star-outline" size={15} color={Colors.primary} />
          <Text style={s.btnResenaText}>Dejar reseña</Text>
        </TouchableOpacity>
      )}
      {pedido.estado === 'recogido' && yaReseno && (
        <View style={s.resenaEnviada}>
          <Ionicons name="checkmark-circle" size={15} color={Colors.primary} />
          <Text style={s.resenaEnviadaText}>Reseña enviada</Text>
        </View>
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
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>Dejar reseña</Text>
          <Text style={s.modalSub}>{state.pedido?.negocios?.nombre}</Text>
          <View style={s.estrellas}>
            {[1, 2, 3, 4, 5].map((n) => (
              <TouchableOpacity key={n} onPress={() => onChange('calificacion', n)} style={s.estrellaBtn}>
                <Ionicons name={n <= state.calificacion ? 'star' : 'star-outline'} size={36} color={n <= state.calificacion ? '#FF9800' : Colors.border} />
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
            multiline numberOfLines={4} textAlignVertical="top"
          />
          <TouchableOpacity style={[s.btnEnviar, state.enviando && s.btnDisabled]} onPress={onEnviar} disabled={state.enviando}>
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
  const [resenasEnviadas, setResenasEnviadas] = useState<Set<string>>(new Set());
  const [resena, setResena] = useState<ResenaState>({ visible: false, pedido: null, calificacion: 5, comentario: '', enviando: false });
  const pollingRef = useRef<any>(null);

  useEffect(() => {
    AsyncStorage.getItem(RESENAS_KEY).then((val) => {
      if (val) setResenasEnviadas(new Set(JSON.parse(val)));
    });
  }, []);

  const cargar = useCallback(async () => {
    try {
      const res = await pedidosAPI.listar();
      setPedidos(res.data || []);
    } catch { setPedidos([]); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => {
    const tieneActivos = pedidos.some(p => p.estado === 'confirmado' || p.estado === 'listo' || p.estado === 'pendiente');
    if (tieneActivos) {
      pollingRef.current = setInterval(cargar, 10000);
    } else {
      clearInterval(pollingRef.current);
    }
    return () => clearInterval(pollingRef.current);
  }, [pedidos, cargar]);

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
      const nuevas = new Set([...resenasEnviadas, resena.pedido.id]);
      setResenasEnviadas(nuevas);
      await AsyncStorage.setItem(RESENAS_KEY, JSON.stringify([...nuevas]));
      setResena({ visible: false, pedido: null, calificacion: 5, comentario: '', enviando: false });
      Alert.alert('¡Gracias!', 'Tu reseña fue enviada 🌟');
    } catch (e: any) {
      setResena((r) => ({ ...r, enviando: false }));
      Alert.alert('Error', e.message || 'No se pudo enviar la reseña');
    }
  }

  if (loading) return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>Mis pedidos</Text></View>
      <View style={s.loadingBox}><ActivityIndicator color={Colors.primary} size="large" /></View>
    </SafeAreaView>
  );

  const activos = pedidos.filter(p => p.estado === 'confirmado' || p.estado === 'listo');
  const historial = pedidos.filter(p => p.estado === 'recogido' || p.estado === 'cancelado');
  const pendientes = pedidos.filter(p => p.estado === 'pendiente');

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mis pedidos</Text>
        {activos.length > 0 && (
          <View style={s.activoBadge}>
            <View style={s.activoDot} />
            <Text style={s.activoBadgeText}>{activos.length} activo{activos.length > 1 ? 's' : ''}</Text>
          </View>
        )}
      </View>

      {pedidos.length === 0 ? (
        <View style={s.empty}>
          <View style={s.emptyIconWrap}>
            <Ionicons name="receipt-outline" size={40} color={Colors.textLight} />
          </View>
          <Text style={s.emptyTitle}>Sin pedidos aún</Text>
          <Text style={s.emptyText}>Tus pedidos aparecerán aquí una vez que hagas tu primera compra</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {activos.length > 0 && (
            <>
              <Text style={s.seccionLabel}>En curso</Text>
              {activos.map((p) => <PedidoCard key={p.id} pedido={p} yaReseno={resenasEnviadas.has(p.id)} onResena={(pd) => setResena({ visible: true, pedido: pd, calificacion: 5, comentario: '', enviando: false })} />)}
            </>
          )}
          {pendientes.length > 0 && (
            <>
              <Text style={s.seccionLabel}>Pendientes</Text>
              {pendientes.map((p) => <PedidoCard key={p.id} pedido={p} yaReseno={false} onResena={(pd) => setResena({ visible: true, pedido: pd, calificacion: 5, comentario: '', enviando: false })} />)}
            </>
          )}
          {historial.length > 0 && (
            <>
              <Text style={s.seccionLabel}>Historial</Text>
              {historial.map((p) => <PedidoCard key={p.id} pedido={p} yaReseno={resenasEnviadas.has(p.id)} onResena={(pd) => setResena({ visible: true, pedido: pd, calificacion: 5, comentario: '', enviando: false })} />)}
            </>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      )}

      <ResenaModal
        state={resena}
        onClose={() => setResena((r) => ({ ...r, visible: false }))}
        onEnviar={enviarResena}
        onChange={(k, v) => setResena((r) => ({ ...r, [k]: v }))}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loadingBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 10 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary, flex: 1 },
  activoBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: Colors.accentLight, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  activoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.primary },
  activoBadgeText: { color: Colors.primary, fontWeight: '700', fontSize: 12 },

  scroll: { padding: 16 },
  seccionLabel: { fontSize: 12, fontWeight: '800', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12, marginTop: 4 },

  card: { backgroundColor: Colors.white, borderRadius: 20, padding: 16, marginBottom: 14, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  cardNegocio: { fontSize: 11, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  cardNombre: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary, maxWidth: 190 },
  estadoBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  estadoText: { fontSize: 12, fontWeight: '700' },

  infoRow: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: 14, padding: 14, marginBottom: 12, alignItems: 'center' },
  infoItem: { flex: 1, alignItems: 'center' },
  infoDivider: { width: 1, height: 32, backgroundColor: Colors.border },
  infoLabel: { fontSize: 10, color: Colors.textLight, fontWeight: '600', marginBottom: 4 },
  infoVal: { fontSize: 13, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },

  codigoBox: { backgroundColor: Colors.surface, borderRadius: 16, padding: 16, alignItems: 'center' },
  codigoBoxListo: { backgroundColor: Colors.primary },
  codigoLabel: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', marginBottom: 6 },
  codigo: { fontSize: 30, fontWeight: '900', color: Colors.textPrimary, letterSpacing: 4 },
  codigoHoraRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  codigoHora: { fontSize: 12, color: Colors.textSecondary },

  btnResena: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1.5, borderColor: Colors.primary, borderRadius: 14, padding: 10, marginTop: 10 },
  btnResenaText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  resenaEnviada: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: Colors.accentLight, borderRadius: 14, padding: 10, marginTop: 10 },
  resenaEnviadaText: { color: Colors.primary, fontWeight: '600', fontSize: 12 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 32 },
  emptyIconWrap: { width: 90, height: 90, borderRadius: 45, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: Colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: '900', color: Colors.textPrimary, textAlign: 'center' },
  modalSub: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 24 },
  estrellas: { flexDirection: 'row', justifyContent: 'center', gap: 4, marginBottom: 6 },
  estrellaBtn: { padding: 4 },
  estrellaLabel: { textAlign: 'center', fontSize: 13, color: Colors.textSecondary, fontWeight: '600', marginBottom: 20 },
  comentarioInput: { backgroundColor: Colors.surface, borderRadius: 14, padding: 14, fontSize: 14, color: Colors.textPrimary, height: 100, marginBottom: 16 },
  btnEnviar: { backgroundColor: Colors.primary, borderRadius: 16, padding: 16, alignItems: 'center', marginBottom: 10 },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnEnviarText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnCancelar: { alignItems: 'center', padding: 10 },
  btnCancelarText: { color: Colors.textSecondary, fontSize: 14, fontWeight: '500' },
});
