# 🚀 BOCARA - Guía completa de lanzamiento
# Lee esto de principio a fin antes de empezar. Tiempo estimado: 3-4 horas.

═══════════════════════════════════════════════════════
 PASO 1: SUPABASE (Base de datos) — GRATIS
 Tiempo: ~15 minutos
═══════════════════════════════════════════════════════

1. Ve a https://supabase.com y crea una cuenta
2. Clic en "New project"
   - Nombre: bocara
   - Contraseña: genera una segura y GUÁRDALA
   - Región: elige la más cercana (US East o similar)
3. Espera ~2 minutos que se cree el proyecto
4. Ve a: Settings → API
   - Copia "Project URL" → es tu SUPABASE_URL
   - Copia "service_role" key → es tu SUPABASE_SERVICE_KEY
5. Ve a: SQL Editor → New query
   - Pega TODO el contenido de backend/database.sql
   - Clic "Run" → verás "Success"
✅ Listo, ya tienes tu base de datos.


═══════════════════════════════════════════════════════
 PASO 2: STRIPE (Pagos) — GRATIS hasta que proceses pagos
 Tiempo: ~20 minutos
═══════════════════════════════════════════════════════

1. Ve a https://dashboard.stripe.com y crea una cuenta
2. En el dashboard, asegúrate de estar en modo PRUEBA (toggle arriba a la derecha)
3. Ve a: Developers → API Keys
   - "Publishable key" (pk_test_...) → va en la app móvil (App.js)
   - "Secret key" (sk_test_...) → va en backend/.env como STRIPE_SECRET_KEY
4. Configurar Webhook (para recibir confirmación de pagos):
   - Ve a: Developers → Webhooks → Add endpoint
   - URL: https://TU-DOMINIO.com/api/pagos/webhook
     (durante desarrollo usa: npx stripe listen --forward-to localhost:3000/api/pagos/webhook)
   - Selecciona eventos: payment_intent.succeeded, payment_intent.payment_failed
   - Copia el "Signing secret" (whsec_...) → STRIPE_WEBHOOK_SECRET
5. Para activar pagos reales (cuando lances):
   - Ve a: Settings → Business → Complete your profile
   - Agrega tu información de Guatemala
   - Stripe requiere verificación de identidad (~2-3 días)
💰 Costo: Stripe cobra 2.9% + $0.30 por transacción exitosa.
    Bocara cobra 15% de comisión (configurable en BOCARA_COMMISSION_PERCENT)


═══════════════════════════════════════════════════════
 PASO 3: BACKEND en Railway — ~$5/mes
 Tiempo: ~20 minutos
═══════════════════════════════════════════════════════

1. Ve a https://railway.app y crea cuenta con GitHub
2. "New Project" → "Deploy from GitHub repo"
   - Sube el código del backend a un repo de GitHub primero
3. En Railway, ve a tu proyecto → Variables:
   Agrega TODAS las variables de backend/.env.example con tus valores reales
4. Railway detecta automáticamente que es Node.js y hace el deploy
5. Ve a Settings → Domains → Generate Domain
   - Obtienes algo como: bocara-backend-production.up.railway.app
   - ESA es tu URL de producción
6. En la app móvil (src/services/api.js), cambia:
   const BASE_URL = "https://bocara-backend-production.up.railway.app";
✅ Tu API ya está en internet.


═══════════════════════════════════════════════════════
 PASO 4: EXPO / APP MÓVIL — GRATIS para empezar
 Tiempo: ~30 minutos (primera vez)
═══════════════════════════════════════════════════════

Prerrequisitos en tu computadora:
  - Node.js (descargar en nodejs.org)
  - Expo CLI: ejecuta en terminal → npm install -g expo-cli eas-cli

Pasos:
1. Abre terminal, ve a la carpeta bocara/mobile
2. npm install               (instala todas las dependencias)
3. expo login                (crea cuenta en expo.dev)
4. Para PROBAR en tu celular:
   - Instala "Expo Go" desde App Store o Play Store
   - Ejecuta: npx expo start
   - Escanea el QR con tu celular
   ¡La app corre en tu celular al instante!

5. Para PUBLICAR en tiendas (cuando estés listo):
   a. Configura EAS: eas build:configure
   b. Android (Play Store):
      - eas build --platform android
      - Espera ~15 minutos que compile en la nube
      - Descarga el .aab y súbelo a Google Play Console
   c. iOS (App Store):
      - Necesitas Mac o usar el build de EAS en la nube
      - eas build --platform ios
      - Descarga el .ipa y súbelo desde Transporter (Mac)


═══════════════════════════════════════════════════════
 PASO 5: EMPRESAS DE ENVÍO (contactar directamente)
═══════════════════════════════════════════════════════

FORZA DELIVERY (recomendado para Guatemala City):
  - Web: https://forzadelivery.com
  - Contactar para obtener: API Key y Store ID
  - Cobertura: Guatemala City, mismo día

GUATEX (cobertura nacional):
  - Web: https://www.guatex.com.gt
  - Tel: 1-800-500-5000
  - Email: customerservice@guatex.com
  - Pedir: acceso API para e-commerce
  - Obtener: API Key, API Secret, Account ID

EASYPOST (fallback, funciona sin contacto):
  - Registro gratis en: https://www.easypost.com
  - Obtén tu API key al instante
  - No requiere contacto previo

Una vez tengas las credenciales, agrégalas al archivo .env del backend.


═══════════════════════════════════════════════════════
 PASO 6: NOTIFICACIONES PUSH
═══════════════════════════════════════════════════════

Expo maneja todo automáticamente:
1. La app pide permiso al usuario al hacer login
2. Expo genera un token único por dispositivo
3. El backend lo guarda y lo usa para enviar notificaciones
4. Para producción, ve a https://expo.dev → Access Tokens → crear token
   Agrégalo como EXPO_ACCESS_TOKEN en el .env del backend

Las notificaciones que ya están configuradas:
  ✅ Pago confirmado + código de recogida
  🛍️ Bolsa lista para recoger
  🏍️ Pedido en camino (con número de tracking)
  📦 Pedido entregado
  🔔 Nueva bolsa en negocio favorito
  ⏰ Recordatorio de recogida


═══════════════════════════════════════════════════════
 COSTOS MENSUALES ESTIMADOS
═══════════════════════════════════════════════════════

Servicio          | Costo        | Notas
──────────────────┼──────────────┼─────────────────────
Supabase          | Gratis       | Hasta 500MB y 50K filas
Railway (backend) | ~$5/mes      | Plan Starter
Expo              | Gratis       | Hasta 1,000 notif/mes
Stripe            | 0%           | Solo cobra por transacción
Apple Developer   | $99/año      | Para publicar en iOS
Google Play       | $25 único    | Para publicar en Android
Dominio (.gt)     | ~$20/año     | Opcional
──────────────────┼──────────────┼─────────────────────
TOTAL BASE        | ~$5-10/mes   | + comisiones de Stripe

Cuando escales:
  - Supabase Pro: $25/mes (más almacenamiento y usuarios)
  - Railway Pro: $20/mes (más recursos)


═══════════════════════════════════════════════════════
 ESTRUCTURA DE ARCHIVOS GENERADOS
═══════════════════════════════════════════════════════

bocara/
├── backend/
│   ├── server.js              ← Servidor principal
│   ├── package.json           ← Dependencias Node.js
│   ├── .env.example           ← Plantilla de variables
│   ├── database.sql           ← Esquema de base de datos
│   ├── config/
│   │   └── supabase.js        ← Conexión a Supabase
│   ├── middleware/
│   │   └── auth.js            ← Verificación JWT
│   ├── routes/
│   │   ├── auth.js            ← Login/registro
│   │   ├── bolsas.js          ← Listar bolsas disponibles
│   │   ├── negocios.js        ← Negocios/restaurantes
│   │   ├── pagos.js           ← Stripe + webhook
│   │   ├── pedidos.js         ← Historial y tracking
│   │   ├── envios.js          ← Cotizar y rastrear
│   │   ├── notificaciones.js  ← Historial de notifs
│   │   └── resenas.js         ← Calificaciones
│   └── services/
│       ├── envios.js          ← Guatex + Forza + EasyPost
│       └── notificaciones.js  ← Expo Push
└── mobile/
    ├── App.js                 ← Entrada + navegación
    ├── app.json               ← Config de Expo
    ├── package.json           ← Dependencias React Native
    └── src/
        ├── context/
        │   └── AuthContext.js ← Estado de autenticación
        ├── services/
        │   ├── api.js         ← Cliente HTTP al backend
        │   └── pushNotifications.js
        └── screens/
            ├── ExplorarScreen.js    ← Pantalla principal
            ├── DetalleNegocioScreen ← Ver bolsas de un negocio
            ├── PagoScreen.js        ← Pago Stripe + envío
            ├── PedidosScreen.js     ← Mis pedidos
            ├── TrackingScreen.js    ← Rastreo de envío
            ├── LoginScreen.js
            └── RegistroScreen.js
