const https = require('https');

/**
 * Envía email vía Resend API si RESEND_API_KEY está configurada.
 * Falla silenciosamente si no hay API key.
 */
async function enviarEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Bocara Food <noreply@bocarafood.com>';

  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY no configurada — omitiendo email a: ${to}`);
    return { ok: false };
  }

  try {
    const body = JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    return await new Promise((resolve) => {
      const options = {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ ok: res.statusCode < 400, response: JSON.parse(data) }); }
          catch { resolve({ ok: res.statusCode < 400 }); }
        });
      });
      req.on('error', (e) => {
        console.error('[email] Error HTTP:', e.message);
        resolve({ ok: false });
      });
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error('[email] Error:', e.message);
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
<p style="color:#64748B;font-size:13px">Si tienes preguntas, responde este correo o contáctanos.</p>
</body></html>`;
}

function templateRechazado(nombreNegocio, nombrePropietario, motivo) {
  const motivoHtml = motivo
    ? `<div style="background:#FEF3C7;border-radius:10px;padding:14px;margin:16px 0">
         <b>Motivo del rechazo:</b><br>${motivo}
       </div>`
    : '';
  return `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#EF4444;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
  <h1 style="color:white;margin:0">❌ Solicitud rechazada</h1>
</div>
<p>Hola <b>${nombrePropietario}</b>,</p>
<p>Lamentablemente, la solicitud para registrar <b>${nombreNegocio}</b> en Bocara Food no fue aprobada en esta ocasión.</p>
${motivoHtml}
<p>Puedes corregir la información y volver a enviar tu solicitud desde la app, o contactarnos si crees que es un error.</p>
<p style="color:#64748B;font-size:13px">Equipo Bocara Food</p>
</body></html>`;
}

module.exports = { enviarEmail, templateAprobado, templateRechazado };
