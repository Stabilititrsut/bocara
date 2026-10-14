// Asistente de IA para el restaurante.
//   POST /api/ia/descripcion  → { descripcion }
// Propone una descripción para una Promoción (tipo=cupon) o Tiempo limitado
// (tipo=bolsa) a partir de los datos del formulario. No guarda nada: el
// restaurante revisa, edita y guarda con el flujo normal de /api/bolsas.
//
// Se monta en server.js ANTES del express.json global (15 MB): este router
// lee el body con su propio límite de 8 KB.
const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const textoIA = require('../services/text-ai');
const { crearLimites } = require('../services/text-ai/limites');

const MENSAJE_FALLO = 'No pudimos mejorar la descripción. Intenta nuevamente.';
const LIMITE_BODY = '8kb';

// Categoría del negocio del propio restaurante (dato público del perfil). Si
// la consulta falla se omite: no es imprescindible para redactar.
async function categoriaDelNegocio(usuarioId) {
  try {
    const { data } = await supabase.from('negocios').select('categoria')
      .eq('propietario_id', usuarioId).limit(1).maybeSingle();
    return data?.categoria || null;
  } catch {
    return null;
  }
}

function crearRouterIA({
  generar = textoIA.generarDescripcion,
  limites = crearLimites(),
  buscarCategoria = categoriaDelNegocio,
} = {}) {
  const router = express.Router();
  router.use(express.json({ limit: LIMITE_BODY }));

  router.post('/descripcion', authMiddleware, async (req, res) => {
    const usuario = req.usuario;
    if (usuario?.rol !== 'restaurante') {
      return res.status(403).json({ error: 'Solo los restaurantes pueden usar esta función' });
    }

    const intento = limites.permitirIntento(usuario.id);
    if (!intento.ok) {
      res.set('Retry-After', String(intento.reintentarEnS));
      return res.status(429).json({ error: `Demasiadas solicitudes. Espera ${intento.reintentarEnS} s e intenta de nuevo.` });
    }

    const { datos, error } = textoIA.validarEntrada(req.body);
    if (error) return res.status(400).json({ error });

    const cupo = limites.consumirDiario(usuario.id);
    if (!cupo.ok) {
      console.warn('[TEXTO_IA] límite %s alcanzado', cupo.motivo === 'global' ? 'global diario' : 'diario por usuario');
      return res.status(429).json({ error: 'Alcanzaste el límite diario de descripciones con IA. Intenta mañana.' });
    }

    try {
      const categoriaNegocio = await buscarCategoria(usuario.id);
      const { descripcion, meta } = await generar(datos, { categoriaNegocio });
      // Sin datos del formulario ni de la propuesta en el log.
      console.log('[TEXTO_IA] ok proveedor=%s modelo=%s ms=%d tokens=%s/%s chars=%d',
        meta.proveedor, meta.modelo, meta.ms, meta.uso?.entrada ?? '-', meta.uso?.salida ?? '-', descripcion.length);
      return res.json({ descripcion });
    } catch (err) {
      const codigo = err?.codigo || 'interno';
      console.warn('[TEXTO_IA] fallo codigo=%s %s', codigo, err?.name === 'ErrorTextoIA' ? err.message : (err?.message || ''));
      if (codigo === 'no_configurado') {
        return res.status(503).json({ error: 'La mejora de descripción con IA no está disponible por ahora.' });
      }
      return res.status(codigo === 'timeout' ? 504 : 502).json({ error: MENSAJE_FALLO });
    }
  });

  // Body demasiado grande o JSON inválido → respuesta JSON propia.
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    return next(err);
  });

  return router;
}

module.exports = crearRouterIA();
module.exports.crearRouterIA = crearRouterIA;
module.exports.MENSAJE_FALLO = MENSAJE_FALLO;
