import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  Modal, TextInput, Alert, RefreshControl, Switch, Image, ActivityIndicator, Platform,
} from 'react-native';
import { bolsasAPI, negociosAPI, uploadsAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { pickImage } from '@/src/utils/pickImage';

const TIPOS_DESCUENTO = ['Porcentaje', 'Monto fijo', '2x1', 'Gratis', 'Especial'];

const MENU_CLASIFS = [
  { key: 'es_tiempo_limitado', label: 'Tiempo Limitado', emoji: '⏱️' },
  { key: 'es_promocion',       label: 'Promoción',       emoji: '🏷️' },
  { key: 'es_descuento',       label: 'Descuento',       emoji: '💸' },
  { key: 'es_destacado',       label: 'Destacado',       emoji: '⭐' },
  { key: 'es_mas_vendido',     label: 'Más vendido',     emoji: '🔥' },
  { key: 'es_precio_bajo',     label: 'Precio bajo',     emoji: '💰' },
];

const FORM_INIT = {
  tipo_form: 'bolsa' as 'bolsa' | 'cupon',
  nombre: '', descripcion: '', contenido: '',
  precio_original: '', precio_descuento: '',
  cantidad_disponible: '5',
  hora_recogida_inicio: '18:00', hora_recogida_fin: '20:00',
  peso_kg: '0.5', imagen_url: '', activo: true,
  categoria: 'Porcentaje',
  fecha_caducidad: '',
  // Clasificación en el menú
  categoria_menu: '',
  es_tiempo_limitado: true,
  es_promocion: false,
  es_descuento: false,
  es_destacado: false,
  es_mas_vendido: false,
  es_precio_bajo: false,
};

export default function BolsasRestauranteScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState<any>(FORM_INIT);
  const [editId, setEditId] = useState<string | null>(null);
  const [negocioId, setNegocioId] = useState('');
  const [uploadingFoto, setUploadingFoto] = useState(false);
  const [uploadFotoError, setUploadFotoError] = useState('');
  const [tabVista, setTabVista] = useState<'todos' | 'bolsa' | 'cupon'>('todos');
  const [saving, setSaving] = useState(false);
  const [co2Toast, setCo2Toast] = useState<string | null>(null);
  const fileInputRef = useRef<any>(null);
  const set = (k: string) => (v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  function handleWebFileChange(e: any) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      setUploadingFoto(true);
      setUploadFotoError('');
      try {
        const ext = file.type.split('/')[1] || 'jpg';
        const path = `bolsas/${negocioId}_${Date.now()}.${ext}`;
        const { data } = await uploadsAPI.uploadBase64(base64, path, file.type || 'image/jpeg');
        if (data?.publicUrl) setForm((f: any) => ({ ...f, imagen_url: data.publicUrl }));
      } catch (err: any) {
        setUploadFotoError(err.message || 'No se pudo subir la foto');
      } finally { setUploadingFoto(false); }
    };
    reader.onerror = () => setUploadFotoError('No se pudo leer la imagen');
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function seleccionarFotoBolsa() {
    setUploadFotoError('');
    if (Platform.OS === 'web') { fileInputRef.current?.click(); return; }
    pickImage().then(async (picked) => {
      if (!picked) return;
      setUploadingFoto(true);
      try {
        const ext = picked.mimeType.split('/')[1] || 'jpg';
        const path = `bolsas/${negocioId}_${Date.now()}.${ext}`;
        const { data } = await uploadsAPI.uploadBase64(picked.base64, path, picked.mimeType);
        if (data?.publicUrl) setForm((f: any) => ({ ...f, imagen_url: data.publicUrl }));
      } catch (e: any) {
        setUploadFotoError(e.message || 'No se pudo subir la foto');
      } finally { setUploadingFoto(false); }
    });
  }

  const cargar = useCallback(async () => {
    try {
      const [negRes, bolRes] = await Promise.all([negociosAPI.miNegocio(), bolsasAPI.listar({ mi_negocio: true })]);
      setNegocioId(negRes.data?.id || '');
      // Deduplicar por id en caso de datos duplicados en BD
      const raw: any[] = bolRes.data || [];
      const dedup = Array.from(new Map(raw.map(b => [String(b.id), b])).values());
      setItems(dedup);
    } catch { } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  function abrir(b?: any) {
    setUploadFotoError('');
    setSaving(false);
    if (b) {
      setEditId(b.id);
      setForm({
        ...FORM_INIT,
        tipo_form: b.tipo === 'cupon' ? 'cupon' : 'bolsa',
        nombre: b.nombre || '',
        descripcion: b.descripcion || '',
        contenido: b.contenido || '',
        precio_original: String(b.precio_original),
        precio_descuento: String(b.precio_descuento),
        cantidad_disponible: String(b.cantidad_disponible),
        peso_kg: String(b.peso_kg || 0.5),
        hora_recogida_inicio: b.hora_recogida_inicio || '18:00',
        hora_recogida_fin: b.hora_recogida_fin || '20:00',
        imagen_url: b.imagen_url || '',
        activo: b.activo,
        categoria: b.categoria || 'Porcentaje',
        fecha_caducidad: b.fecha_caducidad
          ? (() => { const d = new Date(b.fecha_caducidad + 'T12:00:00'); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })()
          : '',
        categoria_menu: b.categoria_menu || '',
        es_tiempo_limitado: b.es_tiempo_limitado ?? (b.tipo !== 'cupon'),
        es_promocion: b.es_promocion ?? (b.tipo === 'cupon'),
        es_descuento: b.es_descuento ?? (b.precio_original > b.precio_descuento),
        es_destacado: b.es_destacado ?? false,
        es_mas_vendido: b.es_mas_vendido ?? false,
        es_precio_bajo: b.es_precio_bajo ?? false,
      });
    } else {
      setEditId(null);
      setForm(FORM_INIT);
    }
    setModal(true);
  }

  function alertar(msg: string) {
    Platform.OS === 'web' ? (window as any).alert(msg) : Alert.alert('Error', msg);
  }

  async function guardar() {
    if (saving) return;
    if (!form.nombre || !form.precio_original || form.precio_descuento === '')
      return alertar('Nombre, precio original y precio Bocara son requeridos');
    if (form.tipo_form === 'cupon' && !form.contenido.trim())
      return alertar('El código de la promoción es requerido');

    // BUG 1: Validar fecha de caducidad para bolsas de tiempo limitado
    if (form.tipo_form === 'bolsa') {
      const fc = form.fecha_caducidad?.trim();
      if (!fc) return alertar('La fecha de caducidad es obligatoria');
      const parts = fc.split('/');
      if (parts.length !== 3 || parts.some((p: string) => !p)) return alertar('Formato de fecha inválido. Usa DD/MM/YYYY');
      const fechaCad = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      if (isNaN(fechaCad.getTime())) return alertar('Fecha de caducidad inválida');
      if (fechaCad < hoy) return alertar('La fecha de caducidad no puede ser anterior a hoy');
    }

    setSaving(true);
    const precOrig = parseFloat(form.precio_original) || 0;
    const precDesc = parseFloat(form.precio_descuento) || 0;

    const payload: any = {
      negocio_id: negocioId,
      tipo: form.tipo_form,
      nombre: form.nombre.trim(),
      descripcion: form.descripcion.trim(),
      contenido: form.tipo_form === 'cupon' ? form.contenido.trim().toUpperCase() : form.contenido.trim(),
      precio_original: precOrig,
      precio_descuento: precDesc,
      cantidad_disponible: parseInt(form.cantidad_disponible) || 1,
      hora_recogida_inicio: form.hora_recogida_inicio,
      hora_recogida_fin: form.hora_recogida_fin,
      imagen_url: form.imagen_url || null,
      // Clasificación en el menú
      categoria_menu: form.categoria_menu || null,
      es_tiempo_limitado: form.es_tiempo_limitado,
      es_promocion: form.es_promocion,
      es_descuento: form.es_descuento || (precOrig > precDesc),
      es_destacado: form.es_destacado,
      es_mas_vendido: form.es_mas_vendido,
      es_precio_bajo: form.es_precio_bajo,
    };
    // El backend calcula co2_salvado_kg automáticamente a partir del peso
    if (form.tipo_form === 'bolsa') {
      payload.peso_kg = parseFloat(form.peso_kg) || 0.5;
      // BUG 1: Enviar fecha_caducidad en formato YYYY-MM-DD
      const [d, m, y] = form.fecha_caducidad.split('/');
      if (d && m && y) payload.fecha_caducidad = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    if (form.tipo_form === 'cupon') payload.categoria = form.categoria;

    try {
      const res = editId
        ? await bolsasAPI.actualizar(editId, payload)
        : await bolsasAPI.crear(payload);
      setModal(false);
      cargar();
      // Mostrar CO₂ calculado por el servidor (nunca calculado en frontend)
      const co2 = res?.data?.co2_salvado_kg;
      if (co2 != null && co2 > 0) {
        setCo2Toast(`🌱 Impacto estimado: ${co2} kg CO₂e potencialmente evitados`);
        setTimeout(() => setCo2Toast(null), 5000);
      }
    } catch (e: any) {
      alertar(e.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function eliminar(id: string) {
    if (Platform.OS === 'web') {
      if (!(window as any).confirm('¿Eliminar este elemento? Esta acción no se puede deshacer.')) return;
      try { await bolsasAPI.eliminar(id); cargar(); } catch (e: any) { (window as any).alert(e.message || 'Error al eliminar'); }
      return;
    }
    Alert.alert('Eliminar', '¿Eliminar este elemento?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => bolsasAPI.eliminar(id).then(cargar) },
    ]);
  }

  const desc = (b: any) => b.precio_original > 0 ? Math.round((1 - b.precio_descuento / b.precio_original) * 100) : 0;

  const filtrados = tabVista === 'todos' ? items
    : items.filter(b => tabVista === 'cupon' ? b.tipo === 'cupon' : b.tipo !== 'cupon');

  if (loading) return <View style={s.loading}><ActivityIndicator color={Colors.orange} size="large" /></View>;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>⏱️ Disponibles</Text>
          <Text style={s.headerSub}>{items.length} publicacion{items.length !== 1 ? 'es' : ''}</Text>
        </View>
        <TouchableOpacity style={s.addBtn} onPress={() => abrir()}>
          <Text style={s.addBtnText}>+ Nueva</Text>
        </TouchableOpacity>
      </View>

      {/* Vista tabs: Todos / Tiempo Limitado / Promociones */}
      <View style={s.vistaRow}>
        {([['todos', 'Todos'], ['bolsa', 'Tiempo Limitado'], ['cupon', 'Promociones']] as const).map(([key, label]) => (
          <TouchableOpacity key={key} style={[s.vistaBtn, tabVista === key && s.vistaBtnActive]} onPress={() => setTabVista(key)}>
            <Text style={[s.vistaBtnText, tabVista === key && s.vistaBtnTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {co2Toast && (
        <View style={s.co2ToastBanner}>
          <Text style={s.co2ToastBannerText}>{co2Toast}</Text>
        </View>
      )}

      {items.some(b => b.estado_aprobacion === 'pendiente') && (
        <View style={s.infoBanner}>
          <Text style={s.infoBannerText}>⏳ Tienes publicaciones pendientes de aprobación.</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); cargar(); }} tintColor={Colors.orange} />}
      >
        {filtrados.length === 0 && !loading && (
          <View style={s.empty}>
            <Text style={{ fontSize: 48 }}>{tabVista === 'cupon' ? '🏷️' : '⏱️'}</Text>
            <Text style={s.emptyTitle}>Sin publicaciones</Text>
            <Text style={s.emptyText}>Crea tu primera publicación para que los clientes la vean.</Text>
            <TouchableOpacity style={s.emptyBtn} onPress={() => abrir()}>
              <Text style={s.emptyBtnText}>Crear primera publicación</Text>
            </TouchableOpacity>
          </View>
        )}

        {filtrados.map((b) => (
          <View key={b.id} style={[s.card, !b.activo && s.cardInactiva]}>
            <View style={s.cardRow}>
              <View style={s.foto}>
                {b.imagen_url
                  ? <Image source={{ uri: b.imagen_url }} style={s.fotoImg} />
                  : <Text style={{ fontSize: 36 }}>{b.tipo === 'cupon' ? '🏷️' : '⏱️'}</Text>
                }
              </View>
              <View style={{ flex: 1 }}>
                <View style={s.badgeRow}>
                  <View style={[s.tipoBadge, b.tipo === 'cupon' && s.tipoBadgeCupon]}>
                    <Text style={s.tipoBadgeText}>{b.tipo === 'cupon' ? 'PROMO' : 'T. LIMITADO'}</Text>
                  </View>
                  <View style={s.descBadge}><Text style={s.descBadgeText}>-{desc(b)}%</Text></View>
                  {!b.activo && <View style={s.inactivaBadge}><Text style={s.inactivaText}>Inactiva</Text></View>}
                  {b.estado_aprobacion === 'pendiente' && (
                    <View style={s.enRevisionBadge}><Text style={s.enRevisionText}>En revisión</Text></View>
                  )}
                  {b.estado_aprobacion === 'rechazado' && (
                    <View style={s.rechazadaBadge}><Text style={s.rechazadaText}>✕ Rechazada</Text></View>
                  )}
                  {(b.estado_aprobacion === 'aprobado' || !b.estado_aprobacion) && b.activo && (
                    <View style={s.aprobadaBadge}><Text style={s.aprobadaText}>✓ Aprobada</Text></View>
                  )}
                </View>
                <Text style={s.cardNombre}>{b.nombre}</Text>
                {b.tipo === 'cupon' && b.contenido ? (
                  <Text style={s.codigoBadge}>CÓDIGO: {b.contenido}</Text>
                ) : (
                  <Text style={s.cardSub} numberOfLines={1}>{b.descripcion}</Text>
                )}
                <Text style={s.cardHora}>⏰ {b.hora_recogida_inicio?.slice(0, 5)} – {b.hora_recogida_fin?.slice(0, 5)}</Text>
                {b.estado_aprobacion === 'pendiente' && (
                  <Text style={s.revisionMsg}>Esta publicación está siendo revisada por el administrador</Text>
                )}
                {b.estado_aprobacion === 'rechazado' && b.motivo_rechazo && (
                  <View style={s.motivoBox}><Text style={s.motivoText}>Motivo: {b.motivo_rechazo}</Text></View>
                )}
              </View>
              <View style={s.cardRight}>
                <Text style={s.precioOriginal}>Q{b.precio_original}</Text>
                <Text style={s.precioBocara}>Q{b.precio_descuento}</Text>
                <Text style={s.disp}>{b.cantidad_disponible} disp.</Text>
              </View>
            </View>

            <View style={s.cardActions}>
              <Switch
                value={!!b.activo}
                onValueChange={() => bolsasAPI.actualizar(b.id, { activo: !b.activo }).then(cargar)}
                trackColor={{ true: Colors.green, false: Colors.border }}
                thumbColor={Colors.white}
              />
              {/* Visible a clientes solo si activo Y aprobado */}
              <Text style={s.switchLabel}>
                {b.activo && (b.estado_aprobacion === 'aprobado' || !b.estado_aprobacion)
                  ? 'Visible'
                  : b.activo && b.estado_aprobacion === 'pendiente'
                  ? 'En revisión'
                  : 'Inactiva'}
              </Text>
              <View style={{ flex: 1 }} />
              <TouchableOpacity style={s.editBtn} onPress={() => abrir(b)}>
                <Text style={s.editBtnText}>Editar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.deleteBtn} onPress={() => eliminar(b.id)}>
                <Text style={s.deleteBtnText}>Eliminar</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Modal crear/editar */}
      <Modal visible={modal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={s.modal}>
          {Platform.OS === 'web' && React.createElement('input', {
            ref: fileInputRef, type: 'file', accept: 'image/*',
            style: { display: 'none' }, onChange: handleWebFileChange,
          })}

          <View style={s.modalHeader}>
            <TouchableOpacity onPress={() => setModal(false)} disabled={saving}>
              <Text style={s.cancelText}>Cancelar</Text>
            </TouchableOpacity>
            <Text style={s.modalTitle}>{editId ? 'Editar publicación' : 'Nueva publicación'}</Text>
            <TouchableOpacity onPress={guardar} disabled={saving}>
              {saving
                ? <ActivityIndicator color={Colors.orange} size="small" />
                : <Text style={s.saveText}>Guardar</Text>
              }
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
            {/* Selector de tipo */}
            {!editId && (
              <View style={s.tipoSelectorWrap}>
                <Text style={s.sectionLabel}>Tipo de publicación</Text>
                <View style={s.tipoSelector}>
                  <TouchableOpacity
                    style={[s.tipoBtn, form.tipo_form === 'bolsa' && s.tipoBtnActive]}
                    onPress={() => setForm((f: any) => ({ ...f, tipo_form: 'bolsa', es_tiempo_limitado: true, es_promocion: false }))}
                  >
                    <Text style={[s.tipoBtnEmoji]}>⏱️</Text>
                    <Text style={[s.tipoBtnLabel, form.tipo_form === 'bolsa' && s.tipoBtnLabelActive]}>Disponible por{'\n'}Tiempo Limitado</Text>
                    <Text style={[s.tipoBtnDesc, form.tipo_form === 'bolsa' && { color: Colors.white }]}>Fecha/hora · Cantidad limitada</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.tipoBtn, form.tipo_form === 'cupon' && s.tipoBtnActive]}
                    onPress={() => setForm((f: any) => ({ ...f, tipo_form: 'cupon', es_promocion: true, es_tiempo_limitado: false }))}
                  >
                    <Text style={[s.tipoBtnEmoji]}>🏷️</Text>
                    <Text style={[s.tipoBtnLabel, form.tipo_form === 'cupon' && s.tipoBtnLabelActive]}>Promoción</Text>
                    <Text style={[s.tipoBtnDesc, form.tipo_form === 'cupon' && { color: Colors.white }]}>Código · Descuento · Vigencia</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Foto */}
            <>
              <Text style={s.sectionLabel}>📷 Foto</Text>
              <TouchableOpacity
                style={[s.fotoBtn, uploadingFoto && { opacity: 0.6 }]}
                onPress={seleccionarFotoBolsa}
                disabled={uploadingFoto}
                activeOpacity={0.8}
              >
                {form.imagen_url
                  ? <Image source={{ uri: form.imagen_url }} style={s.fotoPreview} />
                  : <View style={s.fotoPlaceholder}>
                      <Text style={{ fontSize: 40 }}>{form.tipo_form === 'cupon' ? '🏷️' : '⏱️'}</Text>
                      <Text style={s.fotoPlaceholderText}>Toca para agregar foto</Text>
                    </View>
                }
                <View style={s.fotoOverlay}>
                  {uploadingFoto
                    ? <ActivityIndicator color={Colors.white} />
                    : <Text style={s.fotoOverlayText}>{form.imagen_url ? '📷 Cambiar foto' : '📷 Seleccionar foto'}</Text>
                  }
                </View>
              </TouchableOpacity>
              {uploadFotoError ? (
                <View style={s.uploadError}><Text style={s.uploadErrorText}>⚠️ {uploadFotoError}</Text></View>
              ) : null}
            </>

            <Text style={s.sectionLabel}>📝 Información</Text>
            <Field label="Nombre *" value={form.nombre} onChange={set('nombre')} placeholder={form.tipo_form === 'cupon' ? 'Ej. Descuento miércoles' : 'Ej. Bolsa de panadería'} />
            <Field label="Descripción" value={form.descripcion} onChange={set('descripcion')} placeholder="Detalles adicionales..." multiline />

            {/* Campos específicos por tipo */}
            {form.tipo_form === 'cupon' ? (
              <>
                <Field
                  label="Código de promoción *"
                  value={form.contenido}
                  onChange={set('contenido')}
                  placeholder="Ej. BOCARA20"
                  autoCapitalize="characters"
                />
                <Text style={s.sectionLabel}>Tipo de descuento</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 16 }}>
                  {TIPOS_DESCUENTO.map((t) => (
                    <TouchableOpacity
                      key={t}
                      style={[s.discChip, form.categoria === t && s.discChipActive]}
                      onPress={() => setForm((f: any) => ({ ...f, categoria: t }))}
                    >
                      <Text style={[s.discChipText, form.categoria === t && s.discChipTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            ) : (
              <Field label="¿Qué puede contener?" value={form.contenido} onChange={set('contenido')} placeholder="Pan, croissants, galletas..." multiline />
            )}

            <Text style={s.sectionLabel}>💰 Precios</Text>
            <View style={s.priceRow}>
              <View style={{ flex: 1 }}>
                <Field label="Precio original (Q) *" value={form.precio_original} onChange={set('precio_original')} placeholder="100" keyboard="numeric" />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field label="Precio Bocara (Q) *" value={form.precio_descuento} onChange={set('precio_descuento')} placeholder="35" keyboard="numeric" />
              </View>
            </View>

            {form.precio_original && form.precio_descuento ? (
              <View style={s.descInfo}>
                <Text style={s.descInfoText}>
                  Descuento: {Math.round((1 - parseFloat(form.precio_descuento || '0') / parseFloat(form.precio_original || '1')) * 100)}% · El cliente ahorra Q{(parseFloat(form.precio_original || '0') - parseFloat(form.precio_descuento || '0')).toFixed(2)}
                </Text>
              </View>
            ) : null}

            <Field label="Unidades disponibles *" value={form.cantidad_disponible} onChange={set('cantidad_disponible')} placeholder="5" keyboard="numeric" />

            <Text style={s.sectionLabel}>{form.tipo_form === 'cupon' ? '📅 Vigencia' : '⏰ Horario de recogida'}</Text>
            <View style={s.priceRow}>
              <View style={{ flex: 1 }}>
                <Field label={form.tipo_form === 'cupon' ? 'Válido desde (hora)' : 'Hora inicio'} value={form.hora_recogida_inicio} onChange={set('hora_recogida_inicio')} placeholder="18:00" />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Field label={form.tipo_form === 'cupon' ? 'Válido hasta (hora)' : 'Hora fin'} value={form.hora_recogida_fin} onChange={set('hora_recogida_fin')} placeholder="20:00" />
              </View>
            </View>

            {form.tipo_form === 'bolsa' && (
              <>
                {/* BUG 1: Fecha de caducidad obligatoria */}
                <Field
                  label="Fecha de caducidad * (DD/MM/YYYY)"
                  value={form.fecha_caducidad}
                  onChange={set('fecha_caducidad')}
                  placeholder="31/12/2025"
                  keyboard="numeric"
                />
                <Field
                  label="Peso aproximado del producto (kg)"
                  value={form.peso_kg}
                  onChange={set('peso_kg')}
                  placeholder="0.5"
                  keyboard="numeric"
                />
                {/* CO₂: calculado exclusivamente en backend según categoría del negocio */}
                <View style={s.co2Info}>
                  <Text style={s.co2InfoText}>
                    🌱 Bocara calculará automáticamente el impacto estimado según el peso y la categoría del alimento. El valor se mostrará al guardar.
                  </Text>
                </View>
              </>
            )}

            <Text style={s.sectionLabel}>🏷️ Clasificación en el menú</Text>
            <Text style={s.clasifHint}>
              Selecciona dónde debe aparecer este producto en los filtros de la tienda.
              El administrador revisará la publicación antes de mostrarla a los clientes.
            </Text>
            <View style={s.clasifGrid}>
              {MENU_CLASIFS.map(({ key, label, emoji }) => (
                <TouchableOpacity
                  key={key}
                  style={[s.clasifChip, (form as any)[key] && s.clasifChipActive]}
                  onPress={() => set(key)(!(form as any)[key])}
                  activeOpacity={0.8}
                >
                  <Text style={s.clasifChipEmoji}>{emoji}</Text>
                  <Text style={[s.clasifChipText, (form as any)[key] && s.clasifChipTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ height: 40 }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, multiline, keyboard, autoCapitalize }: any) {
  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={sf.label}>{label}</Text>
      <TextInput
        style={[sf.input, multiline && { height: 72 }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={Colors.textLight}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        keyboardType={keyboard || 'default'}
        autoCapitalize={autoCapitalize}
      />
    </View>
  );
}

const sf = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6, marginTop: 4 },
  input: { backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 14, color: Colors.textPrimary, marginBottom: 4 },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 20, fontWeight: '900', color: Colors.brown },
  headerSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  addBtn: { backgroundColor: Colors.orange, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: Colors.white, fontWeight: '700', fontSize: 13 },

  vistaRow: { flexDirection: 'row', backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border, paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  vistaBtn: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.white },
  vistaBtnActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  vistaBtnText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  vistaBtnTextActive: { color: Colors.white, fontWeight: '700' },

  infoBanner: { backgroundColor: '#FEF3C7', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#FDE68A' },
  infoBannerText: { fontSize: 12, color: '#92400E', fontWeight: '600' },
  scroll: { padding: 14 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.brown },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyBtn: { backgroundColor: Colors.orange, borderRadius: 14, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  emptyBtnText: { color: Colors.white, fontWeight: '700', fontSize: 14 },

  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6 },
  cardInactiva: { opacity: 0.55 },
  cardRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  foto: { width: 72, height: 72, borderRadius: 12, backgroundColor: Colors.brownLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fotoImg: { width: 72, height: 72, borderRadius: 12 },
  badgeRow: { flexDirection: 'row', gap: 5, marginBottom: 4, flexWrap: 'wrap' },
  tipoBadge: { backgroundColor: Colors.orange, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  tipoBadgeCupon: { backgroundColor: '#7C3AED' },
  tipoBadgeText: { color: Colors.white, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  descBadge: { backgroundColor: Colors.brown, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  descBadgeText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  inactivaBadge: { backgroundColor: Colors.border, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  inactivaText: { fontSize: 10, color: Colors.textSecondary, fontWeight: '600' },
  cardNombre: { fontSize: 15, fontWeight: '800', color: Colors.brown },
  cardSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  codigoBadge: { fontSize: 12, fontWeight: '900', color: '#7C3AED', marginTop: 3, letterSpacing: 1 },
  cardHora: { fontSize: 12, color: Colors.textSecondary, marginTop: 4 },
  cardRight: { alignItems: 'flex-end', justifyContent: 'center' },
  precioOriginal: { fontSize: 11, color: Colors.textLight, textDecorationLine: 'line-through' },
  precioBocara: { fontSize: 22, fontWeight: '900', color: Colors.orange },
  disp: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  cardActions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10 },
  switchLabel: { fontSize: 12, color: Colors.textSecondary, marginLeft: 4 },
  editBtn: { borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  editBtnText: { color: Colors.orange, fontSize: 13, fontWeight: '700' },
  deleteBtn: { borderWidth: 1.5, borderColor: Colors.error, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  deleteBtnText: { color: Colors.error, fontSize: 13, fontWeight: '700' },

  enRevisionBadge: { backgroundColor: '#FEF3C7', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  enRevisionText: { fontSize: 10, color: '#92400E', fontWeight: '700' },
  revisionMsg: { fontSize: 11, color: '#92400E', marginTop: 4, fontStyle: 'italic', lineHeight: 16 },
  rechazadaBadge: { backgroundColor: '#FEE2E2', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  rechazadaText: { fontSize: 10, color: '#DC2626', fontWeight: '700' },
  aprobadaBadge: { backgroundColor: '#DCFCE7', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  aprobadaText: { fontSize: 10, color: '#16A34A', fontWeight: '700' },
  motivoBox: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: 8, marginTop: 4 },
  motivoText: { fontSize: 12, color: '#DC2626', fontStyle: 'italic' },

  modal: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: Colors.white, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 17, fontWeight: '800', color: Colors.brown },
  cancelText: { color: Colors.error, fontSize: 15 },
  saveText: { color: Colors.orange, fontSize: 15, fontWeight: '800' },
  modalScroll: { padding: 16 },
  sectionLabel: { fontSize: 15, fontWeight: '800', color: Colors.brown, marginTop: 16, marginBottom: 10 },
  priceRow: { flexDirection: 'row' },
  descInfo: { backgroundColor: Colors.greenLight, borderRadius: 10, padding: 10, marginBottom: 12 },
  descInfoText: { fontSize: 13, color: Colors.green, fontWeight: '600' },
  uploadError: { backgroundColor: '#FEE2E2', borderRadius: 10, padding: 10, marginBottom: 12, marginTop: -8 },
  uploadErrorText: { color: '#B91C1C', fontSize: 13, fontWeight: '600' },
  fotoBtn: { borderRadius: 12, overflow: 'hidden', height: 150, marginBottom: 16 },
  fotoPreview: { width: '100%', height: '100%' },
  fotoPlaceholder: { width: '100%', height: '100%', backgroundColor: Colors.brownLight, alignItems: 'center', justifyContent: 'center', gap: 6 },
  fotoPlaceholderText: { fontSize: 13, color: Colors.textSecondary },
  fotoOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.5)', paddingVertical: 8, alignItems: 'center' },
  fotoOverlayText: { color: Colors.white, fontWeight: '700', fontSize: 13 },

  tipoSelectorWrap: { marginBottom: 4 },
  tipoSelector: { flexDirection: 'row', gap: 10 },
  tipoBtn: { flex: 1, borderWidth: 2, borderColor: Colors.border, borderRadius: 16, padding: 14, alignItems: 'center', gap: 4, backgroundColor: Colors.white },
  tipoBtnActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  tipoBtnEmoji: { fontSize: 28 },
  tipoBtnLabel: { fontSize: 13, fontWeight: '800', color: Colors.brown, textAlign: 'center' },
  tipoBtnLabelActive: { color: Colors.white },
  tipoBtnDesc: { fontSize: 10, color: Colors.textSecondary, textAlign: 'center', marginTop: 2 },
  discChip: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: Colors.white },
  discChipActive: { backgroundColor: Colors.orange, borderColor: Colors.orange },
  discChipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  discChipTextActive: { color: Colors.white, fontWeight: '800' },

  clasifHint: { fontSize: 12, color: Colors.textSecondary, lineHeight: 18, marginBottom: 12, marginTop: -6 },
  clasifGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  clasifChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 8, backgroundColor: Colors.white,
  },
  clasifChipActive: { backgroundColor: '#1A1A1A', borderColor: '#1A1A1A' },
  clasifChipEmoji: { fontSize: 14 },
  clasifChipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  clasifChipTextActive: { color: '#fff', fontWeight: '700' },
  co2Info: { backgroundColor: '#F0FDF4', borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#BBF7D0' },
  co2InfoText: { fontSize: 12, color: '#166534', lineHeight: 18 },
  co2ToastBanner: { backgroundColor: '#D1FAE5', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#6EE7B7' },
  co2ToastBannerText: { fontSize: 13, color: '#065F46', fontWeight: '700' },
});
