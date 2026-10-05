import { publicacionVencida } from '@/src/utils/horarioRecogida';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Alert, Platform, RefreshControl, ActivityIndicator, Modal,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { bolsasAPI, negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import type { Bolsa, CrearBolsaPayload } from '@/src/types';
import { normalizarHora } from '@/src/utils/hora';
import {
  estadoPublicacion, bloqueadaParaEditar, textoBotonEditar, avisoAlEditar, payloadDeEdicion, mensajeTrasGuardar,
  horaParaFormulario,
} from '@/src/utils/estadoPublicacion';

// Promoción tal como la devuelve GET /bolsas?mi_negocio=true: incluye el estado
// de revisión del admin, igual que BolsaRestaurante en restaurante/bolsas.tsx.
interface CuponRestaurante extends Bolsa {
  estado_aprobacion?: 'pendiente' | 'aprobado' | 'rechazado' | null;
  motivo_rechazo?: string | null;
}

// `categoria` no tiene enum en backend (validarDatosBolsa no lo restringe) —
// es una lista fija solo para esta UI, no un contrato de backend.
const TIPOS_DESCUENTO = ['Porcentaje', 'Monto fijo', '2x1', 'Gratis', 'Especial'];

interface CuponForm {
  nombre: string;
  contenido: string;
  categoria: string;
  descripcion: string;
  precio_original: string;
  precio_descuento: string;
  cantidad_disponible: string;
  hora_recogida_inicio: string;
  hora_recogida_fin: string;
}

const FORM_INIT: CuponForm = {
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

// Alert.alert no hace nada en react-native-web: en web se usa el diálogo del
// navegador (mismo criterio que restaurante/bolsas.tsx). Sin esto, en la app web
// no se veían ni los errores del backend ni la confirmación de guardado.
function avisar(titulo: string, mensaje: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(mensaje);
  else Alert.alert(titulo, mensaje);
}

function construirPayload(form: CuponForm, horaInicio: string, horaFin: string): CrearBolsaPayload {
  return {
    nombre: form.nombre.trim(),
    contenido: form.contenido.trim().toUpperCase(),
    categoria: form.categoria,
    descripcion: form.descripcion.trim(),
    precio_original: parseFloat(form.precio_original) || 0,
    precio_descuento: parseFloat(form.precio_descuento),
    cantidad_disponible: parseInt(form.cantidad_disponible) || 1,
    hora_recogida_inicio: horaInicio,
    hora_recogida_fin: horaFin,
    tipo: 'cupon',
    // fecha_disponible (fecha de publicación) es obligatoria en el backend
    // (ver routes/bolsas.js). Esta pantalla no tiene selector propio de
    // fecha — se publica siempre a partir de hoy en Guatemala (UTC-6 fijo,
    // sin horario de verano — igual que services/horarioGuatemala.js en el
    // backend). Restar 6h antes de tomar la fecha evita que, cerca de la
    // medianoche UTC, esto calcule "mañana" y la publicación nazca con
    // motivo "no_iniciada" hasta el día siguiente.
    fecha_disponible: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

export default function CuponesRestauranteScreen() {
  const [cupones, setCupones] = useState<CuponRestaurante[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(false);
  const [editando, setEditando] = useState<CuponRestaurante | null>(null);
  const [saving, setSaving] = useState(false);
  const [negocioId, setNegocioId] = useState<string>('');
  const [form, setForm] = useState<CuponForm>({ ...FORM_INIT });
  const [errorGuardar, setErrorGuardar] = useState('');
  // Payload que el formulario cargó al abrir "Editar": base para mandar solo
  // los campos que el usuario cambió (ver payloadDeEdicion).
  const cargadoAlEditar = useRef<CrearBolsaPayload | null>(null);

  const cargar = useCallback(async () => {
    try {
      const negRes = await negociosAPI.miNegocio();
      const nid = negRes.data?.id;
      setNegocioId(nid || '');
      if (!nid) return;
      const res = await bolsasAPI.listar({ negocio_id: nid, mi_negocio: 'true' });
      setCupones((res.data || []).filter((b: CuponRestaurante) => b.tipo === 'cupon'));
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Re-sincronizar al recuperar el foco — mismo criterio que restaurante/bolsas.tsx:
  // si el admin cambia el estado de una promoción (comparte estado_aprobacion con
  // las bolsas vía /admin/contenido) mientras esta pantalla ya está abierta, no
  // debe quedarse con datos viejos hasta un pull-to-refresh manual.
  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  function abrirNuevo() {
    setEditando(null);
    setErrorGuardar('');
    cargadoAlEditar.current = null;
    setForm({ ...FORM_INIT });
    setModal(true);
  }

  function abrirEditar(c: CuponRestaurante) {
    setEditando(c);
    setErrorGuardar('');
    const cargado: CuponForm = {
      nombre: c.nombre || '',
      contenido: c.contenido || '',
      categoria: c.categoria || 'Porcentaje',
      descripcion: c.descripcion || '',
      precio_original: String(c.precio_original || ''),
      precio_descuento: String(c.precio_descuento || ''),
      cantidad_disponible: String(c.cantidad_disponible || '1'),
      hora_recogida_inicio: horaParaFormulario(c.hora_recogida_inicio, '18:00'),
      hora_recogida_fin: horaParaFormulario(c.hora_recogida_fin, '20:00'),
    };
    cargadoAlEditar.current = construirPayload(cargado,
      normalizarHora(cargado.hora_recogida_inicio) || cargado.hora_recogida_inicio,
      normalizarHora(cargado.hora_recogida_fin) || cargado.hora_recogida_fin);
    setForm(cargado);
    setModal(true);
  }

  async function guardar() {
    if (saving) return;
    if (publicacionVencida(form)) {
      return avisar('Publicación vencida', 'El horario de recogida ya venció. Corrígelo antes de publicar.');
    }
    if (!form.nombre.trim() || !form.contenido.trim()) {
      return avisar('Campos requeridos', 'Nombre y código del cupón son obligatorios');
    }
    if (form.precio_descuento == null || form.precio_descuento === '') {
      return avisar('Campos requeridos', 'El precio con descuento es obligatorio');
    }
    const horaInicio = normalizarHora(form.hora_recogida_inicio);
    if (!horaInicio) return avisar('Error', 'Hora de inicio inválida. Usa el formato HH:MM, por ejemplo 08:00 o 20:00.');
    const horaFin = normalizarHora(form.hora_recogida_fin);
    if (!horaFin) return avisar('Error', 'Hora de fin inválida. Usa el formato HH:MM, por ejemplo 08:00 o 20:00.');
    // negocio_id solo se manda al crear: PUT /bolsas/:id lo ignora (no está en
    // su allowlist de campos editables), así que mandarlo al editar no
    // cambiaría nada — ver ActualizarBolsaPayload en src/types/index.ts.
    const payload = construirPayload(form, horaInicio, horaFin);
    const cambios = editando ? payloadDeEdicion(editando, payload, cargadoAlEditar.current) : payload;
    if (editando && Object.keys(cambios).length === 0) {
      setModal(false);
      return avisar('Sin cambios', 'No modificaste ningún dato.');
    }
    setSaving(true);
    setErrorGuardar('');
    try {
      // Siempre se edita la MISMA publicación (PUT /bolsas/:id), nunca se crea
      // una copia: corregir una rechazada la devuelve a Pendiente.
      const res = editando
        ? await bolsasAPI.actualizar(editando.id, cambios)
        : await bolsasAPI.crear({ ...payload, negocio_id: negocioId });
      // La tarjeta refleja el estado devuelto por el backend al instante (p. ej.
      // Rechazada → Pendiente), sin esperar a la recarga de abajo.
      const guardada: CuponRestaurante | undefined = res.data?.id ? res.data : undefined;
      if (guardada) {
        setCupones(prev => editando
          ? prev.map(c => (c.id === guardada.id ? { ...c, ...guardada } : c))
          : [guardada, ...prev]);
      }
      setModal(false);
      avisar('Listo', mensajeTrasGuardar(res.data?.estado_aprobacion, !!editando));
      cargar();
    } catch (e: any) {
      // El formulario queda abierto con lo que el usuario escribió.
      const mensaje = e?.message || 'No se pudo guardar la promoción';
      setErrorGuardar(mensaje);
      avisar('Error', mensaje);
    } finally {
      setSaving(false);
    }
  }

  // Volver a mostrar una promoción aprobada que el restaurante ocultó. Mismo
  // endpoint que el switch de restaurante/bolsas.tsx: solo cambia `activo`, no
  // la manda a revisión.
  async function activar(c: CuponRestaurante) {
    if (publicacionVencida(c)) {
      return avisar('Promoción vencida', 'El horario ya venció. Edítala para actualizarlo antes de activarla.');
    }
    try {
      await bolsasAPI.actualizar(c.id, { activo: true });
      cargar();
    } catch (e: any) {
      avisar('Error', e.message || 'No se pudo activar la promoción');
    }
  }

  async function desactivar(id: string) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (!window.confirm('¿Seguro que quieres desactivar este cupón?')) return;
      try { await bolsasAPI.eliminar(id); cargar(); } catch (e: any) { avisar('Error', e.message || 'No se pudo desactivar'); }
      return;
    }
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
        <Text style={s.headerTitle}>🏷️ Promociones</Text>
        <TouchableOpacity style={s.addBtn} onPress={abrirNuevo}>
          <Text style={s.addBtnText}>+ Nueva</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {cupones.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>🎫</Text>
            <Text style={s.emptyText}>Aún no tienes promociones publicadas</Text>
            <TouchableOpacity style={s.emptyBtn} onPress={abrirNuevo}>
              <Text style={s.emptyBtnText}>Crear primera promoción</Text>
            </TouchableOpacity>
          </View>
        )}

        {cupones.map((c: CuponRestaurante) => {
          const descuento = c.precio_original > 0
            ? Math.round((1 - c.precio_descuento / c.precio_original) * 100)
            : 0;
          const aprobada = c.estado_aprobacion === 'aprobado' || !c.estado_aprobacion;
          const rechazada = c.estado_aprobacion === 'rechazado';
          const estado = estadoPublicacion(c);
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
                  <View style={s.estadoRow}>
                    <Text style={[s.estado, ESTILO_ESTADO[estado.clave]]}>{estado.etiqueta}</Text>
                    {estado.visible && <Text style={[s.estado, s.estadoVisible]}>Visible para clientes</Text>}
                  </View>
                  {estado.ayuda ? <Text style={s.ayuda}>{estado.ayuda}</Text> : null}
                  {c.motivo_rechazo ? <Text style={s.motivo}>Motivo: {c.motivo_rechazo}</Text> : null}
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
                {/* En revisión inicial el backend responde 409 a cualquier edición. */}
                {!bloqueadaParaEditar(c) && (
                  <TouchableOpacity style={s.btnEditar} onPress={() => abrirEditar(c)}>
                    <Text style={s.btnEditarText}>✏️ {textoBotonEditar(c)}</Text>
                  </TouchableOpacity>
                )}
                {c.activo && !rechazada && (
                  <TouchableOpacity style={s.btnEliminar} onPress={() => desactivar(c.id)}>
                    <Text style={s.btnEliminarText}>Desactivar</Text>
                  </TouchableOpacity>
                )}
                {aprobada && !c.activo && (
                  <TouchableOpacity style={s.btnActivar} onPress={() => activar(c)}>
                    <Text style={s.btnActivarText}>Activar</Text>
                  </TouchableOpacity>
                )}
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
            <Text style={s.modalTitle}>{editando ? 'Editar cupón' : 'Nueva promoción'}</Text>
            <TouchableOpacity onPress={guardar} disabled={saving}>
              <Text style={[s.saveText, saving && { opacity: 0.5 }]}>{saving ? 'Guardando…' : 'Guardar'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            {editando && avisoAlEditar(editando) ? <Text style={s.avisoEdicion}>{avisoAlEditar(editando)}</Text> : null}
            {editando?.motivo_rechazo ? <Text style={s.motivo}>Motivo del administrador: {editando.motivo_rechazo}</Text> : null}
            {errorGuardar ? <Text style={s.errorGuardar}>{errorGuardar}</Text> : null}
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
  btnActivar: { flex: 1, borderWidth: 1.5, borderColor: Colors.green, borderRadius: 10, padding: 9, alignItems: 'center' },
  btnActivarText: { color: Colors.green, fontWeight: '700', fontSize: 13 },
  estadoRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  estado: { fontSize: 11, fontWeight: '800', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  estadoRevision: { backgroundColor: '#FEF3C7', color: '#92400E' },
  estadoRechazada: { backgroundColor: '#FEE2E2', color: Colors.error },
  estadoVisible: { backgroundColor: '#DCFCE7', color: '#166534' },
  estadoOculta: { backgroundColor: Colors.border, color: Colors.textSecondary },
  ayuda: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  motivo: { fontSize: 12, color: Colors.error, marginTop: 4, fontWeight: '600' },
  avisoEdicion: { fontSize: 13, color: '#92400E', backgroundColor: '#FEF3C7', borderRadius: 10, padding: 10, marginBottom: 12 },
  errorGuardar: { fontSize: 13, color: Colors.error, backgroundColor: '#FEE2E2', borderRadius: 10, padding: 10, marginBottom: 12, fontWeight: '600' },
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

const ESTILO_ESTADO = {
  pendiente: s.estadoRevision,
  cambios: s.estadoRevision,
  rechazada: s.estadoRechazada,
  inactiva: s.estadoOculta,
  vencida: s.estadoOculta,
  agotada: s.estadoOculta,
  aprobada: s.estadoVisible,
};
