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
  const dest = Array.isArray(to) ? to.join(', ') : to;
  if (!t) {
    console.warn(`[email] ⚠️  EMAIL_USER/EMAIL_PASS no configuradas en .env — email NO enviado a: ${dest} | asunto: "${subject}"`);
    return { ok: false };
  }
  try {
    console.log(`[email] → Enviando a: ${dest} | asunto: "${subject}"`);
    await t.sendMail({
      from: `"Bocara Food" <${process.env.EMAIL_USER}>`,
      to: dest,
      subject,
      html,
    });
    console.log(`[email] ✓ Email enviado correctamente a: ${dest}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email] ✗ Error al enviar a ${dest}:`, e.message);
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

function templateBienvenidaRestaurante(nombrePropietario, nombreNegocio) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0EB;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <!-- Header negro con logo -->
        <tr>
          <td style="background:#1A1A1A;padding:36px 40px;text-align:center">
            <div style="font-size:32px;font-weight:900;letter-spacing:-1px;color:#C8A97E;margin-bottom:4px">
              Bocara <span style="color:#FFFFFF">Food</span>
            </div>
            <div style="font-size:13px;color:rgba(200,169,126,0.7);letter-spacing:2px;text-transform:uppercase;margin-top:6px">
              Panel para Restaurantes
            </div>
          </td>
        </tr>

        <!-- Ícono de confirmación -->
        <tr>
          <td style="padding:40px 40px 0;text-align:center">
            <div style="display:inline-block;background:#F5F0EB;border-radius:50%;width:80px;height:80px;line-height:80px;font-size:40px;margin-bottom:8px">
              ✅
            </div>
          </td>
        </tr>

        <!-- Título principal -->
        <tr>
          <td style="padding:16px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:28px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px">
              ¡Recibimos tu solicitud!
            </h1>
          </td>
        </tr>

        <!-- Subtítulo -->
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:16px;color:#64748B;line-height:24px">
              Hola, <strong style="color:#1A1A1A">${nombrePropietario}</strong>. Tu negocio
              <strong style="color:#C8A97E">${nombreNegocio}</strong> ha sido registrado y está siendo revisado por nuestro equipo.
            </p>
          </td>
        </tr>

        <!-- Separador dorado -->
        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>

        <!-- Bloque de tiempo de revisión -->
        <tr>
          <td style="padding:28px 40px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr>
                <td style="padding:20px 24px">
                  <div style="font-size:13px;font-weight:700;color:#C8A97E;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">
                    ⏳ Tiempo de revisión
                  </div>
                  <div style="font-size:22px;font-weight:900;color:#1A1A1A;margin-bottom:6px">
                    24 a 48 horas hábiles
                  </div>
                  <div style="font-size:14px;color:#64748B;line-height:20px">
                    Revisaremos tu información y documentos. Te notificaremos en cuanto tu negocio sea aprobado.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Pasos de proceso -->
        <tr>
          <td style="padding:0 40px 28px">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #F0EBE5">
                  <span style="color:#22C55E;font-weight:700;margin-right:10px">✅</span>
                  <span style="font-size:14px;color:#1A1A1A;font-weight:600">Solicitud recibida</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid #F0EBE5">
                  <span style="color:#C8A97E;font-weight:700;margin-right:10px">⏳</span>
                  <span style="font-size:14px;color:#1A1A1A;font-weight:600">Verificación de documentos (24–48h)</span>
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0">
                  <span style="color:#CBD5E1;font-weight:700;margin-right:10px">🔜</span>
                  <span style="font-size:14px;color:#94A3B8;font-weight:600">Activación y publicación</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA Button -->
        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://bocara.vercel.app" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ir a mi panel →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocara.vercel.app<br>
              Si tienes alguna duda, responde este correo y te ayudaremos.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function templateSuspendido(nombreNegocio, nombrePropietario, motivo) {
  const motivoHtml = motivo
    ? `<tr><td style="padding:0 40px 28px">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border-radius:16px;border-left:4px solid #D97706">
          <tr><td style="padding:18px 22px">
            <div style="font-size:12px;font-weight:700;color:#D97706;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Motivo de suspensión</div>
            <div style="font-size:15px;color:#1A1A1A;line-height:22px">${motivo}</div>
          </td></tr>
        </table>
      </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0EB;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <!-- Header negro con logo -->
        <tr>
          <td style="background:#1A1A1A;padding:36px 40px;text-align:center">
            <div style="font-size:32px;font-weight:900;letter-spacing:-1px;color:#C8A97E;margin-bottom:4px">
              Bocara <span style="color:#FFFFFF">Food</span>
            </div>
            <div style="font-size:13px;color:rgba(200,169,126,0.7);letter-spacing:2px;text-transform:uppercase;margin-top:6px">
              Panel para Restaurantes
            </div>
          </td>
        </tr>

        <!-- Ícono de advertencia -->
        <tr>
          <td style="padding:40px 40px 0;text-align:center">
            <div style="display:inline-block;background:#FEF3C7;border-radius:50%;width:80px;height:80px;line-height:80px;font-size:40px;margin-bottom:8px">
              ⚠️
            </div>
          </td>
        </tr>

        <!-- Título -->
        <tr>
          <td style="padding:16px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:28px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px">
              Cuenta suspendida
            </h1>
          </td>
        </tr>

        <!-- Mensaje -->
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:16px;color:#64748B;line-height:24px">
              Hola, <strong style="color:#1A1A1A">${nombrePropietario}</strong>. Tu negocio
              <strong style="color:#C8A97E">${nombreNegocio}</strong> ha sido suspendido temporalmente en Bocara Food.
            </p>
          </td>
        </tr>

        <!-- Separador dorado -->
        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>

        <!-- Espacio -->
        <tr><td style="height:28px"></td></tr>

        <!-- Motivo (si existe) -->
        ${motivoHtml}

        <!-- Instrucciones -->
        <tr>
          <td style="padding:0 40px 28px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr><td style="padding:20px 24px">
                <div style="font-size:13px;font-weight:700;color:#C8A97E;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">
                  ¿Cómo apelar esta decisión?
                </div>
                <div style="font-size:14px;color:#1A1A1A;line-height:22px">
                  Contáctanos directamente por WhatsApp al número <strong>+502 5107-7949</strong> o responde este correo para hablar con nuestro equipo.
                </div>
              </td></tr>
            </table>
          </td>
        </tr>

        <!-- CTA WhatsApp -->
        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://wa.me/50251077949?text=${encodeURIComponent(`Hola, quiero apelar la suspensión de mi negocio ${nombreNegocio} en Bocara Food.`)}"
               style="display:inline-block;background:#25D366;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Contactar por WhatsApp →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocara.vercel.app<br>
              Este mensaje fue enviado porque eres propietario de un negocio registrado en Bocara.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function templateVerificacionOTP(codigo) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <tr>
          <td style="background:#1A1A1A;padding:32px 40px;text-align:center">
            <div style="font-size:30px;font-weight:900;letter-spacing:-1px;color:#C8A97E;margin-bottom:2px">
              Bocara <span style="color:#FFFFFF">Food</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A">
              ¡Bienvenido a Bocara Food!
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 32px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:22px">
              Ingresa este código para verificar tu cuenta:
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 32px;text-align:center">
            <div style="display:inline-block;background:#FFFBEB;border:2.5px solid #C8A97E;border-radius:20px;padding:24px 52px">
              <span style="font-size:48px;font-weight:900;letter-spacing:10px;color:#C8A97E;font-family:monospace">${codigo}</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 32px;text-align:center">
            <p style="margin:0;font-size:13px;color:#64748B;background:#F1F5F9;border-radius:10px;padding:12px 20px;display:inline-block">
              ⏱ Este código expira en <strong>30 minutos</strong>
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:22px 40px;text-align:center">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.45);line-height:18px">
              Si no creaste esta cuenta, ignora este correo.<br>
              <strong style="color:#C8A97E">Equipo Bocara Food</strong>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function templateSuspendidoUsuario(nombreUsuario, emailUsuario, motivo) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0EB;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)">

        <tr>
          <td style="background:#1A1A1A;padding:36px 40px;text-align:center">
            <div style="font-size:32px;font-weight:900;letter-spacing:-1px;color:#C8A97E;margin-bottom:4px">
              Bocara <span style="color:#FFFFFF">Food</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 0;text-align:center">
            <div style="display:inline-block;background:#FEE2E2;border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px">🚫</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A">Tu cuenta ha sido suspendida</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:24px">
              La cuenta asociada a <strong style="color:#1A1A1A">${emailUsuario}</strong> ha sido suspendida en Bocara Food.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>
        <tr><td style="height:28px"></td></tr>

        <tr>
          <td style="padding:0 40px 28px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr><td style="padding:18px 22px">
                <div style="font-size:12px;font-weight:700;color:#D97706;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Motivo de suspensión</div>
                <div style="font-size:15px;color:#1A1A1A;line-height:22px">${motivo}</div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 28px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr><td style="padding:18px 22px">
                <div style="font-size:13px;font-weight:700;color:#C8A97E;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">¿Quieres apelar esta decisión?</div>
                <div style="font-size:14px;color:#1A1A1A;line-height:22px">
                  Contáctanos por WhatsApp al <strong>+502 5107-7949</strong> o responde este correo.
                </div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://wa.me/50251077949?text=${encodeURIComponent('Hola, quiero apelar la suspensión de mi cuenta en Bocara Food.')}"
               style="display:inline-block;background:#25D366;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:14px 32px;border-radius:50px">
              Contactar por WhatsApp →
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:22px 40px;text-align:center">
            <div style="font-size:12px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocara.vercel.app
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { enviarEmail, templateAprobado, templateRechazado, templateOlvidoContrasena, templateBienvenidaRestaurante, templateSuspendido, templateVerificacionOTP, templateSuspendidoUsuario };
