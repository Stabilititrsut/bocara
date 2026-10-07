import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  ActivityIndicator, TextInput, RefreshControl, Modal,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { estrellas, fechaGT, validarMotivoOcultar } from '@/src/utils/liquidacionesResenas';

const DARK = '#1E293B';
const DARK2 = '#0F172A';
const BORDER = '#334155';
const TEXT2 = '#94A3B8';

type Filtro = 'todas' | 'visibles' | 'ocultas';
const FILTROS: { key: Filtro; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'visibles', label: 'Públicas' },
  { key: 'ocultas', label: 'Ocultas' },
];

type Resena = {
  id: string;
  pedido_id: string | null;
  calificacion: number;
  comentario: string | null;
  respuesta_restaurante: string | null;
  visible: boolean | null;
  motivo_moderacion: string | null;
  moderada_en: string | null;
  created_at: string;
  usuarios?: { nombre?: string } | null;
  negocios?: { nombre?: string } | null;
};

// Moderación de reseñas: ocultar exige motivo (queda en auditoría con quién y
// cuándo). El promedio del negocio lo recalcula la base al cambiar `visible`.
export default function AdminResenasScreen() {
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [items, setItems] = useState<Resena[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [modalOcultar, setModalOcultar] = useState<Resena | null>(null);
  const [motivo, setMotivo] = useState('');
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  const cargar = useCallback(async (f: Filtro) => {
    try {
      const visible = f === 'visibles' ? 'true' : f === 'ocultas' ? 'false' : undefined;
      const res = await adminAPI.resenas(visible ? { visible } : undefined);
      setItems(res.data || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar las reseñas');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { setLoading(true); cargar(filtro); }, [filtro, cargar]);

  async function moderar(r: Resena, visible: boolean, motivoTexto?: string) {
    setProcesando(r.id);
    try {
      const { data } = await adminAPI.moderarResena(r.id, { visible, motivo: motivoTexto });
      setItems((lista) => {
        const actualizada = lista.map((x) => (x.id === r.id ? { ...x, ...data } : x));
        // Si el filtro activo ya no la incluye, sale de la lista.
        if (filtro === 'visibles') return actualizada.filter((x) => x.visible !== false);
        if (filtro === 'ocultas') return actualizada.filter((x) => x.visible === false);
        return actualizada;
      });
      showToast(visible ? 'Reseña visible de nuevo' : 'Reseña ocultada');
      return true;
    } catch (e: any) {
      showToast(e?.message || 'No se pudo moderar la reseña', false);
      return false;
    } finally {
      setProcesando(null);
    }
  }

  async function confirmarOcultar() {
    if (!modalOcultar) return;
    const invalido = validarMotivoOcultar(motivo);
    if (invalido) { setErrorMotivo(invalido); return; }
    const ok = await moderar(modalOcultar, false, motivo.trim());
    if (ok) { setModalOcultar(null); setMotivo(''); }
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>COMUNIDAD · BOCARA</Text>
          <Text style={s.headerTitle}>Reseñas</Text>
        </View>
        <Text style={s.headerCount}>{items.length}</Text>
      </View>

      <View style={s.filtros}>
        {FILTROS.map(({ key, label }) => (
          <TouchableOpacity key={key} style={[s.filtro, filtro === key && s.filtroActivo]} onPress={() => setFiltro(key)}>
            <Text style={[s.filtroText, filtro === key && s.filtroTextActivo]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {toast && (
        <View style={[s.toast, { backgroundColor: toast.ok ? '#065F46' : '#7F1D1D' }]}>
          <Text style={s.toastText}>{toast.msg}</Text>
        </View>
      )}

      {loading ? (
        <View style={s.center}><ActivityIndicator color={Colors.gold} size="large" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(filtro); }} tintColor={Colors.gold} />}
        >
          {error ? (
            <View style={s.empty}>
              <Text style={[s.emptySub, { color: '#FCA5A5' }]}>{error}</Text>
              <TouchableOpacity onPress={() => { setLoading(true); cargar(filtro); }}>
                <Text style={s.link}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : items.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 40 }}>💬</Text>
              <Text style={s.emptyTitle}>Sin reseñas</Text>
              <Text style={s.emptySub}>No hay reseñas en este filtro.</Text>
            </View>
          ) : items.map((r) => {
            const oculta = r.visible === false;
            return (
              <View key={r.id} style={[s.card, oculta && s.cardOculta]}>
                <View style={s.cardTop}>
                  <Text style={s.negocio} numberOfLines={1}>{r.negocios?.nombre || 'Negocio'}</Text>
                  <Text style={s.estrellas}>{estrellas(r.calificacion)}</Text>
                </View>
                <Text style={s.meta}>
                  {r.usuarios?.nombre || 'Cliente'} · {fechaGT(r.created_at)}{r.pedido_id ? ' · ✓ compra verificada' : ''}
                </Text>
                {r.comentario
                  ? <Text style={s.comentario}>{r.comentario}</Text>
                  : <Text style={[s.comentario, { color: TEXT2, fontStyle: 'italic' }]}>Sin comentario</Text>}
                {!!r.respuesta_restaurante && (
                  <View style={s.respuesta}>
                    <Text style={s.respuestaLabel}>Respuesta del comercio</Text>
                    <Text style={s.respuestaTexto}>{r.respuesta_restaurante}</Text>
                  </View>
                )}
                {oculta && (
                  <Text style={s.motivo}>
                    Oculta{r.moderada_en ? ` el ${fechaGT(r.moderada_en)}` : ''}{r.motivo_moderacion ? ` — ${r.motivo_moderacion}` : ''}
                  </Text>
                )}
                <TouchableOpacity
                  style={[oculta ? s.btnMostrar : s.btnOcultar, procesando === r.id && { opacity: 0.6 }]}
                  disabled={procesando !== null}
                  onPress={() => (oculta ? moderar(r, true) : (setModalOcultar(r), setMotivo(''), setErrorMotivo(null)))}
                >
                  {procesando === r.id
                    ? <ActivityIndicator size="small" color="#FFFFFF" />
                    : <Text style={s.btnText}>{oculta ? '👁 Volver a mostrar' : '🚫 Ocultar'}</Text>}
                </TouchableOpacity>
              </View>
            );
          })}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      <Modal visible={!!modalOcultar} transparent animationType="fade" onRequestClose={() => setModalOcultar(null)}>
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Ocultar reseña</Text>
            <Text style={s.modalSub}>
              {modalOcultar?.negocios?.nombre} · {estrellas(modalOcultar?.calificacion || 0)}
            </Text>
            <Text style={s.modalLabel}>Motivo (queda en auditoría)</Text>
            <TextInput
              style={s.input}
              value={motivo}
              onChangeText={(v) => { setMotivo(v); setErrorMotivo(null); }}
              placeholder="Ej. lenguaje ofensivo, spam, datos personales…"
              placeholderTextColor="#64748B"
              multiline
              textAlignVertical="top"
            />
            {!!errorMotivo && <Text style={s.errorMotivo}>{errorMotivo}</Text>}
            <View style={s.modalBotones}>
              <TouchableOpacity style={s.btnCancelar} onPress={() => setModalOcultar(null)} disabled={procesando !== null}>
                <Text style={s.btnCancelarText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btnConfirmar, procesando !== null && { opacity: 0.6 }]} onPress={confirmarOcultar} disabled={procesando !== null}>
                <Text style={s.btnText}>Ocultar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK2 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  headerCount: { fontSize: 22, fontWeight: '900', color: Colors.gold },
  filtros: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: BORDER },
  filtro: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: BORDER },
  filtroActivo: { backgroundColor: Colors.gold, borderColor: Colors.gold },
  filtroText: { fontSize: 13, fontWeight: '700', color: TEXT2 },
  filtroTextActivo: { color: DARK2 },
  toast: { marginHorizontal: 16, marginTop: 10, borderRadius: 10, padding: 10 },
  toastText: { color: Colors.white, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  scroll: { padding: 16 },
  empty: { alignItems: 'center', padding: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: Colors.white, marginTop: 8 },
  emptySub: { fontSize: 13, color: TEXT2, marginTop: 4, textAlign: 'center' },
  link: { fontSize: 13, fontWeight: '800', color: Colors.gold, marginTop: 10 },
  card: { backgroundColor: DARK, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: BORDER },
  cardOculta: { borderStyle: 'dashed', opacity: 0.8 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  negocio: { flex: 1, fontSize: 14, fontWeight: '800', color: Colors.white },
  estrellas: { fontSize: 14, color: '#FBBF24', letterSpacing: 1 },
  meta: { fontSize: 11, color: TEXT2, marginTop: 4 },
  comentario: { fontSize: 13, color: '#E2E8F0', lineHeight: 19, marginTop: 8 },
  respuesta: { marginTop: 8, backgroundColor: DARK2, borderRadius: 8, padding: 8, borderLeftWidth: 3, borderLeftColor: Colors.gold },
  respuestaLabel: { fontSize: 10, fontWeight: '800', color: TEXT2, marginBottom: 2 },
  respuestaTexto: { fontSize: 12, color: '#CBD5E1', lineHeight: 17 },
  motivo: { fontSize: 12, color: '#FCA5A5', marginTop: 8 },
  btnOcultar: { marginTop: 10, backgroundColor: '#7F1D1D', borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  btnMostrar: { marginTop: 10, backgroundColor: '#065F46', borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 13 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: DARK, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: BORDER, maxWidth: 480, width: '100%', alignSelf: 'center' },
  modalTitle: { fontSize: 17, fontWeight: '900', color: Colors.white },
  modalSub: { fontSize: 12, color: TEXT2, marginTop: 4 },
  modalLabel: { fontSize: 12, fontWeight: '700', color: TEXT2, marginTop: 14, marginBottom: 6 },
  input: { minHeight: 80, borderWidth: 1, borderColor: BORDER, borderRadius: 10, padding: 10, color: Colors.white, backgroundColor: DARK2, fontSize: 14 },
  errorMotivo: { fontSize: 12, color: '#FCA5A5', marginTop: 6 },
  modalBotones: { flexDirection: 'row', gap: 8, marginTop: 14 },
  btnCancelar: { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnCancelarText: { color: TEXT2, fontWeight: '700', fontSize: 13 },
  btnConfirmar: { flex: 1, backgroundColor: '#7F1D1D', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
});
