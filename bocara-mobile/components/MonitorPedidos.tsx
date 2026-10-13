// Monitor operativo en vivo (Admin › Dashboard): pedidos pagados en curso
// (pagado / confirmado / en_preparacion / listo) con el tiempo que llevan en su
// estado actual y un semáforo para priorizar llamadas de seguimiento:
// verde < 10 min · amarillo 10–25 min · rojo > 25 min (GET /admin/monitor-pedidos).
//
// Se refresca solo cada 20 s mientras la pantalla está enfocada (no gasta red
// en segundo plano) y con el botón "Actualizar en vivo".
import { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI } from '@/src/services/api';

const REFRESCO_MS = 20000;
const VISIBLES_INICIAL = 8;

type Nivel = 'verde' | 'amarillo' | 'rojo' | 'sin_datos';
type FilaMonitor = {
  id: string;
  codigo: string | null;
  tipo: 'tiempo_limitado' | 'promocion' | 'mixto';
  estado: string;
  estado_etiqueta: string;
  minutos_en_estado: number | null;
  nivel: Nivel;
  restaurante: { id: string; nombre: string; zona: string | null; telefono: string | null };
};
type RespuestaMonitor = {
  pedidos: FilaMonitor[];
  conteo: Record<Nivel, number>;
  total: number;
  generado_en: string;
};

const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#E8820C';

const COLOR_NIVEL: Record<Nivel, { punto: string; fondo: string; texto: string; etiqueta: string }> = {
  verde:     { punto: '#22C55E', fondo: '#F0FDF4', texto: '#166534', etiqueta: '< 10 min' },
  amarillo:  { punto: '#F59E0B', fondo: '#FFFBEB', texto: '#92400E', etiqueta: '10–25 min' },
  rojo:      { punto: '#DC2626', fondo: '#FEF2F2', texto: '#991B1B', etiqueta: '> 25 min' },
  sin_datos: { punto: '#9CA3AF', fondo: '#F3F4F6', texto: '#374151', etiqueta: 'sin marca' },
};

const ETIQUETA_TIPO: Record<FilaMonitor['tipo'], string> = {
  tiempo_limitado: 'Tiempo Limitado',
  promocion: 'Promoción',
  mixto: 'TL + Promo',
};

function duracion(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export default function MonitorPedidos() {
  const [datos, setDatos] = useState<RespuestaMonitor | null>(null);
  const [cargando, setCargando] = useState(true);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState('');
  const [verTodos, setVerTodos] = useState(false);
  const [contactoAbierto, setContactoAbierto] = useState<string | null>(null);
  const enCurso = useRef(false);

  const cargar = useCallback(async () => {
    if (enCurso.current) return; // no apilar consultas si la red va lenta
    enCurso.current = true;
    try {
      const res = await adminAPI.monitorPedidos();
      setDatos(res.data);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'No se pudo actualizar el monitor.');
    } finally {
      enCurso.current = false;
      setCargando(false);
      setActualizando(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    cargar();
    const id = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(id);
  }, [cargar]));

  const pedidos = datos?.pedidos || [];
  const visibles = verTodos ? pedidos : pedidos.slice(0, VISIBLES_INICIAL);
  const hora = datos ? new Date(datos.generado_en).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;

  return (
    <View style={s.card}>
      <View style={s.cabecera}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={s.puntoVivo} />
            <Text style={s.titulo}>Monitor operativo en vivo</Text>
          </View>
          <Text style={s.sub}>
            {datos ? `${datos.total} pedido${datos.total !== 1 ? 's' : ''} activo${datos.total !== 1 ? 's' : ''} · actualizado ${hora} · cada 20 s` : 'Pedidos activos'}
          </Text>
        </View>
        <TouchableOpacity
          style={[s.boton, actualizando && { opacity: 0.6 }]}
          onPress={() => { setActualizando(true); cargar(); }}
          disabled={actualizando}
          accessibilityRole="button"
        >
          {actualizando
            ? <ActivityIndicator color="#fff" size="small" />
            : <><Ionicons name="refresh" size={14} color="#fff" /><Text style={s.botonTexto}>Actualizar en vivo</Text></>}
        </TouchableOpacity>
      </View>

      {datos && datos.total > 0 && (
        <View style={s.resumen}>
          {(['rojo', 'amarillo', 'verde'] as Nivel[]).map((n) => (
            <View key={n} style={[s.resumenChip, { backgroundColor: COLOR_NIVEL[n].fondo }]}>
              <View style={[s.punto, { backgroundColor: COLOR_NIVEL[n].punto }]} />
              <Text style={[s.resumenTexto, { color: COLOR_NIVEL[n].texto }]}>
                {datos.conteo[n] || 0} · {COLOR_NIVEL[n].etiqueta}
              </Text>
            </View>
          ))}
        </View>
      )}

      {!!error && <Text style={s.error}>{error}</Text>}

      {cargando ? (
        <ActivityIndicator color={GOLD} style={{ marginVertical: 20 }} />
      ) : pedidos.length === 0 ? (
        <View style={s.vacio}>
          <Ionicons name="checkmark-circle-outline" size={28} color="#22C55E" />
          <Text style={s.vacioTexto}>Sin pedidos en curso. Todo al día.</Text>
        </View>
      ) : (
        visibles.map((p) => {
          const c = COLOR_NIVEL[p.nivel];
          const tel = p.restaurante.telefono;
          const abierto = contactoAbierto === p.id;
          return (
            <View key={p.id} style={[s.fila, { borderLeftColor: c.punto }]}>
              <View style={s.filaArriba}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={s.codigo}>{p.codigo || '—'}</Text>
                    <View style={[s.tipo, p.tipo !== 'tiempo_limitado' && s.tipoPromo]}>
                      <Text style={[s.tipoTexto, p.tipo !== 'tiempo_limitado' && { color: '#6D28D9' }]}>{ETIQUETA_TIPO[p.tipo]}</Text>
                    </View>
                  </View>
                  <Text style={s.restaurante} numberOfLines={1}>
                    {p.restaurante.nombre}{p.restaurante.zona ? ` · Zona ${String(p.restaurante.zona).replace(/^zona\s*/i, '')}` : ''}
                  </Text>
                </View>
                <View style={[s.alerta, { backgroundColor: c.fondo }]}>
                  <View style={[s.punto, { backgroundColor: c.punto }]} />
                  <Text style={[s.alertaTexto, { color: c.texto }]}>{duracion(p.minutos_en_estado)}</Text>
                </View>
              </View>

              <View style={s.filaAbajo}>
                <Text style={s.estado}>
                  {p.estado_etiqueta}: <Text style={{ fontWeight: '800', color: c.texto }}>{duracion(p.minutos_en_estado)}</Text>
                </Text>
                <TouchableOpacity
                  style={s.contactoBtn}
                  onPress={() => setContactoAbierto(abierto ? null : p.id)}
                  accessibilityRole="button"
                >
                  <Ionicons name="call-outline" size={13} color={GOLD} />
                  <Text style={s.contactoBtnTexto}>Contacto</Text>
                </TouchableOpacity>
              </View>

              {abierto && (
                <View style={s.contacto}>
                  {tel ? (
                    <>
                      <Text style={s.contactoTel} selectable>{tel}</Text>
                      <TouchableOpacity style={s.llamarBtn} onPress={() => Linking.openURL(`tel:${tel.replace(/[^\d+]/g, '')}`).catch(() => {})}>
                        <Ionicons name="call" size={13} color="#fff" />
                        <Text style={s.llamarTexto}>Llamar</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <Text style={s.sinTel}>Restaurante sin teléfono registrado.</Text>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}

      {pedidos.length > VISIBLES_INICIAL && (
        <TouchableOpacity onPress={() => setVerTodos(!verTodos)} style={{ paddingTop: 10, alignItems: 'center' }}>
          <Text style={s.enlace}>{verTodos ? 'Ver menos' : `Ver todos (${pedidos.length})`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:        { backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER, padding: 14, marginBottom: 20,
                 shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  cabecera:    { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  puntoVivo:   { width: 8, height: 8, borderRadius: 4, backgroundColor: '#DC2626' },
  titulo:      { fontSize: 15, fontWeight: '900', color: TEXT },
  sub:         { fontSize: 11, color: TEXT2, marginTop: 2 },
  boton:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: GOLD, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, minWidth: 40, justifyContent: 'center' },
  botonTexto:  { color: '#fff', fontWeight: '700', fontSize: 12 },

  resumen:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  resumenChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  resumenTexto: { fontSize: 11, fontWeight: '700' },
  punto:       { width: 8, height: 8, borderRadius: 4 },

  error:       { fontSize: 12, color: '#DC2626', marginBottom: 8 },
  vacio:       { alignItems: 'center', paddingVertical: 18, gap: 6 },
  vacioTexto:  { fontSize: 13, color: TEXT2 },

  fila:        { borderWidth: 1, borderColor: BORDER, borderLeftWidth: 4, borderRadius: 12, padding: 10, marginTop: 8 },
  filaArriba:  { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  codigo:      { fontSize: 13, fontWeight: '900', color: TEXT, letterSpacing: 0.5 },
  tipo:        { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: '#FFF7ED' },
  tipoPromo:   { backgroundColor: '#F5F3FF' },
  tipoTexto:   { fontSize: 10, fontWeight: '800', color: '#C2410C' },
  restaurante: { fontSize: 12, color: TEXT2, marginTop: 2 },
  alerta:      { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  alertaTexto: { fontSize: 12, fontWeight: '800' },
  filaAbajo:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  estado:      { fontSize: 12, color: TEXT, flexShrink: 1 },
  contactoBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: '#FED7AA', borderRadius: 14, paddingHorizontal: 9, paddingVertical: 4 },
  contactoBtnTexto: { fontSize: 11, fontWeight: '700', color: GOLD },
  contacto:    { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, backgroundColor: '#F9FAFB', borderRadius: 10, padding: 8 },
  contactoTel: { fontSize: 14, fontWeight: '800', color: TEXT, flex: 1 },
  llamarBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#16A34A', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  llamarTexto: { color: '#fff', fontWeight: '700', fontSize: 12 },
  sinTel:      { fontSize: 12, color: TEXT2 },
  enlace:      { color: GOLD, fontSize: 13, fontWeight: '700' },
});
