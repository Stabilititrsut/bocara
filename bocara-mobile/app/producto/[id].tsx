import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Dimensions, Linking, Platform, StatusBar, Share,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { bolsasAPI, resenasAPI, favoritosAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';
import { useCart } from '@/src/context/CartContext';
import { useAuth } from '@/src/context/AuthContext';
import { useLocation } from '@/src/context/LocationContext';

const { height: SH } = Dimensions.get('window');
const IMG_H = Math.round(SH * 0.42);
const STATUS_TOP = Platform.OS === 'ios' ? 52 : (StatusBar.currentHeight || 24) + 8;

function calcularEstadoHorario(inicio: string, fin: string) {
  if (!inicio || !fin) return { estado: 'desconocido', mensaje: '', color: Colors.textLight };
  const now = new Date();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fin.split(':').map(Number);
  const ini = new Date(now); ini.setHours(ih, im, 0, 0);
  const end = new Date(now); end.setHours(fh, fm, 0, 0);
  if (now > end) return { estado: 'vencido', mensaje: 'Horario de recogida vencido por hoy', color: Colors.error, bloqueado: true };
  if (now < ini) {
    const mins = Math.floor((ini.getTime() - now.getTime()) / 60000);
    const hrs = Math.floor(mins / 60);
    const txt = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins} min`;
    return { estado: 'pronto', mensaje: `Abre en ${txt} · ${inicio.slice(0, 5)} – ${fin.slice(0, 5)}`, color: '#F59E0B', bloqueado: false };
  }
  const mins = Math.floor((end.getTime() - now.getTime()) / 60000);
  const hrs = Math.floor(mins / 60);
  const txt = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins} min`;
  return { estado: 'abierto', mensaje: `Cierra en ${txt}`, color: mins <= 30 ? Colors.error : '#22C55E', bloqueado: false };
}

function Stars({ rating, size = 13 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Ionicons key={i} name={i <= Math.round(rating) ? 'star' : 'star-outline'} size={size} color={Colors.accent} />
      ))}
    </View>
  );
}

function MapCard({ lat, lng, direccion, zona, googleMapsUrl, wazeUrl }: {
  lat?: number | null; lng?: number | null; direccion?: string; zona?: string;
  googleMapsUrl?: string | null; wazeUrl?: string | null;
}) {
  const [mapErr, setMapErr] = useState(false);
  const hasCoords = lat != null && lng != null;
  const canNavigate = !!(googleMapsUrl || hasCoords);
  const mapUrl = hasCoords && !mapErr
    ? `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=15&size=400x200&markers=${lat},${lng},red-pushpin`
    : null;

  const openGoogleMaps = () => {
    const url = googleMapsUrl || (hasCoords ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null);
    if (url) Linking.openURL(url);
    else Alert.alert('Sin ubicación', 'Este negocio aún no tiene ubicación registrada.');
  };
  const openWaze = () => {
    const url = wazeUrl || (hasCoords ? `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` : null);
    if (url) Linking.openURL(url);
    else Alert.alert('Sin ubicación', 'Este negocio aún no tiene ubicación registrada.');
  };

  return (
    <View style={ms.wrap}>
      <TouchableOpacity style={ms.mapBox} onPress={openGoogleMaps} activeOpacity={0.88} disabled={!canNavigate}>
        {mapUrl ? (
          <Image
            source={{ uri: mapUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={400}
            onError={() => setMapErr(true)}
          />
        ) : null}
        {(!mapUrl) && (
          <View style={ms.mapFallback}>
            <Ionicons name="map-outline" size={52} color={Colors.textLight} />
            <Text style={ms.mapFallbackText}>{hasCoords ? 'Cargando mapa…' : 'Sin coordenadas'}</Text>
          </View>
        )}
        {hasCoords && (
          <View style={ms.mapOpenOverlay}>
            <Ionicons name="expand-outline" size={14} color={Colors.white} />
            <Text style={ms.mapOpenText}>Abrir mapa completo</Text>
          </View>
        )}
      </TouchableOpacity>

      {(direccion || zona) && (
        <View style={ms.addrRow}>
          <Ionicons name="location-outline" size={16} color={Colors.accent} />
          <Text style={ms.addrText} numberOfLines={2}>
            {[direccion, zona].filter(Boolean).join(' · ')}
          </Text>
        </View>
      )}

      <View style={ms.navRow}>
        <TouchableOpacity
          style={[ms.navBtnGoogle, !canNavigate && ms.navBtnOff]}
          onPress={openGoogleMaps}
          disabled={!canNavigate}
          activeOpacity={0.85}
        >
          <Ionicons name="navigate-outline" size={15} color={canNavigate ? Colors.white : Colors.textLight} />
          <Text style={[ms.navText, !canNavigate && ms.navTextOff]}>Google Maps</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[ms.navBtnWaze, !canNavigate && ms.navBtnOff]}
          onPress={openWaze}
          disabled={!canNavigate}
          activeOpacity={0.85}
        >
          <Text style={{ fontSize: 15 }}>🚗</Text>
          <Text style={[ms.navText, !canNavigate && ms.navTextOff]}>Waze</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
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
  const [tab, setTab] = useState<'info' | 'resenas'>('info');
  const { agregar, items } = useCart();
  const { usuario } = useAuth();
  const { haversine, formatDistancia } = useLocation();
  const router = useRouter();
  const timerRef = useRef<any>(null);

  const cargarBolsa = useCallback(async () => {
    const bolsaId = Array.isArray(id) ? id[0] : id;
    if (!bolsaId) { setErrorMsg('ID de producto no válido.'); setLoading(false); return; }
    setBolsa(null); setErrorMsg(''); setLoading(true);
    try {
      const bRes = await bolsasAPI.detalle(bolsaId);
      const data: Bolsa = bRes.data;
      if (!data || !data.id) throw new Error('Bolsa no encontrada');
      setBolsa(data);
      setHorario(calcularEstadoHorario(data.hora_recogida_inicio, data.hora_recogida_fin));
      if (data.negocio_id) {
        resenasAPI.listarPorNegocio(data.negocio_id).then(r => setResenas(r.data || [])).catch(() => {});
        if (usuario) favoritosAPI.check(data.negocio_id).then(r => setEsFavorito(r.data.esFavorito)).catch(() => {});
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'No se pudo cargar el producto.');
    } finally {
      setLoading(false);
    }
  }, [id, retryCount]);

  useEffect(() => { cargarBolsa(); }, [cargarBolsa]);

  useEffect(() => {
    if (!bolsa) return;
    timerRef.current = setInterval(() => {
      setHorario(calcularEstadoHorario(bolsa.hora_recogida_inicio, bolsa.hora_recogida_fin));
    }, 30000);
    return () => clearInterval(timerRef.current);
  }, [bolsa]);

  if (loading) {
    return (
      <View style={s.root}>
        <View style={s.loadingCenter}>
          <ActivityIndicator color={Colors.accent} size="large" />
          <Text style={s.loadingText}>Cargando producto...</Text>
        </View>
      </View>
    );
  }

  if (errorMsg || !bolsa) {
    return (
      <View style={s.root}>
        <TouchableOpacity style={s.backRow} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={20} color={Colors.accent} />
          <Text style={s.backRowText}>Volver</Text>
        </TouchableOpacity>
        <View style={s.errorCenter}>
          <Text style={s.errorIcon}>😕</Text>
          <Text style={s.errorTitle}>No se pudo cargar</Text>
          <Text style={s.errorSub}>{errorMsg || 'Bolsa no encontrada.'}</Text>
          <Text style={s.errorHint}>Si el servidor está despertando puede tardar unos segundos.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => setRetryCount(c => c + 1)}>
            <Ionicons name="refresh" size={16} color={Colors.white} />
            <Text style={s.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const desc = bolsa.precio_original > 0
    ? Math.round((1 - bolsa.precio_descuento / bolsa.precio_original) * 100) : 0;
  const enCarrito = items.find(i => i.bolsa.id === bolsa.id);
  const agotada = bolsa.cantidad_disponible === 0;
  const horarioBloqueado = horario?.bloqueado ?? false;
  const puedeComprar = !agotada && !horarioBloqueado;
  const EMOJI_MAP: Record<string, string> = {
    Panadería: '🥐', Restaurante: '🍽️', Cafetería: '☕', Supermercado: '🛒', Sushi: '🍣', Pizza: '🍕',
  };
  const emoji = EMOJI_MAP[bolsa.negocios?.categoria || ''] || '🍱';
  const imagenSrc = bolsa.imagen_url || bolsa.negocios?.imagen_url;
  const nLat = bolsa.negocios?.latitud;
  const nLng = bolsa.negocios?.longitud;
  const distanciaKm = (nLat != null && nLng != null) ? haversine(nLat, nLng) : null;
  const distanciaTexto = distanciaKm !== null ? formatDistancia(distanciaKm) : null;
  const rating = bolsa.negocios?.calificacion_promedio || 0;

  async function toggleFavorito() {
    if (!usuario) return router.push('/login');
    setToggleandoFav(true);
    try {
      if (esFavorito) { await favoritosAPI.quitar(bolsa!.negocio_id); setEsFavorito(false); }
      else { await favoritosAPI.agregar(bolsa!.negocio_id); setEsFavorito(true); }
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setToggleandoFav(false); }
  }

  async function compartir() {
    if (!bolsa) return;
    Share.share({
      message: `🛍️ ¡Mira esta bolsa en Bocara!\n${bolsa.negocios?.nombre} — ${bolsa.nombre}\nSolo Q${bolsa.precio_descuento} (antes Q${bolsa.precio_original})\nhttps://bocara.vercel.app/producto/${bolsa.id}`,
    });
  }

  function compartirWhatsApp() {
    if (!bolsa) return;
    const texto = encodeURIComponent(
      `🛍️ ¡Mira esta oferta en Bocara!\n${bolsa.nombre} por Q${bolsa.precio_descuento}\n👉 https://bocara.vercel.app/producto/${bolsa.id}`
    );
    Linking.openURL(`https://wa.me/?text=${texto}`);
  }

  function handleAgregar() {
    if (!bolsa || !puedeComprar) return;
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

  return (
    <View style={s.root}>
      <ScrollView showsVerticalScrollIndicator={false} bounces>

        {/* ── HERO IMAGE ── */}
        <View style={[s.hero, { height: IMG_H }]}>
          {imagenSrc ? (
            <Image source={{ uri: imagenSrc }} style={StyleSheet.absoluteFill} contentFit="cover" transition={300} />
          ) : (
            <View style={[StyleSheet.absoluteFill, s.heroFallback]}>
              <Text style={{ fontSize: 80 }}>{bolsa.tipo === 'cupon' ? '🎫' : emoji}</Text>
            </View>
          )}
          <View style={s.heroGradientTop} />
          <View style={s.heroGradientBottom} />

          {/* Back + action buttons */}
          <View style={[s.heroButtons, { top: STATUS_TOP }]}>
            <TouchableOpacity style={s.circleBtn} onPress={() => router.back()}>
              <Ionicons name="arrow-back" size={20} color={Colors.primary} />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={s.circleBtn} onPress={compartir}>
                <Ionicons name="share-outline" size={20} color={Colors.primary} />
              </TouchableOpacity>
              {usuario?.rol === 'cliente' && (
                <TouchableOpacity style={s.circleBtn} onPress={toggleFavorito} disabled={toggleandoFav}>
                  <Ionicons
                    name={esFavorito ? 'heart' : 'heart-outline'}
                    size={20}
                    color={esFavorito ? Colors.error : Colors.primary}
                  />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Badges at bottom of image */}
          <View style={s.heroBadges}>
            {bolsa.tipo === 'cupon' && (
              <View style={s.cuponBadge}><Text style={s.cuponBadgeText}>🎫 Cupón</Text></View>
            )}
            <View style={s.discBadge}>
              <Text style={s.discBadgeText}>-{desc}% OFF</Text>
            </View>
          </View>
        </View>

        {/* ── NEGOCIO ROW ── */}
        <View style={s.negocioCard}>
          <View style={s.negocioRow}>
            <View style={[s.negocioLogo, { overflow: 'hidden' }]}>
              {bolsa.negocios?.imagen_url ? (
                <Image
                  source={{ uri: bolsa.negocios.imagen_url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ fontSize: 20, fontWeight: '900', color: Colors.white }}>
                    {(bolsa.negocios?.nombre || '?')[0].toUpperCase()}
                  </Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.negocioNombre} numberOfLines={1}>{bolsa.negocios?.nombre}</Text>
              <Text style={s.negocioZona} numberOfLines={1}>
                📍 {[bolsa.negocios?.zona, bolsa.negocios?.ciudad].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {rating > 0 && (
              <View style={s.ratingWrap}>
                <Stars rating={rating} size={13} />
                <Text style={s.ratingText}>
                  {rating.toFixed(1)} · {bolsa.negocios!.total_resenas} reseñas
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* ── TABS ── */}
        <View style={s.tabBar}>
          <TouchableOpacity
            style={[s.tabItem, tab === 'info' && s.tabActive]}
            onPress={() => setTab('info')}
          >
            <Text style={[s.tabText, tab === 'info' && s.tabTextActive]}>Información</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabItem, tab === 'resenas' && s.tabActive]}
            onPress={() => setTab('resenas')}
          >
            <Text style={[s.tabText, tab === 'resenas' && s.tabTextActive]}>
              Reseñas{resenas.length > 0 ? ` (${resenas.length})` : ''}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── INFO TAB ── */}
        {tab === 'info' && (
          <View style={s.tabContent}>

            {/* Quick info pills */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.pillsRow}
              contentContainerStyle={s.pillsContent}
            >
              <View style={s.pill}>
                <Ionicons name="time-outline" size={14} color={Colors.accent} />
                <Text style={s.pillText}>
                  {bolsa.hora_recogida_inicio?.slice(0, 5)} – {bolsa.hora_recogida_fin?.slice(0, 5)}
                </Text>
              </View>
              <View style={s.pill}>
                <Ionicons name="card-outline" size={14} color={Colors.accent} />
                <Text style={s.pillText}>Solo pago online</Text>
              </View>
              {distanciaTexto && (
                <View style={s.pill}>
                  <Ionicons name="location-outline" size={14} color={Colors.accent} />
                  <Text style={s.pillText}>A {distanciaTexto}</Text>
                </View>
              )}
            </ScrollView>

            {/* Product name */}
            <Text style={s.productNombre}>{bolsa.nombre}</Text>

            {/* Horario status */}
            {horario && (
              <View style={[s.horarioPill, { backgroundColor: horario.color + '18' }]}>
                <View style={[s.horarioDot, { backgroundColor: horario.color }]} />
                <Text style={[s.horarioText, { color: horario.color }]}>{horario.mensaje}</Text>
              </View>
            )}

            {/* Price block */}
            <View style={s.priceBlock}>
              <View>
                <Text style={s.priceOriginal}>Q{bolsa.precio_original}</Text>
                <Text style={s.priceDiscount}>Q{bolsa.precio_descuento}</Text>
              </View>
              <View style={s.saveBadge}>
                <Text style={s.saveLabel}>Ahorras</Text>
                <Text style={s.saveAmount}>Q{(bolsa.precio_original - bolsa.precio_descuento).toFixed(0)}</Text>
              </View>
            </View>

            {/* Stock */}
            <View style={s.stockRow}>
              <Ionicons
                name="cube-outline"
                size={15}
                color={bolsa.cantidad_disponible <= 3 ? Colors.error : Colors.textSecondary}
              />
              <Text style={[s.stockText, bolsa.cantidad_disponible <= 3 && { color: Colors.error }]}>
                {agotada
                  ? 'Sin stock disponible'
                  : `${bolsa.cantidad_disponible} unidad${bolsa.cantidad_disponible !== 1 ? 'es' : ''} disponible${bolsa.cantidad_disponible !== 1 ? 's' : ''}`}
              </Text>
            </View>

            {/* Description */}
            {bolsa.descripcion && (
              <View style={s.textSection}>
                <Text style={s.textSectionTitle}>Descripción del producto</Text>
                <Text style={s.textSectionBody}>{bolsa.descripcion}</Text>
              </View>
            )}
            {bolsa.contenido && (
              <View style={s.textSection}>
                <Text style={s.textSectionTitle}>Contenido</Text>
                <Text style={s.textSectionBody}>{bolsa.contenido}</Text>
              </View>
            )}

            {/* Map / Location */}
            <View style={s.textSection}>
              <Text style={s.textSectionTitle}>Lugar de recogida</Text>
              <MapCard
                lat={bolsa.negocios?.latitud}
                lng={bolsa.negocios?.longitud}
                direccion={bolsa.negocios?.direccion}
                zona={bolsa.negocios?.zona}
                googleMapsUrl={bolsa.negocios?.google_maps_url}
                wazeUrl={bolsa.negocios?.waze_url}
              />
            </View>

            {/* Peso aproximado por unidad */}
            {(bolsa as any).peso_kg > 0 && (
              <View style={s.impactCard}>
                <Text style={s.impactEmoji}>🍽️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.impactTitle}>Peso aproximado por unidad</Text>
                  <Text style={s.impactText}>{(bolsa as any).peso_kg} kg de alimentos</Text>
                </View>
              </View>
            )}

            {/* Share */}
            <TouchableOpacity style={s.whatsappBtn} onPress={compartirWhatsApp}>
              <Ionicons name="logo-whatsapp" size={20} color={Colors.white} />
              <Text style={s.whatsappBtnText}>Compartir por WhatsApp</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── RESEÑAS TAB ── */}
        {tab === 'resenas' && (
          <View style={s.tabContent}>
            {resenas.length === 0 ? (
              <View style={s.emptyResenas}>
                <Text style={{ fontSize: 44 }}>⭐</Text>
                <Text style={s.emptyResenasTitle}>Sin reseñas aún</Text>
                <Text style={s.emptyResenasText}>Sé el primero en dejar una reseña después de tu compra.</Text>
              </View>
            ) : (
              <>
                {rating > 0 && (
                  <View style={s.ratingSummary}>
                    <Text style={s.ratingSummaryNum}>{rating.toFixed(1)}</Text>
                    <Stars rating={rating} size={20} />
                    <Text style={s.ratingSummaryCount}>
                      {resenas.length} reseña{resenas.length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                )}
                {resenas.map((r: any) => (
                  <View key={r.id} style={s.resenaCard}>
                    <View style={s.resenaHeader}>
                      <View style={s.resenaAvatar}>
                        <Text style={s.resenaAvatarText}>
                          {(r.usuarios?.nombre || 'C')[0].toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.resenaUser}>{r.usuarios?.nombre || 'Cliente'}</Text>
                        <Text style={s.resenaFecha}>
                          {new Date(r.created_at || r.creado_en).toLocaleDateString('es-GT')}
                        </Text>
                      </View>
                      <Stars rating={r.calificacion} size={12} />
                    </View>
                    {r.comentario ? (
                      <Text style={s.resenaComentario}>{r.comentario}</Text>
                    ) : null}
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* ── FOOTER ── */}
      <View style={s.footer}>
        {agotada ? (
          <View style={[s.footerBtn, s.footerBtnOff]}>
            <Text style={s.footerBtnTextOff}>Sin stock disponible</Text>
          </View>
        ) : horarioBloqueado ? (
          <View style={[s.footerBtn, s.footerBtnOff]}>
            <Ionicons name="time-outline" size={16} color={Colors.textLight} />
            <Text style={s.footerBtnTextOff}>{horario?.mensaje}</Text>
          </View>
        ) : enCarrito ? (
          <TouchableOpacity
            style={[s.footerBtn, { backgroundColor: Colors.accent }]}
            onPress={() => router.push('/(tabs)/carrito')}
            activeOpacity={0.85}
          >
            <Ionicons name="bag-outline" size={18} color={Colors.primary} />
            <Text style={[s.footerBtnText, { color: Colors.primary }]}>
              Ver carrito ({enCarrito.cantidad}) →
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.footerBtn} onPress={handleAgregar} activeOpacity={0.85}>
            <Ionicons name="bag-add-outline" size={18} color={Colors.white} />
            <Text style={s.footerBtnText}>Agregar al carrito · Q{bolsa.precio_descuento}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Main styles ───────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, minHeight: 500 },
  loadingText: { color: Colors.textSecondary, fontSize: 14 },

  backRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingTop: STATUS_TOP + 8, paddingBottom: 8,
  },
  backRowText: { color: Colors.accent, fontWeight: '700', fontSize: 15 },
  errorCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  errorIcon: { fontSize: 56 },
  errorTitle: { fontSize: 20, fontWeight: '800', color: Colors.primary },
  errorSub: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  errorHint: { fontSize: 12, color: Colors.textLight, textAlign: 'center', lineHeight: 18 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.accent, borderRadius: 14, paddingHorizontal: 28, paddingVertical: 14, marginTop: 8,
  },
  retryText: { color: Colors.white, fontWeight: '800', fontSize: 15 },

  // Hero image
  hero: { width: '100%', backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  heroFallback: { justifyContent: 'center', alignItems: 'center' },
  heroGradientTop: { position: 'absolute', top: 0, left: 0, right: 0, height: STATUS_TOP + 60, backgroundColor: 'rgba(0,0,0,0.22)' },
  heroGradientBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, backgroundColor: 'rgba(0,0,0,0.38)' },
  heroButtons: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  circleBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.14, shadowRadius: 6, elevation: 4,
  },
  heroBadges: { position: 'absolute', bottom: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  discBadge: { backgroundColor: Colors.accent, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  discBadgeText: { color: Colors.white, fontSize: 13, fontWeight: '900' },
  cuponBadge: { backgroundColor: Colors.primary, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  cuponBadgeText: { color: Colors.white, fontSize: 12, fontWeight: '700' },

  // Negocio row
  negocioCard: {
    backgroundColor: Colors.white, paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  negocioRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  negocioLogo: {
    width: 50, height: 50, borderRadius: 25, backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  negocioNombre: { fontSize: 15, fontWeight: '800', color: Colors.primary },
  negocioZona: { fontSize: 12, color: Colors.textSecondary, marginTop: 3 },
  ratingWrap: { alignItems: 'flex-end', gap: 4 },
  ratingText: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },

  // Tabs
  tabBar: { flexDirection: 'row', backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabItem: { flex: 1, paddingVertical: 14, alignItems: 'center', borderBottomWidth: 2.5, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: Colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary },
  tabTextActive: { color: Colors.primary, fontWeight: '800' },
  tabContent: { padding: 20 },

  // Pills
  pillsRow: { marginBottom: 20 },
  pillsContent: { gap: 8, paddingRight: 4 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.surface, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9,
  },
  pillText: { fontSize: 13, color: Colors.primary, fontWeight: '600' },

  // Product
  productNombre: { fontSize: 26, fontWeight: '900', color: Colors.primary, lineHeight: 32, marginBottom: 12 },

  // Horario
  horarioPill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, marginBottom: 16 },
  horarioDot: { width: 8, height: 8, borderRadius: 4 },
  horarioText: { fontSize: 13, fontWeight: '700' },

  // Price
  priceBlock: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  priceOriginal: { fontSize: 14, color: Colors.textLight, textDecorationLine: 'line-through', marginBottom: 2 },
  priceDiscount: { fontSize: 42, fontWeight: '900', color: Colors.primary, letterSpacing: -1 },
  saveBadge: { backgroundColor: Colors.surface, borderRadius: 14, padding: 14, alignItems: 'center' },
  saveLabel: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  saveAmount: { fontSize: 20, fontWeight: '900', color: Colors.accent },

  // Stock
  stockRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 20 },
  stockText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },

  // Text sections
  textSection: { marginBottom: 24 },
  textSectionTitle: { fontSize: 15, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  textSectionBody: { fontSize: 14, color: Colors.textSecondary, lineHeight: 22 },

  // Impact
  impactCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.surface, borderRadius: 16, padding: 16, marginBottom: 16 },
  impactEmoji: { fontSize: 28 },
  impactTitle: { fontSize: 14, fontWeight: '800', color: Colors.primary, marginBottom: 4 },
  impactText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },

  // Share
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.surface, borderRadius: 14, padding: 14,
  },
  shareBtnText: { color: Colors.textSecondary, fontWeight: '700', fontSize: 14 },
  whatsappBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#25D366', borderRadius: 14, padding: 14,
  },
  whatsappBtnText: { color: Colors.white, fontWeight: '800', fontSize: 14 },

  // Reviews
  emptyResenas: { alignItems: 'center', paddingVertical: 44, gap: 12 },
  emptyResenasTitle: { fontSize: 18, fontWeight: '800', color: Colors.primary },
  emptyResenasText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  ratingSummary: {
    alignItems: 'center', gap: 10, paddingVertical: 24,
    borderBottomWidth: 1, borderBottomColor: Colors.border, marginBottom: 16,
  },
  ratingSummaryNum: { fontSize: 52, fontWeight: '900', color: Colors.primary, lineHeight: 56 },
  ratingSummaryCount: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  resenaCard: { backgroundColor: Colors.white, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: Colors.border },
  resenaHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  resenaAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  resenaAvatarText: { fontSize: 16, fontWeight: '800', color: Colors.primary },
  resenaUser: { fontSize: 13, fontWeight: '800', color: Colors.primary },
  resenaFecha: { fontSize: 11, color: Colors.textLight, marginTop: 2 },
  resenaComentario: { fontSize: 13, color: Colors.textSecondary, lineHeight: 20 },

  // Footer
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.white,
    paddingHorizontal: 20, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  footerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: Colors.primary, borderRadius: 50, paddingVertical: 17,
  },
  footerBtnOff: { backgroundColor: Colors.border },
  footerBtnText: { color: Colors.white, fontWeight: '800', fontSize: 16 },
  footerBtnTextOff: { color: Colors.textLight, fontWeight: '700', fontSize: 15 },
});

// ── Map card styles ───────────────────────────────────────────────────────────
const ms = StyleSheet.create({
  wrap: { borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: Colors.border },
  mapBox: { height: 200, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center' },
  mapFallback: { alignItems: 'center', gap: 10 },
  mapFallbackText: { fontSize: 13, color: Colors.textLight, fontWeight: '600' },
  mapOpenOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.48)', paddingVertical: 9,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  mapOpenText: { color: Colors.white, fontSize: 13, fontWeight: '700' },
  addrRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 14, borderTopWidth: 1, borderTopColor: Colors.border },
  addrText: { flex: 1, fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  navRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingBottom: 14 },
  navBtnGoogle: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: Colors.primary, borderRadius: 10, paddingVertical: 12,
  },
  navBtnWaze: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: '#00B4D8', borderRadius: 10, paddingVertical: 12,
  },
  navBtnOff: { backgroundColor: Colors.border },
  navText: { fontSize: 13, color: Colors.white, fontWeight: '700' },
  navTextOff: { color: Colors.textLight },
});
