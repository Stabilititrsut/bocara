const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transporter;
}

async function enviarEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email] EMAIL_USER/EMAIL_PASS no configuradas — omitiendo email a: ${to}`);
    return { ok: false };
  }
  try {
    await t.sendMail({
      from: `"Bocara Food" <${process.env.EMAIL_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
    });
    return { ok: true };
  } catch (e) {
    console.error('[email] Error al enviar:', e.message);
    return { ok: false };
  }
}

function templateAprobado(nombreNegocio, nombrePropietario) {
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#22C55E;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
  <h1 style="color:white;margin:0">🎉 ¡Negocio aprobado!</h1>
</div>
<p>Hola <b>${nombrePropietario}</b>,</p>
<p>Tu negocio <b>${nombreNegocio}</b> ha sido aprobado y ya está activo en <b>Bocara Food</b>.</p>
<p>Ya puedes iniciar sesión en tu panel y publicar tus primeras ofertas.</p>
<div style="text-align:center;margin:28px 0">
  <a href="https://bocara.vercel.app" style="background:#C8A97E;color:white;padding:14px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:16px">
    Ir a mi panel →
  </a>
</div>
<p style="color:#64748B;font-size:13px">Si tienes preguntas contáctanos respondiendo este correo.</p>
</body></html>`;
}

const CAMPO_LABELS = {
  nombre_negocio: 'Nombre del negocio',
  direccion: 'Dirección',
  telefono: 'Teléfono',
  nit: 'NIT',
  dpi_foto_url: 'Foto del DPI',
  datos_bancarios: 'Datos bancarios',
  imagen_url: 'Foto del negocio',
};

function templateRechazado(nombreNegocio, nombrePropietario, motivo, campos = []) {
  const motivoHtml = motivo
    ? `<div style="background:#FEF3C7;border-radius:10px;padding:14px;margin:16px 0"><b>Motivo:</b><br>${motivo}</div>`
    : '';
  const camposFiltrados = (campos || []).filter(c => c !== 'otro' && CAMPO_LABELS[c]);
  const camposHtml = camposFiltrados.length > 0
    ? `<div style="background:#FEE2E2;border-radius:10px;padding:14px;margin:16px 0">
  <b style="color:#991B1B">Campos que necesitan corrección:</b>
  <ul style="margin:8px 0 0 0;padding-left:20px;color:#7F1D1D">
    ${camposFiltrados.map(c => `<li style="margin:4px 0">${CAMPO_LABELS[c]}</li>`).join('')}
  </ul>
</div>`
    : '';
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#EF4444;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
  <h1 style="color:white;margin:0">❌ Solicitud rechazada</h1>
</div>
<p>Hola <b>${nombrePropietario}</b>,</p>
<p>Lamentablemente, la solicitud para registrar <b>${nombreNegocio}</b> en Bocara Food no fue aprobada.</p>
${camposHtml}
${motivoHtml}
<p>Puedes corregir la información y volver a intentarlo desde la app, o contactarnos si crees que es un error.</p>
<p style="color:#64748B;font-size:13px">Equipo Bocara Food</p>
</body></html>`;
}

function templateOlvidoContrasena(nombre, codigo) {
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#C8A97E;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
  <h1 style="color:white;margin:0">🔑 Restablecer contraseña</h1>
</div>
<p>Hola <b>${nombre}</b>,</p>
<p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en <b>Bocara Food</b>.</p>
<p>Usa el siguiente código en la app. Expira en <b>15 minutos</b>.</p>
<div style="text-align:center;margin:28px 0">
  <div style="display:inline-block;background:#F3F4F6;border:2px solid #E5E7EB;border-radius:16px;padding:20px 40px">
    <span style="font-size:40px;font-weight:900;letter-spacing:10px;color:#1A1A1A">${codigo}</span>
  </div>
</div>
<p style="color:#64748B;font-size:13px">Si no solicitaste este cambio, ignora este correo. Tu contraseña no cambiará.</p>
<p style="color:#64748B;font-size:13px">Equipo Bocara Food</p>
</body></html>`;
}

module.exports = { enviarEmail, templateAprobado, templateRechazado, templateOlvidoContrasena };
