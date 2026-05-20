import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, SafeAreaView, Share,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { bolsasAPI, resenasAPI, favoritosAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useCart } from '@/src/context/CartContext';
import { useAuth } from '@/src/context/AuthContext';

function calcularEstadoHorario(inicio: string, fin: string) {
  if (!inicio || !fin) return { estado: 'desconocido', mensaje: '', color: Colors.textLight };
  const now = new Date();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fin.split(':').map(Number);
  const ini = new Date(now); ini.setHours(ih, im, 0, 0);
  const end = new Date(now); end.setHours(fh, fm, 0, 0);

  if (now > end) {
    return { estado: 'vencido', mensaje: 'Horario de recogida vencido por hoy', color: Colors.error, bloqueado: true };
  }
  if (now < ini) {
    const diffMs = ini.getTime() - now.getTime();
    const mins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(mins / 60);
    const minResto = mins % 60;
    const txt = hrs > 0 ? `${hrs}h ${minResto}m` : `${mins} min`;
    return { estado: 'pronto', mensaje: `Abre en ${txt} · ${inicio.slice(0, 5)} – ${fin.slice(0, 5)}`, color: Colors.orange, bloqueado: false };
  }
  const diffMs = end.getTime() - now.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const minResto = mins % 60;
  const txt = hrs > 0 ? `${hrs}h ${minResto}m` : `${mins} min`;
  const urgente = mins <= 30;
  return { estado: 'abierto', mensaje: `Cierra en ${txt}`, color: urgente ? Colors.error : Colors.green, bloqueado: false };
}

export default function ProductoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bolsa, setBolsa] = useState<Bolsa | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [resenas, setResenas] = useState<any[]>([]);
  const [esFavorito, setEsFavorito] = useState(false);
  const [toggleandoFav, setToggleandoFav] = useState(false);
  const [horario, setHorario] = useState<ReturnType<typeof calcularEstadoHorario> | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const { agregar, items } = useCart();
  const { usuario } = useAuth();
  const router = useRouter();
  const timerRef = useRef<any>(null);

  const cargarBolsa = useCallback(async () => {
    const bolsaId = Array.isArray(id) ? id[0] : id;
    if (!bolsaId) {
      setErrorMsg('ID de producto no válido.');
      setLoading(false);
      return;
    }

    setBolsa(null);
    setErrorMsg('');
    setLoading(true);

    try {
      const bRes = await bolsasAPI.detalle(bolsaId);
      const data: Bolsa = bRes.data;
      if (!data || !data.id) throw new Error('Bolsa no encontrada');
      setBolsa(data);
      setHorario(calcularEstadoHorario(data.hora_recogida_inicio, data.hora_recogida_fin));

      // Cargar reseñas y favorito en paralelo sin bloquear el render
      if (data.negocio_id) {
        resenasAPI.listarPorNegocio(data.negocio_id)
          .then(r => setResenas(r.data || []))
          .catch(() => {});
        if (usuario) {
          favoritosAPI.check(data.negocio_id)
            .then(r => setEsFavorito(r.data.esFavorito))
            .catch(() => {});
        }
      }
    } catch (e: any) {
      const msg = e.message || 'No se pudo cargar el producto.';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }, [id, retryCount]);

  useEffect(() => {
    cargarBolsa();
  }, [cargarBolsa]);

  // Actualizar horario cada 30 s
  useEffect(() => {
    if (!bolsa) return;
    timerRef.current = setInterval(() => {
      setHorario(calcularEstadoHorario(bolsa.hora_recogida_inicio, bolsa.hora_recogida_fin));
    }, 30000);
    return () => clearInterval(timerRef.current);
  }, [bolsa]);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.loadingCenter}>
          <ActivityIndicator color={Colors.orange} size="large" />
          <Text style={s.loadingText}>Cargando producto...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Error / no data ───────────────────────────────────────────────────────────
  if (errorMsg || !bolsa) {
    return (
      <SafeAreaView style={s.root}>
        <TouchableOpacity style={s.backRow} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={20} color={Colors.orange} />
          <Text style={s.backRowText}>Volver</Text>
        </TouchableOpacity>
        <View style={s.errorCenter}>
          <Text style={s.errorIcon}>😕</Text>
          <Text style={s.errorTitle}>No se pudo cargar</Text>
          <Text style={s.errorSub}>
            {errorMsg || 'Bolsa no encontrada.'}
          </Text>
          <Text style={s.errorHint}>
            Si el servidor está despertando puede tardar unos segundos.
          </Text>
          <TouchableOpacity
            style={s.retryBtn}
            onPress={() => setRetryCount(c => c + 1)}
          >
            <Ionicons name="refresh" size={16} color={Colors.white} />
            <Text style={s.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Producto cargado ──────────────────────────────────────────────────────────
  const desc = bolsa.precio_original > 0 ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const enCarrito = items.find((i) => i.bolsa.id === bolsa.id);
  const agotada = bolsa.cantidad_disponible === 0;
  const horarioBloqueado = horario?.bloqueado ?? false;
  const puedeComprar = !agotada && !horarioBloqueado;

  async function toggleFavorito() {
    if (!usuario) return router.push('/login');
    setToggleandoFav(true);
    try {
      if (esFavorito) {
        await favoritosAPI.quitar(bolsa!.negocio_id);
        setEsFavorito(false);
      } else {
        await favoritosAPI.agregar(bolsa!.negocio_id);
        setEsFavorito(true);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setToggleandoFav(false);
    }
  }

  async function compartir() {
    await Share.share({
      message: `🛍️ ¡Mira esta bolsa de comida rescatada en Bocara!\n${bolsa!.negocios?.nombre} — ${bolsa!.nombre}\nSolo Q${bolsa!.precio_descuento} (antes Q${bolsa!.precio_original})\nhttps://bocarafood.com`,
    });
  }

  function handleAgregar() {
    if (!puedeComprar) return;
    if (enCarrito && enCarrito.cantidad >= bolsa.cantidad_disponible) {
      Alert.alert('Sin stock', `Solo quedan ${bolsa.cantidad_disponible} unidades disponibles.`);
      return;
    }
    agregar(bolsa!);
    Alert.alert('¡Agregado!', `${bolsa!.nombre} está en tu carrito 🛒`, [
      { text: 'Seguir viendo', style: 'cancel' },
      { text: 'Ver carrito', onPress: () => router.push('/(tabs)/carrito') },
    ]);
  }

  const imagenSrc = bolsa.imagen_url || bolsa.negocios?.imagen_url;
  const EMOJI_MAP: Record<string, string> = { Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒', Sushi: '🍣', Pizza: '🍕' };
  const emoji = EMOJI_MAP[bolsa.negocios?.categoria || ''] || '🍱';

  return (
    <SafeAreaView style={s.root}>
      <ScrollView>
        {/* Imagen */}
        <View style={s.imgBox}>
          {imagenSrc ? (
            <Image source={{ uri: imagenSrc }} style={StyleSheet.absoluteFill} contentFit="cover" transition={300} />
          ) : (
            <Text style={{ fontSize: 80 }}>{bolsa.tipo === 'cupon' ? '🎫' : emoji}</Text>
          )}
          <View style={s.imgOverlay} />
          <View style={s.badge}><Text style={s.badgeText}>-{desc}% OFF</Text></View>
          {bolsa.tipo === 'cupon' && <View style={s.cuponBadge}><Text style={s.cuponText}>🎫 Cupón</Text></View>}
          <View style={s.imgBtns}>
            <TouchableOpacity style={s.imgBtn} onPress={compartir}>
              <Text style={{ fontSize: 18 }}>↗️</Text>
            </TouchableOpacity>
            {usuario?.rol === 'cliente' && (
              <TouchableOpacity style={s.imgBtn} onPress={toggleFavorito} disabled={toggleandoFav}>
                <Text style={{ fontSize: 20 }}>{esFavorito ? '❤️' : '🤍'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={s.body}>
          <Text style={s.negocio}>{bolsa.negocios?.nombre}</Text>
          <Text style={s.nombre}>{bolsa.nombre}</Text>
          <Text style={s.zona}>📍 {bolsa.negocios?.zona} · {bolsa.negocios?.ciudad}</Text>

          {(bolsa.negocios?.calificacion_promedio || 0) > 0 && (
            <View style={s.ratingRow}>
              <Text style={s.ratingStars}>{'⭐'.repeat(Math.round(bolsa.negocios!.calificacion_promedio))}</Text>
              <Text style={s.ratingVal}>{bolsa.negocios!.calificacion_promedio.toFixed(1)}</Text>
              <Text style={s.ratingCount}>({bolsa.negocios!.total_resenas} reseñas)</Text>
            </View>
          )}

          {horario && (
            <View style={[s.horarioBadge, { backgroundColor: horario.color + '20', borderColor: horario.color + '40' }]}>
              <Text style={[s.horarioText, { color: horario.color }]}>
                {horario.estado === 'abierto' ? '🟢' : horario.estado === 'pronto' ? '🟡' : '🔴'} {horario.mensaje}
              </Text>
            </View>
          )}

          <View style={s.priceRow}>
            <View>
              <Text style={s.original}>Q{bolsa.precio_original}</Text>
              <Text style={s.precio}>Q{bolsa.precio_descuento}</Text>
            </View>
            <View style={s.ahorroBox}>
              <Text style={s.ahorroText}>Ahorras Q{(bolsa.precio_original - bolsa.precio_descuento).toFixed(0)}</Text>
            </View>
          </View>

          <View style={s.infoRow}>
            <View style={s.infoItem}>
              <Text style={s.infoIcon}>⏰</Text>
              <Text style={s.infoLabel}>Recogida</Text>
              <Text style={s.infoVal}>{bolsa.hora_recogida_inicio?.slice(0, 5)} – {bolsa.hora_recogida_fin?.slice(0, 5)}</Text>
            </View>
            <View style={s.infoItem}>
              <Text style={s.infoIcon}>📦</Text>
              <Text style={s.infoLabel}>Disponibles</Text>
              <Text style={[s.infoVal, bolsa.cantidad_disponible <= 3 && { color: Colors.error }]}>
                {agotada ? 'Agotado' : `${bolsa.cantidad_disponible} unid.`}
              </Text>
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

          <View style={s.impact}>
            <Text style={s.impactTitle}>🌱 Tu impacto ambiental</Text>
            <Text style={s.impactText}>Al rescatar esta bolsa evitas {bolsa.co2_salvado_kg} kg de CO₂ y salvas comida de buena calidad.</Text>
          </View>

          <TouchableOpacity style={s.shareRow} onPress={compartir}>
            <Text style={s.shareText}>↗️  Compartir por WhatsApp</Text>
          </TouchableOpacity>

          {resenas.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>⭐ Reseñas del restaurante ({resenas.length})</Text>
              {resenas.slice(0, 5).map((r: any) => (
                <View key={r.id} style={s.resena}>
                  <View style={s.resenaHeader}>
                    <Text style={s.resenaUser}>{r.usuarios?.nombre || 'Cliente'}</Text>
                    <Text style={s.resenaStars}>{'⭐'.repeat(r.calificacion)}</Text>
                    <Text style={s.resenaFecha}>{new Date(r.created_at || r.creado_en).toLocaleDateString('es-GT')}</Text>
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
        {agotada ? (
          <View style={[s.btn, s.btnDisabled]}>
            <Text style={s.btnText}>Bolsa agotada</Text>
          </View>
        ) : horarioBloqueado ? (
          <View style={[s.btn, { backgroundColor: Colors.textLight }]}>
            <Text style={s.btnText}>🔴 {horario?.mensaje}</Text>
          </View>
        ) : enCarrito ? (
          <TouchableOpacity style={[s.btn, { backgroundColor: Colors.brown }]} onPress={() => router.push('/(tabs)/carrito')}>
            <Text style={s.btnText}>Ver carrito ({enCarrito.cantidad}) →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.btn} onPress={handleAgregar}>
            <Text style={s.btnText}>Agregar al carrito · Q{bolsa.precio_descuento}</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  // Loading
  loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, paddingVertical: 80 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },

  // Error
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 20 },
  backRowText: { color: Colors.orange, fontWeight: '700', fontSize: 15 },
  errorCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  errorIcon: { fontSize: 56 },
  errorTitle: { fontSize: 20, fontWeight: '800', color: Colors.brown },
  errorSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  errorHint: { fontSize: 12, color: Colors.textLight, textAlign: 'center', lineHeight: 18 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 14, marginTop: 8 },
  retryText: { color: Colors.white, fontWeight: '800', fontSize: 15 },

  // Product
  imgBox: { backgroundColor: Colors.brownLight, height: 240, justifyContent: 'center', alignItems: 'center' },
  imgOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.15)' },
  badge: { position: 'absolute', top: 16, right: 16, backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  badgeText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  cuponBadge: { position: 'absolute', top: 16, left: 16, backgroundColor: Colors.green, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  cuponText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  imgBtns: { position: 'absolute', bottom: 16, right: 16, flexDirection: 'row', gap: 8 },
  imgBtn: { backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  body: { padding: 20 },
  negocio: { fontSize: 12, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  nombre: { fontSize: 26, fontWeight: '900', color: Colors.brown, marginTop: 4, marginBottom: 4 },
  zona: { fontSize: 14, color: Colors.textSecondary },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  ratingStars: { fontSize: 12 },
  ratingVal: { fontSize: 14, fontWeight: '800', color: Colors.brown },
  ratingCount: { fontSize: 12, color: Colors.textSecondary },
  horarioBadge: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, marginTop: 12 },
  horarioText: { fontSize: 13, fontWeight: '700' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  original: { fontSize: 14, color: Colors.textLight, textDecorationLine: 'line-through' },
  precio: { fontSize: 36, fontWeight: '900', color: Colors.orange },
  ahorroBox: { backgroundColor: Colors.greenLight, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
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
  shareRow: { backgroundColor: Colors.brownLight, borderRadius: 14, padding: 14, alignItems: 'center', marginTop: 16 },
  shareText: { color: Colors.brown, fontWeight: '700', fontSize: 14 },
  resena: { backgroundColor: Colors.white, borderRadius: 12, padding: 12, marginBottom: 8 },
  resenaHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  resenaUser: { fontSize: 12, fontWeight: '700', color: Colors.brown, flex: 1 },
  resenaStars: { fontSize: 11 },
  resenaFecha: { fontSize: 11, color: Colors.textLight },
  resenaComentario: { fontSize: 13, color: Colors.textSecondary, lineHeight: 20 },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.white, padding: 16, borderTopWidth: 1, borderTopColor: Colors.border },
  btn: { backgroundColor: Colors.orange, borderRadius: 16, padding: 16, alignItems: 'center' },
  btnDisabled: { backgroundColor: Colors.textLight },
  btnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
});
