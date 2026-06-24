import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';
const GREEN  = '#22C55E';
const RED    = '#EF4444';

type CuboStatus = {
  configurado: boolean;
  ambiente: string;
  pagos_habilitados: boolean;
  api_url_produccion: boolean;
  api_key_configurada: boolean;
  webhook_url: string;
  verificacion_webhook_disponible: boolean;
};

function Fila({
  label,
  valor,
  ok,
}: {
  label: string;
  valor: string;
  ok: boolean;
}) {
  return (
    <View style={s.fila}>
      <Text style={s.filaLabel}>{label}</Text>
      <View style={s.filaRight}>
        <Ionicons
          name={ok ? 'checkmark-circle' : 'close-circle'}
          size={18}
          color={ok ? GREEN : RED}
          style={{ marginRight: 6 }}
        />
        <Text style={[s.filaValor, { color: ok ? TEXT : RED }]}>{valor}</Text>
      </View>
    </View>
  );
}

export default function CuboStatusScreen() {
  const [status,   setStatus]   = useState<CuboStatus | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [lastAt,   setLastAt]   = useState<Date | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminAPI.cuboStatus();
      setStatus(res.data);
      setLastAt(new Date());
    } catch (e: any) {
      setError(e.message || 'Error al consultar el estado');
    } finally {
      setLoading(false);
    }
  }, []);

  const listo =
    status !== null &&
    status.ambiente === 'production' &&
    status.pagos_habilitados &&
    status.api_url_produccion &&
    status.api_key_configurada;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTag}>BOCARA ADMIN</Text>
          <Text style={s.headerTitle}>Estado de Cubo Pago</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Banner listo / no listo */}
        {status !== null && (
          <View style={[s.banner, listo ? s.bannerOk : s.bannerError]}>
            <Ionicons
              name={listo ? 'checkmark-circle' : 'alert-circle'}
              size={22}
              color={listo ? '#166534' : '#991B1B'}
            />
            <Text style={[s.bannerText, { color: listo ? '#166534' : '#991B1B' }]}>
              {listo ? 'Cubo Pago listo para piloto' : 'Configuración incompleta'}
            </Text>
          </View>
        )}

        {/* Card de estado */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Configuración actual</Text>

          {status === null && !loading && !error && (
            <Text style={s.hint}>Toca «Actualizar estado» para consultar.</Text>
          )}

          {error && (
            <View style={s.errorBox}>
              <Ionicons name="warning-outline" size={16} color={RED} />
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          {loading && (
            <View style={s.loadingBox}>
              <ActivityIndicator color={GOLD} />
              <Text style={s.loadingText}>Consultando…</Text>
            </View>
          )}

          {status !== null && !loading && (
            <>
              <Fila
                label="Ambiente"
                valor={status.ambiente}
                ok={status.ambiente === 'production'}
              />
              <View style={s.sep} />
              <Fila
                label="Pagos habilitados"
                valor={status.pagos_habilitados ? 'Sí' : 'No'}
                ok={status.pagos_habilitados}
              />
              <View style={s.sep} />
              <Fila
                label="API URL de producción"
                valor={status.api_url_produccion ? 'Sí' : 'No'}
                ok={status.api_url_produccion}
              />
              <View style={s.sep} />
              <Fila
                label="API key configurada"
                valor={status.api_key_configurada ? 'Sí' : 'No'}
                ok={status.api_key_configurada}
              />
            </>
          )}
        </View>

        {/* Webhook */}
        {status?.webhook_url ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>Webhook</Text>
            <Text style={s.webhookUrl}>{status.webhook_url}</Text>
            <Text style={s.webhookNote}>
              Registrar esta URL en Cubo Admin → Developers → Webhooks.
            </Text>
          </View>
        ) : null}

        {/* Botón */}
        <TouchableOpacity
          style={[s.btn, loading && s.btnDisabled]}
          onPress={cargar}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Ionicons name="refresh" size={18} color="#fff" />
          }
          <Text style={s.btnText}>Actualizar estado</Text>
        </TouchableOpacity>

        {lastAt && (
          <Text style={s.lastAt}>
            Última consulta: {lastAt.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </Text>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: BG },
  header:      { backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:   { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  scroll:      { padding: 16 },

  banner:      { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1 },
  bannerOk:    { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' },
  bannerError: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  bannerText:  { fontSize: 15, fontWeight: '700', flex: 1 },

  card:        { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 16, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  cardTitle:   { fontSize: 11, fontWeight: '700', color: TEXT2, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 14 },

  fila:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  filaLabel:   { fontSize: 14, color: TEXT2 },
  filaRight:   { flexDirection: 'row', alignItems: 'center' },
  filaValor:   { fontSize: 14, fontWeight: '700' },
  sep:         { height: 1, backgroundColor: BORDER },

  hint:        { fontSize: 13, color: TEXT2, textAlign: 'center', paddingVertical: 16 },

  errorBox:    { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FEF2F2', borderRadius: 8, padding: 12, marginTop: 8 },
  errorText:   { fontSize: 13, color: RED, flex: 1 },

  loadingBox:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  loadingText: { fontSize: 13, color: TEXT2 },

  webhookUrl:  { fontSize: 12, color: TEXT, fontFamily: 'monospace' as any, backgroundColor: '#F9FAFB', borderRadius: 8, padding: 10, marginBottom: 6 },
  webhookNote: { fontSize: 11, color: TEXT2 },

  btn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: GOLD, borderRadius: 14, paddingVertical: 14, marginBottom: 10 },
  btnDisabled: { opacity: 0.6 },
  btnText:     { fontSize: 15, fontWeight: '700', color: '#fff' },

  lastAt:      { fontSize: 11, color: TEXT2, textAlign: 'center' },
});
