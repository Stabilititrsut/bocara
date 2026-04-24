// ═══════════════════════════════════════════════
//  BOCARA - Servidor principal (server.js)
//  Lo que hace este archivo:
//  - Arranca el servidor Express
//  - Conecta todas las rutas de la API
//  - Configura seguridad y middlewares
// ═══════════════════════════════════════════════
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares de seguridad ─────────────────
app.use(helmet());
app.use(cors({ origin: "*" })); // En producción, limitar al dominio de tu app
app.use(morgan("dev"));

// IMPORTANTE: El webhook de Stripe necesita el body RAW (sin parsear)
app.use("/api/pagos/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Rutas de la API ──────────────────────────
app.use("/api/auth",          require("./routes/auth"));
app.use("/api/negocios",      require("./routes/negocios"));
app.use("/api/bolsas",        require("./routes/bolsas"));
app.use("/api/pedidos",       require("./routes/pedidos"));
app.use("/api/pagos",         require("./routes/pagos"));
app.use("/api/envios",        require("./routes/envios"));
app.use("/api/notificaciones",require("./routes/notificaciones"));
app.use("/api/resenas",       require("./routes/resenas"));

// ── Ruta de salud ────────────────────────────
app.get("/", (req, res) => {
  res.json({ 
    status: "✅ Bocara API funcionando",
    version: "1.0.0",
    ambiente: process.env.NODE_ENV 
  });
});

// ── Manejo de errores global ─────────────────
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.message);
  res.status(err.status || 500).json({ 
    error: err.message || "Error interno del servidor" 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Bocara API corriendo en puerto ${PORT}`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV}`);
});

module.exports = app;
