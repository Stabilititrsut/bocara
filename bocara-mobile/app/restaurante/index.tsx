import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, RefreshControl, AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import { negociosAPI, pedidosAPI, bolsasAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/src/context/AuthContext';
import CalendarioPicker from '@/components/CalendarioPicker';

const PRIMARY = '#2C4A2E';
const GOLD    = '#E8820C';
const GOLD_BG = '#FFF4E6';
const WHITE   = '#FFFFFF';
const BORDER  = '#E8EDE8';

const ESTADO_COLOR: Record<string, { bg: string; text: string }> = {
  confirmado: { bg: '#FEF3C7', text: '#92400E' },
  listo:      { bg: '#D1FAE5', text: '#065F46' },
  recogido:   { bg: '#DBEAFE', text: '#1E40AF' },
  cancelado:  { bg: '#FEE2E2', text: '#991B1B' },
};

// 'YYYY-MM-DD' ± días, sin pasar por zona horaria del dispositivo (aritmética
// entera de calendario). Usado solo para mover el día que se le PIDE al
// backend — el backend decide qué pedidos hay ese día en hora de Guatemala.
function sumarDiasISO(fechaISO: string, dias: number): string {
  const [a, m, d] = fechaISO.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1, d));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

// 'YYYY-MM' ± meses.
function sumarMesesISO(mesISO: string, meses: number): string {
  const [a, m] = mesISO.split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 + meses, 1));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

function etiquetaMes(mesISO: string): string {
  const [a, m] = mesISO.split('-').map(Number);
  const nombres = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${nombres[m - 1]} ${a}`;
}

function etiquetaDia(fechaISO: string, hoyISO: string): string {
  if (fechaISO === hoyISO) return 'Hoy';
  if (fechaISO === sumarDiasISO(hoyISO, -1)) return 'Ayer';
  const [a, m, d] = fechaISO.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).toLocaleDateString('es-GT', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// Hora/fecha de un `created_at` (instante UTC) en hora de Guatemala — UTC-6
// fijo, sin horario de verano (igual que backend/services/horarioGuatemala.js).
// Se desplaza el instante y se lee con getters UTC: no depende de la zona del
// dispositivo ni del soporte de `timeZone` en Intl (Hermes).
const OFFSET_GT_MS = 6 * 60 * 60 * 1000;
function horaGt(iso: string): string {
  const d = new Date(new Date(iso).getTime() - OFFSET_GT_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'a. m.' : 'p. m.'}`;
}
function diaCortoGt(iso: string): string {
  const d = new Date(new Date(iso).getTime() - OFFSET_GT_MS);
  return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function MetricCard({ emoji, label, value, accent }: { emoji: string; label: string; value: string | number; accent?: string }) {
  return (
    <View style={s.metricCard}>
      <Text style={{ fontSize: 28, marginBottom: 6 }}>{emoji}</Text>
      <Text style={[s.metricVal, { color: accent || PRIMARY }]}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
    </View>
  );
}

type VistaPedidos = 'dia' | 'mes';

export default function DashboardRestauranteScreen() {
  const { usuario } = useAuth();
  const router = useRouter();
  const [negocio, setNegocio] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // "Hoy" tal como lo resuelve el backend en hora de Guatemala (nunca el
  // reloj del dispositivo) — se captura una vez al cargar el resumen y sirve
  // para no permitir navegar el explorador de pedidos hacia el futuro.
  const [hoyGt, setHoyGt] = useState<string | null>(null);

  // Explorador de pedidos por día/mes, debajo de "Últimos pedidos". Por
  // defecto día = hoy (resuelto por el backend, ver pedidosAPI.restaurante).
  const [vista, setVista] = useState<VistaPedidos>('dia');
  const [fechaVista, setFechaVista] = useState<string | null>(null); // null = "hoy" (backend resuelve)
  const [mesVista, setMesVista] = useState<string | null>(null);     // null = "actual"
  const [pedidosVista, setPedidosVista] = useState<any[]>([]);
  const [loadingVista, setLoadingVista] = useState(true);
  const [errorVista, setErrorVista] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [negRes, resumenRes, bolRes] = await Promise.allSettled([
        negociosAPI.miNegocio(),
        pedidosAPI.restaurante({ fecha: 'hoy' }),
        bolsasAPI.listar({ mi_negocio: true }),
      ]);

      const neg = negRes.status === 'fulfilled' ? negRes.value.data : null;
      setNegocio(neg);

      // { fecha, pedidos } — "fecha" es el día resuelto en Guatemala; nunca se
      // calcula "hoy" en el dispositivo (podría ser otro día que en Guatemala).
      const resumen = resumenRes.status === 'fulfilled' ? resumenRes.value.data : null;
      if (resumen?.fecha) setHoyGt(resumen.fecha);
      const pedidosHoy = (resumen?.pedidos || []).filter((p: any) => p.estado !== 'cancelado');
      // Solo pedidos realmente pagados cuentan para las métricas de ventas/ganancias del día
      const pagados = pedidosHoy.filter((p: any) => p.estado_pago === 'pagado');

      const bolsas = bolRes.status === 'fulfilled' ? (bolRes.value?.data || []) : [];
      const activas = bolsas.filter((b: any) => b.activo && (b.estado_aprobacion == null || b.estado_aprobacion === 'aprobado')).length;

      setStats({
        hoy: pagados.length,
        // Ganancias = lo que le corresponde al restaurante (75% de la venta + propina
        // íntegra), no el total que pagó el cliente — ese incluye la comisión de
        // Bocara y el cargo de plataforma, que nunca son del restaurante.
        ingresos: pagados.reduce((s: number, p: any) => s + (p.monto_neto_restaurante || 0), 0),
        activas,
      });
    } catch { } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Explorador de pedidos: independiente del resumen de arriba — el
  // restaurante puede estar viendo un día o mes distinto al de hoy. Siempre
  // manda `fecha` o `mes` (filtro en el backend, hora de Guatemala): sin
  // ellos el endpoint devolvería todo el historial (contrato antiguo).
  const cargarVista = useCallback(async () => {
    setLoadingVista(true);
    setErrorVista(false);
    try {
      const params = vista === 'dia'
        ? { fecha: fechaVista || 'hoy' }
        : { mes: mesVista || 'actual' };
      const res = await pedidosAPI.restaurante(params);
      // Al pedir "hoy", la respuesta trae el día resuelto en Guatemala — se
      // actualiza siempre (no solo la primera vez) para que, si la app quedó
      // abierta pasada la medianoche, la etiqueta y los límites usen el día nuevo.
      if (vista === 'dia' && !fechaVista && res.data?.fecha) setHoyGt(res.data.fecha);
      const lista = (res.data?.pedidos || []).filter((p: any) => p.estado !== 'cancelado');
      setPedidosVista(lista);
    } catch {
      // Un array vacío NO es error (estado vacío abajo); esto es solo para un
      // fallo real de red/backend — aviso breve con "Reintentar".
      setPedidosVista([]);
      setErrorVista(true);
    } finally {
      setLoadingVista(false);
    }
  }, [vista, fechaVista, mesVista]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { cargarVista(); }, [cargarVista]);

  // Al volver a la app (p. ej. al día siguiente con la app en segundo plano)
  // se recarga: con día/mes "por defecto" (null) el backend resuelve el nuevo
  // hoy/mes actual sin que el usuario tenga que hacer nada.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') { cargar(); cargarVista(); }
    });
    return () => sub.remove();
  }, [cargar, cargarVista]);

  // Elegir explícitamente hoy (o el mes actual) vuelve al modo automático
  // (null), para que al cambiar de día no quede anclado a una fecha vieja.
  const mesActualGt = hoyGt ? hoyGt.slice(0, 7) : null;
  const elegirDia = (f: string) => setFechaVista(f && f !== hoyGt ? f : null);
  const elegirMes = (m: string) => setMesVista(m && m !== mesActualGt ? m : null);
  const diaMostrado = fechaVista || hoyGt || '';
  const mesMostrado = mesVista || mesActualGt || '';

  // ─── Pendiente ───────────────────────────────────────────────────────────────
  if (!loading && (negocio?.estado_verificacion === 'pendiente' || (!negocio?.activo && negocio?.estado_verificacion !== 'rechazado'))) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView
          contentContainerStyle={s.scrollCenter}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
        >
          <View style={s.statusCard}>
            <Text style={s.statusEmoji}>⏳</Text>
            <Text style={s.statusTitle}>Solicitud en revisión</Text>
            <Text style={s.statusSub}>
              Hola, <Text style={{ fontWeight: '700', color: PRIMARY }}>{usuario?.nombre}</Text>. Tu negocio{' '}
              <Text style={{ fontWeight: '900', color: PRIMARY }}>{negocio?.nombre || '...'}</Text> está siendo revisado.
            </Text>

            <View style={s.divider} />

            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: '#22C55E' }]}><Text style={s.stepDotText}>✓</Text></View>
              <Text style={s.stepText}>Solicitud recibida</Text>
            </View>
            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: GOLD }]}><Text style={s.stepDotText}>⏳</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.stepText}>Verificación de documentos</Text>
                <Text style={s.stepSub}>24 – 48 horas hábiles</Text>
              </View>
            </View>
            <View style={s.stepRow}>
              <View style={[s.stepDot, { backgroundColor: '#CBD5E1' }]}><Text style={s.stepDotText}>🔜</Text></View>
              <Text style={[s.stepText, { color: Colors.textLight }]}>Activación y publicación</Text>
            </View>

            <View style={s.divider} />
            <Text style={s.statusHint}>Te notificaremos cuando tu negocio sea aprobado. También puedes actualizar tu información desde “Mi negocio”.</Text>

            <TouchableOpacity style={s.refreshBtn} onPress={() => { setRefreshing(true); cargar(); }}>
              <Text style={s.refreshBtnText}>↻ Verificar estado</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Rechazado ───────────────────────────────────────────────────────────────
  if (!loading && negocio?.estado_verificacion === 'rechazado') {
    const CAMPO_LABELS_R: Record<string, string> = {
      nombre_negocio: 'Nombre del negocio',
      direccion:      'Dirección',
      telefono:       'Teléfono',
      nit:            'NIT',
      dpi_foto_url:   'Foto del DPI',
      datos_bancarios:'Datos bancarios',
      imagen_url:     'Foto del negocio',
    };
    let motivoTexto = '';
    let camposRechazados: string[] = [];
    if (negocio.motivo_rechazo) {
      try {
        const p = JSON.parse(negocio.motivo_rechazo);
        motivoTexto = p.texto || '';
        camposRechazados = Array.isArray(p.campos) ? p.campos : [];
      } catch { motivoTexto = negocio.motivo_rechazo; }
    }
    const camposConLabel = camposRechazados.filter(c => c !== 'otro' && CAMPO_LABELS_R[c]);

    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.scrollCenter}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={GOLD} />}
        >
          <View style={[s.statusCard, s.rejectedCard]}>
            <Text style={s.statusEmoji}>❌</Text>
            <Text style={s.statusTitle}>Solicitud rechazada</Text>
            {camposConLabel.length > 0 && (
              <View style={s.camposCard}>
                <Text style={s.camposTitle}>Campos que debes corregir:</Text>
                {camposConLabel.map(c => (
                  <Text key={c} style={s.campoItem}>• {CAMPO_LABELS_R[c]}</Text>
                ))}
              </View>
            )}
            {motivoTexto ? (
              <View style={s.motivoCard}>
                <Text style={s.motivoLabel}>Motivo adicional</Text>
                <Text style={s.motivoText}>{motivoTexto}</Text>
              </View>
            ) : null}
            <Text style={s.statusHint}>Corrige los datos desde “Mi negocio” y vuelve a enviar tu solicitud.</Text>
            <TouchableOpacity style={s.corregirBtn} onPress={() => router.push('/restaurante/perfil' as any)}>
              <Text style={s.corregirBtnText}>✏️ Corregir y reenviar →</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Dashboard normal ────────────────────────────────────────────────────────
  const faltaDpi = negocio && !negocio.dpi_foto_url && !negocio.datos_bancarios?.dpi_foto_url;

  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); cargarVista(); }} tintColor={GOLD} />}
        showsVerticalScrollIndicator={false}
      >
        {/* BUG 5: Advertencia DPI faltante */}
        {faltaDpi && (
          <TouchableOpacity style={s.dpiBanner} onPress={() => router.push('/restaurante/perfil' as any)} activeOpacity={0.85}>
            <Text style={s.dpiBannerText}>⚠️ Completa tu perfil: falta subir la foto del DPI para activar tu cuenta →</Text>
          </TouchableOpacity>
        )}

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.headerGreeting}>Bienvenido</Text>
              <Text style={s.headerNegocio} numberOfLines={1}>{negocio?.nombre || 'Mi Negocio'}</Text>
            </View>
            {negocio?.verificado && (
              <View style={s.verificadoBadge}>
                <Text style={s.verificadoText}>✓ Verificado</Text>
              </View>
            )}
          </View>
          <Text style={s.headerFecha}>
            {hoyGt
              ? new Date(`${hoyGt}T12:00:00Z`).toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
              : ''}
          </Text>
        </View>

        {/* Métricas */}
        <Text style={s.sectionTitle}>Resumen de hoy</Text>
        <View style={s.metricsRow}>
          <MetricCard emoji="📦" label="Pedidos"  value={loading ? '—' : (stats?.hoy || 0)}                          accent={GOLD} />
          <MetricCard emoji="💰" label="Ganancias" value={loading ? '—' : `Q${(stats?.ingresos || 0).toFixed(2)}`}   accent='#22C55E' />
          <MetricCard emoji="⏱️" label="Activas"  value={loading ? '—' : (stats?.activas || 0)}                      accent='#60A5FA' />
        </View>

        {/* Pedidos por día / mes — reemplaza "Últimos pedidos" fijo. Por
            defecto el día de hoy (resuelto en el backend, hora de Guatemala);
            el restaurante puede moverse a días anteriores o a un mes completo,
            sin recargar la app ni depender del reloj del dispositivo. */}
        <Text style={s.sectionTitle}>Pedidos</Text>
        <View style={s.vistaTabsRow}>
          <TouchableOpacity
            style={[s.vistaTab, vista === 'dia' && s.vistaTabActive]}
            onPress={() => setVista('dia')}
          >
            <Text style={[s.vistaTabText, vista === 'dia' && s.vistaTabTextActive]}>Día</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.vistaTab, vista === 'mes' && s.vistaTabActive]}
            onPress={() => setVista('mes')}
          >
            <Text style={[s.vistaTabText, vista === 'mes' && s.vistaTabTextActive]}>Mes</Text>
          </TouchableOpacity>
        </View>

        {vista === 'dia' ? (
          <View style={s.navRow}>
            <TouchableOpacity
              style={[s.navBtn, !diaMostrado && s.navBtnDisabled]}
              onPress={() => elegirDia(sumarDiasISO(diaMostrado, -1))}
              disabled={!diaMostrado}
              accessibilityLabel="Día anterior"
            >
              <Text style={s.navBtnText}>‹</Text>
            </TouchableOpacity>
            <View style={s.navPicker}>
              <CalendarioPicker
                label=""
                value={diaMostrado}
                onChange={elegirDia}
                placeholder="Elegir día"
                maxDate={hoyGt || undefined}
              />
            </View>
            <TouchableOpacity
              style={[s.navBtn, !fechaVista && s.navBtnDisabled]}
              disabled={!fechaVista}
              onPress={() => elegirDia(sumarDiasISO(diaMostrado, 1))}
              accessibilityLabel="Día siguiente"
            >
              <Text style={s.navBtnText}>›</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.navRow}>
            <TouchableOpacity
              style={[s.navBtn, !mesMostrado && s.navBtnDisabled]}
              onPress={() => elegirMes(sumarMesesISO(mesMostrado, -1))}
              disabled={!mesMostrado}
              accessibilityLabel="Mes anterior"
            >
              <Text style={s.navBtnText}>‹</Text>
            </TouchableOpacity>
            <View style={s.navPicker}>
              <CalendarioPicker
                label=""
                modo="mes"
                value={mesMostrado}
                onChange={elegirMes}
                placeholder="Elegir mes"
                maxDate={mesActualGt || undefined}
              />
            </View>
            <TouchableOpacity
              style={[s.navBtn, !mesVista && s.navBtnDisabled]}
              disabled={!mesVista}
              onPress={() => elegirMes(sumarMesesISO(mesMostrado, 1))}
              accessibilityLabel="Mes siguiente"
            >
              <Text style={s.navBtnText}>›</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.vistaEtiquetaRow}>
          <Text style={s.vistaEtiqueta}>
            {vista === 'dia'
              ? (diaMostrado ? etiquetaDia(diaMostrado, hoyGt || '') : '')
              : (mesMostrado ? etiquetaMes(mesMostrado) : '')}
            {!loadingVista && !errorVista ? ` · ${pedidosVista.length} ${pedidosVista.length === 1 ? 'pedido' : 'pedidos'}` : ''}
          </Text>
          {(vista === 'dia' ? !!fechaVista : !!mesVista) && (
            <TouchableOpacity onPress={() => (vista === 'dia' ? setFechaVista(null) : setMesVista(null))}>
              <Text style={s.volverHoyText}>{vista === 'dia' ? 'Ir a hoy' : 'Ir a este mes'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {loadingVista ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyText}>Cargando pedidos…</Text>
          </View>
        ) : errorVista ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyText}>No se pudieron cargar los pedidos.</Text>
            <TouchableOpacity style={s.reintentarBtn} onPress={cargarVista}>
              <Text style={s.reintentarText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : pedidosVista.length === 0 ? (
          <View style={s.emptyCard}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>🥡</Text>
            <Text style={s.emptyText}>
              {vista === 'dia' ? 'No hay pedidos para este día.' : 'No hay pedidos para este mes.'}
            </Text>
          </View>
        ) : (
          pedidosVista.map((p: any) => {
            const est = ESTADO_COLOR[p.estado] || { bg: '#F3F4F6', text: '#6B7280' };
            return (
              <View key={p.id} style={s.pedidoCard}>
                <View style={{ flex: 1 }}>
                  <Text style={s.pedidoNombre} numberOfLines={1}>{p.bolsas?.nombre || 'Bolsa sorpresa'}</Text>
                  <Text style={s.pedidoHora}>
                    {vista === 'mes' ? `${diaCortoGt(p.created_at)} · ` : ''}{horaGt(p.created_at)}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.pedidoTotal}>Q{(p.total || 0).toFixed(2)}</Text>
                  <View style={[s.estadoBadge, { backgroundColor: est.bg }]}>
                    <Text style={[s.estadoText, { color: est.text }]}>{p.estado}</Text>
                  </View>
                </View>
              </View>
            );
          })
        )}

        {pedidosVista.length > 0 && (
          <TouchableOpacity style={s.verTodosBtn} onPress={() => router.push('/restaurante/pedidos' as any)}>
            <Text style={s.verTodosBtnText}>Ver todos los pedidos →</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: GOLD_BG },
  loadingWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: GOLD_BG },
  scroll:       { padding: 16 },
  scrollCenter: { flexGrow: 1, padding: 16, justifyContent: 'center' },

  // ─── Status cards (pending/rejected) ───
  statusCard:   { backgroundColor: WHITE, borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 2, borderColor: '#F59E0B40' },
  rejectedCard: { borderColor: Colors.error + '40' },
  statusEmoji:  { fontSize: 56, marginBottom: 12 },
  statusTitle:  { fontSize: 22, fontWeight: '900', color: PRIMARY, marginBottom: 10, textAlign: 'center' },
  statusSub:    { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  statusHint:   { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  divider:      { height: 1, backgroundColor: BORDER, alignSelf: 'stretch', marginVertical: 16 },
  stepRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12, alignSelf: 'stretch' },
  stepDot:      { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  stepDotText:  { fontSize: 12 },
  stepText:     { fontSize: 14, fontWeight: '700', color: PRIMARY, lineHeight: 20 },
  stepSub:      { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  refreshBtn:   { backgroundColor: GOLD_BG, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 20, borderWidth: 1.5, borderColor: GOLD },
  refreshBtnText: { color: PRIMARY, fontWeight: '800', fontSize: 14 },
  camposCard:   { backgroundColor: '#FEE2E2', borderRadius: 12, padding: 14, alignSelf: 'stretch', marginBottom: 16, borderWidth: 1, borderColor: '#FCA5A5' },
  camposTitle:  { fontSize: 12, fontWeight: '800', color: '#DC2626', marginBottom: 8 },
  campoItem:    { fontSize: 13, color: '#991B1B', paddingVertical: 2 },
  motivoCard:   { backgroundColor: '#FEF2F2', borderRadius: 12, padding: 14, alignSelf: 'stretch', marginBottom: 16, borderWidth: 1, borderColor: Colors.error + '30' },
  motivoLabel:  { fontSize: 12, fontWeight: '800', color: Colors.error, marginBottom: 4 },
  motivoText:   { fontSize: 13, color: PRIMARY },
  corregirBtn:  { backgroundColor: GOLD, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 14, width: '100%', alignItems: 'center', marginTop: 12 },
  corregirBtnText: { color: WHITE, fontWeight: '800', fontSize: 15 },

  // ─── Dashboard normal ───
  header: {
    backgroundColor: PRIMARY, borderRadius: 20, padding: 20, marginBottom: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 4,
  },
  headerTop:      { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  headerGreeting: { fontSize: 12, color: 'rgba(200,169,126,0.7)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  headerNegocio:  { fontSize: 24, fontWeight: '900', color: WHITE, marginTop: 2 },
  headerFecha:    { fontSize: 12, color: 'rgba(255,255,255,0.5)', textTransform: 'capitalize' },
  verificadoBadge: { backgroundColor: GOLD, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, flexShrink: 0, marginLeft: 12 },
  verificadoText:  { color: WHITE, fontSize: 11, fontWeight: '800' },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: PRIMARY, marginBottom: 12, marginTop: 4 },

  metricsRow:  { flexDirection: 'row', gap: 10, marginBottom: 20 },
  metricCard:  {
    flex: 1, backgroundColor: WHITE, borderRadius: 16, padding: 14, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2,
  },
  metricVal:   { fontSize: 22, fontWeight: '900', marginBottom: 2 },
  metricLabel: { fontSize: 11, color: Colors.textSecondary, textAlign: 'center', fontWeight: '600' },

  emptyCard:  { backgroundColor: WHITE, borderRadius: 16, padding: 28, alignItems: 'center', borderWidth: 1.5, borderColor: BORDER, borderStyle: 'dashed' },
  emptyText:  { color: Colors.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  pedidoCard: {
    flexDirection: 'row', backgroundColor: WHITE, borderRadius: 14, padding: 14, marginBottom: 8,
    alignItems: 'center', borderWidth: 1, borderColor: BORDER,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  pedidoNombre: { fontSize: 14, fontWeight: '700', color: PRIMARY },
  pedidoHora:   { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  pedidoTotal:  { fontSize: 16, fontWeight: '900', color: GOLD, textAlign: 'right' },
  estadoBadge:  { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4 },
  estadoText:   { fontSize: 11, fontWeight: '700' },

  verTodosBtn:  { backgroundColor: WHITE, borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: GOLD, marginTop: 4 },
  verTodosBtnText: { color: GOLD, fontWeight: '800', fontSize: 14 },

  dpiBanner: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1.5, borderColor: '#FDE68A' },
  dpiBannerText: { fontSize: 13, color: '#92400E', fontWeight: '700', lineHeight: 19 },

  // ─── Explorador de pedidos (día/mes) ───
  vistaTabsRow:  { flexDirection: 'row', backgroundColor: WHITE, borderRadius: 12, padding: 4, marginBottom: 10, borderWidth: 1, borderColor: BORDER },
  vistaTab:      { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 9 },
  vistaTabActive:{ backgroundColor: PRIMARY },
  vistaTabText:  { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },
  vistaTabTextActive: { color: WHITE },
  navRow:        { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  navPicker:     { flex: 1, marginHorizontal: 8 },
  navBtn:        { width: 36, height: 36, borderRadius: 18, backgroundColor: WHITE, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  navBtnDisabled:{ opacity: 0.4 },
  navBtnText:    { fontSize: 18, fontWeight: '800', color: PRIMARY },
  vistaEtiquetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  vistaEtiqueta: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  volverHoyText: { fontSize: 12, fontWeight: '800', color: GOLD },
  reintentarBtn: { marginTop: 12, borderRadius: 10, borderWidth: 1.5, borderColor: GOLD, paddingHorizontal: 18, paddingVertical: 8 },
  reintentarText: { color: GOLD, fontWeight: '800', fontSize: 13 },
});
