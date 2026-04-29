import { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { bolsasAPI, resenasAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useCart } from '@/src/context/CartContext';

export default function ProductoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bolsa, setBolsa] = useState<Bolsa | null>(null);
  const [loading, setLoading] = useState(true);
  const [resenas, setResenas] = useState<any[]>([]);
  const { agregar, items } = useCart();
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        const [bRes] = await Promise.all([bolsasAPI.detalle(id)]);
        setBolsa(bRes.data);
        if (bRes.data?.negocio_id) {
          const rRes = await resenasAPI.listarPorNegocio(bRes.data.negocio_id);
          setResenas(rRes.data || []);
        }
      } catch (e) {
        Alert.alert('Error', 'No se pudo cargar el producto');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading || !bolsa) {
    return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;
  }

  const desc = Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100);
  const enCarrito = items.find((i) => i.bolsa.id === bolsa.id);
  const agotada = bolsa.cantidad_disponible === 0;

  function handleAgregar() {
    if (agotada) return;
    agregar(bolsa!);
    Alert.alert('¡Agregado!', `${bolsa!.nombre} está en tu carrito 🛒`, [
      { text: 'Seguir viendo', style: 'cancel' },
      { text: 'Ver carrito', onPress: () => router.push('/(tabs)/carrito') },
    ]);
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView>
        {/* Imagen */}
        <View style={s.imgBox}>
          <Text style={{ fontSize: 80 }}>🍱</Text>
          <View style={s.badge}><Text style={s.badgeText}>-{desc}% OFF</Text></View>
          {bolsa.tipo === 'cupon' && <View style={s.cuponBadge}><Text style={s.cuponText}>🎫 Cupón</Text></View>}
        </View>

        <View style={s.body}>
          {/* Negocio */}
          <Text style={s.negocio}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.nombre}>{bolsa.nombre}</Text>
          <Text style={s.zona}>📍 {bolsa.negocios?.zona} · {bolsa.negocios?.ciudad}</Text>

          {/* Precio */}
          <View style={s.priceRow}>
            <View>
              <Text style={s.original}>Q{bolsa.precio_original}</Text>
              <Text style={s.precio}>Q{bolsa.precio_descuento}</Text>
            </View>
            <View style={s.ahorro}>
              <Text style={s.ahorroText}>Ahorras Q{(bolsa.precio_original - bolsa.precio_descuento).toFixed(0)}</Text>
            </View>
          </View>

          {/* Info */}
          <View style={s.infoRow}>
            <View style={s.infoItem}>
              <Text style={s.infoIcon}>⏰</Text>
              <Text style={s.infoLabel}>Recogida</Text>
              <Text style={s.infoVal}>{bolsa.hora_recogida_inicio?.slice(0, 5)} - {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
            </View>
            <View style={s.infoItem}>
              <Text style={s.infoIcon}>📦</Text>
              <Text style={s.infoLabel}>Disponibles</Text>
              <Text style={s.infoVal}>{bolsa.cantidad_disponible}</Text>
            </View>
            <View style={s.infoItem}>
              <Text style={s.infoIcon}>🌿</Text>
              <Text style={s.infoLabel}>CO₂ salvas</Text>
              <Text style={s.infoVal}>{bolsa.co2_salvado_kg} kg</Text>
            </View>
          </View>

          {bolsa.descripcion && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>Sobre esta bolsa</Text>
              <Text style={s.sectionText}>{bolsa.descripcion}</Text>
            </View>
          )}

          {bolsa.contenido && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>¿Qué puede contener?</Text>
              <Text style={s.sectionText}>{bolsa.contenido}</Text>
            </View>
          )}

          {/* Impacto */}
          <View style={s.impact}>
            <Text style={s.impactTitle}>🌱 Tu impacto ambiental</Text>
            <Text style={s.impactText}>Al comprar esta bolsa rescatas {bolsa.co2_salvado_kg} kg de CO₂ y evitas el desperdicio de comida.</Text>
          </View>

          {/* Reseñas */}
          {resenas.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>⭐ Reseñas ({resenas.length})</Text>
              {resenas.slice(0, 3).map((r: any) => (
                <View key={r.id} style={s.resena}>
                  <View style={s.resenaHeader}>
                    <Text style={s.resenaStars}>{'⭐'.repeat(r.calificacion)}</Text>
                    <Text style={s.resenaFecha}>{new Date(r.created_at).toLocaleDateString('es-GT')}</Text>
                  </View>
                  {r.comentario && <Text style={s.resenaComentario}>{r.comentario}</Text>}
                </View>
              ))}
            </View>
          )}

          <View style={{ height: 120 }} />
        </View>
      </ScrollView>

      {/* Botón fijo */}
      <View style={s.footer}>
        {enCarrito ? (
          <TouchableOpacity style={s.btnCart} onPress={() => router.push('/(tabs)/carrito')}>
            <Text style={s.btnText}>Ver carrito ({enCarrito.cantidad}) →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.btnCart, agotada && s.btnDisabled]} onPress={handleAgregar} disabled={agotada}>
            <Text style={s.btnText}>{agotada ? 'Bolsa agotada' : `Agregar al carrito · Q${bolsa.precio_descuento}`}</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  imgBox: { backgroundColor: Colors.brownLight, height: 220, justifyContent: 'center', alignItems: 'center' },
  badge: { position: 'absolute', top: 16, right: 16, backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  badgeText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 16, left: 16, backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  cuponText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  body: { padding: 20 },
  negocio: { fontSize: 12, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  nombre: { fontSize: 26, fontWeight: '900', color: Colors.brown, marginTop: 4 },
  zona: { fontSize: 14, color: Colors.textSecondary, marginTop: 6 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  original: { fontSize: 14, color: Colors.textLight, textDecorationLine: 'line-through' },
  precio: { fontSize: 36, fontWeight: '900', color: Colors.orange },
  ahorro: { backgroundColor: Colors.greenLight, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  ahorroText: { color: Colors.green, fontWeight: '800', fontSize: 14 },
  infoRow: { flexDirection: 'row', marginTop: 20, gap: 8 },
  infoItem: { flex: 1, backgroundColor: Colors.white, borderRadius: 14, padding: 12, alignItems: 'center', elevation: 1 },
  infoIcon: { fontSize: 20, marginBottom: 4 },
  infoLabel: { fontSize: 10, color: Colors.textLight, fontWeight: '600' },
  infoVal: { fontSize: 12, color: Colors.brown, fontWeight: '800', textAlign: 'center', marginTop: 2 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: Colors.brown, marginBottom: 8 },
  sectionText: { fontSize: 14, color: Colors.textSecondary, lineHeight: 22 },
  impact: { backgroundColor: Colors.greenLight, borderRadius: 16, padding: 16, marginTop: 20 },
  impactTitle: { fontSize: 15, fontWeight: '800', color: Colors.green, marginBottom: 6 },
  impactText: { fontSize: 13, color: Colors.brown, lineHeight: 20 },
  resena: { backgroundColor: Colors.white, borderRadius: 12, padding: 12, marginBottom: 8 },
  resenaHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  resenaStars: { fontSize: 12 },
  resenaFecha: { fontSize: 11, color: Colors.textLight },
  resenaComentario: { fontSize: 13, color: Colors.textSecondary },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.white, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  btnCart: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center' },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
