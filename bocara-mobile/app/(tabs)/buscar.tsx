import { useState, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { bolsasAPI } from '@/src/services/api';
import { Bolsa } from '@/src/types';
import { Colors } from '@/constants/Colors';

const SUGERENCIAS = ['Sushi', 'Pizza', 'Panadería', 'Cafetería', 'Zona 10', 'Zona 4', 'Mixco', 'Comida Típica', 'Villa Nueva'];

export default function BuscarScreen() {
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<Bolsa[]>([]);
  const [loading, setLoading] = useState(false);
  const [buscado, setBuscado] = useState(false);
  const router = useRouter();

  const buscar = useCallback(async (texto: string) => {
    if (!texto.trim()) { setResultados([]); setBuscado(false); return; }
    setLoading(true);
    setBuscado(true);
    try {
      const res = await bolsasAPI.listar({ activo: true });
      const todos: Bolsa[] = res.data || [];
      const q = texto.toLowerCase();
      setResultados(todos.filter(b =>
        b.negocios?.nombre?.toLowerCase().includes(q) ||
        b.nombre?.toLowerCase().includes(q) ||
        b.negocios?.categoria?.toLowerCase().includes(q) ||
        b.negocios?.zona?.toLowerCase().includes(q)
      ));
    } catch { setResultados([]); }
    finally { setLoading(false); }
  }, []);

  function handleSugerencia(s: string) {
    setQuery(s);
    buscar(s);
  }

  return (
    <SafeAreaView style={st.root}>
      {/* Header */}
      <View style={st.header}>
        <Text style={st.headerTitle}>Buscar</Text>
      </View>

      {/* Search bar */}
      <View style={st.searchWrap}>
        <View style={st.searchBar}>
          <Ionicons name="search-outline" size={18} color={Colors.textSecondary} />
          <TextInput
            style={st.searchInput}
            placeholder="Restaurantes, zonas, categorías..."
            placeholderTextColor={Colors.textLight}
            value={query}
            onChangeText={(v) => { setQuery(v); buscar(v); }}
            returnKeyType="search"
            autoFocus
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => { setQuery(''); setResultados([]); setBuscado(false); }}>
              <Ionicons name="close-circle" size={18} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={st.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Suggestions (shown when empty) */}
        {!buscado && (
          <View>
            <Text style={st.sectionTitle}>Búsquedas populares</Text>
            <View style={st.chips}>
              {SUGERENCIAS.map(sg => (
                <TouchableOpacity key={sg} style={st.chip} onPress={() => handleSugerencia(sg)}>
                  <Text style={st.chipText}>{sg}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Loading */}
        {loading && (
          <View style={st.loadingBox}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        )}

        {/* Results */}
        {buscado && !loading && (
          <>
            <Text style={st.resultsHeader}>
              {resultados.length > 0 ? `${resultados.length} resultado${resultados.length !== 1 ? 's' : ''} para "${query}"` : `Sin resultados para "${query}"`}
            </Text>
            {resultados.map(b => {
              const desc = b.precio_original > 0 ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;
              const imgUri = b.imagen_url || b.negocios?.imagen_url;
              return (
                <TouchableOpacity key={b.id} style={st.resultCard} onPress={() => router.push(`/producto/${b.id}` as any)} activeOpacity={0.85}>
                  <View style={st.resultImgWrap}>
                    {imgUri
                      ? <Image source={{ uri: imgUri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
                      : <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface }]}><Text style={{ fontSize: 28 }}>🍱</Text></View>
                    }
                  </View>
                  <View style={st.resultInfo}>
                    <Text style={st.resultNegocio} numberOfLines={1}>{b.negocios?.nombre}</Text>
                    <Text style={st.resultNombre} numberOfLines={1}>{b.nombre}</Text>
                    <View style={st.resultMeta}>
                      {b.negocios?.zona && <Text style={st.resultZona}>{b.negocios.zona}</Text>}
                    </View>
                  </View>
                  <View style={st.resultRight}>
                    <View style={st.discBadge}><Text style={st.discText}>-{desc}%</Text></View>
                    <Text style={st.resultPrice}>Q{b.precio_descuento}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  header: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4, backgroundColor: Colors.white },
  headerTitle: { fontSize: 28, fontWeight: '900', color: Colors.textPrimary, letterSpacing: -0.5 },

  searchWrap: { backgroundColor: Colors.white, paddingHorizontal: 20, paddingBottom: 16, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5', borderRadius: 50, paddingHorizontal: 16, gap: 10 },
  searchInput: { flex: 1, fontSize: 15, color: Colors.textPrimary, paddingVertical: 13 },

  content: { padding: 20 },

  sectionTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, marginBottom: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 50, paddingHorizontal: 16, paddingVertical: 9 },
  chipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },

  loadingBox: { paddingVertical: 40, alignItems: 'center' },

  resultsHeader: { fontSize: 14, color: Colors.textSecondary, fontWeight: '600', marginBottom: 16 },

  resultCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white, borderRadius: 18, marginBottom: 12, overflow: 'hidden', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
  resultImgWrap: { width: 76, height: 76, backgroundColor: Colors.surface },
  resultInfo: { flex: 1, paddingHorizontal: 14 },
  resultNegocio: { fontSize: 10, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  resultNombre: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary, marginBottom: 4 },
  resultMeta: { flexDirection: 'row', gap: 6 },
  resultZona: { fontSize: 11, color: Colors.textLight },
  resultRight: { paddingRight: 14, alignItems: 'flex-end', gap: 4 },
  discBadge: { backgroundColor: Colors.primary, borderRadius: 50, paddingHorizontal: 8, paddingVertical: 3 },
  discText: { color: Colors.white, fontSize: 10, fontWeight: '900' },
  resultPrice: { fontSize: 16, fontWeight: '900', color: Colors.primary },
});
