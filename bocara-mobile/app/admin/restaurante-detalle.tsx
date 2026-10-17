import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator, Alert, Modal, TextInput,
  Image, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { adminAPI, negociosAPI, uploadsAPI } from '@/src/services/api';
import { Colors } from '@/constants/Colors';
import { volver } from '@/src/utils/backNavigation';
import { pickImage } from '@/src/utils/pickImage';
import {
  accionDisponibleNegocio, ejecutarAccionNegocio, textosAccionNegocio, type AccionNegocio,
  negocioTieneFoto, solicitudFotoPendiente, subirFotoNegocio,
} from '@/src/utils/suspensionAdmin';
import { ejecutarAccionAdmin } from '@/src/utils/accionAdmin';
import ConfirmarAccionModal, { AvisoAccion } from '@/components/ConfirmarAccionModal';

const DARK  = '#1E293B';
const DARK2 = '#0F172A';

type Tab = 'negocio' | 'propietario' | 'bancario';

export default function RestauranteDetalleScreen() {
  // accion=foto: llega desde "📷 Agregar foto para reactivar" (admin/negocios).
  const { id, accion } = useLocalSearchParams<{ id: string; accion?: string }>();
  const router  = useRouter();

  const [negocio,    setNegocio]    = useState<any>(null);
  const [propietario, setPropietario] = useState<any>(null);
  const [loading,    setLoading]    = useState(true);
  const [tab,        setTab]        = useState<Tab>('negocio');
  const [procesando, setProcesando] = useState(false);
  const [rechazarModal, setRechazarModal] = useState(false);
  const [motivo,     setMotivo]     = useState('');
  const [suspensionModal, setSuspensionModal] = useState<AccionNegocio | null>(null);
  const [motivoSuspension, setMotivoSuspension] = useState('');
  const [errorSuspension, setErrorSuspension] = useState('');
  const [aviso, setAviso] = useState<{ tipo: 'exito' | 'error'; texto: string } | null>(null);
  const [aprobarModal, setAprobarModal] = useState(false);
  const [errorAprobar, setErrorAprobar] = useState('');
  // Foto del negocio subida por el admin (caso "Sabor Casero": suspendido y
  // sin foto, el toggle respondía 409 y no había forma de cargarla aquí).
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const [errorFoto, setErrorFoto] = useState('');
  const [fotoRecienSubida, setFotoRecienSubida] = useState(false);
  const [solicitudFoto, setSolicitudFoto] = useState<any>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      // Usa el listado admin (autenticado, adminOnly) en vez del endpoint público
      // GET /negocios/:id — ese es sin auth y expone DPI/datos bancarios a
      // cualquiera que conozca el id del negocio.
      const [negRes, usersRes] = await Promise.all([adminAPI.negocios(), adminAPI.usuarios()]);
      const negocios = negRes.data || [];
      const neg = negocios.find((n: any) => n.id === id);
      if (!neg) { Alert.alert('Error', 'No se encontró el negocio'); return; }
      setNegocio(neg);

      if (neg.propietario_id) {
        const users = usersRes.data || [];
        const prop  = users.find((u: any) => u.id === neg.propietario_id);
        setPropietario(prop || null);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'No se pudo cargar el perfil');
    } finally {
      setLoading(false);
    }
    // Foto que el restaurante subió y espera revisión: aparte y sin bloquear
    // la pantalla si el listado de cambios falla.
    try {
      const sol = await adminAPI.cambiosPerfil();
      setSolicitudFoto(solicitudFotoPendiente(sol.data, id));
    } catch {
      setSolicitudFoto(null);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    cargar();
  }, [id, cargar]);

  // Confirmación con modal propio: Alert.alert con botones no hace nada en web.
  function aprobar() {
    if (!negocio) return;
    setAviso(null);
    setErrorAprobar('');
    setAprobarModal(true);
  }

  async function confirmarAprobar() {
    if (!negocio) return;
    setProcesando(true);
    setErrorAprobar('');
    const r = await ejecutarAccionAdmin(() => adminAPI.verificarNegocio(negocio.id), {
      exito: `"${negocio.nombre}" fue aprobado y notificado.`,
      error: 'No se pudo aprobar el negocio.',
    });
    setProcesando(false);
    if (!r.ok) {
      // El modal queda abierto con el error real (p. ej. negocio sin foto).
      setErrorAprobar(r.error);
      return;
    }
    // El backend devuelve la fila ya aprobada: se pinta sin recargar.
    setNegocio((prev: any) => ({
      ...prev, verificado: true, activo: true, estado_verificacion: 'aprobado', motivo_rechazo: null,
      ...(r.data?.data || {}),
    }));
    setAprobarModal(false);
    setAviso({ tipo: 'exito', texto: r.mensaje });
  }

  async function rechazar() {
    if (!negocio) return;
    setProcesando(true);
    try {
      await adminAPI.rechazarNegocio(negocio.id, motivo.trim() || undefined);
      setRechazarModal(false);
      setMotivo('');
      await cargar();
      Alert.alert('Rechazado', 'El restaurante fue rechazado.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setProcesando(false); }
  }

  // Antes usaba Alert.alert con botones, que en web es un no-op: el botón
  // "Suspender" no abría nada ni llamaba al API. Ahora confirma con un Modal.
  function abrirSuspension() {
    const accion = accionDisponibleNegocio(negocio);
    if (!accion) return;
    setAviso(null);
    setErrorSuspension('');
    setMotivoSuspension('');
    setSuspensionModal(accion);
  }

  async function confirmarSuspension() {
    if (!negocio || !suspensionModal) return;
    setProcesando(true);
    setErrorSuspension('');
    const r = await ejecutarAccionNegocio(adminAPI, negocio, suspensionModal, motivoSuspension);
    setProcesando(false);
    if (!r.ok) {
      // El modal queda abierto con el error real del backend.
      setErrorSuspension(r.error);
      return;
    }
    setNegocio((prev: any) => ({ ...prev, activo: r.activo }));
    setSuspensionModal(null);
    setMotivoSuspension('');
    setAviso({ tipo: 'exito', texto: r.mensaje });
  }

  // pickImage() va primero y sin await previo: en web abre el selector de
  // archivos, y el navegador solo lo permite dentro del gesto (onPress).
  async function subirFoto() {
    if (!negocio || subiendoFoto) return;
    const imagen = await pickImage();
    if (!imagen) return;
    setAviso(null);
    setErrorFoto('');
    setSubiendoFoto(true);
    const r = await subirFotoNegocio(
      { uploadBase64: uploadsAPI.uploadBase64, actualizarNegocio: negociosAPI.actualizar },
      negocio.id, imagen,
    );
    setSubiendoFoto(false);
    if (!r.ok) { setErrorFoto(r.error); return; }
    setNegocio((prev: any) => ({ ...prev, ...(r.negocio || {}), imagen_url: r.imagen_url }));
    setFotoRecienSubida(true);
    setAviso({ tipo: 'exito', texto: 'Foto del negocio actualizada.' });
  }

  // La solicitud del restaurante solo se aprueba desde aquí si trae ÚNICAMENTE
  // la foto; si cambia más campos, se revisa completa en Cambios de perfil.
  async function aprobarSolicitudFoto() {
    if (!solicitudFoto) return;
    setProcesando(true);
    setErrorFoto('');
    const r = await ejecutarAccionAdmin(() => adminAPI.aprobarCambioPerfil(solicitudFoto.id), {
      exito: 'Foto del restaurante aprobada y publicada.',
      error: 'No se pudo aprobar la foto.',
    });
    setProcesando(false);
    if (!r.ok) { setErrorFoto(r.error); return; }
    setNegocio((prev: any) => ({ ...prev, imagen_url: solicitudFoto.cambios.imagen_url }));
    setSolicitudFoto(null);
    setFotoRecienSubida(true);
    setAviso({ tipo: 'exito', texto: r.mensaje });
  }

  // Mismo flujo compartido que el botón inferior (ejecutarAccionNegocio); el
  // admin ya lo pidió explícitamente con "Reactivar negocio ahora".
  async function reactivarAhora() {
    if (!negocio) return;
    setProcesando(true);
    setErrorFoto('');
    const r = await ejecutarAccionNegocio(adminAPI, negocio, 'reactivar');
    setProcesando(false);
    if (!r.ok) { setErrorFoto(r.error); return; }
    setNegocio((prev: any) => ({ ...prev, activo: r.activo }));
    setFotoRecienSubida(false);
    setAviso({ tipo: 'exito', texto: r.mensaje });
  }

  if (loading) return (
    <View style={s.loading}>
      <ActivityIndicator color={Colors.orange} size="large" />
    </View>
  );

  if (!negocio) return (
    <SafeAreaView style={s.root}>
      <TouchableOpacity style={s.backBtn} onPress={() => volver(router, '/admin/negocios')}>
        <Text style={s.backText}>← Volver</Text>
      </TouchableOpacity>
      <View style={s.loading}>
        <Text style={{ color: '#64748B' }}>No se encontró el restaurante</Text>
      </View>
    </SafeAreaView>
  );

  const bancario = negocio.datos_bancarios || {};
  const dpiUrl   = negocio.dpi_foto_url || bancario.dpi_foto_url;
  const estadoColor = negocio.verificado
    ? '#34D399'
    : negocio.estado_verificacion === 'rechazado' ? '#F87171' : '#FCD34D';
  const estadoLabel = negocio.verificado
    ? 'Verificado'
    : negocio.estado_verificacion === 'rechazado' ? 'Rechazado' : 'Pendiente';
  const accionSuspension = accionDisponibleNegocio(negocio);
  const suspendido = accionSuspension === 'reactivar';
  const textosSuspension = suspensionModal ? textosAccionNegocio(suspensionModal, negocio.nombre) : null;
  const tieneFoto = negocioTieneFoto(negocio);
  const faltaFotoParaReactivar = suspendido && !tieneFoto;
  const destacarFoto = faltaFotoParaReactivar || (accion === 'foto' && !tieneFoto);
  const puedeReactivarAhora = suspendido && tieneFoto && fotoRecienSubida;
  const soloFotoEnSolicitud = !!solicitudFoto && Object.keys(solicitudFoto.cambios || {}).every((k) => k === 'imagen_url');

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => volver(router, '/admin/negocios')} style={s.backBtn}>
          <Text style={s.backText}>←  Negocios</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} numberOfLines={1}>{negocio.nombre}</Text>
          <View style={[s.estadoBadge, { backgroundColor: estadoColor + '22' }]}>
            <Text style={[s.estadoText, { color: estadoColor }]}>{estadoLabel}</Text>
          </View>
          {suspendido && (
            <View style={[s.estadoBadge, { backgroundColor: '#F8717122' }]}>
              <Text style={[s.estadoText, { color: '#F87171' }]}>Negocio suspendido</Text>
            </View>
          )}
        </View>
      </View>

      <AvisoAccion aviso={aviso} onCerrar={() => setAviso(null)} />

      {/* Tabs */}
      <View style={s.tabs}>
        {(['negocio', 'propietario', 'bancario'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[s.tabItem, tab === t && s.tabActive]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabTextActive]}>
              {t === 'negocio' ? '🏪 Negocio' : t === 'propietario' ? '👤 Propietario' : '🏦 Bancario'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        {tab === 'negocio' && (
          <>
            <Section title="Información del negocio">
              <Row label="Nombre" val={negocio.nombre} />
              <Row label="Categoría" val={negocio.categoria} />
              <Row label="Zona" val={negocio.zona} />
              <Row label="Ciudad" val={negocio.ciudad} />
              <Row label="Dirección" val={negocio.direccion} />
              <Row label="Teléfono" val={negocio.telefono} />
              <Row label="Email" val={negocio.email} />
              <Row label="Horario" val={negocio.horario_atencion} />
              <Row label="NIT" val={negocio.nit} />
              <Row label="DPI" val={negocio.dpi} />
            </Section>

            <Section title="Ubicación">
              {negocio.latitud && negocio.longitud ? (
                <>
                  <Row label="Latitud" val={negocio.latitud} />
                  <Row label="Longitud" val={negocio.longitud} />
                  <TouchableOpacity
                    style={s.mapBtn}
                    onPress={() => Linking.openURL(`https://www.google.com/maps?q=${negocio.latitud},${negocio.longitud}`)}
                  >
                    <Text style={s.mapBtnText}>📍 Ver en Google Maps</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <Text style={s.noData}>Sin coordenadas registradas</Text>
              )}
            </Section>

            <Section title="Descripción">
              <Text style={s.desc}>{negocio.descripcion || 'Sin descripción'}</Text>
            </Section>

            <Section title="Estadísticas">
              <Row label="Bolsas vendidas" val={negocio.total_bolsas_vendidas || 0} />
              <Row label="Calificación" val={negocio.calificacion_promedio ? `⭐ ${negocio.calificacion_promedio.toFixed(1)}` : '—'} />
              <Row label="Estado" val={estadoLabel} valColor={estadoColor} />
              {negocio.motivo_rechazo && <Row label="Motivo rechazo" val={negocio.motivo_rechazo} valColor="#F87171" />}
            </Section>

            <Section title="Foto del negocio">
              {tieneFoto
                ? <Image source={{ uri: negocio.imagen_url }} style={s.dpiImg} resizeMode="cover" />
                : <Text style={s.noData}>Sin foto del negocio cargada</Text>}
              {destacarFoto && (
                <Text style={s.fotoAviso}>
                  ⚠️ Sin foto este negocio no se puede reactivar. Súbela aquí y luego reactívalo.
                </Text>
              )}
              {solicitudFoto && (
                <View style={s.fotoSolicitud}>
                  <Text style={s.fotoSolicitudText}>
                    📨 El restaurante envió una foto nueva que espera revisión.
                  </Text>
                  {solicitudFoto.cambios?.imagen_url
                    ? <Image source={{ uri: solicitudFoto.cambios.imagen_url }} style={s.fotoPropuesta} resizeMode="cover" />
                    : null}
                  {soloFotoEnSolicitud ? (
                    <TouchableOpacity style={s.btnFotoSecundario} onPress={aprobarSolicitudFoto} disabled={procesando} accessibilityRole="button">
                      <Text style={s.btnFotoSecundarioText}>✓ Aprobar foto del restaurante</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={s.btnFotoSecundario} onPress={() => router.push('/admin/cambios-perfil' as any)} accessibilityRole="button">
                      <Text style={s.btnFotoSecundarioText}>Revisar la solicitud en Cambios de perfil ›</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              <TouchableOpacity
                style={[s.btnFoto, destacarFoto && s.btnFotoDestacado]}
                onPress={subirFoto}
                disabled={subiendoFoto || procesando}
                accessibilityRole="button"
                testID="admin-negocio-subir-foto"
              >
                {subiendoFoto
                  ? <ActivityIndicator color={Colors.orange} size="small" />
                  : <Text style={s.btnFotoText}>{tieneFoto ? '📷 Cambiar foto del negocio' : '📷 Subir foto del negocio'}</Text>}
              </TouchableOpacity>
              {errorFoto ? <Text style={s.fotoError} accessibilityRole="alert">⚠️ {errorFoto}</Text> : null}
              {puedeReactivarAhora && (
                <TouchableOpacity style={s.btnReactivarAhora} onPress={reactivarAhora} disabled={procesando} accessibilityRole="button">
                  {procesando
                    ? <ActivityIndicator color="#6EE7B7" size="small" />
                    : <Text style={s.btnReactivarAhoraText}>▶ Reactivar negocio ahora</Text>}
                </TouchableOpacity>
              )}
            </Section>

            {dpiUrl ? (
              <Section title="Foto DPI">
                <Image source={{ uri: dpiUrl }} style={s.dpiImg} resizeMode="contain" />
              </Section>
            ) : (
              <Section title="Foto DPI">
                <Text style={s.noData}>Sin foto DPI cargada</Text>
              </Section>
            )}
          </>
        )}

        {tab === 'propietario' && (
          <>
            {propietario ? (
              <Section title="Datos del propietario">
                <Row label="Nombre" val={`${propietario.nombre || ''} ${propietario.apellido || ''}`.trim()} />
                <Row label="Correo" val={propietario.email} />
                <Row label="Teléfono" val={propietario.telefono} />
                <Row label="Rol" val={propietario.rol} />
                <Row label="Puntos" val={propietario.puntos} />
              </Section>
            ) : (
              <View style={s.emptySection}>
                <Text style={{ fontSize: 32 }}>👤</Text>
                <Text style={s.emptyText}>No se encontraron datos del propietario</Text>
              </View>
            )}
          </>
        )}

        {tab === 'bancario' && (
          <>
            {Object.keys(bancario).length > 0 ? (
              <Section title="Datos bancarios">
                <Row label="Banco" val={bancario.banco} />
                <Row label="Tipo de cuenta" val={bancario.tipo_cuenta} />
                <Row label="Número de cuenta" val={bancario.numero_cuenta || bancario.cuenta} />
                <Row label="Titular" val={bancario.titular || bancario.nombre_titular} />
                <Row label="Moneda" val={bancario.moneda} />
              </Section>
            ) : (
              <View style={s.emptySection}>
                <Text style={{ fontSize: 32 }}>🏦</Text>
                <Text style={s.emptyText}>Sin datos bancarios registrados</Text>
              </View>
            )}
          </>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Action buttons */}
      <View style={s.actions}>
        {!negocio.verificado && (
          <>
            <TouchableOpacity style={s.btnAprobar} onPress={aprobar} disabled={procesando}>
              {procesando ? <ActivityIndicator color="#6EE7B7" size="small" />
                : <Text style={s.btnAprobarText}>✓ Aprobar</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.btnRechazar} onPress={() => setRechazarModal(true)} disabled={procesando}>
              <Text style={s.btnRechazarText}>✕ Rechazar</Text>
            </TouchableOpacity>
          </>
        )}
        {/* Suspendido sin foto: "Reactivar" respondería 409. Se lleva a la
            sección de la foto en vez de ofrecer un botón que va a fallar. */}
        {faltaFotoParaReactivar && (
          <TouchableOpacity
            style={[s.btnToggle, s.btnFotoPendiente]}
            onPress={() => { setTab('negocio'); setErrorFoto(''); }}
            accessibilityRole="button"
          >
            <Text style={[s.btnToggleText, { color: '#FDBA74' }]}>📷 Sube una foto para reactivar</Text>
          </TouchableOpacity>
        )}
        {accionSuspension && !faltaFotoParaReactivar && (
          <TouchableOpacity
            style={[s.btnToggle, suspendido && s.btnActivar]}
            onPress={abrirSuspension}
            disabled={procesando}
            accessibilityRole="button"
            testID="admin-negocio-suspension"
          >
            <Text style={[s.btnToggleText, suspendido && s.btnActivarText]}>
              {suspendido ? '▶ Reactivar negocio' : '⏸ Suspender negocio'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Modal suspender / reactivar negocio */}
      <ConfirmarAccionModal
        visible={!!suspensionModal}
        titulo={textosSuspension?.titulo || ''}
        mensaje={textosSuspension?.pregunta || ''}
        detalle={textosSuspension?.detalle}
        textoConfirmar={textosSuspension?.boton || ''}
        tono={suspensionModal === 'reactivar' ? 'exito' : 'peligro'}
        procesando={procesando}
        error={errorSuspension}
        onConfirmar={confirmarSuspension}
        onCancelar={() => setSuspensionModal(null)}
      >
        {suspensionModal === 'suspender' && (
          <>
            <Text style={s.modalLabel}>Motivo (opcional — si lo indicas, se notifica al propietario)</Text>
            <TextInput
              style={s.modalInput}
              value={motivoSuspension}
              onChangeText={setMotivoSuspension}
              placeholder="Ej. Quejas reiteradas de clientes..."
              placeholderTextColor="#64748B"
              multiline
            />
          </>
        )}
      </ConfirmarAccionModal>

      {/* Modal aprobar negocio */}
      <ConfirmarAccionModal
        visible={aprobarModal}
        titulo="Aprobar restaurante"
        mensaje={`¿Seguro que deseas aprobar "${negocio.nombre}"?`}
        detalle="Quedará verificado y visible para los clientes, y se notificará al propietario."
        textoConfirmar="Aprobar"
        tono="exito"
        procesando={procesando}
        error={errorAprobar}
        onConfirmar={confirmarAprobar}
        onCancelar={() => setAprobarModal(false)}
      />

      {/* Modal rechazo */}
      <Modal visible={rechazarModal} transparent animationType="fade">
        <View style={s.overlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rechazar negocio</Text>
            <Text style={s.modalSub}>{negocio.nombre}</Text>
            <Text style={s.modalLabel}>Motivo (opcional)</Text>
            <TextInput
              style={s.modalInput}
              value={motivo}
              onChangeText={setMotivo}
              placeholder="Ej. Documentación incompleta..."
              placeholderTextColor="#64748B"
              multiline
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setRechazarModal(false)}>
                <Text style={s.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalConfirm} onPress={rechazar} disabled={procesando}>
                {procesando ? <ActivityIndicator color="#FCA5A5" size="small" />
                  : <Text style={s.modalConfirmText}>Rechazar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, val, valColor }: { label: string; val?: any; valColor?: string }) {
  if (!val && val !== 0) return null;
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowVal, valColor ? { color: valColor } : undefined]}>{String(val)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: DARK2 },
  loading:      { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: DARK2 },
  header:       { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: DARK, padding: 16, borderBottomWidth: 1, borderBottomColor: '#334155' },
  backBtn:      { paddingRight: 4 },
  backText:     { color: Colors.orange, fontSize: 14, fontWeight: '700' },
  headerTitle:  { fontSize: 18, fontWeight: '900', color: Colors.white },
  estadoBadge:  { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, marginTop: 2 },
  estadoText:   { fontSize: 11, fontWeight: '700' },
  tabs:         { flexDirection: 'row', backgroundColor: DARK, borderBottomWidth: 1, borderBottomColor: '#334155' },
  tabItem:      { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive:    { borderBottomColor: Colors.orange },
  tabText:      { fontSize: 12, color: '#64748B', fontWeight: '600' },
  tabTextActive: { color: Colors.white, fontWeight: '800' },
  scroll:       { padding: 16 },
  section:      { marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },
  sectionBody:  { backgroundColor: DARK, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#334155' },
  row:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  rowLabel:     { fontSize: 13, color: '#94A3B8', flex: 1 },
  rowVal:       { fontSize: 13, color: Colors.white, fontWeight: '600', flex: 2, textAlign: 'right' },
  desc:         { fontSize: 13, color: '#94A3B8', padding: 12, lineHeight: 20 },
  noData:       { fontSize: 13, color: '#475569', padding: 12 },
  dpiImg:       { width: '100%', height: 200, borderRadius: 12 },
  fotoAviso:    { fontSize: 13, color: '#FDBA74', fontWeight: '700', paddingHorizontal: 12, paddingBottom: 4, lineHeight: 19 },
  fotoSolicitud: { margin: 12, marginBottom: 0, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#1D4ED8', backgroundColor: '#0B1A3A', gap: 8 },
  fotoSolicitudText: { fontSize: 13, color: '#93C5FD', fontWeight: '700' },
  fotoPropuesta: { width: '100%', height: 140, borderRadius: 10 },
  btnFotoSecundario: { borderWidth: 1.5, borderColor: '#2563EB', borderRadius: 10, padding: 10, alignItems: 'center' },
  btnFotoSecundarioText: { color: '#93C5FD', fontWeight: '800', fontSize: 13 },
  btnFoto:      { margin: 12, borderWidth: 1.5, borderColor: Colors.orange, borderRadius: 10, padding: 12, alignItems: 'center' },
  btnFotoDestacado: { backgroundColor: '#3B1D06' },
  btnFotoText:  { color: Colors.orange, fontWeight: '800', fontSize: 14 },
  fotoError:    { fontSize: 13, color: '#FCA5A5', fontWeight: '600', paddingHorizontal: 12, paddingBottom: 12 },
  btnReactivarAhora: { margin: 12, marginTop: 0, backgroundColor: '#065F46', borderRadius: 10, padding: 13, alignItems: 'center' },
  btnReactivarAhoraText: { color: '#6EE7B7', fontWeight: '900', fontSize: 14 },
  btnFotoPendiente: { borderColor: '#C2410C', backgroundColor: '#2A1404' },
  mapBtn:       { margin: 12, marginTop: 4, borderWidth: 1.5, borderColor: '#2563EB', borderRadius: 10, padding: 12, alignItems: 'center' },
  mapBtnText:   { color: '#60A5FA', fontWeight: '700', fontSize: 13 },
  emptySection: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyText:    { fontSize: 14, color: '#64748B', textAlign: 'center' },
  actions:      { flexDirection: 'row', gap: 10, padding: 16, backgroundColor: DARK, borderTopWidth: 1, borderTopColor: '#334155' },
  btnAprobar:   { flex: 1, backgroundColor: '#065F46', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnAprobarText: { color: '#6EE7B7', fontWeight: '800', fontSize: 14 },
  btnRechazar:  { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnRechazarText: { color: '#F87171', fontWeight: '800', fontSize: 14 },
  btnToggle:    { flex: 1, borderWidth: 1.5, borderColor: '#991B1B', borderRadius: 12, padding: 14, alignItems: 'center' },
  btnActivar:   { borderColor: '#065F46', backgroundColor: '#021F16' },
  btnToggleText: { color: '#F87171', fontWeight: '800', fontSize: 14 },
  btnActivarText: { color: '#6EE7B7' },
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  modalCard:    { backgroundColor: DARK, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#334155' },
  modalTitle:   { fontSize: 18, fontWeight: '900', color: Colors.white, marginBottom: 4 },
  modalSub:     { fontSize: 14, color: '#94A3B8', marginBottom: 16 },
  modalLabel:   { fontSize: 13, color: '#94A3B8', fontWeight: '600', marginBottom: 8 },
  modalInput:   { backgroundColor: '#334155', borderRadius: 12, padding: 12, color: Colors.white, fontSize: 14, minHeight: 80, textAlignVertical: 'top', marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancel:  { flex: 1, borderWidth: 1.5, borderColor: '#334155', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalCancelText: { color: '#94A3B8', fontWeight: '600', fontSize: 14 },
  modalConfirm: { flex: 1, backgroundColor: '#991B1B', borderRadius: 12, padding: 12, alignItems: 'center' },
  modalConfirmText: { color: '#FCA5A5', fontWeight: '800', fontSize: 14 },
});
