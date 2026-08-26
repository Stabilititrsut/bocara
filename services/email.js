const axios = require('axios');

// Diagnóstico de vars de entorno al cargar el módulo
console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'configurada' : 'FALTA');

// Render bloquea/degrada las conexiones SMTP salientes (medido en producción:
// ~7 de cada 8 envíos por Gmail SMTP fallaban con "Connection timeout" tras
// colgarse los 120s del connectionTimeout default de Nodemailer — muy por
// encima de cualquier timeout razonable del frontend). Resend usa su API HTTP
// en vez de SMTP, así que ese bloqueo no lo afecta.
const RESEND_FROM = 'Bocara Food <no-reply@bocarafood.com>';
const RESEND_TIMEOUT_MS = 10000;
const RESEND_MAX_INTENTOS = 3;

const resendClient = axios.create({
  baseURL: 'https://api.resend.com',
  timeout: RESEND_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Solo vale la pena reintentar fallos transitorios (timeout, red caída, 5xx de
// Resend). Un 4xx (API key inválida, dominio no verificado, payload mal
// formado) va a fallar igual las veces que se reintente.
function esTransitorio(err) {
  if (!err.response) return true;
  return err.response.status >= 500;
}

async function enviarEmail({ to, subject, html }) {
  const dest = Array.isArray(to) ? to.join(', ') : to;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`[email] ⚠️  RESEND_API_KEY no configurada — email NO enviado a: ${dest} | asunto: "${subject}"`);
    return { ok: false };
  }

  console.log(`[email] → Enviando a: ${dest} | asunto: "${subject}"`);
  const toArr = Array.isArray(to) ? to : [to];

  for (let intento = 1; intento <= RESEND_MAX_INTENTOS; intento++) {
    try {
      await resendClient.post('/emails', { from: RESEND_FROM, to: toArr, subject, html });
      console.log(`[email] ✓ Email enviado correctamente a: ${dest} (Resend, intento ${intento}/${RESEND_MAX_INTENTOS})`);
      return { ok: true };
    } catch (e) {
      const detalle = e.response?.data?.message || e.message;
      const transitorio = esTransitorio(e);
      console.error(`[email] ✗ Error al enviar a ${dest} (intento ${intento}/${RESEND_MAX_INTENTOS}): ${detalle}`);
      if (!transitorio || intento === RESEND_MAX_INTENTOS) return { ok: false };
      await esperar(500 * intento);
    }
  }
  return { ok: false };
}

// ─── Respaldo: envío por Gmail SMTP (Nodemailer) ───────────────────────────
// Desactivado porque Render bloquea/degrada las conexiones SMTP salientes
// (ver nota arriba). Si algún día hace falta volver a este camino: instalar
// `nodemailer` (sigue en package.json), descomentar este bloque, comentar el
// enviarEmail() de arriba, y configurar EMAIL_USER/EMAIL_PASS en Render
// (Contraseña de Aplicación de Google — ver .env.example).
//
// const nodemailer = require('nodemailer');
// let transporter = null;
// function getTransporter() {
//   if (transporter) return transporter;
//   const user = process.env.EMAIL_USER;
//   const pass = process.env.EMAIL_PASS;
//   if (!user || !pass) return null;
//   transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: { user, pass },
//   });
//   return transporter;
// }
// async function enviarEmailGmailSMTP({ to, subject, html }) {
//   const t = getTransporter();
//   const dest = Array.isArray(to) ? to.join(', ') : to;
//   if (!t) {
//     console.warn(`[email] ⚠️  EMAIL_USER/EMAIL_PASS no configuradas en .env — email NO enviado a: ${dest} | asunto: "${subject}"`);
//     return { ok: false };
//   }
//   try {
//     console.log(`[email] → Enviando a: ${dest} | asunto: "${subject}"`);
//     await t.sendMail({
//       from: `"Bocara Food" <${process.env.EMAIL_USER}>`,
//       to: dest,
//       subject,
//       html,
//     });
//     console.log(`[email] ✓ Email enviado correctamente a: ${dest}`);
//     return { ok: true };
//   } catch (e) {
//     console.error(`[email] ✗ Error al enviar a ${dest}:`, e.message);
//     return { ok: false };
//   }
// }

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
  <a href="https://bocarafood.com" style="background:#C8A97E;color:white;padding:14px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:16px">
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
            <a href="https://bocarafood.com" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ir a mi panel →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com<br>
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
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com<br>
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
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function templateRehabilitadoUsuario(nombreUsuario, emailUsuario) {
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
            <div style="display:inline-block;background:#DCFCE7;border-radius:50%;width:72px;height:72px;line-height:72px;font-size:36px">✅</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A">Tu cuenta ha sido reactivada</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:24px">
              Hola, <strong style="color:#1A1A1A">${nombreUsuario}</strong>. Tu cuenta asociada a
              <strong style="color:#1A1A1A">${emailUsuario}</strong> ha sido <strong style="color:#22C55E">reactivada</strong> en Bocara Food.
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
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;border-radius:16px;border-left:4px solid #22C55E">
              <tr><td style="padding:18px 22px">
                <div style="font-size:13px;font-weight:700;color:#15803D;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">¿Qué significa esto?</div>
                <div style="font-size:14px;color:#1A1A1A;line-height:22px">
                  Ya puedes iniciar sesión normalmente en la app y acceder a todas las funciones de Bocara Food.
                </div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://bocarafood.com" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ir a la app →
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:22px 40px;text-align:center">
            <div style="font-size:12px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Confirmación de pedido (cliente) ──────────────────────────────────────
// Único respaldo escrito de la compra: Bocara es solo recogida en local con
// código, y hoy todo el ciclo del pedido depende del push. Si el push falla,
// este correo es lo único que prueba la compra frente al restaurante.
function formatQ(n) {
  return `Q${(Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2)}`;
}

function formatHorario(inicio, fin) {
  if (inicio && fin) return `${inicio} – ${fin}`;
  if (inicio) return `A partir de las ${inicio}`;
  return 'Consulta el horario con el restaurante';
}

function filaItemsHtml(items) {
  if (!items || items.length === 0) return '';
  return items.map(it => `
    <tr>
      <td style="padding:8px 0;font-size:14px;color:#1A1A1A">${it.cantidad} × ${it.nombre}</td>
      <td style="padding:8px 0;font-size:14px;color:#1A1A1A;text-align:right">${formatQ(it.subtotal)}</td>
    </tr>`).join('');
}

function filaMontoHtml(label, valor, opts = {}) {
  if (!valor) return '';
  const color = opts.negativo ? '#22C55E' : '#64748B';
  const signo = opts.negativo ? '-' : '';
  return `
    <tr>
      <td style="padding:4px 0;font-size:13px;color:${color}">${label}</td>
      <td style="padding:4px 0;font-size:13px;color:${color};text-align:right">${signo}${formatQ(valor)}</td>
    </tr>`;
}

function templateConfirmacionPedidoCliente({ nombreCliente, codigoRecogida, nombreNegocio, direccionNegocio, horarioRecogida, items, subtotal, costoEnvio, propina, descuentoCupon, total }) {
  const itemsHtml = filaItemsHtml(items);
  const desgloseHtml = `
    ${filaMontoHtml('Subtotal', subtotal)}
    ${filaMontoHtml('Envío', costoEnvio)}
    ${filaMontoHtml('Propina', propina)}
    ${filaMontoHtml('Descuento cupón', descuentoCupon, { negativo: true })}`;

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
            <div style="display:inline-block;background:#F5F0EB;border-radius:50%;width:80px;height:80px;line-height:80px;font-size:40px;margin-bottom:8px">🎉</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px">¡Tu pedido está confirmado!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:23px">
              Hola, <strong style="color:#1A1A1A">${nombreCliente}</strong>. Tu pago en
              <strong style="color:#C8A97E">${nombreNegocio}</strong> fue confirmado. Guarda este correo — es tu comprobante de compra.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 28px;text-align:center">
            <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Tu código de recogida</div>
            <div style="display:inline-block;background:#FFFBEB;border:2.5px solid #C8A97E;border-radius:20px;padding:18px 44px">
              <span style="font-size:38px;font-weight:900;letter-spacing:8px;color:#C8A97E;font-family:monospace">${codigoRecogida}</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 40px 0">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr><td style="padding:20px 24px">
                <div style="font-size:13px;font-weight:700;color:#C8A97E;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">📍 Recoge en</div>
                <div style="font-size:17px;font-weight:800;color:#1A1A1A;margin-bottom:4px">${nombreNegocio}</div>
                <div style="font-size:14px;color:#64748B;line-height:20px;margin-bottom:10px">${direccionNegocio || 'Dirección no disponible'}</div>
                <div style="font-size:13px;font-weight:700;color:#1A1A1A">🕐 ${horarioRecogida}</div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 40px 32px">
            <div style="font-size:13px;font-weight:700;color:#1A1A1A;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🧾 Desglose de tu pedido</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #F0EBE5">
              <tr><td colspan="2" style="height:8px"></td></tr>
              ${itemsHtml}
              <tr><td colspan="2" style="padding-top:8px;border-top:1px solid #F0EBE5"></td></tr>
              ${desgloseHtml}
              <tr>
                <td style="padding:12px 0 0;font-size:16px;font-weight:900;color:#1A1A1A;border-top:2px solid #1A1A1A">Total pagado</td>
                <td style="padding:12px 0 0;font-size:16px;font-weight:900;color:#1A1A1A;text-align:right;border-top:2px solid #1A1A1A">${formatQ(total)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://bocarafood.com" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ver mi pedido →
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com<br>
              Presenta este código en el restaurante para recoger tu pedido.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Nuevo pedido (restaurante) ─────────────────────────────────────────────
function templateNuevoPedidoNegocio({ nombrePropietario, nombreNegocio, codigoRecogida, nombreCliente, horarioRecogida, items, montoNetoRestaurante, total }) {
  const itemsHtml = filaItemsHtml(items);

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
            <div style="font-size:13px;color:rgba(200,169,126,0.7);letter-spacing:2px;text-transform:uppercase;margin-top:6px">Panel para Restaurantes</div>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 0;text-align:center">
            <div style="display:inline-block;background:#F5F0EB;border-radius:50%;width:80px;height:80px;line-height:80px;font-size:40px;margin-bottom:8px">🛍️</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px">¡Tienes un nuevo pedido!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:23px">
              Hola, <strong style="color:#1A1A1A">${nombrePropietario}</strong>. <strong style="color:#C8A97E">${nombreNegocio}</strong> recibió un pedido nuevo, ya pagado.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 28px;text-align:center">
            <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Código de recogida del cliente</div>
            <div style="display:inline-block;background:#FFFBEB;border:2.5px solid #C8A97E;border-radius:20px;padding:18px 44px">
              <span style="font-size:38px;font-weight:900;letter-spacing:8px;color:#C8A97E;font-family:monospace">${codigoRecogida}</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 40px 0">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0EB;border-radius:16px;border-left:4px solid #C8A97E">
              <tr><td style="padding:20px 24px">
                <div style="font-size:13px;font-weight:700;color:#C8A97E;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Cliente</div>
                <div style="font-size:16px;font-weight:800;color:#1A1A1A;margin-bottom:10px">${nombreCliente}</div>
                <div style="font-size:13px;font-weight:700;color:#1A1A1A">🕐 Recoge: ${horarioRecogida}</div>
              </td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 40px 12px">
            <div style="font-size:13px;font-weight:700;color:#1A1A1A;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🧾 Productos del pedido</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #F0EBE5">
              <tr><td colspan="2" style="height:8px"></td></tr>
              ${itemsHtml}
              <tr>
                <td style="padding:12px 0 0;font-size:15px;font-weight:900;color:#1A1A1A;border-top:2px solid #1A1A1A">Total del pedido</td>
                <td style="padding:12px 0 0;font-size:15px;font-weight:900;color:#1A1A1A;text-align:right;border-top:2px solid #1A1A1A">${formatQ(total)}</td>
              </tr>
              <tr>
                <td style="padding:4px 0 0;font-size:13px;color:#22C55E">Lo que recibirás</td>
                <td style="padding:4px 0 0;font-size:13px;color:#22C55E;text-align:right">${formatQ(montoNetoRestaurante)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 40px 36px;text-align:center">
            <a href="https://bocarafood.com" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ver en mi panel →
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com<br>
              El cliente recogerá su pedido con el código mostrado arriba.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Liquidación pagada (restaurante) ───────────────────────────────────────
// Único respaldo escrito del pago si el restaurante no tiene push configurado
// (frecuente en negocios nuevos que nunca abrieron la app en un celular) —
// sin esto, el pago solo queda como un aviso silencioso dentro de la app.
function templateLiquidacionPagada({ nombrePropietario, nombreNegocio, monto, ventasBrutas, comisionBocara, cargoPlataforma, propinas, totalPedidos, referencia, banco }) {
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
            <div style="font-size:13px;color:rgba(200,169,126,0.7);letter-spacing:2px;text-transform:uppercase;margin-top:6px">Panel para Restaurantes</div>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 0;text-align:center">
            <div style="display:inline-block;background:#F0FDF4;border-radius:50%;width:80px;height:80px;line-height:80px;font-size:40px;margin-bottom:8px">💸</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 8px;text-align:center">
            <h1 style="margin:0;font-size:26px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px">¡Recibiste un pago!</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 28px;text-align:center">
            <p style="margin:0;font-size:15px;color:#64748B;line-height:23px">
              Hola, <strong style="color:#1A1A1A">${nombrePropietario}</strong>. Bocara transfirió el pago de
              <strong style="color:#C8A97E">${nombreNegocio}</strong> por ${totalPedidos} pedido${totalPedidos !== 1 ? 's' : ''} completado${totalPedidos !== 1 ? 's' : ''}.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 28px;text-align:center">
            <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Monto transferido</div>
            <div style="display:inline-block;background:#F0FDF4;border:2.5px solid #22C55E;border-radius:20px;padding:18px 44px">
              <span style="font-size:38px;font-weight:900;color:#16A34A;font-family:monospace">${formatQ(monto)}</span>
            </div>
            ${banco ? `<div style="margin-top:10px;font-size:13px;color:#64748B">${banco}</div>` : ''}
            ${referencia ? `<div style="font-size:12px;color:#94A3B8">Referencia: ${referencia}</div>` : ''}
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px">
            <div style="height:2px;background:linear-gradient(90deg,transparent,#C8A97E,transparent)"></div>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 40px 32px">
            <div style="font-size:13px;font-weight:700;color:#1A1A1A;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">🧾 Desglose del pago</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #F0EBE5">
              <tr><td colspan="2" style="height:8px"></td></tr>
              <tr>
                <td style="padding:8px 0;font-size:14px;color:#1A1A1A">Ventas brutas (producto)</td>
                <td style="padding:8px 0;font-size:14px;color:#1A1A1A;text-align:right">${formatQ(ventasBrutas)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748B">− Comisión Bocara</td>
                <td style="padding:8px 0;font-size:13px;color:#64748B;text-align:right">-${formatQ(comisionBocara)}</td>
              </tr>
              ${cargoPlataforma ? `<tr>
                <td style="padding:8px 0;font-size:12px;color:#94A3B8">Cargo de plataforma (no afecta este pago)</td>
                <td style="padding:8px 0;font-size:12px;color:#94A3B8;text-align:right">${formatQ(cargoPlataforma)}</td>
              </tr>` : ''}
              ${propinas ? `<tr>
                <td style="padding:8px 0;font-size:14px;color:#22C55E">+ Propinas (100% restaurante)</td>
                <td style="padding:8px 0;font-size:14px;color:#22C55E;text-align:right">${formatQ(propinas)}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:12px 0 0;font-size:16px;font-weight:900;color:#1A1A1A;border-top:2px solid #1A1A1A">Total transferido</td>
                <td style="padding:12px 0 0;font-size:16px;font-weight:900;color:#16A34A;text-align:right;border-top:2px solid #1A1A1A">${formatQ(monto)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px 36px;text-align:center">
            <a href="https://bocarafood.com" style="display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-weight:800;font-size:15px;padding:16px 36px;border-radius:50px;letter-spacing:0.3px">
              Ver mis liquidaciones →
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#1A1A1A;padding:24px 40px;text-align:center">
            <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:20px">
              <strong style="color:#C8A97E">Equipo Bocara Food</strong> &nbsp;|&nbsp; bocarafood.com<br>
              Si el monto no coincide con tu cuenta bancaria, respóndenos este correo.
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { enviarEmail, templateAprobado, templateRechazado, templateOlvidoContrasena, templateBienvenidaRestaurante, templateSuspendido, templateVerificacionOTP, templateSuspendidoUsuario, templateRehabilitadoUsuario, templateConfirmacionPedidoCliente, templateNuevoPedidoNegocio, templateLiquidacionPagada };
