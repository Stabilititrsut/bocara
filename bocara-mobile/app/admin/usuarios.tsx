import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, TextInput, ActivityIndicator,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';

const ROL_CONFIG: Record<string, { color: string; bg: string; emoji: string }> = {
  cliente:     { color: '#60A5FA', bg: '#1E3A5F', emoji: '👤' },
  restaurante: { color: '#FBBF24', bg: '#451A03', emoji: '🏪' },
  admin:       { color: '#A78BFA', bg: '#2E1065', emoji: '🔐' },
  suspendido:  { color: '#F87171', bg: '#450A0A', emoji: '🚫' },
};

export default function AdminUsuariosScreen() {
  const [usuarios, setUsuarios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [rolFiltro, setRolFiltro] = useState('todos');
  const [confirmando, setConfirmando] = useState<{ id: string; accion: string; nombre: string; rol?: string } | null>(null);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.usuarios();
      setUsuarios(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function ejecutarAccion() {
    if (!confirmando) return;
    const { id, accion, rol } = confirmando;
    setProcesando(id);
    setConfirmando(null);
    setErrores(prev => ({ ...prev, [id]: '' }));
    try {
      if (accion === 'suspender') await adminAPI.suspenderUsuario(id);
      else if (accion === 'rehabilitar') await adminAPI.rehabilitarUsuario(id, rol || 'cliente');
      else if (accion === 'cambiar_rol') await adminAPI.gestionarUsuario(id, { rol });
      cargar();
    } catch (e: any) {
      setErrores(prev => ({ ...prev, [id]: e.message || 'Error al procesar' }));
    } finally {
      setProcesando(null);
    }
  }

  const filtrados = usuarios.filter((u) => {
    const q = busqueda.toLowerCase();
    const matchBusq = !busqueda || u.nombre?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.apellido?.toLowerCase().includes(q);
    const matchRol = rolFiltro === 'todos' || u.rol === rolFiltro;
    return matchBusq && matchRol;
  });

  const conteos: Record<string, number> = { todos: usuarios.length };
  for (const u of usuarios) conteos[u.rol] = (conteos[u.rol] || 0) + 1;

  if (loading) return <View style={[s.loading, { backgroundColor: '#0F172A' }]}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}><Text style={s.headerTitle}>👥 Gestión de usuarios</Text></View>

      <View style={s.searchRow}>
        <TextInput
          style={s.search}
          placeholder="Buscar por nombre o email..."
          placeholderTextColor="#475569"
          value={busqueda}
          onChangeText={setBusqueda}
        />
      </View>

      <View style={s.filtros}>
        {(['todos', 'cliente', 'restaurante', 'admin', 'suspendido'] as const).map((r) => {
          const cfg = ROL_CONFIG[r];
          const isActive = rolFiltro === r;
          return (
            <TouchableOpacity
              key={r}
              style={[s.chip, isActive && { backgroundColor: cfg?.color || Colors.orange, borderColor: cfg?.color || Colors.orange }]}
              onPress={() => setRolFiltro(r)}
            >
              <Text style={[s.chipText, isActive && { color: Colors.white }]}>
                {r === 'todos' ? `Todos (${conteos.todos || 0})` : `${cfg?.emoji || ''} ${r} (${conteos[r] || 0})`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        <Text style={s.count}>{filtrados.length} usuario{filtrados.length !== 1 ? 's' : ''}</Text>

        {filtrados.map((u) => {
          const cfg = ROL_CONFIG[u.rol] || ROL_CONFIG.cliente;
          const fechaReg = u.created_at || u.creado_en;
          return (
            <View key={u.id} style={s.card}>
              <View style={s.cardTop}>
                <View style={[s.avatar, { backgroundColor: cfg.bg }]}>
                  <Text style={{ fontSize: 20 }}>{cfg.emoji}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.nombre}>{u.nombre} {u.apellido || ''}</Text>
                  <Text style={s.email}>{u.email}</Text>
                  {u.telefono ? <Text style={s.meta}>📞 {u.telefono}</Text> : null}
                  {fechaReg ? <Text style={s.meta}>Desde {new Date(fechaReg).toLocaleDateString('es-GT')}</Text> : null}
                </View>
                <View style={[s.rolBadge, { backgroundColor: cfg.bg }]}>
                  <Text style={[s.rolText, { color: cfg.color }]}>{u.rol}</Text>
                </View>
              </View>

              <View style={s.stats}>
                <Text style={s.statItem}>📦 {u.total_bolsas_salvadas || 0} bolsas</Text>
                <Text style={s.statItem}>⭐ {u.puntos || 0} pts</Text>
                <Text style={s.statItem}>💰 Q{(u.total_ahorrado || 0).toFixed(0)}</Text>
              </View>

              {errores[u.id] ? (
                <View style={s.errorCard}><Text style={s.errorText}>⚠️ {errores[u.id]}</Text></View>
              ) : null}

              {confirmando?.id === u.id ? (
                <View style={s.confirmCard}>
                  <Text style={s.confirmText}>
                    {confirmando.accion === 'suspender' && `¿Suspender a "${confirmando.nombre}"? No podrá iniciar sesión.`}
                    {confirmando.accion === 'rehabilitar' && `¿Rehabilitar a "${confirmando.nombre}" como ${confirmando.rol}?`}
                    {confirmando.accion === 'cambiar_rol' && `¿Cambiar a "${confirmando.nombre}" al rol "${confirmando.rol}"?`}
                  </Text>
                  <View style={s.confirmRow}>
                    <TouchableOpacity style={s.confirmNo} onPress={() => setConfirmando(null)}>
                      <Text style={s.confirmNoText}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.confirmSi, procesando === u.id && { opacity: 0.5 }]}
                      onPress={ejecutarAccion}
                      disabled={procesando === u.id}
                    >
                      {procesando === u.id
                        ? <ActivityIndicator color={Colors.white} size="small" />
                        : <Text style={s.confirmSiText}>Confirmar</Text>
                      }
                    </TouchableOpacity>
                  </View>
                </View>
              ) : u.rol !== 'admin' ? (
                <View style={s.actions}>
                  {u.rol === 'suspendido' ? (
                    <TouchableOpacity style={s.btnRehabilitar} onPress={() => setConfirmando({ id: u.id, accion: 'rehabilitar', nombre: u.nombre, rol: 'cliente' })}>
                      <Text style={s.btnRehabilitarText}>▶ Rehabilitar</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={s.btnSuspender} onPress={() => setConfirmando({ id: u.id, accion: 'suspender', nombre: u.nombre })}>
                      <Text style={s.btnSuspenderText}>⏸ Suspender</Text>
                    </TouchableOpacity>
                  )}
                  {u.rol === 'cliente' && (
                    <TouchableOpacity style={s.btnRol} onPress={() => setConfirmando({ id: u.id, accion: 'cambiar_rol', nombre: u.nombre, rol: 'restaurante' })}>
                      <Text style={s.btnRolText}>→ Restaurante</Text>
                    </TouchableOpacity>
                  )}
                  {(u.rol === 'cliente' || u.rol === 'restaurante') && (
                    <TouchableOpacity style={[s.btnRol, { borderColor: '#7C3AED' }]} onPress={() => setConfirmando({ id: u.id, accion: 'cambiar_rol', nombre: u.nombre, rol: 'admin' })}>
                      <Text style={[s.btnRolText, { color: '#A78BFA' }]}>→ Admin</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 16, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white },
  searchRow: { padding: 12, paddingBottom: 4, backgroundColor: DARK },
  search: { backgroundColor: '#334155', borderRadius: 12, padding: 12, fontSize: 14, color: Colors.white },
  filtros: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: DARK, marginBottom: 2 },
  chip: { borderWidth: 1.5, borderColor: '#334155', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#1E293B' },
  chipText: { fontSize: 12, color: '#94A3B8', fontWeight: '600' },
  scroll: { padding: 14 },
  count: { fontSize: 12, color: '#64748B', marginBottom: 12 },
  card: { backgroundColor: DARK, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  avatar: { borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nombre: { fontSize: 15, fontWeight: '800', color: Colors.white },
  email: { fontSize: 12, color: '#94A3B8', marginTop: 1 },
  meta: { fontSize: 11, color: '#64748B', marginTop: 1 },
  rolBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  rolText: { fontSize: 11, fontWeight: '700' },
  stats: { flexDirection: 'row', gap: 16, backgroundColor: '#0F172A', borderRadius: 10, padding: 8, marginBottom: 8 },
  statItem: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 10, flexWrap: 'wrap' },
  btnSuspender: { borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  btnSuspenderText: { color: '#F87171', fontSize: 12, fontWeight: '700' },
  btnRehabilitar: { borderWidth: 1.5, borderColor: '#065F46', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  btnRehabilitarText: { color: '#34D399', fontSize: 12, fontWeight: '700' },
  btnRol: { borderWidth: 1.5, borderColor: '#1D4ED8', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  btnRolText: { color: '#60A5FA', fontSize: 12, fontWeight: '700' },
  errorCard: { backgroundColor: '#450A0A', borderRadius: 8, padding: 8, marginBottom: 8, borderWidth: 1, borderColor: '#991B1B' },
  errorText: { color: '#FCA5A5', fontSize: 12, fontWeight: '600' },
  confirmCard: { backgroundColor: '#1E293B', borderRadius: 10, padding: 12, borderWidth: 1.5, borderColor: '#334155', marginTop: 4 },
  confirmText: { color: '#E2E8F0', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  confirmRow: { flexDirection: 'row', gap: 8 },
  confirmNo: { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 8, padding: 8, alignItems: 'center' },
  confirmNoText: { color: '#94A3B8', fontWeight: '700', fontSize: 12 },
  confirmSi: { flex: 1, backgroundColor: Colors.orange, borderRadius: 8, padding: 8, alignItems: 'center' },
  confirmSiText: { color: Colors.white, fontWeight: '800', fontSize: 12 },
});
