const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic']);

function isSafePath(path) {
  if (typeof path !== 'string' || path.length < 5 || path.length > 240) return false;
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false;
  if (!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(path)) return false;
  const ext = path.split('.').pop().toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

async function canWritePath(usuario, path) {
  if (usuario.rol === 'admin') return true;
  const { data: negocio } = await supabase
    .from('negocios').select('id').eq('propietario_id', usuario.id).maybeSingle();
  if (!negocio?.id) return false;
  const id = String(negocio.id);
  return path.startsWith(`bolsas/${id}_`) ||
    path.startsWith(`dpi/${id}_`) ||
    path.startsWith(`negocios/${id}_`) ||
    path.startsWith(`negocios/${id}/`);
}

// POST /api/uploads/signed-url
// Body: { path: 'negocios/uuid/logo.jpg' }
// Returns signed upload URL + public URL so client uploads directly to Supabase Storage
router.post('/signed-url', authMiddleware, (_req, res) => {
  res.status(410).json({ error: 'Carga directa retirada. Usa la carga de imágenes validada.' });
});

// POST /api/uploads/base64
// Body: { base64: string, path: string, contentType?: string }
// Uploads image from base64 directly to Supabase Storage — works on native + web
router.post('/base64', authMiddleware, async (req, res) => {
  const { base64, path, contentType } = req.body;
  if (!base64 || !path) return res.status(400).json({ error: 'base64 y path son requeridos' });
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  const normalizedType = String(contentType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(normalizedType))
    return res.status(415).json({ error: 'Formato de imagen no permitido' });
  if (!isSafePath(path))
    return res.status(400).json({ error: 'Ruta de imagen inválida' });

  try {
    if (!(await canWritePath(req.usuario, path)))
      return res.status(403).json({ error: 'No puedes subir archivos en esa ubicación' });

    const cleanBase64 = String(base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!cleanBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64))
      return res.status(400).json({ error: 'Imagen base64 inválida' });
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES)
      return res.status(413).json({ error: 'La imagen debe pesar como máximo 5 MB' });

    const { error } = await supabase.storage
      .from('bocara-images')
      .upload(path, buffer, { contentType: normalizedType, upsert: false });

    if (error?.statusCode === '409' || /already exists/i.test(error?.message || ''))
      return res.status(409).json({ error: 'Ya existe una imagen con ese nombre. Intenta nuevamente.' });
    if (error) return res.status(500).json({ error: error.message });

    const { data: urlData } = supabase.storage
      .from('bocara-images')
      .getPublicUrl(path);

    res.json({ publicUrl: urlData.publicUrl, path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
