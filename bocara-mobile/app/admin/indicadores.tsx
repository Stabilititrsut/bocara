// Admin › Indicadores y embudo (pantalla "03 · Indicadores y Embudo" de la guía).
//
// Once KPIs con fórmula, unidad, numerador, denominador, periodo y
// exclusiones consultables; embudo de 5 pasos por sesión; tiempos operativos
// con umbrales; e inversión Meta Ads para el CAC híbrido. Toda la lógica de
// lectura vive en src/utils/indicadores.ts: esta pantalla solo pinta.
//
// "No aplica" / "Sin datos" siempre se muestran como insignia, nunca como 0.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  RefreshControl, ActivityIndicator, Modal, TextInput, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CalendarioPicker from '@/components/CalendarioPicker';
import { adminAPI, indicadoresAPI } from '@/src/services/api';
import type { EstadoKpi, InversionPublicitaria, Kpi, RespuestaEmbudo, RespuestaIndicadores } from '@/src/services/api';
import {
  OPCIONES_PERIODO, OPCIONES_TIPO, ETIQUETA_ESTADO, EXPLICACION_ESTADO, UMBRALES_TIEMPOS,
  filtrosIniciales, construirFiltros, valorPrincipal, partesCociente, filasDesglose, notasKpi,
  describirPeriodo, nivelTiempo, tramosTiempos, barrasEmbudo, validarFormInversion, hoyGuatemala,
  formatearMoneda,
} from '@/src/utils/indicadores';
import type { EstadoFiltros, FormInversion, NivelTiempo } from '@/src/utils/indicadores';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';
const GREEN  = '#16A34A';
const AMBER  = '#D97706';
const RED    = '#DC2626';

const COLOR_ESTADO: Record<EstadoKpi, { fondo: string; borde: string; texto: string }> = {
  ok:        { fondo: '#F0FDF4', borde: '#BBF7D0', texto: '#166534' },
  no_aplica: { fondo: '#F1F5F9', borde: '#CBD5E1', texto: '#475569' },
  sin_datos: { fondo: '#FFFBEB', borde: '#FDE68A', texto: '#92400E' },
};

const COLOR_NIVEL: Record<NivelTiempo, string> = { ok: GREEN, alerta: AMBER, critico: RED, sin_datos: TEXT2 };
const ETIQUETA_NIVEL: Record<NivelTiempo, string> = { ok: 'En rango', alerta: 'Alerta', critico: 'Crítico', sin_datos: 'Sin datos' };

// ── Piezas sin estado propio (las prueba scripts/test-indicadores.cjs) ────────

export function InsigniaEstado({ estado }: { estado: EstadoKpi }) {
  const c = COLOR_ESTADO[estado];
  return (
    <View style={[s.insignia, { backgroundColor: c.fondo, borderColor: c.borde }]} accessibilityLabel={`Estado: ${ETIQUETA_ESTADO[estado]}`}>
      <Text style={[s.insigniaTexto, { color: c.texto }]}>{ETIQUETA_ESTADO[estado]}</Text>
    </View>
  );
}

export function TarjetaKpi({ kpi, expandida, onAlternar }: { kpi: Kpi; expandida: boolean; onAlternar: () => void }) {
  const valor = valorPrincipal(kpi);
  const partes = partesCociente(kpi);
  const desglose = filasDesglose(kpi);
  const notas = notasKpi(kpi);
  return (
    <View style={s.tarjeta}>
      <View style={s.tarjetaCabecera}>
        <Text style={s.tarjetaNombre}>{kpi.nombre}</Text>
        {kpi.estado !== 'ok' && <InsigniaEstado estado={kpi.estado} />}
      </View>

      {valor != null
        ? <Text style={s.tarjetaValor}>{valor}</Text>
        : <Text style={s.tarjetaSinValor}>{EXPLICACION_ESTADO[kpi.estado as Exclude<EstadoKpi, 'ok'>]}</Text>}

      {partes && (
        <Text style={s.tarjetaCociente}>
          {partes.numerador} / {partes.denominador}
          {kpi.unidad === '%' ? ' × 100' : ''}
        </Text>
      )}
      {kpi.muestras != null && <Text style={s.tarjetaCociente}>{kpi.muestras} pedidos medidos</Text>}

      <TouchableOpacity onPress={onAlternar} style={s.tarjetaToggle} accessibilityRole="button">
        <Text style={s.tarjetaToggleTexto}>{expandida ? 'Ocultar fórmula' : 'Ver fórmula'}</Text>
        <Ionicons name={expandida ? 'chevron-up' : 'chevron-down'} size={14} color={GOLD} />
      </TouchableOpacity>

      {expandida && (
        <View style={s.tarjetaDetalle}>
          <Text style={s.detalleEtiqueta}>Fórmula</Text>
          <Text style={s.detalleTexto}>{kpi.formula}</Text>
          <Text style={s.detalleEtiqueta}>Unidad</Text>
          <Text style={s.detalleTexto}>{kpi.unidad}</Text>
          <Text style={s.detalleEtiqueta}>Numerador / denominador</Text>
          <Text style={s.detalleTexto}>{partes ? `${partes.numerador} / ${partes.denominador}` : 'No disponible'}</Text>
          <Text style={s.detalleEtiqueta}>Periodo</Text>
          <Text style={s.detalleTexto}>{describirPeriodo(kpi.periodo)}</Text>
          <Text style={s.detalleEtiqueta}>Exclusiones</Text>
          <Text style={s.detalleTexto}>{kpi.exclusiones}</Text>
          {desglose.length > 0 && (
            <>
              <Text style={s.detalleEtiqueta}>Desglose</Text>
              {desglose.map((d) => (
                <View key={d.etiqueta} style={s.filaDesglose}>
                  <Text style={s.detalleTexto}>{d.etiqueta}</Text>
                  <Text style={s.filaDesgloseValor}>{d.valor}</Text>
                </View>
              ))}
            </>
          )}
          {notas.map((n) => <Text key={n} style={s.nota}>• {n}</Text>)}
        </View>
      )}
    </View>
  );
}

export function SeccionEmbudo({ embudo }: { embudo: RespuestaEmbudo | null }) {
  const barras = barrasEmbudo(embudo);
  if (!embudo) return null;
  return (
    <View style={s.tarjeta}>
      <View style={s.tarjetaCabecera}>
        <Text style={s.tarjetaNombre}>Embudo de compra</Text>
        {embudo.estado !== 'ok' && <InsigniaEstado estado={embudo.estado} />}
      </View>
      {embudo.estado === 'sin_datos' && <Text style={s.tarjetaSinValor}>{EXPLICACION_ESTADO.sin_datos}</Text>}
      {barras.map((b, i) => (
        <View key={b.clave} style={s.pasoEmbudo}>
          <View style={s.pasoCabecera}>
            <Text style={s.pasoNombre}>{i + 1}. {b.nombre}</Text>
            <Text style={s.pasoSesiones}>{b.sesiones == null ? '—' : `${b.sesiones} sesiones`}</Text>
          </View>
          <View style={s.barraFondo}>
            {b.ancho != null && <View style={[s.barra, { width: `${b.ancho}%` }]} />}
          </View>
          {b.tasa && (
            <Text style={s.pasoTasa}>
              {b.tasa.estado === 'ok' ? `${b.tasa.valor}% desde el paso anterior` : `${ETIQUETA_ESTADO[b.tasa.estado]} desde el paso anterior`}
            </Text>
          )}
        </View>
      ))}
      {embudo.regla && <Text style={s.nota}>• {embudo.regla}</Text>}
    </View>
  );
}

export function SeccionTiempos({ tramos }: { tramos: Kpi[] }) {
  if (tramos.length === 0) return null;
  return (
    <View style={s.tarjeta}>
      <Text style={s.tarjetaNombre}>Tiempos operativos (medianas)</Text>
      {tramos.map((t) => {
        const nivel = nivelTiempo(t);
        const umbral = UMBRALES_TIEMPOS[t.clave];
        return (
          <View key={t.clave} style={s.tramo}>
            <View style={{ flex: 1 }}>
              <Text style={s.pasoNombre}>{t.nombre}</Text>
              {umbral && <Text style={s.nota}>Alerta ≥ {umbral.alerta} min · Crítico ≥ {umbral.critico} min</Text>}
              <Text style={s.nota}>{t.muestras ?? 0} pedidos medidos</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {t.estado === 'ok'
                ? <Text style={[s.tramoValor, { color: COLOR_NIVEL[nivel] }]}>{valorPrincipal(t)}</Text>
                : <InsigniaEstado estado={t.estado} />}
              {t.estado === 'ok' && <Text style={[s.nota, { color: COLOR_NIVEL[nivel] }]}>{ETIQUETA_NIVEL[nivel]}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── Pantalla ─────────────────────────────────────────────────────────────────

type NegocioOpcion = { id: string; nombre: string; zona?: string | null };

export default function AdminIndicadoresScreen() {
  const [ui, setUi] = useState<EstadoFiltros>(() => filtrosIniciales());
  const [datos, setDatos] = useState<RespuestaIndicadores | null>(null);
  const [embudo, setEmbudo] = useState<RespuestaEmbudo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState('');
  const [expandidas, setExpandidas] = useState<Record<string, boolean>>({});
  const [negocios, setNegocios] = useState<NegocioOpcion[]>([]);
  const [selectorNegocio, setSelectorNegocio] = useState(false);
  const [busquedaNegocio, setBusquedaNegocio] = useState('');
  const [inversiones, setInversiones] = useState<{ registros: InversionPublicitaria[]; total: number } | null>(null);
  const [form, setForm] = useState<FormInversion>({ campana: '', fecha_inicio: '', fecha_fin: '', monto: '' });
  const [errorForm, setErrorForm] = useState('');
  const [guardando, setGuardando] = useState(false);
  const consulta = useRef(0);

  const entrada = useMemo(() => construirFiltros(ui), [ui]);
  const hoy = hoyGuatemala();

  useEffect(() => {
    adminAPI.negocios()
      .then((r) => setNegocios((r.data || []).map((n: any) => ({ id: n.id, nombre: n.nombre, zona: n.zona }))))
      .catch(() => {});
  }, []);

  const cargar = useCallback(async () => {
    if (!entrada.filtros) { setCargando(false); setRefrescando(false); return; }
    const id = ++consulta.current;
    setError('');
    const [rInd, rEmb] = await Promise.allSettled([
      indicadoresAPI.indicadores(entrada.filtros),
      indicadoresAPI.embudo(entrada.filtros),
    ]);
    if (id !== consulta.current) return; // llegó una consulta más nueva
    if (rInd.status === 'fulfilled') {
      setDatos(rInd.value.data);
      const p = rInd.value.data.periodo;
      indicadoresAPI.inversiones({ desde: p.desde_local, hasta: p.hasta_local, canal: 'meta_ads' })
        .then((r) => { if (id === consulta.current) setInversiones(r.data); })
        .catch(() => { if (id === consulta.current) setInversiones(null); });
    } else {
      setDatos(null);
      setError((rInd.reason as Error)?.message || 'No se pudieron cargar los indicadores.');
    }
    setEmbudo(rEmb.status === 'fulfilled' ? rEmb.value.data : null);
    setCargando(false);
    setRefrescando(false);
  }, [entrada]);

  useEffect(() => { setCargando(true); void cargar(); }, [cargar]);

  const zonas = useMemo(
    () => [...new Set(negocios.map((n) => (n.zona || '').trim()).filter(Boolean))].sort(),
    [negocios],
  );
  const negocioElegido = negocios.find((n) => n.id === ui.negocio_id);
  const negociosFiltrados = negocios.filter((n) => n.nombre?.toLowerCase().includes(busquedaNegocio.trim().toLowerCase()));
  const kpis = datos?.kpis || [];
  const tramos = tramosTiempos(kpis);
  const cambiar = (parcial: Partial<EstadoFiltros>) => setUi((prev) => ({ ...prev, ...parcial }));

  async function guardarInversion() {
    const v = validarFormInversion(form);
    if (v.error || !v.datos) { setErrorForm(v.error || 'Datos inválidos.'); return; }
    setErrorForm('');
    setGuardando(true);
    try {
      await indicadoresAPI.registrarInversion({ ...v.datos, canal: 'meta_ads' });
      setForm({ campana: '', fecha_inicio: '', fecha_fin: '', monto: '' });
      await cargar(); // el CAC cambia con la inversión nueva
    } catch (e: any) {
      setErrorForm(e?.message || 'No se pudo registrar la inversión.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <SafeAreaView style={s.raiz}>
      <View style={s.cabecera}>
        <Text style={s.cabeceraTag}>03 · INDICADORES</Text>
        <Text style={s.cabeceraTitulo}>Indicadores y embudo</Text>
        {datos && <Text style={s.cabeceraSub}>{describirPeriodo(datos.periodo)}</Text>}
      </View>

      {/* Filtros */}
      <View style={s.filtros}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {OPCIONES_PERIODO.map((o) => (
            <TouchableOpacity key={o.valor} style={[s.chip, ui.periodo === o.valor && s.chipActivo]} onPress={() => cambiar({ periodo: o.valor })}>
              <Text style={[s.chipTexto, ui.periodo === o.valor && s.chipTextoActivo]}>{o.etiqueta}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {ui.periodo === 'mes' && (
          <CalendarioPicker label="Mes" modo="mes" value={ui.mes} maxDate={hoy.slice(0, 7)} onChange={(mes) => cambiar({ mes })} />
        )}
        {ui.periodo === 'rango' && (
          <View style={s.filaRango}>
            <View style={{ flex: 1 }}>
              <CalendarioPicker label="Desde" value={ui.desde} maxDate={ui.hasta || hoy} onChange={(desde) => cambiar({ desde })} />
            </View>
            <View style={{ flex: 1 }}>
              <CalendarioPicker label="Hasta" value={ui.hasta} minDate={ui.desde} maxDate={hoy} onChange={(hasta) => cambiar({ hasta })} />
            </View>
          </View>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          <TouchableOpacity style={[s.chip, !!ui.negocio_id && s.chipActivo]} onPress={() => setSelectorNegocio(true)}>
            <Text style={[s.chipTexto, !!ui.negocio_id && s.chipTextoActivo]} numberOfLines={1}>
              {negocioElegido ? negocioElegido.nombre : 'Todos los negocios'}
            </Text>
          </TouchableOpacity>
          {OPCIONES_TIPO.map((o) => (
            <TouchableOpacity key={o.valor || 'todos'} style={[s.chip, ui.tipo === o.valor && s.chipActivo]} onPress={() => cambiar({ tipo: o.valor })}>
              <Text style={[s.chipTexto, ui.tipo === o.valor && s.chipTextoActivo]}>{o.etiqueta}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {zonas.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            {['', ...zonas].map((z) => (
              <TouchableOpacity key={z || 'todas'} style={[s.chip, ui.zona === z && s.chipActivo]} onPress={() => cambiar({ zona: z })}>
                <Text style={[s.chipTexto, ui.zona === z && s.chipTextoActivo]}>{z ? `Zona ${z.replace(/^zona\s*/i, '')}` : 'Todas las zonas'}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {entrada.error && <Text style={s.error}>{entrada.error}</Text>}
      </View>

      {cargando ? (
        <View style={s.centro}><ActivityIndicator color={GOLD} size="large" /></View>
      ) : (
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={<RefreshControl refreshing={refrescando} onRefresh={() => { setRefrescando(true); void cargar(); }} tintColor={GOLD} />}
        >
          {!!error && (
            <View style={s.aviso}>
              <Text style={s.error}>{error}</Text>
              <TouchableOpacity onPress={() => { setCargando(true); void cargar(); }}><Text style={s.enlace}>Reintentar</Text></TouchableOpacity>
            </View>
          )}
          {(datos?.advertencias || []).length > 0 && (
            <View style={s.aviso}>
              <Text style={s.avisoTexto}>
                Algunas fuentes no respondieron ({datos!.advertencias.map((a) => a.fuente).join(', ')}): sus indicadores se muestran como &quot;Sin datos&quot;.
              </Text>
            </View>
          )}

          {kpis.length > 0 && <Text style={s.seccion}>Indicadores ({kpis.length})</Text>}
          {kpis.map((k) => (
            <TarjetaKpi key={k.clave} kpi={k} expandida={!!expandidas[k.clave]}
              onAlternar={() => setExpandidas((prev) => ({ ...prev, [k.clave]: !prev[k.clave] }))} />
          ))}

          {tramos.length > 0 && <Text style={s.seccion}>Tiempos operativos</Text>}
          <SeccionTiempos tramos={tramos} />

          {embudo && <Text style={s.seccion}>Embudo</Text>}
          <SeccionEmbudo embudo={embudo} />

          {datos && (
            <>
              <Text style={s.seccion}>Inversión Meta Ads (CAC)</Text>
              <View style={s.tarjeta}>
                <Text style={s.nota}>Registros que se solapan con el periodo · {describirPeriodo(datos.periodo)}</Text>
                {inversiones == null ? (
                  <Text style={s.tarjetaSinValor}>No se pudo consultar la inversión.</Text>
                ) : inversiones.registros.length === 0 ? (
                  <Text style={s.tarjetaSinValor}>Sin inversión registrada: el CAC se muestra como &quot;Sin datos&quot;.</Text>
                ) : (
                  <>
                    {inversiones.registros.map((r) => (
                      <View key={r.id} style={s.filaDesglose}>
                        <Text style={s.detalleTexto}>{r.campana || 'Sin campaña'} · {r.fecha_inicio} → {r.fecha_fin}</Text>
                        <Text style={s.filaDesgloseValor}>{formatearMoneda(Number(r.monto))}</Text>
                      </View>
                    ))}
                    <View style={s.filaDesglose}>
                      <Text style={[s.detalleTexto, { fontWeight: '800' }]}>Total registrado (sin prorrateo)</Text>
                      <Text style={s.filaDesgloseValor}>{formatearMoneda(inversiones.total)}</Text>
                    </View>
                  </>
                )}

                <Text style={[s.detalleEtiqueta, { marginTop: 14 }]}>Registrar inversión</Text>
                <TextInput style={s.input} placeholder="Campaña (opcional)" value={form.campana}
                  onChangeText={(campana) => setForm((f) => ({ ...f, campana }))} maxLength={120} />
                <View style={s.filaRango}>
                  <View style={{ flex: 1 }}>
                    <CalendarioPicker label="Inicio" value={form.fecha_inicio} maxDate={form.fecha_fin || undefined}
                      onChange={(fecha_inicio) => setForm((f) => ({ ...f, fecha_inicio }))} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <CalendarioPicker label="Fin" value={form.fecha_fin} minDate={form.fecha_inicio || undefined}
                      onChange={(fecha_fin) => setForm((f) => ({ ...f, fecha_fin }))} />
                  </View>
                </View>
                <TextInput style={s.input} placeholder="Monto (Q)" keyboardType="decimal-pad" value={form.monto}
                  onChangeText={(monto) => setForm((f) => ({ ...f, monto }))} />
                {!!errorForm && <Text style={s.error}>{errorForm}</Text>}
                <TouchableOpacity style={[s.boton, guardando && { opacity: 0.6 }]} onPress={guardarInversion} disabled={guardando}>
                  {guardando ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.botonTexto}>Guardar inversión</Text>}
                </TouchableOpacity>
                <Text style={s.nota}>Una corrección se registra como un nuevo registro: el histórico se conserva.</Text>
              </View>
            </>
          )}
          <View style={{ height: 32 }} />
        </ScrollView>
      )}

      <Modal visible={selectorNegocio} transparent animationType="fade" onRequestClose={() => setSelectorNegocio(false)}>
        <View style={s.modalFondo}>
          <View style={s.modalTarjeta}>
            <Text style={s.tarjetaNombre}>Filtrar por negocio</Text>
            <TextInput style={s.input} placeholder="Buscar negocio" value={busquedaNegocio} onChangeText={setBusquedaNegocio} />
            <FlatList
              data={[{ id: '', nombre: 'Todos los negocios' }, ...negociosFiltrados]}
              keyExtractor={(n) => n.id || 'todos'}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.opcionNegocio} onPress={() => { cambiar({ negocio_id: item.id }); setSelectorNegocio(false); }}>
                  <Text style={[s.detalleTexto, ui.negocio_id === item.id && { color: GOLD, fontWeight: '800' }]}>{item.nombre}</Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity onPress={() => setSelectorNegocio(false)}><Text style={s.enlace}>Cerrar</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  raiz:            { flex: 1, backgroundColor: BG },
  centro:          { flex: 1, justifyContent: 'center', alignItems: 'center' },
  cabecera:        { backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  cabeceraTag:     { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  cabeceraTitulo:  { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  cabeceraSub:     { fontSize: 12, color: TEXT2, marginTop: 4 },

  filtros:         { backgroundColor: CARD, paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: BORDER, gap: 6 },
  chips:           { gap: 8, paddingVertical: 6 },
  chip:            { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: BG, maxWidth: 220 },
  chipActivo:      { backgroundColor: GOLD, borderColor: GOLD },
  chipTexto:       { fontSize: 13, fontWeight: '600', color: TEXT2 },
  chipTextoActivo: { color: '#fff', fontWeight: '800' },
  filaRango:       { flexDirection: 'row', gap: 8 },

  scroll:          { padding: 14 },
  seccion:         { fontSize: 11, fontWeight: '700', color: TEXT2, marginTop: 8, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 },
  aviso:           { backgroundColor: '#FFFBEB', borderColor: '#FDE68A', borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  avisoTexto:      { fontSize: 12, color: '#92400E' },
  error:           { fontSize: 12, color: RED, marginTop: 4 },
  enlace:          { color: GOLD, fontWeight: '700', fontSize: 13, marginTop: 8, textAlign: 'center' },

  tarjeta:         { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 10 },
  tarjetaCabecera: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tarjetaNombre:   { fontSize: 14, fontWeight: '800', color: TEXT, flexShrink: 1 },
  tarjetaValor:    { fontSize: 26, fontWeight: '900', color: TEXT, marginTop: 6 },
  tarjetaSinValor: { fontSize: 12, color: TEXT2, marginTop: 6 },
  tarjetaCociente: { fontSize: 12, color: TEXT2, marginTop: 2 },
  tarjetaToggle:   { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  tarjetaToggleTexto: { fontSize: 12, color: GOLD, fontWeight: '700' },
  tarjetaDetalle:  { borderTopWidth: 1, borderTopColor: BORDER, marginTop: 10, paddingTop: 8 },
  detalleEtiqueta: { fontSize: 10, fontWeight: '800', color: TEXT2, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8 },
  detalleTexto:    { fontSize: 13, color: TEXT, flexShrink: 1 },
  filaDesglose:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 8 },
  filaDesgloseValor: { fontSize: 13, fontWeight: '800', color: TEXT },
  nota:            { fontSize: 11, color: TEXT2, marginTop: 4 },

  insignia:        { borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  insigniaTexto:   { fontSize: 11, fontWeight: '800' },

  pasoEmbudo:      { marginTop: 12 },
  pasoCabecera:    { flexDirection: 'row', justifyContent: 'space-between' },
  pasoNombre:      { fontSize: 13, fontWeight: '700', color: TEXT },
  pasoSesiones:    { fontSize: 13, fontWeight: '800', color: TEXT },
  pasoTasa:        { fontSize: 11, color: TEXT2, marginTop: 2 },
  barraFondo:      { height: 10, borderRadius: 5, backgroundColor: '#F1F5F9', marginTop: 6, overflow: 'hidden' },
  barra:           { height: 10, borderRadius: 5, backgroundColor: GOLD },

  tramo:           { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: BORDER, marginTop: 8 },
  tramoValor:      { fontSize: 18, fontWeight: '900' },

  input:           { borderWidth: 1, borderColor: BORDER, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: TEXT, backgroundColor: BG, marginTop: 8 },
  boton:           { backgroundColor: GOLD, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  botonTexto:      { color: '#fff', fontWeight: '800', fontSize: 14 },

  modalFondo:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 20 },
  modalTarjeta:    { backgroundColor: CARD, borderRadius: 16, padding: 16, maxWidth: 420, width: '100%', alignSelf: 'center' },
  opcionNegocio:   { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BORDER },
});
