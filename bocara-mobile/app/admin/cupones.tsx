import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, Modal, TextInput,
  Switch, Alert, ActivityIndicator, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

const BG      = '#F8FAFC';
const CARD    = '#FFFFFF';
const BORDER  = '#E5E7EB';
const TEXT    = '#111827';
const TEXT2   = '#6B7280';
const GREEN   = '#22C55E';
const RED     = '#EF4444';
const GOLD    = '#E8820C';
const BLUE    = '#3B82F6';
const PRIMARY = '#1A3C3C';

type TipoCupon = 'porcentaje' | 'monto_fijo' | 'referido';

interface UsuarioExclusivo {
  id: string;
  email: string;
  nombre?: string;
  apellido?: string;
}

interface Cupon {
  id: string;
  codigo: string;
  tipo: TipoCupon;
  valor: number;
  descripcion: string | null;
  uso_maximo: number;
  uso_por_usuario: number;
  usos_actuales: number;
  activo: boolean;
  fecha_vencimiento: string | null;
  usuario_id_exclusivo: string | null;
  usuario_exclusivo: UsuarioExclusivo | null;
  created_at: string;
}

interface UsoRow {
  id: string;
  usuario_id: string;
  pedido_id: string;
  descuento_aplicado: number;
  created_at: string;
  usuario: UsuarioExclusivo | null;
}

interface ReservaRow {
  id: string;
  usuario_id: string;
  pedido_id: string;
  descuento_aplicado: number;
  expires_at: string;
  created_at: string;
  usuario: UsuarioExclusivo | null;
}

const FORM_VACIO = {
  codigo: '',
  tipo: 'porcentaje' as TipoCupon,
  valor: '',
  descripcion: '',
  uso_maximo: '100',
  uso_por_usuario: '1',
  fecha_vencimiento: '',
  usuario_id_exclusivo: '',
  activo: true,
};

type Vista = 'lista' | 'usos' | 'reservas';

function estadoCalculado(c: Cupon): { texto: string; color: string; bg: string } {
  const ahora = new Date();
  if (c.fecha_vencimiento && new Date(c.fecha_vencimiento) < ahora)
    return { texto: 'Vencido',  color: '#B45309', bg: '#FEF3C7' };
  if (c.usos_actuales >= c.uso_maximo)
    return { texto: 'Agotado',  color: RED,       bg: '#FEE2E2' };
  if (!c.activo)
    return { texto: 'Inactivo', color: TEXT2,      bg: '#F3F4F6' };
  return   { texto: 'Activo',   color: GREEN,      bg: '#DCFCE7' };
}

function formatFecha(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-GT', { year: 'numeric', month: 'short', day: 'numeric' });
}

function etiquetaTipo(tipo: TipoCupon) {
  if (tipo === 'porcentaje') return '% Porcentaje';
  if (tipo === 'monto_fijo') return 'Q Monto fijo';
  return '🤝 Referido';
}

function valorDisplay(c: Cupon) {
  if (c.tipo === 'porcentaje') return `${c.valor}%`;
  return `Q${c.valor.toFixed(2)}`;
}

export default function AdminCuponesScreen() {
  const [cupones,    setCupones]    = useState<Cupon[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modal crear / editar
  const [modalVisible, setModalVisible] = useState(false);
  const [editando,     setEditando]     = useState<Cupon | null>(null);
  const [form,         setForm]         = useState({ ...FORM_VACIO });
  const [guardando,    setGuardando]    = useState(false);
  const [errForm,      setErrForm]      = useState('');

  // Modal historial / reservas
  const [vista,       setVista]       = useState<Vista>('lista');
  const [cuponDetalle, setCuponDetalle] = useState<Cupon | null>(null);
  const [detalleData,  setDetalleData]  = useState<(UsoRow | ReservaRow)[]>([]);
  const [loadingDetalle, setLoadingDetalle] = useState(false);

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

  // ── Abrir modal ─────────────────────────────────────────────────────────────

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
      descripcion:          c.descripcion || '',
      uso_maximo:           String(c.uso_maximo),
      uso_por_usuario:      String(c.uso_por_usuario),
      fecha_vencimiento:    c.fecha_vencimiento ? c.fecha_vencimiento.slice(0, 10) : '',
      usuario_id_exclusivo: c.usuario_id_exclusivo || '',
      activo:               c.activo,
    });
    setErrForm('');
    setModalVisible(true);
  }

  // ── Guardar ─────────────────────────────────────────────────────────────────

  async function guardar() {
    const codigo = form.codigo.trim().toUpperCase();
    if (!codigo) return setErrForm('El código es obligatorio.');
    const valorNum = parseFloat(form.valor);
    if (!form.valor || isNaN(valorNum) || valorNum <= 0) return setErrForm('El valor debe ser mayor que 0.');
    if (form.tipo === 'porcentaje' && valorNum > 100) return setErrForm('El porcentaje no puede superar 100.');
    const usoMax = parseInt(form.uso_maximo);
    if (isNaN(usoMax) || usoMax < 1) return setErrForm('El límite global debe ser al menos 1.');
    if (editando && usoMax < editando.usos_actuales)
      return setErrForm(`El límite (${usoMax}) no puede ser menor que los usos actuales (${editando.usos_actuales}).`);
    if (form.fecha_vencimiento) {
      const fv = new Date(form.fecha_vencimiento);
      if (isNaN(fv.getTime())) return setErrForm('Fecha de vencimiento inválida (usa YYYY-MM-DD).');
      if (fv <= new Date()) return setErrForm('La fecha de vencimiento debe ser futura.');
    }

    setGuardando(true);
    setErrForm('');
    try {
      const payload = {
        codigo,
        tipo:                 form.tipo,
        valor:                valorNum,
        descripcion:          form.descripcion.trim() || null,
        uso_maximo:           usoMax,
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

  // ── Toggle activo con confirmación ──────────────────────────────────────────

  function toggleActivo(c: Cupon) {
    if (c.activo) {
      Alert.alert(
        'Desactivar cupón',
        `¿Desactivar "${c.codigo}"? Los usuarios ya no podrán usarlo.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Desactivar', style: 'destructive', onPress: () => _setActivo(c, false) },
        ]
      );
    } else {
      _setActivo(c, true);
    }
  }

  async function _setActivo(c: Cupon, activo: boolean) {
    try {
      await adminAPI.patchEstadoCupon(c.id, activo);
      setCupones(prev => prev.map(x => x.id === c.id ? { ...x, activo } : x));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }

  // ── Eliminar ────────────────────────────────────────────────────────────────

  function confirmarEliminar(c: Cupon) {
    Alert.alert(
      'Eliminar cupón',
      `¿Eliminar "${c.codigo}"? Esta acción no se puede deshacer.`,
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

  // ── Historial / Reservas ─────────────────────────────────────────────────────

  async function abrirUsos(c: Cupon) {
    setCuponDetalle(c);
    setVista('usos');
    setDetalleData([]);
    setLoadingDetalle(true);
    try {
      const res = await adminAPI.usosCupon(c.id);
      setDetalleData(res.data || []);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoadingDetalle(false);
    }
  }

  async function abrirReservas(c: Cupon) {
    setCuponDetalle(c);
    setVista('reservas');
    setDetalleData([]);
    setLoadingDetalle(true);
    try {
      const res = await adminAPI.reservasCupon(c.id);
      setDetalleData(res.data || []);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoadingDetalle(false);
    }
  }

  // ── Stats summary ────────────────────────────────────────────────────────────

  const stats = {
    activos:  cupones.filter(c => estadoCalculado(c).texto === 'Activo').length,
    inactivos:cupones.filter(c => estadoCalculado(c).texto === 'Inactivo').length,
    vencidos: cupones.filter(c => estadoCalculado(c).texto === 'Vencido').length,
    agotados: cupones.filter(c => estadoCalculado(c).texto === 'Agotado').length,
  };

  // ── Render modal detalle (usos / reservas) ────────────────────────────────────

  if (vista !== 'lista' && cuponDetalle) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setVista('lista')} style={s.backBtn}>
            <Ionicons name="arrow-back" size={20} color={PRIMARY} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTag}>{cuponDetalle.codigo}</Text>
            <Text style={s.headerTitle}>{vista === 'usos' ? 'Historial de usos' : 'Reservas activas'}</Text>
          </View>
        </View>

        {loadingDetalle ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={PRIMARY} />
        ) : detalleData.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name={vista === 'usos' ? 'receipt-outline' : 'time-outline'} size={48} color={TEXT2} />
            <Text style={s.emptyText}>
              {vista === 'usos' ? 'Sin usos registrados' : 'Sin reservas activas'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={detalleData}
            keyExtractor={item => item.id}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item }) => {
              const u = item.usuario;
              const nombre = u ? [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email : item.usuario_id.slice(0, 8) + '…';
              return (
                <View style={s.detalleRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.detalleNombre}>{nombre}</Text>
                    {u?.email ? <Text style={s.detalleSub}>{u.email}</Text> : null}
                    <Text style={s.detalleSub}>
                      {vista === 'usos'
                        ? formatFecha(item.created_at)
                        : `Expira: ${formatFecha((item as ReservaRow).expires_at)}`}
                    </Text>
                  </View>
                  <Text style={s.detalleDescuento}>-Q{Number(item.descuento_aplicado).toFixed(2)}</Text>
                </View>
              );
            }}
          />
        )}
      </SafeAreaView>
    );
  }

  // ── Render principal ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <View>
            <Text style={s.headerTag}>ADMIN</Text>
            <Text style={s.headerTitle}>Cupones</Text>
          </View>
        </View>
        <ActivityIndicator style={{ marginTop: 40 }} color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>

      {/* ── Modal crear / editar ── */}
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
                {(['porcentaje', 'monto_fijo', 'referido'] as TipoCupon[]).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[s.toggleBtn, form.tipo === t && s.toggleBtnActive]}
                    onPress={() => setForm(p => ({ ...p, tipo: t }))}
                  >
                    <Text style={[s.toggleText, form.tipo === t && s.toggleTextActive]}>
                      {etiquetaTipo(t)}
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

              <Text style={s.label}>Descripción</Text>
              <TextInput
                style={[s.input, { height: 72, textAlignVertical: 'top' }]}
                placeholder="Ej. Descuento de bienvenida para nuevos usuarios"
                placeholderTextColor={TEXT2}
                value={form.descripcion}
                onChangeText={v => setForm(p => ({ ...p, descripcion: v }))}
                multiline
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

              <Text style={s.label}>Fecha de vencimiento (YYYY-MM-DD)</Text>
              <TextInput
                style={s.input}
                placeholder="Dejar vacío = sin vencimiento"
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

      {/* ── Header ── */}
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
        {/* Stats */}
        {cupones.length > 0 && (
          <View style={s.statsRow}>
            {[
              { label: 'Activos',   val: stats.activos,   color: GREEN  },
              { label: 'Inactivos', val: stats.inactivos, color: TEXT2  },
              { label: 'Vencidos',  val: stats.vencidos,  color: GOLD   },
              { label: 'Agotados',  val: stats.agotados,  color: RED    },
            ].map(({ label, val, color }) => (
              <View key={label} style={s.statMini}>
                <Text style={[s.statVal, { color }]}>{val}</Text>
                <Text style={s.statLabel}>{label}</Text>
              </View>
            ))}
          </View>
        )}

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
          const est = estadoCalculado(c);
          const restantes = c.uso_maximo - c.usos_actuales;
          return (
            <View key={c.id} style={[s.card, !c.activo && s.cardInactivo]}>
              {/* Fila superior: código + estado + acciones */}
              <View style={s.cardTop}>
                <View style={s.codeWrap}>
                  <Text style={s.code}>{c.codigo}</Text>
                  <View style={[s.badge, { backgroundColor: est.bg }]}>
                    <Text style={[s.badgeText, { color: est.color }]}>{est.texto}</Text>
                  </View>
                </View>
                <View style={s.cardActions}>
                  <TouchableOpacity onPress={() => abrirEditar(c)} style={s.actionBtn}>
                    <Ionicons name="pencil" size={16} color={PRIMARY} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => abrirUsos(c)} style={s.actionBtn}>
                    <Ionicons name="receipt-outline" size={16} color={BLUE} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => abrirReservas(c)} style={s.actionBtn}>
                    <Ionicons name="time-outline" size={16} color={GOLD} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => confirmarEliminar(c)} style={s.actionBtn}>
                    <Ionicons name="trash-outline" size={16} color={RED} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Tipo + descripción */}
              <View style={s.tipoRow}>
                <View style={s.tipoChip}>
                  <Text style={s.tipoChipText}>{etiquetaTipo(c.tipo)}</Text>
                </View>
                {c.descripcion ? (
                  <Text style={s.descripcion} numberOfLines={2}>{c.descripcion}</Text>
                ) : null}
              </View>

              {/* Métricas */}
              <View style={s.cardMid}>
                <View style={s.stat}>
                  <Text style={s.statVal}>{valorDisplay(c)}</Text>
                  <Text style={s.statLabel}>Descuento</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statVal}>{c.usos_actuales}</Text>
                  <Text style={s.statLabel}>Usados</Text>
                </View>
                <View style={s.stat}>
                  <Text style={[s.statVal, restantes === 0 ? { color: RED } : {}]}>{restantes}</Text>
                  <Text style={s.statLabel}>Restantes</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statVal}>{c.uso_por_usuario}</Text>
                  <Text style={s.statLabel}>Por usuario</Text>
                </View>
              </View>

              {/* Chips de metadata */}
              <View style={s.cardFoot}>
                <View style={s.footChip}>
                  <Ionicons name="calendar-outline" size={11} color={TEXT2} />
                  <Text style={s.footChipText}>
                    Vence: {c.fecha_vencimiento
                      ? (() => {
                          const vence = new Date(c.fecha_vencimiento);
                          const dias  = Math.ceil((vence.getTime() - Date.now()) / 86400000);
                          if (dias < 0) return `${formatFecha(c.fecha_vencimiento)} (vencido)`;
                          if (dias <= 7) return `en ${dias}d`;
                          return formatFecha(c.fecha_vencimiento);
                        })()
                      : 'sin límite'}
                  </Text>
                </View>
                {c.usuario_exclusivo ? (
                  <View style={s.footChip}>
                    <Ionicons name="person-outline" size={11} color={TEXT2} />
                    <Text style={s.footChipText} numberOfLines={1}>
                      {c.usuario_exclusivo.email}
                    </Text>
                  </View>
                ) : (
                  <View style={s.footChip}>
                    <Ionicons name="people-outline" size={11} color={TEXT2} />
                    <Text style={s.footChipText}>Público</Text>
                  </View>
                )}
              </View>

              {/* Toggle activo */}
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
  backBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', marginRight: 12 },

  btnNuevo:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: PRIMARY, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  btnNuevoText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  statsRow: { flexDirection: 'row', backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, marginBottom: 16, overflow: 'hidden' },
  statMini: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRightWidth: 1, borderRightColor: BORDER },

  empty:     { alignItems: 'center', gap: 14, paddingVertical: 60 },
  emptyText: { fontSize: 15, color: TEXT2, fontWeight: '600' },

  card:        { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 16, marginBottom: 12, gap: 12 },
  cardInactivo:{ opacity: 0.65 },
  cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  codeWrap:    { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  code:        { fontSize: 17, fontWeight: '900', color: PRIMARY, letterSpacing: 1 },
  badge:       { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText:   { fontSize: 11, fontWeight: '800' },
  cardActions: { flexDirection: 'row', gap: 6 },
  actionBtn:   { width: 32, height: 32, borderRadius: 9, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },

  tipoRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tipoChip:    { backgroundColor: '#EFF6FF', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tipoChipText:{ fontSize: 11, fontWeight: '700', color: BLUE },
  descripcion: { flex: 1, fontSize: 12, color: TEXT2, lineHeight: 16 },

  cardMid:  { flexDirection: 'row', justifyContent: 'space-around' },
  stat:     { alignItems: 'center', gap: 2 },
  statVal:  { fontSize: 18, fontWeight: '900', color: TEXT },
  statLabel:{ fontSize: 11, color: TEXT2, fontWeight: '600' },

  cardFoot:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  footChip:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: BG, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  footChipText:{ fontSize: 11, color: TEXT2, fontWeight: '600' },

  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  // Modal crear/editar
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalScroll:  { padding: 16, paddingTop: 60 },
  modalCard:    { backgroundColor: CARD, borderRadius: 24, padding: 24, gap: 4 },
  modalTitle:   { fontSize: 22, fontWeight: '900', color: TEXT, marginBottom: 12 },
  label:        { fontSize: 13, fontWeight: '700', color: TEXT2, marginTop: 10, marginBottom: 6 },
  input:        { backgroundColor: BG, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: TEXT, fontWeight: '600', borderWidth: 1, borderColor: BORDER },
  toggleRow:    { flexDirection: 'row', gap: 8 },
  toggleBtn:    { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: BG, borderWidth: 1.5, borderColor: 'transparent' },
  toggleBtnActive:  { backgroundColor: PRIMARY, borderColor: PRIMARY },
  toggleText:       { fontSize: 12, fontWeight: '700', color: TEXT2, textAlign: 'center' },
  toggleTextActive: { color: '#fff' },
  errText:      { fontSize: 13, color: RED, fontWeight: '600', marginTop: 6 },
  modalBtns:    { gap: 10, marginTop: 16 },
  btnPrimary:   { backgroundColor: PRIMARY, borderRadius: 50, paddingVertical: 16, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  btnSecondary: { alignItems: 'center', paddingVertical: 14 },
  btnSecondaryText: { color: TEXT2, fontWeight: '700', fontSize: 14 },
  btnOff:       { opacity: 0.5 },

  // Vista detalle
  detalleRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  detalleNombre:    { fontSize: 14, fontWeight: '700', color: TEXT },
  detalleSub:       { fontSize: 12, color: TEXT2, marginTop: 2 },
  detalleDescuento: { fontSize: 16, fontWeight: '900', color: RED },
});
