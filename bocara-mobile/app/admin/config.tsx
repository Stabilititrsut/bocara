import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { adminAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';

const DARK = '#1E293B';

const CAMPOS: Array<{
  clave: string;
  label: string;
  descripcion: string;
  emoji: string;
  unidad?: string;
  tipo: 'number' | 'boolean';
}> = [
  { clave: 'comision_porcentaje', label: 'Comisión Bocara', descripcion: 'Porcentaje que Bocara retiene de cada venta', emoji: '🏦', unidad: '%', tipo: 'number' },
  { clave: 'puntos_por_pedido', label: 'Puntos por pedido', descripcion: 'Puntos otorgados al cliente al completar un pedido', emoji: '⭐', unidad: 'pts', tipo: 'number' },
  { clave: 'min_puntos_canje', label: 'Mínimo para canjear', descripcion: 'Puntos mínimos requeridos para hacer un canje', emoji: '🔓', unidad: 'pts', tipo: 'number' },
  { clave: 'puntos_a_quetzales', label: 'Valor del punto', descripcion: 'Cuánto vale cada punto en quetzales al canjear', emoji: '💱', unidad: 'Q', tipo: 'number' },
  { clave: 'costo_envio_fijo', label: 'Costo de envío', descripcion: 'Costo fijo de envío a domicilio (0 para gratuito)', emoji: '🏍️', unidad: 'Q', tipo: 'number' },
  { clave: 'max_bolsas_por_restaurante', label: 'Bolsas máximas', descripcion: 'Número máximo de bolsas activas por restaurante', emoji: '🥡', unidad: '', tipo: 'number' },
];

const DEFAULTS: Record<string, number> = {
  comision_porcentaje: 25,
  puntos_por_pedido: 10,
  min_puntos_canje: 100,
  puntos_a_quetzales: 0.10,
  costo_envio_fijo: 25,
  max_bolsas_por_restaurante: 10,
};

export default function AdminConfigScreen() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasTable, setHasTable] = useState(true);

  const cargar = useCallback(async () => {
    try {
      const res = await adminAPI.getConfig();
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.data || {})) {
        vals[k] = String(v);
      }
      setConfig(vals);
    } catch { } finally { setLoading(false); }
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
      Alert.alert('✅ Guardado', 'Configuración actualizada correctamente.');
    } catch (e: any) {
      if (e.message?.includes('configuracion')) {
        setHasTable(false);
        Alert.alert(
          'Tabla requerida',
          'Crea la tabla de configuración en Supabase SQL Editor:\n\nCREATE TABLE configuracion (\n  clave TEXT PRIMARY KEY,\n  valor TEXT\n);',
          [{ text: 'Entendido' }]
        );
      } else {
        Alert.alert('Error', e.message);
      }
    } finally { setSaving(false); }
  }

  function restaurarDefaults() {
    Alert.alert('Restaurar valores', '¿Restaurar todos los valores por defecto?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar', onPress: () => {
          const vals: Record<string, string> = {};
          for (const [k, v] of Object.entries(DEFAULTS)) vals[k] = String(v);
          setConfig(vals);
        }
      },
    ]);
  }

  if (loading) return (
    <View style={[s.loading, { backgroundColor: '#0F172A' }]}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>⚙️ Configuración</Text>
        <TouchableOpacity style={s.resetBtn} onPress={restaurarDefaults}>
          <Text style={s.resetText}>Restaurar</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        {!hasTable && (
          <View style={s.warningCard}>
            <Text style={s.warningTitle}>⚠️ Tabla de configuración no encontrada</Text>
            <Text style={s.warningText}>
              Ejecuta esto en Supabase → SQL Editor:
            </Text>
            <View style={s.codeBox}>
              <Text style={s.codeText}>
                CREATE TABLE configuracion ({'\n'}
                {'  '}clave TEXT PRIMARY KEY,{'\n'}
                {'  '}valor TEXT{'\n'}
                );
              </Text>
            </View>
          </View>
        )}

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

        {/* Preview de la comisión */}
        <View style={s.previewCard}>
          <Text style={s.previewTitle}>Vista previa: pedido de Q100</Text>
          {(() => {
            const com = parseFloat(config.comision_porcentaje || '25');
            const comVal = (100 * com / 100).toFixed(2);
            const netoVal = (100 - 100 * com / 100).toFixed(2);
            const pts = parseInt(config.puntos_por_pedido || '10');
            const envio = parseFloat(config.costo_envio_fijo || '25');
            return (
              <>
                <View style={s.previewRow}><Text style={s.previewLabel}>Pago del cliente</Text><Text style={s.previewVal}>Q100.00</Text></View>
                <View style={s.previewRow}><Text style={s.previewLabel}>Comisión Bocara ({com}%)</Text><Text style={[s.previewVal, { color: Colors.orange }]}>Q{comVal}</Text></View>
                <View style={s.previewRow}><Text style={s.previewLabel}>Pago al restaurante</Text><Text style={[s.previewVal, { color: '#86EFAC' }]}>Q{netoVal}</Text></View>
                <View style={s.previewRow}><Text style={s.previewLabel}>Puntos cliente gana</Text><Text style={[s.previewVal, { color: '#FCD34D' }]}>{pts} pts</Text></View>
                <View style={s.previewRow}><Text style={s.previewLabel}>Costo envío a domicilio</Text><Text style={s.previewVal}>Q{envio.toFixed(2)}</Text></View>
              </>
            );
          })()}
        </View>

        <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={guardar} disabled={saving}>
          <Text style={s.saveBtnText}>{saving ? 'Guardando...' : '💾 Guardar configuración'}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ConfigCard({ campo, config, setConfig }: { campo: typeof CAMPOS[0]; config: Record<string, string>; setConfig: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  const valor = config[campo.clave] ?? String(DEFAULTS[campo.clave] ?? '');
  return (
    <View style={s.configCard}>
      <View style={s.configCardTop}>
        <Text style={{ fontSize: 24 }}>{campo.emoji}</Text>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={s.configLabel}>{campo.label}</Text>
          <Text style={s.configDesc}>{campo.descripcion}</Text>
        </View>
      </View>
      <View style={s.configInputRow}>
        {campo.unidad && campo.unidad !== '%' && campo.tipo === 'number' && (
          <View style={s.unidadPre}><Text style={s.unidadText}>{campo.unidad}</Text></View>
        )}
        <TextInput
          style={[s.configInput, { flex: 1 }]}
          value={valor}
          onChangeText={(v) => setConfig((prev) => ({ ...prev, [campo.clave]: v }))}
          keyboardType="decimal-pad"
          placeholder={String(DEFAULTS[campo.clave] ?? '')}
          placeholderTextColor="#475569"
        />
        {campo.unidad === '%' && (
          <View style={s.unidadSuf}><Text style={s.unidadText}>%</Text></View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F172A' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.white },
  resetBtn: { borderWidth: 1.5, borderColor: '#334155', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  resetText: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  scroll: { padding: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 16, textTransform: 'uppercase', letterSpacing: 0.8 },
  warningCard: { backgroundColor: '#451A03', borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#92400E' },
  warningTitle: { fontSize: 14, fontWeight: '800', color: '#FCD34D', marginBottom: 8 },
  warningText: { fontSize: 13, color: '#D97706', marginBottom: 10 },
  codeBox: { backgroundColor: '#0F172A', borderRadius: 10, padding: 12 },
  codeText: { fontFamily: 'monospace', fontSize: 12, color: '#86EFAC', lineHeight: 20 },
  configCard: { backgroundColor: DARK, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  configCardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  configLabel: { fontSize: 15, fontWeight: '800', color: Colors.white },
  configDesc: { fontSize: 12, color: '#64748B', marginTop: 2, lineHeight: 18 },
  configInputRow: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  unidadPre: { backgroundColor: '#334155', borderTopLeftRadius: 10, borderBottomLeftRadius: 10, padding: 12, borderWidth: 1, borderColor: '#475569', borderRightWidth: 0 },
  unidadSuf: { backgroundColor: '#334155', borderTopRightRadius: 10, borderBottomRightRadius: 10, padding: 12, borderWidth: 1, borderColor: '#475569', borderLeftWidth: 0 },
  unidadText: { color: '#94A3B8', fontWeight: '700', fontSize: 15 },
  configInput: { backgroundColor: '#334155', borderRadius: 10, padding: 12, fontSize: 18, fontWeight: '800', color: Colors.white, borderWidth: 1, borderColor: '#475569', textAlign: 'center' },
  previewCard: { backgroundColor: '#021F16', borderRadius: 16, padding: 16, marginTop: 16, borderWidth: 1, borderColor: '#065F46' },
  previewTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  previewLabel: { fontSize: 13, color: '#94A3B8' },
  previewVal: { fontSize: 13, fontWeight: '800', color: Colors.white },
  saveBtn: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center', marginTop: 20 },
  saveBtnText: { color: Colors.white, fontWeight: '900', fontSize: 16 },
});
