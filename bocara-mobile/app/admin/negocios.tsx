import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, TextInput, ActivityIndicator, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';
import CalendarioPicker from '@/components/CalendarioPicker';
import ListaResenas, { type ResenaLectura } from '@/components/ListaResenas';
import { mesEnCurso, nombreMes } from '@/components/SelectorPeriodo';
import { ejecutarAccionNegocio } from '@/src/utils/suspensionAdmin';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';

type Filtro = 'todos' | 'pendientes' | 'verificados' | 'suspendidos' | 'inactivos';
type PeriodoResenas = 'mes' | 'todo';
type ResumenResena = { promedio: number; total: number };

export default function AdminNegociosScreen() {
  const router = useRouter();
  const [negocios,   setNegocios]   = useState<any[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda,   setBusqueda]   = useState('');
  const [filtro,     setFiltro]     = useState<Filtro>('pendientes');
  const [procesando, setProcesando] = useState<string | null>(null);
  // Error de la última acción por negocio (p. ej. "No se puede aprobar el
  // negocio porque no tiene foto." del backend) — visible en su tarjeta.
  const [errores, setErrores] = useState<Record<string, string>>({});

  // Modal rechazo
  const [rechazarModal, setRechazarModal] = useState<any>(null);
  const [motivoRechazo, setMotivoRechazo] = useState('');

  // Promedio de reseñas por negocio: mes en curso por defecto, meses
  // históricos con el selector, o el histórico completo.
  const [periodoResenas, setPeriodoResenas] = useState<PeriodoResenas>('mes');
  const [mesResenas, setMesResenas] = useState<string>(() => mesEnCurso());
  const [resenas, setResenas] = useState<Record<string, ResumenResena> | null>(null);
  const [cargandoResenas, setCargandoResenas] = useState(false);
  // Comentarios escritos por negocio (mismo periodo) y tarjetas desplegadas.
  const [comentarios, setComentarios] = useState<Record<string, ResenaLectura[]>>({});
  const [comentariosAbiertos, setComentariosAbiertos] = useState<Record<string, boolean>>({});
  // Éxito de la última acción, arriba de la lista: tras reactivar, la tarjeta
  // puede salir del filtro actual (p. ej. "Suspendidos").
  const [exito, setExito] = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.negocios();
      setNegocios(res.data || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => {
    let vigente = true;
    setCargandoResenas(true);
    adminAPI.resenasResumen(periodoResenas === 'mes' ? mesResenas : undefined)
      .then((res) => {
        if (!vigente) return;
        setResenas(res.data?.negocios || {});
        setComentarios(res.data?.comentarios || {});
      })
      .catch(() => { if (vigente) { setResenas(null); setComentarios({}); } })
      .finally(() => { if (vigente) setCargandoResenas(false); });
    return () => { vigente = false; };
  }, [periodoResenas, mesResenas]);

  const etiquetaResenas = periodoResenas === 'mes'
    ? (mesResenas === mesEnCurso() ? `mes en curso (${nombreMes(mesResenas)})` : nombreMes(mesResenas))
    : 'histórico';
  // Sin respuesta del resumen (error de red o backend anterior), el
  // histórico cae al promedio guardado en el negocio.
  const resenaDe = (n: any): ResumenResena | null => {
    if (resenas) return resenas[n.id] || null;
    if (periodoResenas === 'todo' && n.calificacion_promedio) {
      return { promedio: Number(n.calificacion_promedio), total: Number(n.total_resenas) || 0 };
    }
    return null;
  };

  async function aprobar(n: any) {
    setProcesando(n.id);
    setErrores(prev => ({ ...prev, [n.id]: '' }));
    try {
      await adminAPI.verificarNegocio(n.id);
      cargar();
    } catch (e: any) {
      console.error('[negocios] aprobar error:', e.message);
      setErrores(prev => ({ ...prev, [n.id]: e.message || 'No se pudo aprobar el negocio.' }));
    } finally { setProcesando(null); }
  }

  async function rechazar() {
    if (!rechazarModal) return;
    setProcesando(rechazarModal.id);
    setRechazarModal(null);
    try {
      await adminAPI.rechazarNegocio(rechazarModal.id, motivoRechazo.trim() || undefined);
      cargar();
    } catch (e: any) {
      console.error('[negocios] rechazar error:', e.message);
    } finally { setProcesando(null); setMotivoRechazo(''); }
  }

  // Mismo flujo que el botón del detalle (suspensionAdmin): valida contra el
  // estado conocido antes de llamar al toggle, para no suspender por error.
  async function activar(n: any) {
    setProcesando(n.id);
    setErrores(prev => ({ ...prev, [n.id]: '' }));
    setExito('');
    const r = await ejecutarAccionNegocio(adminAPI, n, 'reactivar');
    setProcesando(null);
    if (!r.ok) {
      console.error('[negocios] activar error:', r.error);
      setErrores(prev => ({ ...prev, [n.id]: r.error }));
      return;
    }
    setNegocios(prev => prev.map(x => (x.id === n.id ? { ...x, activo: r.activo } : x)));
    setExito(r.mensaje);
    cargar();
  }

  const filtrados = negocios.filter((n) => {
    const match = !busqueda ||
      n.nombre?.toLowerCase().includes(busqueda.toLowerCase()) ||
      n.zona?.toLowerCase().includes(busqueda.toLowerCase());
    switch (filtro) {
      case 'pendientes':   return match && !n.verificado;
      case 'verificados':  return match && n.verificado && n.activo !== false;
      case 'suspendidos':  return match && n.verificado && n.activo === false;
      case 'inactivos':    return match && !n.verificado && n.activo === false;
      default: return match;
    }
  });

  const pendienteCount   = negocios.filter(n => !n.verificado).length;
  const suspendidoCount  = negocios.filter(n => n.verificado && n.activo === false).length;

  if (loading) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: BG }}>
      <ActivityIndicator color={GOLD} size="large" />
    </View>
  );

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>GESTIÓN</Text>
          <Text style={s.headerTitle}>Negocios</Text>
        </View>
        {pendienteCount > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{pendienteCount} pendientes</Text>
          </View>
        )}
      </View>

      {/* Búsqueda */}
      <View style={s.searchWrap}>
        <Ionicons name="search" size={16} color={TEXT2} style={{ marginRight: 8 }} />
        <TextInput
          style={s.searchInput}
          placeholder="Buscar por nombre o zona..."
          placeholderTextColor="#9CA3AF"
          value={busqueda}
          onChangeText={setBusqueda}
        />
        {busqueda.length > 0 && (
          <TouchableOpacity onPress={() => setBusqueda('')}>
            <Ionicons name="close-circle" size={18} color={TEXT2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filtros */}
      <View style={s.filtrosBar}>
        {([
          ['todos',       'Todos'],
          ['pendientes',  `Pendientes${pendienteCount > 0 ? ` (${pendienteCount})` : ''}`],
          ['verificados', 'Verificados'],
          ['suspendidos', `Suspendidos${suspendidoCount > 0 ? ` (${suspendidoCount})` : ''}`],
          ['inactivos',   'Inactivos'],
        ] as [Filtro, string][]).map(([f, label]) => (
          <TouchableOpacity key={f} style={[s.chip, filtro === f && s.chipActive]} onPress={() => setFiltro(f)}>
            <Text style={[s.chipText, filtro === f && s.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Reseñas: periodo del promedio mostrado en cada tarjeta */}
      <View style={s.resenasBar}>
        <Text style={s.resenasBarLabel}>⭐ Reseñas</Text>
        {([['mes', 'Por mes'], ['todo', 'Histórico']] as [PeriodoResenas, string][]).map(([p, label]) => (
          <TouchableOpacity
            key={p}
            style={[s.chip, periodoResenas === p && s.chipActive]}
            onPress={() => setPeriodoResenas(p)}
            accessibilityRole="button"
            accessibilityState={{ selected: periodoResenas === p }}
          >
            <Text style={[s.chipText, periodoResenas === p && s.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
        {periodoResenas === 'mes' && (
          <View style={s.resenasMes}>
            <CalendarioPicker
              label="Mes"
              modo="mes"
              value={mesResenas}
              maxDate={mesEnCurso()}
              onChange={(mes) => { if (mes) setMesResenas(mes); }}
            />
          </View>
        )}
        {cargandoResenas && <ActivityIndicator color={GOLD} size="small" />}
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
      >
        {exito ? <Text style={s.exitoAccion} onPress={() => setExito('')}>✓ {exito}</Text> : null}
        <Text style={s.count}>{filtrados.length} negocio{filtrados.length !== 1 ? 's' : ''}</Text>

        {filtrados.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: 60 }}>
            <Ionicons name="storefront-outline" size={48} color={BORDER} />
            <Text style={{ fontSize: 15, color: TEXT2, marginTop: 12, textAlign: 'center' }}>
              No hay negocios en esta categoría
            </Text>
          </View>
        )}

        {filtrados.map((n) => (
          <TouchableOpacity
            key={n.id}
            style={s.card}
            activeOpacity={0.85}
            onPress={() => router.push(`/admin/restaurante-detalle?id=${n.id}` as any)}
          >
            {/* Top row */}
            <View style={s.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.nombre}>{n.nombre}</Text>
                <Text style={s.meta}>{[n.categoria, n.zona && `Zona ${n.zona}`, n.ciudad].filter(Boolean).join(' · ')}</Text>
                {n.telefono && <Text style={s.meta}>{n.telefono}</Text>}
                {n.email && <Text style={s.meta}>{n.email}</Text>}
                <Text style={s.stats}>{n.total_bolsas_vendidas || 0} vendidas</Text>
                {(() => {
                  const r = resenaDe(n);
                  return (
                    <View style={s.resenaChip}>
                      <Text style={s.resenaPromedio}>{r ? `★ ${r.promedio.toFixed(1)}` : '★ —'}</Text>
                      <Text style={s.resenaDetalle}>
                        {r ? `${r.total} reseña${r.total !== 1 ? 's' : ''}` : 'Sin reseñas'} · {etiquetaResenas}
                      </Text>
                    </View>
                  );
                })()}
                {(comentarios[n.id]?.length ?? 0) > 0 && (
                  <TouchableOpacity
                    style={s.verComentariosBtn}
                    onPress={() => setComentariosAbiertos((prev) => ({ ...prev, [n.id]: !prev[n.id] }))}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: !!comentariosAbiertos[n.id] }}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={13} color={GOLD} />
                    <Text style={s.verComentariosText}>
                      {comentariosAbiertos[n.id] ? 'Ocultar comentarios' : `Ver comentarios (${comentarios[n.id].length})`}
                    </Text>
                    <Ionicons name={comentariosAbiertos[n.id] ? 'chevron-up' : 'chevron-down'} size={13} color={GOLD} />
                  </TouchableOpacity>
                )}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                {n.verificado
                  ? <View style={s.chipVer}><Text style={s.chipVerText}>Verificado</Text></View>
                  : <View style={s.chipPend}><Text style={s.chipPendText}>Pendiente</Text></View>}
                {n.activo === false && <View style={s.chipInac}><Text style={s.chipInacText}>Inactivo</Text></View>}
              </View>
            </View>

            {comentariosAbiertos[n.id] && (comentarios[n.id]?.length ?? 0) > 0 && (
              <View style={s.comentariosWrap}>
                <ListaResenas resenas={comentarios[n.id]} />
              </View>
            )}

            {/* Actions */}
            <View style={s.actionsRow}>
              {!n.verificado && (
                <>
                  <TouchableOpacity style={s.btnAprobar} onPress={() => aprobar(n)} disabled={!!procesando}>
                    {procesando === n.id
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <><Ionicons name="checkmark" size={14} color="#fff" /><Text style={s.btnAprobarText}>Aprobar</Text></>}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.btnRechazar}
                    onPress={() => { setRechazarModal(n); setMotivoRechazo(''); }}
                    disabled={!!procesando}
                  >
                    <Ionicons name="close" size={14} color="#DC2626" />
                    <Text style={s.btnRechazarText}>Rechazar</Text>
                  </TouchableOpacity>
                </>
              )}
              {n.verificado && n.activo === false && (
                <TouchableOpacity style={s.btnActivar} onPress={() => activar(n)} disabled={!!procesando}>
                  {procesando === n.id
                    ? <ActivityIndicator color="#16A34A" size="small" />
                    : <><Ionicons name="play-circle" size={14} color="#16A34A" /><Text style={s.btnActivarText}>Reactivar negocio</Text></>}
                </TouchableOpacity>
              )}
              <TouchableOpacity style={s.btnVer} onPress={() => router.push(`/admin/restaurante-detalle?id=${n.id}` as any)}>
                <Ionicons name="eye-outline" size={14} color={TEXT2} />
                <Text style={s.btnVerText}>Ver perfil</Text>
              </TouchableOpacity>
            </View>
            {errores[n.id] ? <Text style={s.errorAccion}>⚠️ {errores[n.id]}</Text> : null}
          </TouchableOpacity>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Modal: Rechazar */}
      <Modal visible={!!rechazarModal} transparent animationType="fade" onRequestClose={() => setRechazarModal(null)}>
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar negocio</Text>
            <Text style={s.modalSub}>{rechazarModal?.nombre}</Text>
            <Text style={s.modalLabel}>Motivo (opcional)</Text>
            <TextInput
              style={s.modalInput}
              value={motivoRechazo}
              onChangeText={setMotivoRechazo}
              placeholder="Ej. Documentación incompleta..."
              placeholderTextColor="#9CA3AF"
              multiline
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setRechazarModal(null)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalSuspendBtn, { backgroundColor: '#DC2626' }]} onPress={rechazar}>
                <Ionicons name="close-circle" size={16} color="#fff" />
                <Text style={s.modalSuspendText}>Rechazar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: BG },
  header:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:  { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  badge:      { backgroundColor: '#FEF3C7', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: '#FDE68A' },
  badgeText:  { color: '#92400E', fontSize: 12, fontWeight: '800' },

  searchWrap:  { flexDirection: 'row', alignItems: 'center', margin: 12, backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 14, paddingVertical: 10 },
  searchInput: { flex: 1, fontSize: 14, color: TEXT },

  filtrosBar:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, marginBottom: 8 },
  chip:         { borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: CARD },
  chipActive:   { backgroundColor: GOLD, borderColor: GOLD },
  chipText:     { fontSize: 12, color: TEXT2, fontWeight: '600' },
  chipTextActive: { color: '#fff', fontWeight: '800' },

  resenasBar:      { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 14, marginBottom: 8 },
  resenasBarLabel: { fontSize: 12, color: TEXT, fontWeight: '700' },
  resenasMes:      { minWidth: 180, maxWidth: 260, flexGrow: 1 },
  resenaChip:      { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginTop: 6, backgroundColor: '#FFF7ED', borderRadius: 10, borderWidth: 1, borderColor: '#FED7AA', paddingHorizontal: 8, paddingVertical: 3 },
  resenaPromedio:  { fontSize: 12, fontWeight: '800', color: '#9A3412' },
  resenaDetalle:   { fontSize: 11, color: '#9A3412' },
  verComentariosBtn:  { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, marginTop: 6, paddingVertical: 2 },
  verComentariosText: { fontSize: 12, fontWeight: '700', color: GOLD },
  comentariosWrap:    { marginBottom: 12 },

  scroll:  { padding: 14 },
  count:   { fontSize: 11, color: TEXT2, marginBottom: 10, fontWeight: '600' },

  card:     { backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: BORDER, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  cardTop:  { flexDirection: 'row', marginBottom: 12 },
  nombre:   { fontSize: 15, fontWeight: '800', color: TEXT },
  meta:     { fontSize: 12, color: TEXT2, marginTop: 2 },
  stats:    { fontSize: 11, color: TEXT2, marginTop: 4 },

  chipVer:      { backgroundColor: '#F0FDF4', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#BBF7D0' },
  chipVerText:  { fontSize: 11, color: '#166534', fontWeight: '700' },
  chipPend:     { backgroundColor: '#FFFBEB', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#FDE68A' },
  chipPendText: { fontSize: 11, color: '#92400E', fontWeight: '700' },
  chipInac:     { backgroundColor: '#F9FAFB', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: BORDER },
  chipInacText: { fontSize: 11, color: TEXT2, fontWeight: '600' },

  actionsRow:       { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: BORDER, paddingTop: 12 },
  btnAprobar:       { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#16A34A', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnAprobarText:   { color: '#fff', fontWeight: '700', fontSize: 12 },
  btnRechazar:      { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnRechazarText:  { color: '#DC2626', fontWeight: '700', fontSize: 12 },
  btnSuspender:     { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FDE68A', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnSuspenderText: { color: '#D97706', fontWeight: '700', fontSize: 12 },
  btnActivar:       { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnActivarText:   { color: '#16A34A', fontWeight: '700', fontSize: 12 },
  errorAccion:      { marginTop: 10, color: '#DC2626', fontSize: 12, fontWeight: '700' },
  exitoAccion:      { marginBottom: 10, color: '#16A34A', fontSize: 12, fontWeight: '700' },
  btnVer:           { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, justifyContent: 'center' },
  btnVerText:       { color: TEXT2, fontWeight: '600', fontSize: 12 },

  overlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard:   { backgroundColor: CARD, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderTopWidth: 1, borderTopColor: BORDER },
  modalTitle:  { fontSize: 18, fontWeight: '900', color: TEXT, marginBottom: 2 },
  modalSub:    { fontSize: 14, color: TEXT2, marginBottom: 16 },
  modalLabel:  { fontSize: 13, color: TEXT, fontWeight: '600', marginBottom: 8 },
  modalNote:   { fontSize: 12, color: TEXT2, marginBottom: 16, lineHeight: 18 },
  modalInput:  { backgroundColor: BG, borderRadius: 12, borderWidth: 1, borderColor: BORDER, padding: 14, fontSize: 14, color: TEXT, minHeight: 80, textAlignVertical: 'top', marginBottom: 12 },
  modalActions:    { flexDirection: 'row', gap: 10 },
  modalCancelBtn:  { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 13, alignItems: 'center' },
  modalCancelText: { color: TEXT2, fontWeight: '600', fontSize: 14 },
  modalSuspendBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#D97706', borderRadius: 12, padding: 13 },
  modalSuspendText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
