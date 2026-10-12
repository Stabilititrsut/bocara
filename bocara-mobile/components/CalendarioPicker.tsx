// Selector visual de fecha (calendario compacto tipo Booking/Airbnb) —
// reemplaza el input de texto libre en Fecha de caducidad / Fecha de inicio /
// Fecha de publicación (restaurante/bolsas.tsx) y sirve también de selector de
// día/mes en el dashboard del restaurante. El usuario nunca escribe la fecha a
// mano: toca el campo, navega entre meses y toca un día. Solo primitivos de
// react-native (Modal, View, Text, TouchableOpacity) — sin dependencias
// nuevas, funciona igual en web y nativo.
//
// El modal es una tarjeta centrada de ancho acotado (maxWidth), no una hoja a
// pantalla completa: en web desktop queda como una tarjeta de ~340 px, en
// pantallas angostas se adapta al ancho disponible dejando margen lateral.
//
// Valor interno siempre canónico: 'YYYY-MM-DD' (modo día, el formato que ya
// usa el backend para columnas `date`) o 'YYYY-MM' (modo mes). En la UI se
// muestra 'DD/MM/AAAA' / 'octubre 2026'.
import { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '@/constants/Colors';

type Props = {
  label: string;
  value: string; // 'YYYY-MM-DD' (o 'YYYY-MM' en modo mes), '' si no hay selección
  onChange: (valorISO: string) => void;
  placeholder?: string;
  disabled?: boolean;
  // 'dia' (por defecto) elige un día; 'mes' elige un mes completo.
  modo?: 'dia' | 'mes';
  // Días (o meses) anteriores a este quedan deshabilitados (p. ej. fecha fin >= fecha inicio).
  minDate?: string;
  // Días (o meses) posteriores a este quedan deshabilitados (p. ej. no consultar el futuro).
  maxDate?: string;
};

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
// Semana empezando en lunes, como en Guatemala.
const DIAS_SEMANA = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

// Ancho máximo de la tarjeta: compacto en desktop, sin llenar la página.
export const ANCHO_MAX_CALENDARIO = 340;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function aISO(anio: number, mes: number, dia: number): string {
  return `${anio}-${pad2(mes + 1)}-${pad2(dia)}`;
}

function aMesISO(anio: number, mes: number): string {
  return `${anio}-${pad2(mes + 1)}`;
}

// Parsea 'YYYY-MM-DD' (o 'YYYY-MM' en modo mes, con dia = 1) a {anio, mes
// (0-11), dia} — sin pasar por Date+ISO con hora, para no arrastrar ningún
// desfase de zona horaria.
function parse(valorISO: string): { anio: number; mes: number; dia: number } | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(valorISO || '');
  if (!m) return null;
  return { anio: Number(m[1]), mes: Number(m[2]) - 1, dia: m[3] ? Number(m[3]) : 1 };
}

// 'YYYY-MM-DD' → 'DD/MM/AAAA'; 'YYYY-MM' → 'octubre 2026'.
export function formatoLegible(valorISO: string, modo: 'dia' | 'mes' = 'dia'): string {
  const p = parse(valorISO);
  if (!p) return '';
  if (modo === 'mes') return `${MESES[p.mes]} ${p.anio}`;
  return `${pad2(p.dia)}/${pad2(p.mes + 1)}/${p.anio}`;
}

// Días del mes `mes` (0-11) de `anio`.
function diasEnMes(anio: number, mes: number): number {
  return new Date(anio, mes + 1, 0).getDate();
}

// Columna (0 = lunes … 6 = domingo) del primer día del mes.
function columnaPrimerDia(anio: number, mes: number): number {
  return (new Date(anio, mes, 1).getDay() + 6) % 7;
}

export default function CalendarioPicker({
  label, value, onChange, placeholder = 'Seleccionar fecha', disabled, modo = 'dia', minDate, maxDate,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const hoy = new Date();
  const hoyISO = aISO(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());

  // Límites normalizados a la granularidad del modo: en modo mes se comparan
  // 'YYYY-MM' (comparar '2026-10' con '2026-10-05' como texto daría el mes
  // de minDate por deshabilitado); en modo día, las fechas completas.
  const limite = (v?: string) => (v ? (modo === 'mes' ? v.slice(0, 7) : v) : undefined);
  const min = limite(minDate);
  const max = limite(maxDate);
  const fueraDeRango = (valorISO: string) => {
    const v = limite(valorISO) as string;
    return (!!min && v < min) || (!!max && v > max);
  };

  // Mes (o año, en modo mes) donde abre el calendario: el del valor si es
  // elegible; si no (p. ej. la fecha fin vieja de una publicación que se
  // edita), el del límite más cercano — nunca un mes que no se puede usar.
  function puntoDeApertura() {
    if (value && !fueraDeRango(value)) return parse(value);
    if (min && hoyISO.slice(0, min.length) < min) return parse(minDate as string);
    if (max && hoyISO.slice(0, max.length) > max) return parse(maxDate as string);
    return { anio: hoy.getFullYear(), mes: hoy.getMonth(), dia: hoy.getDate() };
  }

  const inicial = puntoDeApertura() || { anio: hoy.getFullYear(), mes: hoy.getMonth(), dia: hoy.getDate() };
  const [visAnio, setVisAnio] = useState(inicial.anio);
  const [visMes, setVisMes] = useState(inicial.mes);

  function abrir() {
    if (disabled) return;
    const p = puntoDeApertura() || inicial;
    setVisAnio(p.anio);
    setVisMes(p.mes);
    setAbierto(true);
  }

  // ¿Hay algo elegible antes / después de lo visible? Modo día: por mes;
  // modo mes: por año. Si no, la flecha se deshabilita (no se navega al pasado
  // de minDate ni al futuro de maxDate).
  const visible = modo === 'mes' ? String(visAnio) : aMesISO(visAnio, visMes);
  const minNav = minDate ? (modo === 'mes' ? minDate.slice(0, 4) : minDate.slice(0, 7)) : null;
  const maxNav = maxDate ? (modo === 'mes' ? maxDate.slice(0, 4) : maxDate.slice(0, 7)) : null;
  const puedeRetroceder = !minNav || visible > minNav;
  const puedeAvanzar = !maxNav || visible < maxNav;

  // Modo día: ±1 mes. Modo mes: ±1 año.
  function navegar(delta: number) {
    if (delta < 0 && !puedeRetroceder) return;
    if (delta > 0 && !puedeAvanzar) return;
    if (modo === 'mes') { setVisAnio(visAnio + delta); return; }
    let m = visMes + delta;
    let a = visAnio;
    if (m < 0) { m = 11; a -= 1; }
    if (m > 11) { m = 0; a += 1; }
    setVisMes(m);
    setVisAnio(a);
  }

  function elegir(valorISO: string) {
    if (fueraDeRango(valorISO)) return;
    onChange(valorISO);
    setAbierto(false);
  }

  // Valor ya guardado que quedó fuera de rango (fecha fin vieja al editar):
  // el campo lo marca para que se elija una nueva en vez de parecer válido.
  const valorFueraDeRango = !!value && fueraDeRango(value);

  const seleccionado = parse(value);
  const legible = value ? formatoLegible(value, modo) : '';

  let cuerpo;
  if (modo === 'mes') {
    cuerpo = (
      <View style={st.gridMeses}>
        {MESES_CORTOS.map((nombre, mes) => {
          const valorMes = aMesISO(visAnio, mes);
          const esSeleccionado = !!seleccionado && seleccionado.anio === visAnio && seleccionado.mes === mes && !fueraDeRango(valorMes);
          const deshabilitado = fueraDeRango(valorMes);
          return (
            <TouchableOpacity
              key={mes}
              style={st.celdaMes}
              onPress={() => !deshabilitado && elegir(valorMes)}
              disabled={deshabilitado}
              accessibilityLabel={`${MESES[mes]} ${visAnio}`}
            >
              <View style={[st.pastillaMes, esSeleccionado && st.marcaActiva]}>
                <Text style={[
                  st.celdaTexto,
                  esSeleccionado && st.celdaTextoActivo,
                  deshabilitado && st.celdaTextoDeshabilitado,
                ]}>{nombre}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  } else {
    const total = diasEnMes(visAnio, visMes);
    const celdas: (number | null)[] = [
      ...Array(columnaPrimerDia(visAnio, visMes)).fill(null),
      ...Array.from({ length: total }, (_, i) => i + 1),
    ];
    cuerpo = (
      <>
        <View style={st.filaSemana}>
          {DIAS_SEMANA.map((d) => (
            <Text key={d} style={st.diaSemanaTexto}>{d}</Text>
          ))}
        </View>
        <View style={st.grid}>
          {celdas.map((dia, i) => {
            if (dia === null) return <View key={`v${i}`} style={st.celda} />;
            const fechaCelda = aISO(visAnio, visMes, dia);
            const esSeleccionado = !!seleccionado && seleccionado.anio === visAnio && seleccionado.mes === visMes && seleccionado.dia === dia && !fueraDeRango(fechaCelda);
            const esHoy = fechaCelda === hoyISO;
            const deshabilitada = fueraDeRango(fechaCelda);
            return (
              <TouchableOpacity
                key={fechaCelda}
                style={st.celda}
                onPress={() => !deshabilitada && elegir(fechaCelda)}
                disabled={deshabilitada}
                accessibilityLabel={formatoLegible(fechaCelda)}
              >
                <View style={[st.marca, esHoy && !esSeleccionado && st.marcaHoy, esSeleccionado && st.marcaActiva]}>
                  <Text style={[
                    st.celdaTexto,
                    esSeleccionado && st.celdaTextoActivo,
                    deshabilitada && st.celdaTextoDeshabilitado,
                  ]}>{dia}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </>
    );
  }

  return (
    <View>
      {!!label && <Text style={st.label}>{label}</Text>}
      <TouchableOpacity
        style={[st.boton, disabled && st.botonDeshabilitado, valorFueraDeRango && st.botonFueraDeRango]}
        onPress={abrir}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label ? `${label}: ` : ''}${legible || placeholder}`}
      >
        <Text style={[st.botonTexto, !value && st.botonPlaceholder]} numberOfLines={1}>
          {legible || placeholder}
        </Text>
        <Text style={st.botonIcono}>📅</Text>
      </TouchableOpacity>
      {valorFueraDeRango && (
        <Text style={st.avisoFueraDeRango}>
          {min && (limite(value) as string) < min
            ? `Elige una fecha a partir del ${formatoLegible(minDate as string, modo)}`
            : `Elige una fecha hasta el ${formatoLegible(maxDate as string, modo)}`}
        </Text>
      )}

      <Modal visible={abierto} transparent animationType="fade" onRequestClose={() => setAbierto(false)}>
        <View style={st.overlay}>
          {/* Fondo: tocar fuera de la tarjeta cierra sin cambiar nada. */}
          <TouchableOpacity style={st.fondo} activeOpacity={1} onPress={() => setAbierto(false)} accessibilityLabel="Cerrar calendario" />
          <View style={st.card}>
            {!!label && <Text style={st.titulo} numberOfLines={1}>{label.replace(/\s*\*$/, '')}</Text>}

            <View style={st.cabeceraMes}>
              <TouchableOpacity
                style={st.flecha}
                onPress={() => navegar(-1)}
                disabled={!puedeRetroceder}
                accessibilityState={{ disabled: !puedeRetroceder }}
                accessibilityLabel={modo === 'mes' ? 'Año anterior' : 'Mes anterior'}
              >
                <Text style={[st.flechaTexto, !puedeRetroceder && st.flechaDeshabilitada]}>‹</Text>
              </TouchableOpacity>
              <Text style={st.mesTexto}>{modo === 'mes' ? visAnio : `${MESES[visMes]} ${visAnio}`}</Text>
              <TouchableOpacity
                style={st.flecha}
                onPress={() => navegar(1)}
                disabled={!puedeAvanzar}
                accessibilityState={{ disabled: !puedeAvanzar }}
                accessibilityLabel={modo === 'mes' ? 'Año siguiente' : 'Mes siguiente'}
              >
                <Text style={[st.flechaTexto, !puedeAvanzar && st.flechaDeshabilitada]}>›</Text>
              </TouchableOpacity>
            </View>

            {cuerpo}

            <View style={st.pie}>
              <TouchableOpacity style={st.btnCancelar} onPress={() => setAbierto(false)}>
                <Text style={st.btnCancelarTexto}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const TAM_CELDA = 38;

const st = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6, marginTop: 4 },
  boton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 4,
  },
  botonDeshabilitado: { opacity: 0.5 },
  botonFueraDeRango: { borderColor: Colors.error },
  avisoFueraDeRango: { fontSize: 11, color: Colors.error, fontWeight: '600', marginBottom: 4 },
  botonTexto: { flexShrink: 1, fontSize: 14, color: Colors.textPrimary, fontWeight: '700', textTransform: 'capitalize' },
  botonPlaceholder: { color: Colors.textLight, fontWeight: '400', textTransform: 'none' },
  botonIcono: { fontSize: 15, marginLeft: 6 },

  // Tarjeta centrada, ancho acotado — nunca hoja a pantalla completa.
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  fondo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: '100%', maxWidth: ANCHO_MAX_CALENDARIO,
    backgroundColor: Colors.white, borderRadius: 16,
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 18, elevation: 8,
  },
  titulo: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, textAlign: 'center', marginBottom: 4 },
  cabeceraMes: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  flecha: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  flechaTexto: { fontSize: 22, lineHeight: 24, fontWeight: '700', color: Colors.textPrimary },
  flechaDeshabilitada: { color: Colors.border },
  mesTexto: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary, textTransform: 'capitalize' },

  filaSemana: { flexDirection: 'row', marginBottom: 2 },
  diaSemanaTexto: { width: '14.2857%', textAlign: 'center', fontSize: 11, fontWeight: '700', color: Colors.textLight, paddingVertical: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  celda: { width: '14.2857%', height: TAM_CELDA + 2, alignItems: 'center', justifyContent: 'center' },
  marca: { width: TAM_CELDA - 4, height: TAM_CELDA - 4, borderRadius: (TAM_CELDA - 4) / 2, alignItems: 'center', justifyContent: 'center' },
  marcaHoy: { borderWidth: 1, borderColor: Colors.aqua },
  marcaActiva: { backgroundColor: Colors.aqua },
  celdaTexto: { fontSize: 14, color: Colors.textPrimary, fontWeight: '600' },
  celdaTextoActivo: { color: Colors.white, fontWeight: '800' },
  celdaTextoDeshabilitado: { color: Colors.border },

  gridMeses: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 4 },
  celdaMes: { width: '33.3333%', height: 44, alignItems: 'center', justifyContent: 'center' },
  pastillaMes: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 },

  pie: { flexDirection: 'row', justifyContent: 'center', marginTop: 4, borderTopWidth: 1, borderTopColor: Colors.border },
  btnCancelar: { paddingHorizontal: 20, paddingVertical: 10 },
  btnCancelarTexto: { color: Colors.textSecondary, fontWeight: '700', fontSize: 14 },
});
