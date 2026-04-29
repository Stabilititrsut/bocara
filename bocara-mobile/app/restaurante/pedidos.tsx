import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, Alert, ActivityIndicator,
  Modal, TextInput, Platform,
} from 'react-native';
import { pedidosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

let CameraView: any = null;
let useCameraPermissions: any = null;
if (Platform.OS !== 'web') {
  try {
    const cam = require('expo-camera');
    CameraView = cam.CameraView;
    useCameraPermissions = cam.useCameraPermissions;
  } catch {}
}

const ESTADOS = ['todos', 'confirmado', 'listo', 'recogido'];
const ESTADO_COLORS: Record<string, string> = {
  pendiente: Colors.textLight, confirmado: Colors.orange,
  listo: Colors.green, recogido: Colors.textSecondary, cancelado: Colors.error,
};

function QRScannerModal({ visible, onClose, onScanned }: {
  visible: boolean; onClose: () => void; onScanned: (code: string) => void;
}) {
  const [permStatus, requestPerm] = useCameraPermissions ? useCameraPermissions() : [null, () => {}];
  const [manualCodigo, setManualCodigo] = useState('');
  const scannedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      setManualCodigo('');
      if (permStatus && !permStatus.granted) requestPerm();
    }
  }, [visible]);

  function handleBarcode({ data }: { data: string }) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    onScanned(data);
  }

  function handleManual() {
    const codigo = manualCodigo.trim().toUpperCase();
    if (!codigo) return Alert.alert('Error', 'Ingresa un código');
    onScanned(codigo);
  }

  if (!CameraView) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={sq.header}>
          <TouchableOpacity onPress={onClose} style={sq.closeBtn}>
            <Text style={sq.closeText}>✕ Cerrar</Text>
          </TouchableOpacity>
          <Text style={sq.title}>Escanear QR</Text>
          <View style={{ width: 80 }} />
        </View>

        {permStatus?.granted ? (
          <View style={{ flex: 1 }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcode}
            />
            <View style={sq.overlay}>
              <View style={sq.scanBox} />
              <Text style={sq.hint}>Apunta al código QR del cliente</Text>
            </View>
          </View>
        ) : (
          <View style={sq.noPerm}>
            <Text style={{ color: Colors.white, fontSize: 16, textAlign: 'center' }}>
              Necesitas dar permiso de cámara para escanear QR
            </Text>
            <TouchableOpacity style={sq.permBtn} onPress={requestPerm as any}>
              <Text style={sq.permBtnText}>Dar permiso</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={sq.manual}>
          <Text style={sq.manualLabel}>O ingresa el código manualmente</Text>
          <View style={sq.manualRow}>
            <TextInput
              style={sq.manualInput}
              value={manualCodigo}
              onChangeText={setManualCodigo}
              placeholder="BOC-XXXXXX"
              placeholderTextColor={Colors.textLight}
              autoCapitalize="characters"
            />
            <TouchableOpacity style={sq.manualBtn} onPress={handleManual}>
              <Text style={sq.manualBtnText}>Validar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export default function PedidosRestauranteScreen() {
  const [pedidos, setPedidos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filtro, setFiltro] = useState('todos');
  const [scannerVisible, setScannerVisible] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await pedidosAPI.restaurante();
      setPedidos(res.data || []);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function cambiarEstado(id: string, nuevoEstado: string) {
    try {
      await pedidosAPI.actualizarEstado(id, nuevoEstado);
      cargar();
    } catch (e: any) { Alert.alert('Error', e.message); }
  }

  function handleCodigoEscaneado(codigo: string) {
    setScannerVisible(false);
    const normalizado = codigo.trim().toUpperCase();
    const pedido = pedidos.find((p: any) =>
      p.codigo_recogida?.toUpperCase() === normalizado
    );
    if (!pedido) {
      return Alert.alert('No encontrado', `No se encontró ningún pedido con el código "${normalizado}"`);
    }
    if (pedido.estado === 'recogido') {
      return Alert.alert('Ya recogido', `Este pedido ya fue marcado como recogido.`);
    }
    if (pedido.estado === 'cancelado') {
      return Alert.alert('Cancelado', 'Este pedido está cancelado y no puede recogerse.');
    }
    Alert.alert(
      '✅ Pedido encontrado',
      `Bolsa: ${pedido.bolsas?.nombre || 'Sin nombre'}\nCliente: ${pedido.usuarios?.nombre || 'Cliente'}\nTotal: Q${pedido.total?.toFixed(2)}\n\n¿Confirmar entrega?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar entrega', onPress: () => cambiarEstado(pedido.id, 'recogido'),
        },
      ]
    );
  }

  const filtrados = pedidos.filter((p) => filtro === 'todos' || p.estado === filtro);

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Pedidos</Text>
        {Platform.OS !== 'web' && CameraView && (
          <TouchableOpacity style={s.scanBtn} onPress={() => setScannerVisible(true)}>
            <Text style={s.scanBtnText}>📷 Escanear QR</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filtros} contentContainerStyle={{ paddingHorizontal: 14 }}>
        {ESTADOS.map((e) => (
          <TouchableOpacity key={e} style={[s.filtroChip, filtro === e && s.filtroActive]} onPress={() => setFiltro(e)}>
            <Text style={[s.filtroText, filtro === e && s.filtroTextActive]}>{e.charAt(0).toUpperCase() + e.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {filtrados.length === 0 && (
          <View style={s.empty}>
            <Text style={{ fontSize: 40 }}>📋</Text>
            <Text style={s.emptyText}>No hay pedidos en esta categoría</Text>
          </View>
        )}
        {filtrados.map((p: any) => (
          <View key={p.id} style={s.card}>
            <View style={s.cardHeader}>
              <View>
                <Text style={s.codigo}>{p.codigo_recogida}</Text>
                <Text style={s.bolsaNombre}>{p.bolsas?.nombre}</Text>
                {p.usuarios?.nombre && <Text style={s.clienteNombre}>👤 {p.usuarios.nombre}</Text>}
              </View>
              <View>
                <Text style={s.total}>Q{p.total?.toFixed(2)}</Text>
                <View style={[s.estadoBadge, { backgroundColor: (ESTADO_COLORS[p.estado] || Colors.textLight) + '20' }]}>
                  <Text style={[s.estadoText, { color: ESTADO_COLORS[p.estado] || Colors.textLight }]}>{p.estado}</Text>
                </View>
              </View>
            </View>
            <View style={s.infoRow}>
              <Text style={s.infoText}>⏰ {p.hora_recogida_inicio?.slice(0, 5)} – {p.hora_recogida_fin?.slice(0, 5)}</Text>
              <Text style={s.infoText}>{p.tipo_entrega === 'envio' ? '🏍️ Envío' : '🏪 Recogida'}</Text>
              <Text style={s.infoText}>{new Date(p.created_at || p.creado_en).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}</Text>
            </View>
            {p.estado === 'confirmado' && (
              <TouchableOpacity style={s.btnListo} onPress={() => cambiarEstado(p.id, 'listo')}>
                <Text style={s.btnListoText}>✓ Marcar como listo</Text>
              </TouchableOpacity>
            )}
            {p.estado === 'listo' && (
              <TouchableOpacity style={[s.btnListo, { backgroundColor: Colors.brown }]} onPress={() => cambiarEstado(p.id, 'recogido')}>
                <Text style={s.btnListoText}>✓ Confirmar recogida</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        <View style={{ height: 20 }} />
      </ScrollView>

      {CameraView && (
        <QRScannerModal
          visible={scannerVisible}
          onClose={() => setScannerVisible(false)}
          onScanned={handleCodigoEscaneado}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scanBtn: { backgroundColor: Colors.brown, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  scanBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },
  filtros: { maxHeight: 52, marginVertical: 10 },
  filtroChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7, marginRight: 8, backgroundColor: Colors.white },
  filtroActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  filtroText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  filtroTextActive: { color: Colors.white },
  scroll: { padding: 14 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  codigo: { fontSize: 18, fontWeight: '900', color: Colors.brown, letterSpacing: 2 },
  bolsaNombre: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  clienteNombre: { fontSize: 12, color: Colors.textLight, marginTop: 2 },
  total: { fontSize: 18, fontWeight: '900', color: Colors.orange, textAlign: 'right' },
  estadoBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4, alignSelf: 'flex-end' },
  estadoText: { fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  infoText: { fontSize: 12, color: Colors.textSecondary },
  btnListo: { backgroundColor: Colors.green, borderRadius: 10, padding: 10, alignItems: 'center' },
  btnListoText: { color: Colors.white, fontWeight: '700', fontSize: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyText: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center' },
});

const sq = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: '#111' },
  closeBtn: { padding: 4 },
  closeText: { color: Colors.white, fontSize: 15, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '800', color: Colors.white },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  scanBox: { width: 240, height: 240, borderWidth: 3, borderColor: Colors.orange, borderRadius: 16 },
  hint: { color: Colors.white, marginTop: 16, fontSize: 14, fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  noPerm: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  permBtn: { backgroundColor: Colors.orange, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permBtnText: { color: Colors.white, fontWeight: '800', fontSize: 15 },
  manual: { backgroundColor: '#111', padding: 20 },
  manualLabel: { color: Colors.textLight, fontSize: 13, marginBottom: 10 },
  manualRow: { flexDirection: 'row', gap: 10 },
  manualInput: { flex: 1, backgroundColor: '#222', borderRadius: 12, padding: 12, color: Colors.white, fontSize: 15, fontWeight: '700', letterSpacing: 2 },
  manualBtn: { backgroundColor: Colors.orange, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center' },
  manualBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },
});
