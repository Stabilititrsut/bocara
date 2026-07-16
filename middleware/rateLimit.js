const rateLimit = require('express-rate-limit');

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
  });
}

// Creación de cuentas (registro cliente/restaurante) — evita registros masivos por bots
const registroLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'Demasiados intentos de registro desde este dispositivo. Intenta de nuevo en unos minutos.',
});

// Login — mitiga fuerza bruta / credential stuffing
const loginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.',
});

// Envío de códigos OTP por email/SMS — cuestan dinero (SMS) y son blanco de abuso/spam
const otpSendLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiadas solicitudes de código. Espera unos minutos antes de intentar de nuevo.',
});

// Verificación de códigos OTP — evita fuerza bruta sobre códigos de 6 dígitos
const otpVerifyLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos. Espera unos minutos antes de intentar de nuevo.',
});

// Endpoints de setup de cuentas admin/demo — uso muy poco frecuente, máxima restricción
const setupLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos. Intenta de nuevo más tarde.',
});

// Verificación de disponibilidad de correo — se llama durante el flujo normal de registro
const checkEmailLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Demasiadas solicitudes. Espera unos minutos antes de intentar de nuevo.',
});

module.exports = {
  registroLimiter,
  loginLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  setupLimiter,
  checkEmailLimiter,
};
