import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  ActivityIndicator, RefreshControl, TextInput, Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { resenasAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { volver } from '@/src/utils/backNavigation';
import {
  estrellas, fechaGT, largoTexto, validarRespuesta, MAX_TEXTO_RESENA,
} from '@/src/utils/liquidacionesResenas';

type Resena = {
  id: string;
  pedido_id: string | null;
  calificacion: number;
  comentario: string | null;
  respuesta_restaurante: string | null;
  respondida_en: string | null;
  visible: boolean | null;
  created_at: string;
  usuarios?: { nombre?: string } | null;
};

export default function ResenasRestauranteScreen() {
  const router = useRouter();
  const [resenas, setResenas] = useState<Resena[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errorRespuesta, setErrorRespuesta] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await resenasAPI.restaurante();
      setResenas(res.data || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar tus reseñas');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  function abrirEditor(r: Resena) {
    setEditando(r.id);
    setTexto(r.respuesta_restaurante || '');
    setErrorRespuesta(null);
  }

  async function guardarRespuesta(r: Resena) {
    const invalido = validarRespuesta(texto);
    if (invalido) { setErrorRespuesta(invalido); return; }
    setGuardando(true);
    setErrorRespuesta(null);
    try {
      const { data } = await resenasAPI.responder(r.id, texto.trim());
      setResenas((lista) => lista.map((x) => (x.id === r.id ? { ...x, ...data } : x)));
      setEditando(null);
      setTexto('');
    } catch (e: any) {
      // Alert no se ve en web: el error también queda bajo el campo.
      setErrorRespuesta(e?.message || 'No se pudo guardar la respuesta');
      Alert.alert('Respuesta', e?.message || 'No se pudo guardar la respuesta');
    } finally {
      setGuardando(false);
    }
  }

  const visibles = resenas.filter((r) => r.visible !== false);
  const promedio = visibles.length
    ? visibles.reduce((s, r) => s + r.calificacion, 0) / visibles.length
    : null;
  const sinResponder = visibles.filter((r) => !r.respuesta_restaurante).length;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => volver(router, '/restaurante/perfil')} style={s.back} accessibilityLabel="Volver">
          <Text style={s.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>⭐ Reseñas</Text>
      </View>

      {loading ? (
        <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
        >
          {error ? (
            <View style={s.empty}>
              <Text style={[s.emptyText, { color: Colors.error }]}>{error}</Text>
              <TouchableOpacity onPress={() => { setLoading(true); cargar(); }}>
                <Text style={s.link}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : resenas.length === 0 ? (
            <View style={s.empty}>
              <Text style={{ fontSize: 40, marginBottom: 8 }}>💬</Text>
              <Text style={s.emptyTitle}>Aún no tienes reseñas</Text>
              <Text style={s.emptyText}>Tus clientes podrán calificarte después de recoger su pedido.</Text>
            </View>
          ) : (
            <>
              <View style={s.resumen}>
                <View style={s.resumenItem}>
                  <Text style={s.resumenVal}>{promedio != null ? promedio.toFixed(1) : '–'}</Text>
                  <Text style={s.resumenLabel}>Promedio</Text>
                </View>
                <View style={s.resumenItem}>
                  <Text style={s.resumenVal}>{visibles.length}</Text>
                  <Text style={s.resumenLabel}>Públicas</Text>
                </View>
                <View style={s.resumenItem}>
                  <Text style={[s.resumenVal, sinResponder > 0 && { color: Colors.orange }]}>{sinResponder}</Text>
                  <Text style={s.resumenLabel}>Sin responder</Text>
                </View>
              </View>

              {resenas.map((r) => (
                <View key={r.id} style={[s.card, r.visible === false && s.cardOculta]}>
                  <View style={s.cardTop}>
                    <Text style={s.cliente}>{r.usuarios?.nombre || 'Cliente'}</Text>
                    <Text style={s.estrellas}>{estrellas(r.calificacion)}</Text>
                  </View>
                  <View style={s.badges}>
                    {!!r.pedido_id && <Text style={s.badgeVerificada}>✓ Compra verificada</Text>}
                    {r.visible === false && <Text style={s.badgeOculta}>Oculta por moderación</Text>}
                  </View>
                  {!!r.comentario && <Text style={s.comentario}>{r.comentario}</Text>}
                  <Text style={s.fecha}>{fechaGT(r.created_at)}</Text>

                  {editando === r.id ? (
                    <View style={s.editor}>
                      <TextInput
                        style={s.input}
                        value={texto}
                        onChangeText={(v) => { setTexto(v); setErrorRespuesta(null); }}
                        placeholder="Agradece o aclara la experiencia del cliente…"
                        placeholderTextColor={Colors.textLight}
                        multiline
                        textAlignVertical="top"
                        autoFocus
                      />
                      <Text style={[s.contador, largoTexto(texto.trim()) > MAX_TEXTO_RESENA && { color: Colors.error }]}>
                        {largoTexto(texto.trim())}/{MAX_TEXTO_RESENA}
                      </Text>
                      {!!errorRespuesta && <Text style={s.error}>{errorRespuesta}</Text>}
                      <View style={s.editorBotones}>
                        <TouchableOpacity style={s.btnSecundario} onPress={() => setEditando(null)} disabled={guardando}>
                          <Text style={s.btnSecundarioText}>Cancelar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[s.btnPrimario, guardando && { opacity: 0.6 }]} onPress={() => guardarRespuesta(r)} disabled={guardando}>
                          {guardando
                            ? <ActivityIndicator size="small" color={Colors.white} />
                            : <Text style={s.btnPrimarioText}>Publicar respuesta</Text>}
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : r.respuesta_restaurante ? (
                    <View style={s.respuesta}>
                      <Text style={s.respuestaLabel}>Tu respuesta · {fechaGT(r.respondida_en)}</Text>
                      <Text style={s.respuestaTexto}>{r.respuesta_restaurante}</Text>
                      <TouchableOpacity onPress={() => abrirEditor(r)}>
                        <Text style={s.link}>Editar respuesta</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity style={s.btnResponder} onPress={() => abrirEditor(r)} disabled={editando !== null}>
                      <Text style={s.btnResponderText}>💬 Responder</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  back: { paddingRight: 6, paddingVertical: 2 },
  backText: { fontSize: 30, lineHeight: 30, color: Colors.brown, fontWeight: '700' },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scroll: { padding: 16 },
  empty: { backgroundColor: Colors.white, borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1.5, borderColor: Colors.border },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 13, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  resumen: { flexDirection: 'row', backgroundColor: Colors.brown, borderRadius: 16, padding: 16, marginBottom: 14 },
  resumenItem: { flex: 1, alignItems: 'center' },
  resumenVal: { fontSize: 22, fontWeight: '900', color: Colors.white },
  resumenLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2, fontWeight: '600' },
  card: { backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: Colors.border },
  cardOculta: { opacity: 0.7, borderStyle: 'dashed' },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cliente: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary, flex: 1 },
  estrellas: { fontSize: 14, color: '#FF9800', letterSpacing: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  badgeVerificada: { fontSize: 11, fontWeight: '700', color: '#065F46', backgroundColor: '#D1FAE5', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  badgeOculta: { fontSize: 11, fontWeight: '700', color: '#6B7280', backgroundColor: '#F3F4F6', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  comentario: { fontSize: 13, color: Colors.textPrimary, lineHeight: 20, marginTop: 8 },
  fecha: { fontSize: 11, color: Colors.textLight, marginTop: 6 },
  respuesta: { marginTop: 10, backgroundColor: Colors.surface, borderRadius: 10, padding: 10, borderLeftWidth: 3, borderLeftColor: Colors.orange },
  respuestaLabel: { fontSize: 11, fontWeight: '800', color: Colors.textSecondary, marginBottom: 4 },
  respuestaTexto: { fontSize: 13, color: Colors.textPrimary, lineHeight: 19 },
  link: { fontSize: 13, fontWeight: '800', color: Colors.orange, marginTop: 8 },
  btnResponder: { marginTop: 10, borderWidth: 1.5, borderColor: Colors.brown, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  btnResponderText: { color: Colors.brown, fontWeight: '800', fontSize: 13 },
  editor: { marginTop: 10 },
  input: { minHeight: 90, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 10, padding: 10, fontSize: 14, color: Colors.textPrimary, backgroundColor: Colors.white },
  contador: { fontSize: 11, color: Colors.textLight, textAlign: 'right', marginTop: 4 },
  error: { fontSize: 12, color: Colors.error, marginTop: 4 },
  editorBotones: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btnSecundario: { flex: 1, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnSecundarioText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 13 },
  btnPrimario: { flex: 2, backgroundColor: Colors.brown, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnPrimarioText: { color: Colors.white, fontWeight: '800', fontSize: 13 },
});
