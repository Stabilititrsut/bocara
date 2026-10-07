import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { negociosAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { abrirComprobante } from '@/src/utils/abrirComprobante';
import { etiquetaMes, fechaGT, estadoLiquidacion, pagoVencido, quetzales } from '@/src/utils/liquidacionesResenas';

type Liquidacion = {
  id: string;
  mes: string | null;
  folio: string | null;
  estado: string;
  monto: number;
  ventas_brutas: number;
  comision_bocara: number;
  propinas: number;
  costo_envio: number;
  total_pedidos: number;
  fecha_limite_pago: string | null;
  pagado_en: string | null;
  created_at: string;
  datos_transferencia: { referencia?: string } | null;
};

type Periodo = 'dia' | 'semana' | 'mes' | 'todo';

const PERIODOS: { key: Periodo; label: string }[] = [
  { key: 'dia',    label: 'Hoy' },
  { key: 'semana', label: '7 días' },
  { key: 'mes',    label: '30 días' },
  { key: 'todo',   label: 'Todo' },
];

export default function GananciasScreen() {
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [liquidaciones, setLiquidaciones] = useState<Liquidacion[]>([]);
  const [errorLiquidaciones, setErrorLiquidaciones] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState<string | null>(null);
  const [errorComprobante, setErrorComprobante] = useState<{ id: string; msg: string } | null>(null);

  const cargar = useCallback(async (p: Periodo = periodo) => {
    // El resumen del periodo y el historial mensual son independientes: si
    // uno falla, el otro se muestra igual.
    const [ganancias, liqs] = await Promise.allSettled([
      negociosAPI.ganancias(p),
      negociosAPI.liquidaciones(),
    ]);
    if (ganancias.status === 'fulfilled') setData(ganancias.value.data);
    if (liqs.status === 'fulfilled') {
      setLiquidaciones(liqs.value.data || []);
      setErrorLiquidaciones(null);
    } else {
      setErrorLiquidaciones(liqs.reason?.message || 'No se pudieron cargar tus liquidaciones');
    }
    setLoading(false);
    setRefreshing(false);
  }, [periodo]);

  async function verComprobante(liq: Liquidacion) {
    setAbriendo(liq.id);
    setErrorComprobante(null);
    try {
      await abrirComprobante(async () => (await negociosAPI.comprobanteLiquidacion(liq.id)).data.url);
    } catch (e: any) {
      // Alert no se ve en web: el error también queda en la tarjeta.
      const msg = e?.message || 'No se pudo abrir el comprobante';
      setErrorComprobante({ id: liq.id, msg });
      Alert.alert('Comprobante', msg);
    } finally {
      setAbriendo(null);
    }
  }

  useEffect(() => { cargar(periodo); }, [periodo, cargar]);

  if (loading) return (
    <View style={s.loading}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  const resumen = data?.resumen || {};
  const banco = data?.negocio?.datos_bancarios;
  // % real de comisión de ESTE período: derivado de los montos que ya devolvió
  // el backend (snapshot financiero por pedido, nunca recalculado con el %
  // configurado actual — ver negocios.js), no de un 25% fijo en el frontend.
  // Puede no ser exactamente 25 si el período mezcla pedidos de antes/después
  // de un cambio de configuración del admin.
  const pctComision = resumen.ventas_brutas > 0
    ? Math.round((resumen.comision_bocara / resumen.ventas_brutas) * 100)
    : null;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>💰 Mis ganancias</Text>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(periodo); }} tintColor={Colors.orange} />}
      >
        {/* Selector de periodo */}
        <View style={s.periodoRow}>
          {PERIODOS.map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              style={[s.periodoBtn, periodo === key && s.periodoBtnActive]}
              onPress={() => setPeriodo(key)}
            >
              <Text style={[s.periodoBtnText, periodo === key && s.periodoBtnTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Card principal — venta neta de comisión + propina íntegra, lo que realmente se paga */}
        <View style={s.mainCard}>
          <Text style={s.mainCardLabel}>Lo que recibirás</Text>
          <Text style={s.mainCardVal}>Q{(resumen.total_a_recibir || 0).toFixed(2)}</Text>
          <Text style={s.mainCardSub}>{resumen.total_pedidos || 0} pedidos</Text>
        </View>

        {resumen.pedidos_sin_desglose > 0 && (
          <View style={s.sinBancoCard}>
            <Text style={{ fontSize: 12, color: Colors.error, fontWeight: '700' }}>
              ⚠️ {resumen.pedidos_sin_desglose} pedido{resumen.pedidos_sin_desglose !== 1 ? 's' : ''} sin monto calculado —
              no está incluido arriba. Contacta a soporte.
            </Text>
          </View>
        )}

        {/* Empty state cuando no hay ventas */}
        {resumen.total_pedidos === 0 && (
          <View style={s.emptyVentas}>
            <Text style={{ fontSize: 40, marginBottom: 10 }}>🛍️</Text>
            <Text style={s.emptyVentasTitle}>Aún no tienes ventas registradas</Text>
            <Text style={s.emptyVentasSub}>Publica tus primeras bolsas sorpresa para empezar a vender.</Text>
          </View>
        )}

        {/* Desglose financiero */}
        {resumen.total_pedidos > 0 && <View style={s.desglose}>
          <Text style={s.desgloseTitle}>Desglose</Text>
          {[
            { label: 'Ventas brutas (producto)', val: resumen.ventas_brutas || 0,       color: Colors.textPrimary },
            { label: `Comisión Bocara${pctComision !== null ? ` (${pctComision}%)` : ''}`,    val: -(resumen.comision_bocara || 0),  color: Colors.error, neg: true },
            { label: `Tu ganancia por ventas${pctComision !== null ? ` (${100 - pctComision}%)` : ''}`, val: resumen.neto_restaurante || 0, color: Colors.textPrimary },
            ...(resumen.total_envios > 0 ? [
              { label: 'Envíos recibidos (100%)', val: resumen.total_envios, color: '#22C55E' },
            ] : []),
            ...(resumen.total_propinas > 0 ? [
              { label: 'Propinas recibidas (100%)', val: resumen.total_propinas, color: '#22C55E' },
            ] : []),
            { label: 'Total a recibir',          val: resumen.total_a_recibir || 0,     color: Colors.green, bold: true },
          ].map(({ label, val, color, bold, neg }: any) => (
            <View key={label} style={s.desgloseRow}>
              <Text style={s.desgloseLabel}>{label}</Text>
              <Text style={[s.desgloseVal, { color }, bold && s.desgloseBold]}>
                {neg ? '−' : ''}Q{Math.abs(val).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>}

        {/* Datos bancarios registrados */}
        {banco ? (
          <View style={s.bancoCard}>
            <Text style={s.bancoTitle}>🏦 Cuenta para pagos</Text>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Banco</Text>
              <Text style={s.bancoVal}>{banco.banco || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Número</Text>
              <Text style={s.bancoVal}>{banco.numero_cuenta || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Tipo</Text>
              <Text style={s.bancoVal}>{banco.tipo_cuenta || '—'}</Text>
            </View>
            <View style={s.bancoRow}>
              <Text style={s.bancoLabel}>Titular</Text>
              <Text style={s.bancoVal}>{banco.titular || '—'}</Text>
            </View>
            <Text style={s.bancoHint}>
              Tus ventas se liquidan al cierre de cada mes y se pagan dentro de los primeros 3 días hábiles del mes siguiente.
            </Text>
          </View>
        ) : (
          <View style={s.sinBancoCard}>
            <Text style={{ fontSize: 28, marginBottom: 8 }}>🏦</Text>
            <Text style={s.sinBancoTitle}>Sin datos bancarios</Text>
            <Text style={s.sinBancoSub}>Agrega tu cuenta bancaria desde “Mi negocio” para recibir pagos.</Text>
          </View>
        )}

        {/* Liquidaciones mensuales */}
        <Text style={s.sectionTitle}>Liquidaciones mensuales</Text>
        {errorLiquidaciones ? (
          <View style={s.emptyLiq}>
            <Text style={[s.emptyLiqText, { color: Colors.error }]}>{errorLiquidaciones}</Text>
            <TouchableOpacity onPress={() => { setRefreshing(true); cargar(periodo); }}>
              <Text style={s.reintentar}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : liquidaciones.length === 0 ? (
          <View style={s.emptyLiq}>
            <Text style={s.emptyLiqText}>Aún no tienes liquidaciones. Se generan al cierre de cada mes.</Text>
          </View>
        ) : (
          liquidaciones.map((liq) => {
            const estado = estadoLiquidacion(liq.estado);
            const vencido = pagoVencido(liq);
            return (
              <View key={liq.id} style={s.liqCard}>
                <View style={s.liqHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.liqMes}>{etiquetaMes(liq.mes)}</Text>
                    {!!liq.folio && <Text style={s.liqFolio}>Folio {liq.folio}</Text>}
                  </View>
                  <Text style={s.liqMonto}>{quetzales(liq.monto)}</Text>
                </View>

                <View style={s.liqDetails}>
                  <View style={[s.liqEstado, { backgroundColor: estado.bg }]}>
                    <Text style={[s.liqEstadoText, { color: estado.color }]}>{estado.label}</Text>
                  </View>
                  <Text style={s.liqDetail}>{liq.total_pedidos || 0} pedidos</Text>
                </View>

                <Text style={[s.liqDetail, { marginTop: 8 }, vencido && { color: Colors.error, fontWeight: '700' }]}>
                  {liq.estado === 'pagado' || liq.estado === 'liquidado'
                    ? `Pagado el ${fechaGT(liq.pagado_en)}`
                    : liq.fecha_limite_pago
                      ? `${vencido ? 'Vencido · ' : ''}Fecha límite de pago: ${fechaGT(liq.fecha_limite_pago)}`
                      : `Generada el ${fechaGT(liq.created_at)}`}
                </Text>
                {!!liq.datos_transferencia?.referencia && (
                  <Text style={s.liqRef}>Ref: {liq.datos_transferencia.referencia}</Text>
                )}

                <View style={s.liqDesglose}>
                  <View style={s.liqDesgloseRow}>
                    <Text style={s.liqDesgloseLabel}>Ventas brutas</Text>
                    <Text style={s.liqDesgloseVal}>{quetzales(liq.ventas_brutas)}</Text>
                  </View>
                  <View style={s.liqDesgloseRow}>
                    <Text style={s.liqDesgloseLabel}>Comisión Bocara</Text>
                    <Text style={[s.liqDesgloseVal, { color: Colors.error }]}>−{quetzales(liq.comision_bocara)}</Text>
                  </View>
                  {Number(liq.propinas) > 0 && (
                    <View style={s.liqDesgloseRow}>
                      <Text style={s.liqDesgloseLabel}>Propinas</Text>
                      <Text style={s.liqDesgloseVal}>{quetzales(liq.propinas)}</Text>
                    </View>
                  )}
                  {Number(liq.costo_envio) > 0 && (
                    <View style={s.liqDesgloseRow}>
                      <Text style={s.liqDesgloseLabel}>Envíos</Text>
                      <Text style={s.liqDesgloseVal}>{quetzales(liq.costo_envio)}</Text>
                    </View>
                  )}
                </View>

                <TouchableOpacity
                  style={[s.btnComprobante, abriendo === liq.id && { opacity: 0.6 }]}
                  onPress={() => verComprobante(liq)}
                  disabled={abriendo !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver comprobante de ${etiquetaMes(liq.mes)}`}
                >
                  {abriendo === liq.id
                    ? <ActivityIndicator size="small" color={Colors.white} />
                    : <Text style={s.btnComprobanteText}>📄 Ver comprobante</Text>}
                </TouchableOpacity>
                {errorComprobante?.id === liq.id && (
                  <Text style={s.liqError}>{errorComprobante.msg}</Text>
                )}
              </View>
            );
          })
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: '900', color: Colors.brown },
  scroll: { padding: 16 },
  periodoRow: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 14, padding: 4, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  periodoBtn: { flex: 1, padding: 10, alignItems: 'center', borderRadius: 10 },
  periodoBtnActive: { backgroundColor: Colors.orange },
  periodoBtnText: { fontSize: 14, fontWeight: '700', color: Colors.textSecondary },
  periodoBtnTextActive: { color: Colors.white },
  mainCard: { backgroundColor: Colors.brown, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16 },
  mainCardLabel: { fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '600', marginBottom: 4 },
  mainCardVal: { fontSize: 48, fontWeight: '900', color: Colors.white },
  mainCardSub: { fontSize: 13, color: Colors.orangeLight, marginTop: 4 },
  desglose: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  desgloseTitle: { fontSize: 13, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  desgloseRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  desgloseLabel: { fontSize: 13, color: Colors.textSecondary },
  desgloseVal: { fontSize: 14, fontWeight: '700' },
  desgloseBold: { fontSize: 16, fontWeight: '900' },
  bancoCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  bancoTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12 },
  bancoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  bancoLabel: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  bancoVal: { fontSize: 13, color: Colors.textPrimary, fontWeight: '700' },
  bancoHint: { fontSize: 11, color: Colors.textLight, marginTop: 10, fontStyle: 'italic' },
  sinBancoCard: { backgroundColor: Colors.brownLight, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 16 },
  sinBancoTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  sinBancoSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: Colors.brown, marginBottom: 12, marginTop: 4 },
  emptyVentas: { backgroundColor: Colors.white, borderRadius: 16, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1.5, borderColor: Colors.border },
  emptyVentasTitle: { fontSize: 15, fontWeight: '800', color: Colors.brown, textAlign: 'center' },
  emptyVentasSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 6, textAlign: 'center', lineHeight: 18 },
  emptyLiq: { backgroundColor: Colors.white, borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 16 },
  emptyLiqText: { fontSize: 13, color: Colors.textSecondary },
  liqCard: { backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: Colors.border },
  liqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  liqEstado: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  liqEstadoText: { fontSize: 12, fontWeight: '800' },
  liqMes: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  liqFolio: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  liqMonto: { fontSize: 18, fontWeight: '900', color: Colors.brown },
  liqDetails: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  liqDetail: { fontSize: 12, color: Colors.textSecondary },
  liqRef: { fontSize: 11, color: Colors.textLight, marginTop: 4 },
  liqDesglose: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.border },
  liqDesgloseRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  liqDesgloseLabel: { fontSize: 12, color: Colors.textSecondary },
  liqDesgloseVal: { fontSize: 12, fontWeight: '700', color: Colors.textPrimary },
  btnComprobante: { marginTop: 12, backgroundColor: Colors.brown, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnComprobanteText: { color: Colors.white, fontWeight: '800', fontSize: 13 },
  liqError: { fontSize: 12, color: Colors.error, marginTop: 6, textAlign: 'center' },
  reintentar: { fontSize: 13, fontWeight: '800', color: Colors.orange, marginTop: 8 },
});
