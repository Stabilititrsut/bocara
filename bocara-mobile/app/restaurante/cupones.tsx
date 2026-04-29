import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Alert, RefreshControl, ActivityIndicator, Modal,
} from 'react-native';
import { bolsasAPI, negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const TIPOS_DESCUENTO = ['Porcentaje', 'Monto fijo', '2x1', 'Gratis', 'Especial'];

const FORM_INIT = {
  nombre: '',
  contenido: '',
  categoria: 'Porcentaje',
  descripcion: '',
  precio_original: '',
  precio_descuento: '',
  cantidad_disponible: '1',
  hora_recogida_inicio: '18:00',
  hora_recogida_fin: '20:00',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

export default function CuponesRestauranteScreen() {
  const [cupones, setCupones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(false);
  const [editando, setEditando] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [negocioId, setNegocioId] = useState<string>('');
  const [form, setForm] = useState({ ...FORM_INIT });

  const cargar = useCallback(async () => {
    try {
      const negRes = await negociosAPI.miNegocio();
      const nid = negRes.data?.id;
      setNegocioId(nid || '');
      if (!nid) return;
      const res = await bolsasAPI.listar({ negocio_id: nid, mi_negocio: 'true' });
      setCupones((res.data || []).filter((b: any) => b.tipo === 'cupon'));
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function abrirNuevo() {
    setEditando(null);
    setForm({ ...FORM_INIT });
    setModal(true);
  }

  function abrirEditar(c: any) {
    setEditando(c);
    setForm({
      nombre: c.nombre || '',
      contenido: c.contenido || '',
      categoria: c.categoria || 'Porcentaje',
      descripcion: c.descripcion || '',
      precio_original: String(c.precio_original || ''),
      precio_descuento: String(c.precio_descuento || ''),
      cantidad_disponible: String(c.cantidad_disponible || '1'),
      hora_recogida_inicio: c.hora_recogida_inicio || '18:00',
      hora_recogida_fin: c.hora_recogida_fin || '20:00',
    });
    setModal(true);
  }

  async function guardar() {
    if (!form.nombre.trim() || !form.contenido.trim()) {
      return Alert.alert('Campos requeridos', 'Nombre y código del cupón son obligatorios');
    }
    if (form.precio_descuento == null || form.precio_descuento === '') {
      return Alert.alert('Campos requeridos', 'El precio con descuento es obligatorio');
    }
    setSaving(true);
    try {
      const payload = {
        nombre: form.nombre.trim(),
        contenido: form.contenido.trim().toUpperCase(),
        categoria: form.categoria,
        descripcion: form.descripcion.trim(),
        precio_original: parseFloat(form.precio_original) || 0,
        precio_descuento: parseFloat(form.precio_descuento),
        cantidad_disponible: parseInt(form.cantidad_disponible) || 1,
        hora_recogida_inicio: form.hora_recogida_inicio,
        hora_recogida_fin: form.hora_recogida_fin,
        tipo: 'cupon',
        negocio_id: negocioId,
      };
      if (editando) {
        await bolsasAPI.actualizar(editando.id, payload);
        Alert.alert('Listo', 'Cupón actualizado');
      } else {
        await bolsasAPI.crear(payload);
        Alert.alert('Listo', 'Cupón publicado');
      }
      setModal(false);
      cargar();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  }

  async function desactivar(id: string) {
    Alert.alert('Desactivar cupón', '¿Seguro que quieres desactivar este cupón?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Desactivar', style: 'destructive', onPress: async () => {
          await bolsasAPI.eliminar(id);
          cargar();
        }
      },
    ]);
  }

  const set = (k: keyof typeof FORM_INIT) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>🎫 Cupones</Text>
        <TouchableOpacity style={s.addBtn} onPress={abrirNuevo}>
          <Text style={s.addBtnText}>+ Nuevo</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {cupones.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>🎫</Text>
            <Text style={s.emptyText}>Aún no tienes cupones publicados</Text>
            <TouchableOpacity style={s.emptyBtn} onPress={abrirNuevo}>
              <Text style={s.emptyBtnText}>Crear primer cupón</Text>
            </TouchableOpacity>
          </View>
        )}

        {cupones.map((c: any) => {
          const descuento = c.precio_original > 0
            ? Math.round((1 - c.precio_descuento / c.precio_original) * 100)
            : 0;
          return (
            <View key={c.id} style={s.card}>
              <View style={s.cardTop}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={s.cardNombre}>{c.nombre}</Text>
                    {descuento > 0 && (
                      <View style={s.discountBadge}>
                        <Text style={s.discountText}>-{descuento}%</Text>
                      </View>
                    )}
                  </View>
                  <View style={s.codigoRow}>
                    <Text style={s.codigoLabel}>CÓDIGO</Text>
                    <Text style={s.codigoValor}>{c.contenido}</Text>
                  </View>
                  <Text style={s.tipo}>{c.categoria}</Text>
                  {c.descripcion ? <Text style={s.descripcion}>{c.descripcion}</Text> : null}
                </View>
                <View style={s.precioCol}>
                  {c.precio_original > 0 && (
                    <Text style={s.precioOriginal}>Q{c.precio_original.toFixed(2)}</Text>
                  )}
                  <Text style={s.precioDesc}>Q{c.precio_descuento.toFixed(2)}</Text>
                </View>
              </View>
              <View style={s.cardFooter}>
                <Text style={s.footerText}>
                  ⏰ {c.hora_recogida_inicio?.slice(0, 5)}–{c.hora_recogida_fin?.slice(0, 5)}
                </Text>
                <Text style={s.footerText}>📦 {c.cantidad_disponible} disponibles</Text>
              </View>
              <View style={s.cardActions}>
                <TouchableOpacity style={s.btnEditar} onPress={() => abrirEditar(c)}>
                  <Text style={s.btnEditarText}>✏️ Editar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.btnEliminar} onPress={() => desactivar(c.id)}>
                  <Text style={s.btnEliminarText}>Desactivar</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
        <View style={{ height: 24 }} />
      </ScrollView>

      <Modal visible={modal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: Colors.background }}>
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={() => setModal(false)}>
              <Text style={s.cancelText}>Cancelar</Text>
            </TouchableOpacity>
            <Text style={s.modalTitle}>{editando ? 'Editar cupón' : 'Nuevo cupón'}</Text>
            <TouchableOpacity onPress={guardar} disabled={saving}>
              <Text style={[s.saveText, saving && { opacity: 0.5 }]}>{saving ? 'Guardando…' : 'Guardar'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            <Field label="Nombre del cupón *">
              <TextInput style={s.input} value={form.nombre} onChangeText={set('nombre')} placeholder="Ej. Descuento miércoles" placeholderTextColor={Colors.textLight} />
            </Field>

            <Field label="Código del cupón *">
              <TextInput style={[s.input, s.codigoInput]} value={form.contenido} onChangeText={set('contenido')} placeholder="Ej. BOCARA20" placeholderTextColor={Colors.textLight} autoCapitalize="characters" />
            </Field>

            <Field label="Tipo de descuento">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {TIPOS_DESCUENTO.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[s.tipoChip, form.categoria === t && s.tipoChipActive]}
                    onPress={() => setForm(f => ({ ...f, categoria: t }))}
                  >
                    <Text style={[s.tipoChipText, form.categoria === t && s.tipoChipTextActive]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </Field>

            <Field label="Condiciones / Descripción">
              <TextInput
                style={[s.input, { height: 80, textAlignVertical: 'top' }]}
                value={form.descripcion} onChangeText={set('descripcion')}
                placeholder="Válido de lunes a viernes, no acumulable…"
                placeholderTextColor={Colors.textLight} multiline
              />
            </Field>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Precio original (Q)">
                  <TextInput style={s.input} value={form.precio_original} onChangeText={set('precio_original')} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.textLight} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Precio con descuento (Q) *">
                  <TextInput style={s.input} value={form.precio_descuento} onChangeText={set('precio_descuento')} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.textLight} />
                </Field>
              </View>
            </View>

            <Field label="Cantidad disponible">
              <TextInput style={s.input} value={form.cantidad_disponible} onChangeText={set('cantidad_disponible')} keyboardType="number-pad" placeholder="1" placeholderTextColor={Colors.textLight} />
            </Field>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Válido desde">
                  <TextInput style={s.input} value={form.hora_recogida_inicio} onChangeText={set('hora_recogida_inicio')} placeholder="18:00" placeholderTextColor={Colors.textLight} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Válido hasta">
                  <TextInput style={s.input} value={form.hora_recogida_fin} onChangeText={set('hora_recogida_fin')} placeholder="20:00" placeholderTextColor={Colors.textLight} />
                </Field>
              </View>
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
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  addBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
  scroll: { padding: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
  emptyBtn: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 24, paddingVertical: 12, marginTop: 4 },
  emptyBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12, elevation: 2 },
  cardTop: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  cardNombre: { fontSize: 16, fontWeight: '800', color: Colors.brown },
  discountBadge: { backgroundColor: Colors.orange, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  discountText: { color: Colors.white, fontSize: 11, fontWeight: '800' },
  codigoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  codigoLabel: { fontSize: 9, fontWeight: '800', color: Colors.textLight, letterSpacing: 1, textTransform: 'uppercase' },
  codigoValor: { fontSize: 15, fontWeight: '900', color: Colors.brown, letterSpacing: 2 },
  tipo: { fontSize: 12, color: Colors.orange, fontWeight: '700', marginTop: 4 },
  descripcion: { fontSize: 12, color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  precioCol: { alignItems: 'flex-end' },
  precioOriginal: { fontSize: 13, color: Colors.textLight, textDecorationLine: 'line-through' },
  precioDesc: { fontSize: 20, fontWeight: '900', color: Colors.green },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  footerText: { fontSize: 12, color: Colors.textSecondary },
  cardActions: { flexDirection: 'row', gap: 10 },
  btnEditar: { flex: 1, borderWidth: 1.5, borderColor: Colors.brown, borderRadius: 10, padding: 9, alignItems: 'center' },
  btnEditarText: { color: Colors.brown, fontWeight: '700', fontSize: 13 },
  btnEliminar: { flex: 1, borderWidth: 1.5, borderColor: Colors.error, borderRadius: 10, padding: 9, alignItems: 'center' },
  btnEliminarText: { color: Colors.error, fontWeight: '700', fontSize: 13 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.white },
  cancelText: { fontSize: 16, color: Colors.textSecondary },
  modalTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  saveText: { fontSize: 16, color: Colors.orange, fontWeight: '800' },
  modalScroll: { padding: 20 },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  input: { backgroundColor: Colors.inputBg, borderRadius: 12, padding: 13, fontSize: 15, color: Colors.textPrimary },
  codigoInput: { fontWeight: '800', letterSpacing: 2, color: Colors.brown },
  tipoChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.white },
  tipoChipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  tipoChipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  tipoChipTextActive: { color: Colors.white, fontWeight: '800' },
});
