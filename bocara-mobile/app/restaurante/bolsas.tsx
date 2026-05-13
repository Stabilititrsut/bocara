import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  Modal, TextInput, Alert, RefreshControl, Switch, Image, ActivityIndicator,
} from 'react-native';
import { bolsasAPI, negociosAPI, uploadsAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { pickImage } from '@/src/utils/pickImage';

const FORM_INIT = {
  nombre: '', descripcion: '', contenido: '',
  precio_original: '', precio_descuento: '',
  cantidad_disponible: '5',
  hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
  co2_salvado_kg: '0.5', imagen_url: '', activo: true,
};

export default function BolsasRestauranteScreen() {
  const [bolsas, setBolsas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState<any>(FORM_INIT);
  const [editId, setEditId] = useState<string | null>(null);
  const [negocioId, setNegocioId] = useState('');
  const [uploadingFoto, setUploadingFoto] = useState(false);
  const [uploadFotoError, setUploadFotoError] = useState('');
  const set = (k: string) => (v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  async function seleccionarFotoBolsa() {
    setUploadFotoError('');
    const picked = await pickImage();
    if (!picked) return;
    setUploadingFoto(true);
    try {
      const ext = picked.mimeType.split('/')[1] || 'jpg';
      const path = `bolsas/${negocioId}_${Date.now()}.${ext}`;
      const { data } = await uploadsAPI.uploadBase64(picked.base64, path, picked.mimeType);
      if (data?.publicUrl) {
        setForm((f: any) => ({ ...f, imagen_url: data.publicUrl }));
      }
    } catch (e: any) {
      setUploadFotoError(e.message || 'No se pudo subir la foto');
    } finally {
      setUploadingFoto(false);
    }
  }

  const cargar = useCallback(async () => {
    try {
      const [negRes, bolRes] = await Promise.all([negociosAPI.miNegocio(), bolsasAPI.listar({ mi_negocio: true })]);
      setNegocioId(negRes.data?.id || '');
      setBolsas((bolRes.data || []).filter((b: any) => b.tipo !== 'cupon'));
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function abrir(b?: any) {
    setUploadFotoError('');
    if (b) {
      setEditId(b.id);
      setForm({
        ...FORM_INIT, ...b,
        precio_original: String(b.precio_original),
        precio_descuento: String(b.precio_descuento),
        cantidad_disponible: String(b.cantidad_disponible),
        co2_salvado_kg: String(b.co2_salvado_kg || 0.5),
        imagen_url: b.imagen_url || '',
      });
    } else {
      setEditId(null);
      setForm(FORM_INIT);
    }
    setModal(true);
  }

  async function guardar() {
    if (!form.nombre || !form.precio_original || form.precio_descuento === '')
      return Alert.alert('Error', 'Nombre, precio original y precio Bocara son requeridos');
    const payload = {
      ...form,
      negocio_id: negocioId,
      tipo: 'bolsa',
      precio_original: parseFloat(form.precio_original),
      precio_descuento: parseFloat(form.precio_descuento),
      cantidad_disponible: parseInt(form.cantidad_disponible) || 1,
      co2_salvado_kg: parseFloat(form.co2_salvado_kg) || 0.5,
      imagen_url: form.imagen_url || null,
    };
    try {
      if (editId) await bolsasAPI.actualizar(editId, payload);
      else await bolsasAPI.crear(payload);
      setModal(false);
      cargar();
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  async function eliminar(id: string) {
    Alert.alert('Eliminar', '¿Eliminar esta bolsa?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => bolsasAPI.eliminar(id).then(cargar) },
    ]);
  }

  const desc = (b: any) => Math.round((1 - b.precio_descuento / b.precio_original) * 100);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>🥡 Sabores Rescatados</Text>
          <Text style={s.headerSub}>{bolsas.length} bolsa{bolsas.length !== 1 ? 's' : ''} publicada{bolsas.length !== 1 ? 's' : ''}</Text>
        </View>
        <TouchableOpacity style={s.addBtn} onPress={() => abrir()}>
          <Text style={s.addBtnText}>+ Nueva bolsa</Text>
        </TouchableOpacity>
      </View>

      {bolsas.some(b => b.estado_aprobacion === 'pendiente') && (
        <View style={s.infoBanner}>
          <Text style={s.infoBannerText}>⏳ Tienes bolsas pendientes de aprobación. El admin las revisará pronto.</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {bolsas.length === 0 && !loading && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>🥡</Text>
            <Text style={s.emptyTitle}>Sin bolsas publicadas</Text>
            <Text style={s.emptyText}>Publica tu primera Bolsa Sorpresa con la comida que sobra del día.</Text>
            <TouchableOpacity style={s.emptyBtn} onPress={() => abrir()}>
              <Text style={s.emptyBtnText}>Crear primera bolsa</Text>
            </TouchableOpacity>
          </View>
        )}

        {bolsas.map((b) => (
          <View key={b.id} style={[s.card, !b.activo && s.cardInactiva]}>
            <View style={s.cardRow}>
              {/* Foto / placeholder */}
              <View style={s.foto}>
                {b.imagen_url ? (
                  <Image source={{ uri: b.imagen_url }} style={s.fotoImg} />
                ) : (
                  <Text style={{ fontSize: 36 }}>🥡</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View style={s.badgeRow}>
                  <View style={s.descBadge}><Text style={s.descBadgeText}>-{desc(b)}%</Text></View>
                  {!b.activo && <View style={s.inactivaBadge}><Text style={s.inactivaText}>Inactiva</Text></View>}
                  {b.estado_aprobacion === 'pendiente' && (
                    <View style={s.pendienteBadge}><Text style={s.pendienteText}>⏳ Pendiente</Text></View>
                  )}
                  {b.estado_aprobacion === 'rechazado' && (
                    <View style={s.rechazadaBadge}><Text style={s.rechazadaText}>✕ Rechazada</Text></View>
                  )}
                  {(b.estado_aprobacion === 'aprobado' || !b.estado_aprobacion) && b.activo && (
                    <View style={s.aprobadaBadge}><Text style={s.aprobadaText}>✓ Aprobada</Text></View>
                  )}
                </View>
                <Text style={s.cardNombre}>{b.nombre}</Text>
                <Text style={s.cardSub} numberOfLines={1}>{b.descripcion}</Text>
                <Text style={s.cardHora}>⏰ {b.hora_recogida_inicio?.slice(0, 5)} – {b.hora_recogida_fin?.slice(0, 5)}</Text>
                {b.estado_aprobacion === 'rechazado' && b.motivo_rechazo && (
                  <View style={s.motivoBox}>
                    <Text style={s.motivoText}>Motivo: {b.motivo_rechazo}</Text>
                  </View>
                )}
              </View>
              <View style={s.cardRight}>
                <Text style={s.precioOriginal}>Q{b.precio_original}</Text>
                <Text style={s.precioBocara}>Q{b.precio_descuento}</Text>
                <Text style={s.disp}>{b.cantidad_disponible} disp.</Text>
              </View>
            </View>

            <View style={s.cardActions}>
              <Switch
                value={!!b.activo}
                onValueChange={() => bolsasAPI.actualizar(b.id, { activo: !b.activo }).then(cargar)}
                trackColor={{ true: Colors.green, false: Colors.border }}
                thumbColor={Colors.white}
              />
              <Text style={s.switchLabel}>{b.activo ? 'Activa' : 'Inactiva'}</Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity style={s.editBtn} onPress={() => abrir(b)}>
                <Text style={s.editBtnText}>Editar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.deleteBtn} onPress={() => eliminar(b.id)}>
                <Text style={s.deleteBtnText}>Eliminar</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Modal */}
      <Modal visible={modal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={s.modal}>
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={() => setModal(false)}>
              <Text style={s.cancelText}>Cancelar</Text>
            </TouchableOpacity>
            <Text style={s.modalTitle}>
              {editId
                ? (bolsas.find(b => b.id === editId)?.estado_aprobacion === 'rechazado'
                    ? 'Editar y reenviar'
                    : 'Editar bolsa')
                : 'Nueva bolsa'
              }
            </Text>
            <TouchableOpacity onPress={guardar}>
              <Text style={s.saveText}>Guardar</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            {editId && bolsas.find(b => b.id === editId)?.estado_aprobacion === 'rechazado' && (
              <View style={{ backgroundColor: '#FEF3C7', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <Text style={{ fontSize: 13, color: '#92400E', fontWeight: '600' }}>
                  📤 Al guardar, esta bolsa se reenviará al admin para revisión.
                </Text>
              </View>
            )}
            {/* Foto */}
            <Text style={s.sectionLabel}>📷 Foto de la bolsa</Text>
            <TouchableOpacity
              style={[s.fotoBtn, uploadingFoto && { opacity: 0.6 }]}
              onPress={seleccionarFotoBolsa}
              disabled={uploadingFoto}
              activeOpacity={0.8}
            >
              {form.imagen_url ? (
                <Image source={{ uri: form.imagen_url }} style={s.fotoPreview} />
              ) : (
                <View style={s.fotoPlaceholder}>
                  <Text style={{ fontSize: 40 }}>🥡</Text>
                  <Text style={s.fotoPlaceholderText}>Toca para agregar foto</Text>
                </View>
              )}
              <View style={s.fotoOverlay}>
                {uploadingFoto
                  ? <ActivityIndicator color={Colors.white} />
                  : <Text style={s.fotoOverlayText}>{form.imagen_url ? '📷 Cambiar foto' : '📷 Seleccionar foto'}</Text>
                }
              </View>
            </TouchableOpacity>
            {uploadFotoError ? (
              <View style={s.uploadError}>
                <Text style={s.uploadErrorText}>⚠️ {uploadFotoError}</Text>
              </View>
            ) : null}

            <Text style={s.sectionLabel}>📝 Información</Text>
            <Field label="Nombre *" value={form.nombre} onChange={set('nombre')} placeholder="Bolsa Sorpresa de Panadería" />
            <Field label="Descripción" value={form.descripcion} onChange={set('descripcion')} placeholder="Productos artesanales del día..." multiline />
            <Field label="¿Qué puede contener?" value={form.contenido} onChange={set('contenido')} placeholder="Pan, croissants, galletas..." multiline />

            <Text style={s.sectionLabel}>💰 Precios</Text>
            <View style={s.priceRow}>
              <View style={{ flex: 1 }}>
                <Field label="Precio original (Q) *" value={form.precio_original} onChange={set('precio_original')} placeholder="100" keyboard="numeric" />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field label="Precio Bocara (Q) *" value={form.precio_descuento} onChange={set('precio_descuento')} placeholder="35" keyboard="numeric" />
              </View>
            </View>

            {form.precio_original && form.precio_descuento ? (
              <View style={s.descInfo}>
                <Text style={s.descInfoText}>
                  Descuento: {Math.round((1 - parseFloat(form.precio_descuento || '0') / parseFloat(form.precio_original || '1')) * 100)}% · El cliente ahorra Q{(parseFloat(form.precio_original || '0') - parseFloat(form.precio_descuento || '0')).toFixed(2)}
                </Text>
              </View>
            ) : null}

            <Field label="Unidades disponibles *" value={form.cantidad_disponible} onChange={set('cantidad_disponible')} placeholder="5" keyboard="numeric" />

            <Text style={s.sectionLabel}>⏰ Horario de recogida</Text>
            <View style={s.priceRow}>
              <View style={{ flex: 1 }}>
                <Field label="Hora inicio" value={form.hora_recogida_inicio} onChange={set('hora_recogida_inicio')} placeholder="18:00" />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field label="Hora fin" value={form.hora_recogida_fin} onChange={set('hora_recogida_fin')} placeholder="20:00" />
              </View>
            </View>

            <Field label="CO₂ salvado (kg)" value={form.co2_salvado_kg} onChange={set('co2_salvado_kg')} placeholder="0.5" keyboard="numeric" />

            <View style={{ height: 40 }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, multiline, keyboard }: any) {
  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={sf.label}>{label}</Text>
      <TextInput
        style={[sf.input, multiline && { height: 72 }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={Colors.textLight}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        keyboardType={keyboard || 'default'}
      />
    </View>
  );
}

const sf = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6, marginTop: 4 },
  input: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 4 },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown },
  headerSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  addBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  scroll: { padding: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyBtn: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6 },
  cardInactiva: { opacity: 0.55 },
  cardRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  foto: { width: 72, height: 72, borderRadius: 12, backgroundColor: Colors.brownLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fotoImg: { width: 72, height: 72, borderRadius: 12 },
  badgeRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  descBadge: { backgroundColor: Colors.orange, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  descBadgeText: { color: Colors.white, fontSize: 11, fontWeight: '800' },
  inactivaBadge: { backgroundColor: Colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  inactivaText: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  cardSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  cardHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  cardRight: { alignItems: 'flex-end', justifyContent: 'center' },
  precioOriginal: { fontSize: 11, color: Colors.textLight, textDecorationLine: 'line-through' },
  precioBocara: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  disp: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  cardActions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  switchLabel: { fontSize: 12, color: Colors.textSecondary, marginLeft: 4 },
  editBtn: { borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  editBtnText: { color: Colors.orange, fontSize: 13, fontWeight: '700' },
  deleteBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  deleteBtnText: { color: Colors.error, fontSize: 13, fontWeight: '700' },
  modal: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  cancelText: { color: Colors.error, fontSize: 15 },
  saveText: { color: Colors.orange, fontSize: 15, fontWeight: '800' },
  modalScroll: { padding: 16 },
  sectionLabel: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginTop: 16, marginBottom: 10 },
  priceRow: { flexDirection: 'row' },
  descInfo: { backgroundColor: Colors.greenLight, borderRadius: 10, padding: 10, marginBottom: 12 },
  descInfoText: { fontSize: 13, color: Colors.green, fontWeight: '600' },
  uploadError: { backgroundColor: '#FEE2E2', borderRadius: 10, padding: 10, marginBottom: 12, marginTop: -8 },
  uploadErrorText: { color: '#B91C1C', fontSize: 13, fontWeight: '600' },
  fotoBtn: { borderRadius: 12, overflow: 'hidden', height: 150, marginBottom: 16 },
  fotoPreview: { width: '100%', height: '100%' },
  fotoPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.brownLight, alignItems: 'center', justifyContent: 'center', gap: 6 },
  fotoPlaceholderText: { fontSize: 13, color: Colors.textSecondary },
  fotoOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)', paddingVertical: 8, alignItems: 'center' },
  fotoOverlayText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  pendienteBadge: { backgroundColor: '#451A03', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  pendienteText: { fontSize: 11, color: '#F59E0B', fontWeight: '700' },
  rechazadaBadge: { backgroundColor: '#FEE2E2', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  rechazadaText: { fontSize: 11, color: '#DC2626', fontWeight: '700' },
  aprobadaBadge: { backgroundColor: '#DCFCE7', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  aprobadaText: { fontSize: 11, color: '#16A34A', fontWeight: '700' },
  motivoBox: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: 8, marginTop: 4 },
  motivoText: { fontSize: 12, color: '#DC2626', fontStyle: 'italic' },
  infoBanner: { backgroundColor: '#FEF3C7', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#FDE68A' },
  infoBannerText: { fontSize: 12, color: '#92400E', fontWeight: '600' },
});
