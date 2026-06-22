import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, TextInput, RefreshControl, Modal,
} from 'react-native';
import { Image } from 'expo-image';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

export default function AdminContenidoScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [erroresItem, setErroresItem] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [modalRechazo, setModalRechazo] = useState<{ id: string; nombre: string } | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.contenidoPendiente();
      setItems(res.data || []);
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function aprobar(id: string, nombre: string) {
    console.log('[contenido] CLICK aprobar', { id, nombre });
    showToast(`Aprobando "${nombre}"...`);
    setProcesando(id);
    setErroresItem(prev => ({ ...prev, [id]: '' }));
    try {
      await adminAPI.aprobarBolsa(id);
      console.log('[contenido] aprobar OK:', id);
      await cargar();
      showToast(`✅ "${nombre}" aprobado y activo en Bocara`);
    } catch (e: any) {
      const mensaje = (e as any)?.response?.data?.error
        || (e as any)?.response?.data?.message
        || e?.message
        || 'Error al aprobar';
      console.error('[contenido] aprobar error:', mensaje, e);
      setErroresItem(prev => ({ ...prev, [id]: mensaje }));
      showToast(`Error: ${mensaje}`, false);
    } finally {
      setProcesando(null);
    }
  }

  async function rechazar() {
    if (!modalRechazo) return;
    const { id, nombre } = modalRechazo;
    setProcesando(id);
    setModalRechazo(null);
    setErroresItem(prev => ({ ...prev, [id]: '' }));
    console.log('[contenido] rechazar →', { id, nombre });
    try {
      await adminAPI.rechazarBolsa(id, motivoRechazo);
      console.log('[contenido] rechazar OK:', id);
      setItems(prev => prev.filter(i => i.id !== id));
      showToast(`"${nombre}" rechazado. Propietario notificado.`);
    } catch (e: any) {
      console.error('[contenido] rechazar error:', e.message);
      setErroresItem(prev => ({ ...prev, [id]: e.message || 'Error al rechazar' }));
      showToast(`Error: ${e.message}`, false);
    } finally {
      setProcesando(null);
      setMotivoRechazo('');
    }
  }

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK2 }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerSub}>PANEL DE CONTENIDO</Text>
          <Text style={s.headerTitle}>Contenido pendiente</Text>
        </View>
        <View style={s.badge}>
          <Text style={s.badgeText}>{items.length}</Text>
        </View>
      </View>

      {/* Toast global */}
      {toast && (
        <View style={[s.toast, toast.ok ? s.toastOk : s.toastErr]}>
          <Text style={s.toastText}>{toast.msg}</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); cargar(); }}
            tintColor={Colors.orange}
          />
        }
      >
        {items.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={{ fontSize: 48 }}>✅</Text>
            <Text style={s.emptyTitle}>Sin contenido pendiente</Text>
            <Text style={s.emptySub}>Todas las bolsas han sido revisadas.</Text>
          </View>
        ) : (
          items.map((item) => {
            const isBolsa = item.tipo !== 'cupon';
            const descuento = item.precio_original > 0
              ? Math.round((1 - item.precio_descuento / item.precio_original) * 100)
              : 0;

            return (
              <View key={item.id} style={s.card}>
                {/* Encabezado del card */}
                <View style={s.cardHeader}>
                  {item.imagen_url ? (
                    <Image source={{ uri: item.imagen_url }} style={s.cardImg} contentFit="cover" />
                  ) : (
                    <View style={[s.cardImg, s.cardImgPlaceholder]}>
                      <Text style={{ fontSize: 28 }}>{isBolsa ? '🥡' : '🎫'}</Text>
                    </View>
                  )}

                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Text style={s.cardNombre} numberOfLines={1}>{item.nombre}</Text>
                      <View style={s.tipoBadge}>
                        <Text style={s.tipoBadgeText}>{isBolsa ? 'TIEMPO LIM.' : 'PROMO'}</Text>
                      </View>
                    </View>
                    <Text style={s.cardRestaurante} numberOfLines={1}>
                      🏪 {item.negocios?.nombre || '—'}
                      {item.negocios?.zona ? `  ·  Zona ${item.negocios.zona}` : ''}
                    </Text>

                    {/* Precio */}
                    <View style={s.precioRow}>
                      <Text style={s.precioOriginal}>Q{item.precio_original?.toFixed(2)}</Text>
                      <Text style={s.precioDescuento}>Q{item.precio_descuento?.toFixed(2)}</Text>
                      {descuento > 0 && (
                        <View style={s.descuentoBadge}>
                          <Text style={s.descuentoBadgeText}>-{descuento}%</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>

                {/* Descripción */}
                {!!item.descripcion && (
                  <Text style={s.descripcion} numberOfLines={2}>{item.descripcion}</Text>
                )}

                {/* Horario */}
                <View style={s.metaRow}>
                  {(item.hora_recogida_inicio || item.hora_recogida_fin) && (
                    <View style={s.metaChip}>
                      <Text style={s.metaChipText}>
                        ⏰ {item.hora_recogida_inicio ?? '—'} – {item.hora_recogida_fin ?? '—'}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Clasificación marcada por el restaurante */}
                {(item.es_tiempo_limitado || item.es_promocion || item.es_descuento ||
                  item.es_destacado || item.es_mas_vendido || item.es_precio_bajo) && (
                  <View style={s.clasifRow}>
                    <Text style={s.clasifLabel}>Clasificación:</Text>
                    {item.es_tiempo_limitado && <View style={s.clasifBadge}><Text style={s.clasifBadgeTxt}>⏱️ T. Limitado</Text></View>}
                    {item.es_promocion       && <View style={s.clasifBadge}><Text style={s.clasifBadgeTxt}>🏷️ Promoción</Text></View>}
                    {item.es_descuento       && <View style={s.clasifBadge}><Text style={s.clasifBadgeTxt}>💸 Descuento</Text></View>}
                    {item.es_destacado       && <View style={[s.clasifBadge, s.clasifBadgeGold]}><Text style={s.clasifBadgeTxt}>⭐ Destacado</Text></View>}
                    {item.es_mas_vendido     && <View style={[s.clasifBadge, s.clasifBadgeGold]}><Text style={s.clasifBadgeTxt}>🔥 Más vendido</Text></View>}
                    {item.es_precio_bajo     && <View style={s.clasifBadge}><Text style={s.clasifBadgeTxt}>💰 Precio bajo</Text></View>}
                  </View>
                )}

                {/* Propietario */}
                <View style={s.propietarioRow}>
                  <Text style={s.propietarioLabel}>👤 Propietario:</Text>
                  <Text style={s.propietarioVal}>
                    {`${item.usuarios?.nombre || ''} ${item.usuarios?.apellido || ''}`.trim() || '—'}
                    {item.usuarios?.email ? `  ·  ${item.usuarios.email}` : ''}
                  </Text>
                </View>

                {/* Error inline */}
                {!!erroresItem[item.id] && (
                  <View style={s.errorCard}>
                    <Text style={s.errorText}>⚠️ {erroresItem[item.id]}</Text>
                  </View>
                )}

                {/* Acciones */}
                <View style={s.cardActions}>
                  <TouchableOpacity
                    style={[s.btnRechazar, procesando === item.id && s.btnDisabled]}
                    onPress={() => { setModalRechazo({ id: item.id, nombre: item.nombre }); setMotivoRechazo(''); }}
                    disabled={procesando === item.id}
                  >
                    {procesando === item.id
                      ? <ActivityIndicator color={Colors.error} size="small" />
                      : <Text style={s.btnRechazarText}>✕ Rechazar</Text>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.btnAprobar, procesando === item.id && s.btnDisabled]}
                    onPress={() => aprobar(item.id, item.nombre)}
                    disabled={procesando === item.id}
                  >
                    {procesando === item.id
                      ? <ActivityIndicator color={Colors.white} size="small" />
                      : <Text style={s.btnAprobarText}>✓ Aprobar</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal de rechazo */}
      <Modal visible={!!modalRechazo} transparent animationType="slide" onRequestClose={() => setModalRechazo(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar "{modalRechazo?.nombre}"</Text>
            <Text style={s.modalSub}>Escribe el motivo para notificar al propietario (opcional).</Text>
            <TextInput
              style={s.modalInput}
              placeholder="Ej: Las imágenes no cumplen con los requisitos..."
              placeholderTextColor="#64748B"
              value={motivoRechazo}
              onChangeText={setMotivoRechazo}
              multiline
              autoFocus
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelar} onPress={() => setModalRechazo(null)}>
                <Text style={s.modalCancelarText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalRechazar} onPress={rechazar}>
                <Text style={s.modalRechazarText}>Rechazar y notificar</Text>
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
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: DARK, padding: 20, borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  badge: {
    backgroundColor: Colors.orange, borderRadius: 16, minWidth: 32, height: 32,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10,
  },
  badgeText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
  scroll: { padding: 16 },
  emptyState: { alignItems: 'center', paddingVertical: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.white, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#64748B', marginTop: 6 },
  card: {
    backgroundColor: DARK, borderRadius: 16, padding: 16,
    marginBottom: 16, borderWidth: 1, borderColor: '#334155',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  cardImg: { width: 64, height: 64, borderRadius: 12 },
  cardImgPlaceholder: { backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' },
  cardNombre: { fontSize: 15, fontWeight: '900', color: Colors.white, flexShrink: 1 },
  cardRestaurante: { fontSize: 12, color: '#94A3B8', marginTop: 3 },
  tipoBadge: {
    backgroundColor: '#1A2744', borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2, alignSelf: 'flex-start',
  },
  tipoBadgeText: { fontSize: 9, color: '#94A3B8', fontWeight: '800', letterSpacing: 0.8 },
  precioRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  precioOriginal: { fontSize: 12, color: '#64748B', textDecorationLine: 'line-through' },
  precioDescuento: { fontSize: 14, fontWeight: '900', color: Colors.white },
  descuentoBadge: {
    backgroundColor: Colors.orange, borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  descuentoBadgeText: { fontSize: 10, color: Colors.white, fontWeight: '800' },
  descripcion: { fontSize: 12, color: '#94A3B8', lineHeight: 18, marginBottom: 10 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  metaChip: {
    backgroundColor: '#1A2744', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  metaChipText: { fontSize: 11, color: '#94A3B8', fontWeight: '600' },
  clasifRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginBottom: 10 },
  clasifLabel: { fontSize: 10, color: '#64748B', fontWeight: '700' },
  clasifBadge: { backgroundColor: '#1A2744', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  clasifBadgeGold: { backgroundColor: '#451A03' },
  clasifBadgeTxt: { fontSize: 10, color: '#94A3B8', fontWeight: '700' },
  propietarioRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 },
  propietarioLabel: { fontSize: 11, color: '#64748B', fontWeight: '700' },
  propietarioVal: { fontSize: 11, color: '#94A3B8', flex: 1 },
  cardActions: { flexDirection: 'row', gap: 10 },
  btnAprobar: { flex: 1, backgroundColor: Colors.green, borderRadius: 12, padding: 14, alignItems: 'center' },
  btnAprobarText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  btnRechazar: {
    flex: 1, backgroundColor: DARK, borderWidth: 1.5, borderColor: Colors.error,
    borderRadius: 12, padding: 14, alignItems: 'center',
  },
  btnRechazarText: { color: Colors.error, fontWeight: '800', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
errorCard: { backgroundColor: '#450A0A', borderRadius: 10, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: '#991B1B' },
  errorText: { color: '#FCA5A5', fontSize: 12, fontWeight: '600' },
  toast: { position: 'absolute', top: 70, left: 16, right: 16, zIndex: 99, borderRadius: 12, padding: 14 },
  toastOk: { backgroundColor: '#14532D' },
  toastErr: { backgroundColor: '#450A0A' },
  toastText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: DARK, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, borderTopWidth: 1, borderTopColor: '#334155',
  },
  modalTitle: { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 6 },
  modalSub: { fontSize: 13, color: '#94A3B8', marginBottom: 16 },
  modalInput: {
    backgroundColor: '#1A2744', borderRadius: 12, padding: 14, fontSize: 14,
    color: Colors.white, minHeight: 80, textAlignVertical: 'top',
    borderWidth: 1, borderColor: '#334155', marginBottom: 16,
  },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancelar: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalCancelarText: { color: '#94A3B8', fontWeight: '700', fontSize: 14 },
  modalRechazar: { flex: 1, backgroundColor: Colors.error, borderRadius: 12, padding: 14, alignItems: 'center' },
  modalRechazarText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
