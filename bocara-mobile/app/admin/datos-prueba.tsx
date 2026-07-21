import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';
const DARK2 = '#0F172A';

interface Candidato {
  tabla: string;
  id: string;
  motivo: string;
  detalle: Record<string, any>;
}

export default function AdminDatosPruebaScreen() {
  const [candidatos, setCandidatos] = useState<Candidato[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.datosPrueba();
      setCandidatos(res.data?.candidatos || []);
      setError('');
    } catch (e: any) {
      setError(e.message || 'No se pudo cargar la lista');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return (
    <View style={[s.loading, { backgroundColor: DARK2 }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerSub}>PANEL ADMIN — SOLO LECTURA</Text>
        <Text style={s.headerTitle}>Datos de prueba</Text>
        <Text style={s.headerNote}>
          Esta lista identifica registros creados por el flujo de prueba
          (demo@bocara.gt vía /auth/setup-demo). No se borra nada
          automáticamente — revisa cada fila y elimínala manualmente en
          Supabase si corresponde.
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {error ? (
          <View style={s.errorCard}><Text style={s.errorText}>⚠️ {error}</Text></View>
        ) : null}

        {!error && candidatos.length === 0 ? (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>✅</Text>
            <Text style={s.emptyTitle}>Sin datos de prueba conocidos</Text>
            <Text style={s.emptySub}>No se encontró el usuario demo@bocara.gt ni registros asociados.</Text>
          </View>
        ) : null}

        {candidatos.map((c) => (
          <View key={`${c.tabla}-${c.id}`} style={s.card}>
            <View style={s.cardTop}>
              <View style={s.tablaBadge}><Text style={s.tablaBadgeText}>{c.tabla}</Text></View>
              <Text style={s.cardId} numberOfLines={1}>{c.id}</Text>
            </View>
            <Text style={s.motivo}>{c.motivo}</Text>
            {Object.entries(c.detalle || {}).map(([k, v]) => (
              <Text key={k} style={s.detalleRow}>{k}: {String(v)}</Text>
            ))}
          </View>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK2 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 20, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerSub: { fontSize: 10, color: '#64748B', fontWeight: '700', letterSpacing: 1.2 },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white, marginTop: 2 },
  headerNote: { fontSize: 12, color: '#94A3B8', marginTop: 10, lineHeight: 18 },
  scroll: { padding: 16 },
  empty: { alignItems: 'center', paddingVertical: 80 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.white, marginTop: 12 },
  emptySub: { fontSize: 13, color: '#64748B', marginTop: 6, textAlign: 'center' },
  errorCard: { backgroundColor: '#450A0A', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#991B1B' },
  errorText: { color: '#FCA5A5', fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: DARK, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 },
  tablaBadge: { backgroundColor: '#451A03', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tablaBadgeText: { fontSize: 10, color: '#F59E0B', fontWeight: '800' },
  cardId: { fontSize: 11, color: '#64748B', flex: 1 },
  motivo: { fontSize: 13, color: '#E2E8F0', fontWeight: '600', marginBottom: 6 },
  detalleRow: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
});
