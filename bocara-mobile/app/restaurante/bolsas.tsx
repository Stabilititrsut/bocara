import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  Modal, TextInput, Alert, RefreshControl, Switch,
} from 'react-native';
import { bolsasAPI, negociosAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';

const FORM_INIT = {
  nombre: '', descripcion: '', contenido: '',
  precio_original: '', precio_descuento: '',
  cantidad_disponible: '1', tipo: 'bolsa',
  hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
  co2_salvado_kg: '0.5', activo: true,
};

export default function BolsasRestauranteScreen() {
  const [bolsas, setBolsas] = useState<Bolsa[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState<any>(FORM_INIT);
  const [editId, setEditId] = useState<string | null>(null);
  const [negocioId, setNegocioId] = useState<string>('');
  const set = (k: string) => (v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const cargar = useCallback(async () => {
    try {
      const [negRes, bolRes] = await Promise.all([negociosAPI.miNegocio(), bolsasAPI.listar({ mi_negocio: true })]);
      setNegocioId(negRes.data?.id || '');
      setBolsas(bolRes.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function abrirEditar(b: Bolsa) {
    setEditId(b.id);
    setForm({ ...b, precio_original: String(b.precio_original), precio_descuento: String(b.precio_descuento), cantidad_disponible: String(b.cantidad_disponible), co2_salvado_kg: String(b.co2_salvado_kg) });
    setModal(true);
  }

  async function guardar() {
    if (!form.nombre || !form.precio_original || !form.precio_descuento)
      return Alert.alert('Error', 'Nombre, precio original y precio con descuento son requeridos');
    const data = {
      ...form, negocio_id: negocioId,
      precio_original: parseFloat(form.precio_original),
      precio_descuento: parseFloat(form.precio_descuento),
      cantidad_disponible: parseInt(form.cantidad_disponible) || 1,
      co2_salvado_kg: parseFloat(form.co2_salvado_kg) || 0.5,
    };
    try {
      if (editId) await bolsasAPI.actualizar(editId, data);
      else await bolsasAPI.crear(data);
      setModal(false);
      setForm(FORM_INIT);
      setEditId(null);
      cargar();
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  async function toggleActivo(b: Bolsa) {
    try {
      await bolsasAPI.actualizar(b.id, { activo: !b.activo });
      cargar();
    } catch { }
  }

  async function eliminar(id: string) {
    Alert.alert('Eliminar bolsa', '¿Seguro que quieres eliminar esta bolsa?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: async () => { await bolsasAPI.eliminar(id); cargar(); } },
    ]);
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Mis bolsas</Text>
        <TouchableOpacity style={s.addBtn} onPress={() => { setForm(FORM_INIT); setEditId(null); setModal(true); }}>
          <Text style={s.addBtnText}>+ Nueva</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {bolsas.length === 0 && !loading && (
          <View style={s.empty}><Text style={{ fontSize: 40 }}>🥡</Text><Text style={s.emptyText}>Crea tu primera bolsa de comida rescatada</Text></View>
        )}
        {bolsas.map((b) => (
          <View key={b.id} style={[s.card, !b.activo && s.cardInactiva]}>
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <View style={s.tipoRow}>
                  <View style={[s.tipoBadge, b.tipo === 'cupon' && s.tipoCupon]}>
                    <Text style={s.tipoBadgeText}>{b.tipo === 'cupon' ? '🎫 Cupón' : '🥡 Bolsa'}</Text>
                  </View>
                  {!b.activo && <View style={s.inactivaBadge}><Text style={s.inactivaText}>Inactiva</Text></View>}
                </View>
                <Text style={s.cardNombre}>{b.nombre}</Text>
                <Text style={s.cardHora}>⏰ {b.hora_recogida_inicio?.slice(0, 5)} - {b.hora_recogida_fin?.slice(0, 5)}</Text>
              </View>
              <View style={s.cardRight}>
                <Text style={s.cardOriginal}>Q{b.precio_original}</Text>
                <Text style={s.cardPrecio}>Q{b.precio_descuento}</Text>
                <Text style={s.cardDisp}>{b.cantidad_disponible} disp.</Text>
              </View>
            </View>
            <View style={s.cardActions}>
              <Switch value={b.activo} onValueChange={() => toggleActivo(b)} trackColor={{ true: Colors.green }} thumbColor={Colors.white} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />
              <Text style={s.switchLabel}>{b.activo ? 'Activa' : 'Inactiva'}</Text>
              <TouchableOpacity style={s.editBtn} onPress={() => abrirEditar(b)}><Text style={s.editBtnText}>Editar</Text></TouchableOpacity>
              <TouchableOpacity style={s.deleteBtn} onPress={() => eliminar(b.id)}><Text style={s.deleteBtnText}>Eliminar</Text></TouchableOpacity>
            </View>
          </View>
        ))}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Modal crear/editar */}
      <Modal visible={modal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={s.modal}>
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={() => setModal(false)}><Text style={s.cancelText}>Cancelar</Text></TouchableOpacity>
            <Text style={s.modalTitle}>{editId ? 'Editar bolsa' : 'Nueva bolsa'}</Text>
            <TouchableOpacity onPress={guardar}><Text style={s.saveText}>Guardar</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={s.modalScroll}>
            {[
              { key: 'nombre', label: 'Nombre *', placeholder: 'Bolsa sorpresa de panadería' },
              { key: 'descripcion', label: 'Descripción', placeholder: 'Bolsa con productos del día...' },
              { key: 'contenido', label: '¿Qué puede contener?', placeholder: 'Pan, croissants, bizcochos...' },
              { key: 'precio_original', label: 'Precio original (Q) *', placeholder: '80', keyboard: 'numeric' as any },
              { key: 'precio_descuento', label: 'Precio Bocara (Q) *', placeholder: '25', keyboard: 'numeric' as any },
              { key: 'cantidad_disponible', label: 'Unidades disponibles *', placeholder: '5', keyboard: 'numeric' as any },
              { key: 'hora_recogida_inicio', label: 'Hora inicio recogida', placeholder: '18:00' },
              { key: 'hora_recogida_fin', label: 'Hora fin recogida', placeholder: '20:00' },
              { key: 'co2_salvado_kg', label: 'CO₂ salvado (kg)', placeholder: '0.5', keyboard: 'numeric' as any },
            ].map(({ key, label, placeholder, keyboard }) => (
              <View key={key}>
                <Text style={s.label}>{label}</Text>
                <TextInput
                  style={s.input} placeholder={placeholder} placeholderTextColor={Colors.textLight}
                  keyboardType={keyboard || 'default'} value={String(form[key] || '')}
                  onChangeText={set(key)} multiline={key === 'descripcion' || key === 'contenido'}
                  numberOfLines={key === 'descripcion' || key === 'contenido' ? 3 : 1}
                />
              </View>
            ))}
            <Text style={s.label}>Tipo</Text>
            <View style={s.tipoToggle}>
              <TouchableOpacity style={[s.tipoOpt, form.tipo === 'bolsa' && s.tipoOptActive]} onPress={() => set('tipo')('bolsa')}>
                <Text style={[s.tipoOptText, form.tipo === 'bolsa' && s.tipoOptTextActive]}>🥡 Bolsa</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.tipoOpt, form.tipo === 'cupon' && s.tipoOptActive]} onPress={() => set('tipo')('cupon')}>
                <Text style={[s.tipoOptText, form.tipo === 'cupon' && s.tipoOptTextActive]}>🎫 Cupón</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 40 }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  addBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  scroll: { padding: 14 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2 },
  cardInactiva: { opacity: 0.6 },
  cardTop: { flexDirection: 'row', marginBottom: 10 },
  tipoRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  tipoBadge: { backgroundColor: Colors.brownLight, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  tipoCupon: { backgroundColor: Colors.greenLight },
  tipoBadgeText: { fontSize: 11, color: Colors.brown, fontWeight: '600' },
  inactivaBadge: { backgroundColor: Colors.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  inactivaText: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  cardHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  cardRight: { alignItems: 'flex-end' },
  cardOriginal: { fontSize: 11, color: Colors.textLight, textDecorationLine: 'line-through' },
  cardPrecio: { fontSize: 20, fontWeight: '900', color: Colors.orange },
  cardDisp: { fontSize: 11, color: Colors.textSecondary },
  cardActions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  switchLabel: { fontSize: 12, color: Colors.textSecondary, marginLeft: 4, marginRight: 'auto' },
  editBtn: { borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  editBtnText: { color: Colors.orange, fontSize: 13, fontWeight: '700' },
  deleteBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  deleteBtnText: { color: Colors.error, fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  modal: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  cancelText: { color: Colors.error, fontSize: 15 },
  saveText: { color: Colors.orange, fontSize: 15, fontWeight: '800' },
  modalScroll: { padding: 16 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6, marginTop: 4 },
  input: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 4, textAlignVertical: 'top' },
  tipoToggle: { flexDirection: 'row', backgroundColor: Colors.border, borderRadius: 12, padding: 3, marginBottom: 16 },
  tipoOpt: { flex: 1, padding: 10, alignItems: 'center', borderRadius: 10 },
  tipoOptActive: { backgroundColor: Colors.white },
  tipoOptText: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600' },
  tipoOptTextActive: { color: Colors.brown, fontWeight: '800' },
});
