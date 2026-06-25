import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, Modal, TextInput,
  Switch, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GREEN  = '#22C55E';
const RED    = '#EF4444';
const GOLD   = '#E8820C';
const PRIMARY = '#1A3C3C';

interface Cupon {
  id: string;
  codigo: string;
  tipo: 'porcentaje' | 'fijo';
  valor: number;
  uso_maximo: number;
  uso_por_usuario: number;
  usos_actuales: number;
  activo: boolean;
  fecha_vencimiento: string | null;
  usuario_id_exclusivo: string | null;
  created_at: string;
}

const FORM_VACIO = {
  codigo: '',
  tipo: 'porcentaje' as 'porcentaje' | 'fijo',
  valor: '',
  uso_maximo: '100',
  uso_por_usuario: '1',
  fecha_vencimiento: '',
  usuario_id_exclusivo: '',
  activo: true,
};

export default function AdminCuponesScreen() {
  const [cupones, setCupones]       = useState<Cupon[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editando, setEditando]     = useState<Cupon | null>(null);
  const [form, setForm]             = useState({ ...FORM_VACIO });
  const [guardando, setGuardando]   = useState(false);
  const [errForm, setErrForm]       = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.cupones();
      setCupones(res.data || []);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, []);

  function abrirNuevo() {
    setEditando(null);
    setForm({ ...FORM_VACIO });
    setErrForm('');
    setModalVisible(true);
  }

  function abrirEditar(c: Cupon) {
    setEditando(c);
    setForm({
      codigo:               c.codigo,
      tipo:                 c.tipo,
      valor:                String(c.valor),
      uso_maximo:           String(c.uso_maximo),
      uso_por_usuario:      String(c.uso_por_usuario),
      fecha_vencimiento:    c.fecha_vencimiento ? c.fecha_vencimiento.slice(0, 10) : '',
      usuario_id_exclusivo: c.usuario_id_exclusivo || '',
      activo:               c.activo,
    });
    setErrForm('');
    setModalVisible(true);
  }

  async function guardar() {
    if (!form.codigo.trim()) return setErrForm('El código es obligatorio.');
    const valorNum = parseFloat(form.valor);
    if (!form.valor || isNaN(valorNum) || valorNum <= 0) return setErrForm('El valor debe ser mayor que 0.');
    if (form.tipo === 'porcentaje' && valorNum > 100) return setErrForm('El porcentaje no puede superar 100.');

    setGuardando(true);
    setErrForm('');
    try {
      const payload = {
        codigo:               form.codigo.toUpperCase().trim(),
        tipo:                 form.tipo,
        valor:                valorNum,
        uso_maximo:           parseInt(form.uso_maximo) || 1,
        uso_por_usuario:      parseInt(form.uso_por_usuario) || 1,
        fecha_vencimiento:    form.fecha_vencimiento || null,
        usuario_id_exclusivo: form.usuario_id_exclusivo.trim() || null,
        activo:               form.activo,
      };
      if (editando) {
        await adminAPI.actualizarCupon(editando.id, payload);
      } else {
        await adminAPI.crearCupon(payload);
      }
      setModalVisible(false);
      cargar();
    } catch (e: any) {
      setErrForm(e.message || 'Error al guardar el cupón.');
    } finally {
      setGuardando(false);
    }
  }

  async function toggleActivo(c: Cupon) {
    try {
      await adminAPI.actualizarCupon(c.id, { activo: !c.activo });
      cargar();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  function confirmarEliminar(c: Cupon) {
    Alert.alert(
      'Eliminar cupón',
      `¿Eliminar el cupón "${c.codigo}"? Esta acción no se puede deshacer.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar', style: 'destructive',
          onPress: async () => {
            try {
              await adminAPI.eliminarCupon(c.id);
              cargar();
            } catch (e: any) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ]
    );
  }

  function descricpionTipo(c: Cupon) {
    return c.tipo === 'porcentaje' ? `${c.valor}%` : `Q${c.valor.toFixed(2)}`;
  }

  function estadoVencimiento(c: Cupon) {
    if (!c.fecha_vencimiento) return null;
    const vence = new Date(c.fecha_vencimiento);
    const hoy   = new Date();
    if (vence < hoy) return { texto: 'Vencido', color: RED };
    const dias = Math.ceil((vence.getTime() - hoy.getTime()) / 86400000);
    if (dias <= 7) return { texto: `Vence en ${dias}d`, color: GOLD };
    return { texto: vence.toLocaleDateString('es-GT'), color: TEXT2 };
  }

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Cupones</Text>
        </View>
        <ActivityIndicator style={{ marginTop: 40 }} color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      {/* Modal crear / editar */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <View style={s.modalOverlay}>
          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            <View style={s.modalCard}>
              <Text style={s.modalTitle}>{editando ? 'Editar cupón' : 'Nuevo cupón'}</Text>

              <Text style={s.label}>Código *</Text>
              <TextInput
                style={s.input}
                placeholder="Ej. BOCARA10"
                placeholderTextColor={TEXT2}
                value={form.codigo}
                onChangeText={v => setForm(p => ({ ...p, codigo: v.toUpperCase() }))}
                autoCapitalize="characters"
                editable={!editando}
              />

              <Text style={s.label}>Tipo *</Text>
              <View style={s.toggleRow}>
                {(['porcentaje', 'fijo'] as const).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[s.toggleBtn, form.tipo === t && s.toggleBtnActive]}
                    onPress={() => setForm(p => ({ ...p, tipo: t }))}
                  >
                    <Text style={[s.toggleText, form.tipo === t && s.toggleTextActive]}>
                      {t === 'porcentaje' ? '% Porcentaje' : 'Q Monto fijo'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.label}>{form.tipo === 'porcentaje' ? 'Porcentaje (%)' : 'Monto fijo (Q)'} *</Text>
              <TextInput
                style={s.input}
                placeholder={form.tipo === 'porcentaje' ? 'Ej. 10' : 'Ej. 25.00'}
                placeholderTextColor={TEXT2}
                value={form.valor}
                onChangeText={v => setForm(p => ({ ...p, valor: v }))}
                keyboardType="decimal-pad"
              />

              <Text style={s.label}>Límite global de usos</Text>
              <TextInput
                style={s.input}
                placeholder="100"
                placeholderTextColor={TEXT2}
                value={form.uso_maximo}
                onChangeText={v => setForm(p => ({ ...p, uso_maximo: v }))}
                keyboardType="number-pad"
              />

              <Text style={s.label}>Usos por usuario</Text>
              <TextInput
                style={s.input}
                placeholder="1"
                placeholderTextColor={TEXT2}
                value={form.uso_por_usuario}
                onChangeText={v => setForm(p => ({ ...p, uso_por_usuario: v }))}
                keyboardType="number-pad"
              />

              <Text style={s.label}>Fecha de vencimiento (YYYY-MM-DD, opcional)</Text>
              <TextInput
                style={s.input}
                placeholder="2026-12-31"
                placeholderTextColor={TEXT2}
                value={form.fecha_vencimiento}
                onChangeText={v => setForm(p => ({ ...p, fecha_vencimiento: v }))}
              />

              <Text style={s.label}>UUID de usuario exclusivo (opcional)</Text>
              <TextInput
                style={s.input}
                placeholder="Dejar vacío para cupón público"
                placeholderTextColor={TEXT2}
                value={form.usuario_id_exclusivo}
                onChangeText={v => setForm(p => ({ ...p, usuario_id_exclusivo: v }))}
                autoCapitalize="none"
              />

              <View style={s.switchRow}>
                <Text style={s.label}>Activo</Text>
                <Switch
                  value={form.activo}
                  onValueChange={v => setForm(p => ({ ...p, activo: v }))}
                  trackColor={{ true: GREEN }}
                />
              </View>

              {errForm ? <Text style={s.errText}>{errForm}</Text> : null}

              <View style={s.modalBtns}>
                <TouchableOpacity
                  style={[s.btnPrimary, guardando && s.btnOff]}
                  onPress={guardar}
                  disabled={guardando}
                >
                  {guardando
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={s.btnPrimaryText}>{editando ? 'Guardar cambios' : 'Crear cupón'}</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity style={s.btnSecondary} onPress={() => setModalVisible(false)}>
                  <Text style={s.btnSecondaryText}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.headerTag}>ADMIN</Text>
          <Text style={s.headerTitle}>Cupones</Text>
        </View>
        <TouchableOpacity style={s.btnNuevo} onPress={abrirNuevo}>
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={s.btnNuevoText}>Nuevo</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} />}
      >
        {cupones.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="ticket-outline" size={48} color={TEXT2} />
            <Text style={s.emptyText}>No hay cupones creados</Text>
            <TouchableOpacity style={s.btnNuevo} onPress={abrirNuevo}>
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={s.btnNuevoText}>Crear primer cupón</Text>
            </TouchableOpacity>
          </View>
        ) : cupones.map((c) => {
          const venc = estadoVencimiento(c);
          return (
            <View key={c.id} style={[s.card, !c.activo && s.cardInactivo]}>
              <View style={s.cardTop}>
                <View style={s.codeWrap}>
                  <Text style={s.code}>{c.codigo}</Text>
                  <View style={[s.badge, { backgroundColor: c.activo ? '#DCFCE7' : '#FEE2E2' }]}>
                    <Text style={[s.badgeText, { color: c.activo ? GREEN : RED }]}>
                      {c.activo ? 'Activo' : 'Inactivo'}
                    </Text>
                  </View>
                </View>
                <View style={s.cardActions}>
                  <TouchableOpacity onPress={() => abrirEditar(c)} style={s.actionBtn}>
                    <Ionicons name="pencil" size={17} color={PRIMARY} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => confirmarEliminar(c)} style={s.actionBtn}>
                    <Ionicons name="trash-outline" size={17} color={RED} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={s.cardMid}>
                <View style={s.stat}>
                  <Text style={s.statVal}>{descricpionTipo(c)}</Text>
                  <Text style={s.statLabel}>Descuento</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statVal}>{c.usos_actuales}/{c.uso_maximo}</Text>
                  <Text style={s.statLabel}>Usos</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statVal}>{c.uso_por_usuario}</Text>
                  <Text style={s.statLabel}>Por usuario</Text>
                </View>
              </View>

              {(venc || c.usuario_id_exclusivo) ? (
                <View style={s.cardFoot}>
                  {venc ? (
                    <View style={s.footChip}>
                      <Ionicons name="time-outline" size={12} color={venc.color} />
                      <Text style={[s.footChipText, { color: venc.color }]}>{venc.texto}</Text>
                    </View>
                  ) : null}
                  {c.usuario_id_exclusivo ? (
                    <View style={s.footChip}>
                      <Ionicons name="person-outline" size={12} color={TEXT2} />
                      <Text style={s.footChipText} numberOfLines={1}>
                        Exclusivo: {c.usuario_id_exclusivo.slice(0, 8)}…
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              <View style={s.switchRow}>
                <Text style={[s.label, { marginBottom: 0 }]}>Activo</Text>
                <Switch
                  value={c.activo}
                  onValueChange={() => toggleActivo(c)}
                  trackColor={{ true: GREEN }}
                />
              </View>
            </View>
          );
        })}
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: BG },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:   { fontSize: 10, fontWeight: '700', color: TEXT2, letterSpacing: 1 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT },
  scroll: { padding: 16 },

  btnNuevo:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: PRIMARY, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  btnNuevoText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  empty:     { alignItems: 'center', gap: 14, paddingVertical: 60 },
  emptyText: { fontSize: 15, color: TEXT2, fontWeight: '600' },

  card:        { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 16, marginBottom: 12, gap: 12 },
  cardInactivo:{ opacity: 0.65 },
  cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  codeWrap:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  code:        { fontSize: 18, fontWeight: '900', color: PRIMARY, letterSpacing: 1 },
  badge:       { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText:   { fontSize: 11, fontWeight: '800' },
  cardActions: { flexDirection: 'row', gap: 8 },
  actionBtn:   { width: 34, height: 34, borderRadius: 10, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },

  cardMid:  { flexDirection: 'row', justifyContent: 'space-around' },
  stat:     { alignItems: 'center', gap: 2 },
  statVal:  { fontSize: 18, fontWeight: '900', color: TEXT },
  statLabel:{ fontSize: 11, color: TEXT2, fontWeight: '600' },

  cardFoot:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  footChip:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: BG, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  footChipText:{ fontSize: 11, color: TEXT2, fontWeight: '600' },

  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalScroll:  { padding: 16, paddingTop: 60 },
  modalCard:    { backgroundColor: CARD, borderRadius: 24, padding: 24, gap: 4 },
  modalTitle:   { fontSize: 22, fontWeight: '900', color: TEXT, marginBottom: 12 },
  label:        { fontSize: 13, fontWeight: '700', color: TEXT2, marginTop: 10, marginBottom: 6 },
  input:        { backgroundColor: BG, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: TEXT, fontWeight: '600', borderWidth: 1, borderColor: BORDER },
  toggleRow:    { flexDirection: 'row', gap: 8 },
  toggleBtn:    { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: BG, borderWidth: 1.5, borderColor: 'transparent' },
  toggleBtnActive:  { backgroundColor: PRIMARY, borderColor: PRIMARY },
  toggleText:       { fontSize: 13, fontWeight: '700', color: TEXT2 },
  toggleTextActive: { color: '#fff' },
  errText:      { fontSize: 13, color: RED, fontWeight: '600', marginTop: 6 },
  modalBtns:    { gap: 10, marginTop: 16 },
  btnPrimary:   { backgroundColor: PRIMARY, borderRadius: 50, paddingVertical: 16, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  btnSecondary: { alignItems: 'center', paddingVertical: 14 },
  btnSecondaryText: { color: TEXT2, fontWeight: '700', fontSize: 14 },
  btnOff:       { opacity: 0.5 },
});
