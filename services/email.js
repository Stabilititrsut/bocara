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

function templateRechazado(nombreNegocio, nombrePropietario, motivo) {
  const motivoHtml = motivo
    ? `<div style="background:#FEF3C7;border-radius:10px;padding:14px;margin:16px 0"><b>Motivo:</b><br>${motivo}</div>`
    : '';
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#EF4444;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
  <h1 style="color:white;margin:0">❌ Solicitud rechazada</h1>
</div>
<p>Hola <b>${nombrePropietario}</b>,</p>
<p>Lamentablemente, la solicitud para registrar <b>${nombreNegocio}</b> en Bocara Food no fue aprobada.</p>
${motivoHtml}
<p>Puedes corregir la información y volver a intentarlo desde la app, o contactarnos si crees que es un error.</p>
<p style="color:#64748B;font-size:13px">Equipo Bocara Food</p>
</body></html>`;
}

module.exports = { enviarEmail, templateAprobado, templateRechazado };
