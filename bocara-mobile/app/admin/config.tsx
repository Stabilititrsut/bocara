import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { adminAPI, API_BASE_URL } from '@/src/services/api';

const BG     = '#F8FAFC';
const CARD   = '#FFFFFF';
const BORDER = '#E5E7EB';
const TEXT   = '#111827';
const TEXT2  = '#6B7280';
const GOLD   = '#C8A97E';

const CAMPOS: Array<{
  clave: string;
  label: string;
  descripcion: string;
  icon: any;
  unidad?: string;
}> = [
  { clave: 'comision_porcentaje',        label: 'Comisión Bocara',       descripcion: 'Porcentaje que Bocara retiene de cada venta',              icon: 'trending-up',     unidad: '%'  },
  { clave: 'puntos_por_pedido',           label: 'Puntos por pedido',     descripcion: 'Puntos otorgados al cliente al completar un pedido',      icon: 'star',            unidad: 'pts' },
  { clave: 'min_puntos_canje',            label: 'Mínimo para canjear',   descripcion: 'Puntos mínimos requeridos para hacer un canje',           icon: 'lock-open',       unidad: 'pts' },
  { clave: 'puntos_a_quetzales',          label: 'Valor del punto',       descripcion: 'Cuánto vale cada punto en quetzales al canjear',          icon: 'cash',            unidad: 'Q'   },
  { clave: 'costo_envio_fijo',            label: 'Costo de envío',        descripcion: 'Costo fijo de envío a domicilio (0 = gratuito)',          icon: 'bicycle',         unidad: 'Q'   },
  { clave: 'max_bolsas_por_restaurante',  label: 'Bolsas máximas',        descripcion: 'Número máximo de bolsas activas por restaurante',         icon: 'bag',             unidad: ''    },
];

const DEFAULTS: Record<string, number> = {
  comision_porcentaje: 25,
  puntos_por_pedido: 10,
  min_puntos_canje: 100,
  puntos_a_quetzales: 0.10,
  costo_envio_fijo: 25,
  max_bolsas_por_restaurante: 10,
};

function card(extra?: any) {
  return {
    backgroundColor: CARD, borderRadius: 16,
    borderWidth: 1, borderColor: BORDER,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
    ...extra,
  };
}

export default function AdminConfigScreen() {
  const [config,      setConfig]      = useState<Record<string, string>>({});
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [hasTable,    setHasTable]    = useState(true);
  const [showSQL,     setShowSQL]     = useState(false);
  const [geoLoading,  setGeoLoading]  = useState(false);
  const [geoMsg,      setGeoMsg]      = useState('');

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.getConfig();
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.data || {})) vals[k] = String(v);
      setConfig(vals);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  async function guardar() {
    setSaving(true);
    try {
      const payload: Record<string, number> = {};
      for (const campo of CAMPOS) {
        const val = parseFloat(config[campo.clave] || String(DEFAULTS[campo.clave]));
        if (!isNaN(val)) payload[campo.clave] = val;
      }
      await adminAPI.updateConfig(payload);
      Alert.alert('Guardado', 'Configuración actualizada correctamente.');
    } catch (e: any) {
      if (e.message?.includes('configuracion')) {
        setHasTable(false);
        setShowSQL(true);
      } else {
        Alert.alert('Error', e.message);
      }
    } finally { setSaving(false); }
  }

  async function geocodificar() {
    setGeoLoading(true);
    setGeoMsg('Geocodificando... espera un momento');
    try {
      const token = await AsyncStorage.getItem('bocara_token');
      const res = await fetch(`${API_BASE_URL}/admin/geocodificar`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setGeoMsg(`✓ ${data.geocodificados} negocios geocodificados · ${data.fallidos} sin resultado`);
    } catch (e: any) {
      setGeoMsg(`Error: ${e.message}`);
    } finally {
      setGeoLoading(false);
    }
  }

  function restaurarDefaults() {
    Alert.alert('Restaurar valores', '¿Restaurar todos los valores por defecto?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar', onPress: () => {
          const vals: Record<string, string> = {};
          for (const [k, v] of Object.entries(DEFAULTS)) vals[k] = String(v);
          setConfig(vals);
        },
      },
    ]);
  }

  if (loading) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: BG }}>
      <ActivityIndicator color={GOLD} size="large" />
    </View>
  );

  const comPct = parseFloat(config.comision_porcentaje || '25');
  const pts    = parseInt(config.puntos_por_pedido || '10');
  const envio  = parseFloat(config.costo_envio_fijo || '25');

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTag}>CONFIGURACIÓN</Text>
          <Text style={s.headerTitle}>Parámetros del sistema</Text>
        </View>
        <TouchableOpacity style={s.resetBtn} onPress={restaurarDefaults}>
          <Ionicons name="refresh" size={14} color={TEXT2} />
          <Text style={s.resetText}>Restaurar</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Alerta SQL colapsable */}
        {!hasTable && (
          <View style={s.sqlAlert}>
            <TouchableOpacity style={s.sqlAlertHeader} onPress={() => setShowSQL(!showSQL)}>
              <Ionicons name="warning" size={18} color="#D97706" />
              <Text style={s.sqlAlertTitle}>Tabla de configuración no encontrada</Text>
              <Ionicons name={showSQL ? 'chevron-up' : 'chevron-down'} size={16} color="#D97706" />
            </TouchableOpacity>
            {showSQL && (
              <View style={s.sqlAlertBody}>
                <Text style={s.sqlAlertSub}>Ejecuta esto en Supabase → SQL Editor:</Text>
                <View style={s.codeBox}>
                  <Text style={s.codeText}>
                    {'CREATE TABLE configuracion (\n  clave TEXT PRIMARY KEY,\n  valor TEXT\n);'}
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Secciones de configuración */}
        <Text style={s.sectionTitle}>Comisiones y pagos</Text>
        {CAMPOS.slice(0, 2).map((campo) => (
          <ConfigCard key={campo.clave} campo={campo} config={config} setConfig={setConfig} />
        ))}

        <Text style={s.sectionTitle}>Sistema de puntos</Text>
        {CAMPOS.slice(2, 4).map((campo) => (
          <ConfigCard key={campo.clave} campo={campo} config={config} setConfig={setConfig} />
        ))}

        <Text style={s.sectionTitle}>Operaciones</Text>
        {CAMPOS.slice(4).map((campo) => (
          <ConfigCard key={campo.clave} campo={campo} config={config} setConfig={setConfig} />
        ))}

        {/* Preview */}
        <Text style={s.sectionTitle}>Vista previa — pedido de Q100</Text>
        <View style={[card(), s.previewCard]}>
          {[
            { label: 'Pago del cliente',         val: 'Q100.00',                         color: TEXT   },
            { label: `Comisión Bocara (${comPct}%)`, val: `Q${(100 * comPct / 100).toFixed(2)}`, color: GOLD   },
            { label: 'Pago al restaurante',      val: `Q${(100 - 100 * comPct / 100).toFixed(2)}`, color: '#16A34A' },
            { label: 'Puntos que gana el cliente', val: `${pts} pts`,                    color: '#3B82F6' },
            { label: 'Costo envío a domicilio',  val: `Q${envio.toFixed(2)}`,            color: TEXT2  },
          ].map(({ label, val, color }, i, arr) => (
            <View key={label} style={[s.previewRow, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: BORDER }]}>
              <Text style={s.previewLabel}>{label}</Text>
              <Text style={[s.previewVal, { color }]}>{val}</Text>
            </View>
          ))}
        </View>

        {/* Botón guardar */}
        <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={guardar} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <>
                <Ionicons name="save" size={18} color="#fff" />
                <Text style={s.saveBtnText}>Guardar configuración</Text>
              </>
          }
        </TouchableOpacity>

        {/* SQL para nuevas columnas de ubicación */}
        <Text style={s.sectionTitle}>SQL — Columnas de ubicación</Text>
        <View style={[card(), { padding: 16, marginBottom: 20 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Ionicons name="code-slash" size={18} color={GOLD} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: TEXT }}>Ejecutar en Supabase → SQL Editor</Text>
          </View>
          <Text style={{ fontSize: 12, color: TEXT2, marginBottom: 10, lineHeight: 18 }}>
            Agrega los campos de punto de referencia y links de navegación a la tabla negocios.
          </Text>
          <View style={s.codeBox}>
            <Text style={s.codeText}>
              {'ALTER TABLE negocios\nADD COLUMN IF NOT EXISTS punto_referencia text,\nADD COLUMN IF NOT EXISTS google_maps_url text,\nADD COLUMN IF NOT EXISTS waze_url text;'}
            </Text>
          </View>
        </View>

        {/* Geocodificación */}
        <Text style={s.sectionTitle}>Herramientas</Text>
        <View style={[card(), s.geoCard]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Ionicons name="map" size={20} color={GOLD} />
            <Text style={s.geoTitle}>Geocodificación masiva</Text>
          </View>
          <Text style={s.geoDesc}>
            Asigna coordenadas a todos los negocios sin ubicación usando OpenStreetMap (~1s por negocio).
          </Text>
          <TouchableOpacity
            style={[s.geoBtn, geoLoading && { opacity: 0.5 }]}
            disabled={geoLoading}
            onPress={geocodificar}
          >
            {geoLoading
              ? <ActivityIndicator color="#fff" size="small" />
              : <><Ionicons name="search" size={16} color="#fff" /><Text style={s.geoBtnText}>Geocodificar ahora</Text></>
            }
          </TouchableOpacity>
          {geoMsg ? <Text style={s.geoMsgText}>{geoMsg}</Text> : null}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ConfigCard({ campo, config, setConfig }: {
  campo: typeof CAMPOS[0];
  config: Record<string, string>;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const valor = config[campo.clave] ?? String(DEFAULTS[campo.clave] ?? '');
  const hasPrefix = campo.unidad && campo.unidad !== '%';
  const hasSuffix = campo.unidad === '%';

  return (
    <View style={[{
      backgroundColor: CARD, borderRadius: 16, borderWidth: 1, borderColor: BORDER,
      shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
      marginBottom: 10, padding: 16,
    }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12, gap: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#FEF9EC', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={campo.icon} size={18} color={GOLD} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: TEXT }}>{campo.label}</Text>
          <Text style={{ fontSize: 12, color: TEXT2, marginTop: 2, lineHeight: 17 }}>{campo.descripcion}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {hasPrefix && (
          <View style={s.unitBox}>
            <Text style={s.unitText}>{campo.unidad}</Text>
          </View>
        )}
        <TextInput
          style={[s.input, { flex: 1, borderTopLeftRadius: hasPrefix ? 0 : 12, borderBottomLeftRadius: hasPrefix ? 0 : 12, borderTopRightRadius: hasSuffix ? 0 : 12, borderBottomRightRadius: hasSuffix ? 0 : 12 }]}
          value={valor}
          onChangeText={(v) => setConfig((prev) => ({ ...prev, [campo.clave]: v }))}
          keyboardType="decimal-pad"
          placeholder={String(DEFAULTS[campo.clave] ?? '')}
          placeholderTextColor="#9CA3AF"
        />
        {hasSuffix && (
          <View style={[s.unitBox, { borderTopRightRadius: 12, borderBottomRightRadius: 12, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeftWidth: 0 }]}>
            <Text style={s.unitText}>%</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: BG },
  header:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, padding: 20, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTag:  { fontSize: 10, color: GOLD, fontWeight: '800', letterSpacing: 1.5 },
  headerTitle: { fontSize: 22, fontWeight: '900', color: TEXT, marginTop: 2 },
  resetBtn:   { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  resetText:  { fontSize: 13, color: TEXT2, fontWeight: '600' },
  scroll:     { padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: TEXT2, marginBottom: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.8 },

  sqlAlert:       { backgroundColor: '#FFFBEB', borderRadius: 14, borderWidth: 1, borderColor: '#FDE68A', marginBottom: 16, overflow: 'hidden' },
  sqlAlertHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14 },
  sqlAlertTitle:  { flex: 1, fontSize: 13, fontWeight: '700', color: '#92400E' },
  sqlAlertBody:   { borderTopWidth: 1, borderTopColor: '#FDE68A', padding: 14 },
  sqlAlertSub:    { fontSize: 12, color: '#B45309', marginBottom: 8 },
  codeBox:        { backgroundColor: '#1A1A1A', borderRadius: 10, padding: 12 },
  codeText:       { fontFamily: 'monospace', fontSize: 12, color: '#86EFAC', lineHeight: 20 },

  input:    { height: 48, backgroundColor: BG, borderWidth: 1, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 16, fontSize: 18, fontWeight: '800', color: TEXT, textAlign: 'center' },
  unitBox:  { height: 48, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: BORDER, borderRadius: 12 },
  unitText: { fontSize: 14, fontWeight: '700', color: TEXT2 },

  previewCard: { marginBottom: 20, overflow: 'hidden' },
  previewRow:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14 },
  previewLabel: { fontSize: 13, color: TEXT2 },
  previewVal:   { fontSize: 14, fontWeight: '800' },

  saveBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: GOLD, borderRadius: 16, padding: 16, marginBottom: 20 },
  saveBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },

  geoCard:  { padding: 16, marginBottom: 20 },
  geoTitle: { fontSize: 15, fontWeight: '700', color: TEXT },
  geoDesc:  { fontSize: 12, color: TEXT2, lineHeight: 18, marginBottom: 14 },
  geoBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#1D4ED8', borderRadius: 12, padding: 12 },
  geoBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  geoMsgText: { fontSize: 13, color: GOLD, marginTop: 12, fontWeight: '600', textAlign: 'center' },
});
