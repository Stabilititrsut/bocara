const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const router = express.Router();

// POST /api/uploads/signed-url
// Body: { path: 'negocios/uuid/logo.jpg' }
// Returns signed upload URL + public URL so client uploads directly to Supabase Storage
router.post('/signed-url', authMiddleware, async (req, res) => {
  const { path } = req.body;
  if (!path) return res.status(400).json({ error: 'path requerido' });

  // Solo restaurantes y admins pueden subir imágenes
  if (req.usuario.rol !== 'restaurante' && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'No autorizado' });

  try {
    const { data, error } = await supabase.storage
      .from('bocara-images')
      .createSignedUploadUrl(path);

    if (error) return res.status(500).json({ error: error.message });

    const { data: urlData } = supabase.storage
      .from('bocara-images')
      .getPublicUrl(path);

    res.json({
      signedUrl: data.signedUrl,
      token: data.token,
      path,
      publicUrl: urlData.publicUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
