# Cubo Pago — Evidencia de Prueba Sandbox

**Proyecto:** Bocara  
**Ambiente:** Sandbox  
**Fecha de prueba:** 2026-06-02  
**Backend desplegado en:** https://bocara.onrender.com  
**Frontend en:** https://bocara.vercel.app  

---

## 1. Endpoint probado: Crear Link de Pago

### Request

**Método:** `POST`  
**URL:** `https://bocara.onrender.com/api/pagos/cubo/crear-link-test`  
**Headers:**
```
Content-Type: application/json
```
*(No requiere Authorization — endpoint de prueba sin auth)*

**Body:** *(ninguno requerido — datos de prueba hardcodeados en el backend)*

### Request enviado de backend → Cubo Sandbox

**URL Cubo:** `POST https://api-payment-sandbox.cubopago.com/api/v1/links/one-use`  
**Headers enviados a Cubo:**
```
Content-Type: application/json
X-API-KEY: [API Key Sandbox — omitida de esta evidencia]
```
**Body enviado a Cubo:**
```json
{
  "description": "Prueba Bocara Sandbox",
  "amount": 100,
  "redirectUri": "https://bocara.vercel.app/pago-exitoso",
  "metadata": {
    "orderId": "TEST-CUBO-001",
    "source": "bocara",
    "environment": "sandbox"
  },
  "clientName": "Cliente Prueba",
  "clientEmail": "test@bocara.com",
  "clientPhone": "55555555",
  "items": [
    {
      "name": "Bolsa de comida prueba",
      "price": 100,
      "quantity": 1
    }
  ]
}
```

### Response de Cubo Sandbox

*(Completar después de ejecutar la prueba)*

**HTTP Status:** `___`  
**Body de respuesta:**
```json
{
  // Pegar aquí la respuesta real de Cubo
}
```

**Link de pago generado:** `___`  
**paymentIntentToken / identifier:** `___`

---

## 2. Simulación de Pago en Sandbox

1. Abrir el link generado en el navegador.
2. Ingresar los datos de tarjeta de prueba de Cubo Sandbox.
3. Confirmar el pago.

**Resultado del pago:** `SUCCEEDED / REJECTED` *(completar)*

---

## 3. Webhook recibido

**URL de webhook configurada en Cubo Admin:**
```
https://bocara.onrender.com/api/webhooks/cubo
```

**Body recibido del webhook de Cubo:**
```json
{
  // Pegar aquí el body del webhook recibido (visible en logs de Render)
}
```

**Campos extraídos:**
| Campo | Valor |
|-------|-------|
| `status` | `___` |
| `amount` | `___` |
| `identifier` | `___` |
| `referenceId` | `___` |
| `authorizationCode` | `___` |
| `processedAt` | `___` |
| `metadata.orderId` | `TEST-CUBO-001` |

---

## 4. Estado final del pedido

*(Para pruebas TEST-CUBO-001 no se actualiza la DB — solo se simula en logs)*

**Log esperado en Render si pago exitoso:**
```
[CUBO WEBHOOK] Evento recibido: { ... }
[CUBO WEBHOOK] Pago APROBADO — orderId: TEST-CUBO-001
[CUBO WEBHOOK] TEST — Pedido TEST-CUBO-001 simulado como PAGADO (no se actualiza DB)
```

---

## 5. Comandos cURL para reproducir la prueba

### 5.1 Crear link de pago (prueba local)
```bash
curl -X POST https://bocara.onrender.com/api/pagos/cubo/crear-link-test \
  -H "Content-Type: application/json"
```

### 5.2 Crear link de pago (local en desarrollo)
```bash
curl -X POST http://localhost:3000/api/pagos/cubo/crear-link-test \
  -H "Content-Type: application/json"
```

### 5.3 Simular webhook de Cubo (prueba manual)
```bash
curl -X POST https://bocara.onrender.com/api/webhooks/cubo \
  -H "Content-Type: application/json" \
  -d '{
    "status": "SUCCEEDED",
    "amount": 100,
    "identifier": "test-identifier-001",
    "referenceId": "TEST-CUBO-001",
    "authorizationCode": "AUTH-TEST-001",
    "processedAt": "2026-06-02T12:00:00Z",
    "metadata": {
      "orderId": "TEST-CUBO-001",
      "source": "bocara",
      "environment": "sandbox"
    }
  }'
```

### 5.4 Simular webhook de pago rechazado
```bash
curl -X POST https://bocara.onrender.com/api/webhooks/cubo \
  -H "Content-Type: application/json" \
  -d '{
    "status": "REJECTED",
    "amount": 100,
    "identifier": "test-identifier-002",
    "referenceId": "TEST-CUBO-001",
    "processedAt": "2026-06-02T12:01:00Z",
    "metadata": {
      "orderId": "TEST-CUBO-001"
    }
  }'
```

---

## 6. Logs a revisar en Render

Ir a: **Render Dashboard → bocara (servicio) → Logs**

Buscar las siguientes líneas:
```
[CUBO TEST] Creando link de pago...
[CUBO TEST] API Key (8 chars): xxxxxxxx...
[CUBO TEST] Base URL: https://api-payment-sandbox.cubopago.com
[CUBO TEST] Response Cubo: { ... }
[CUBO WEBHOOK] Evento recibido: { ... }
[CUBO WEBHOOK] Pago APROBADO — orderId: TEST-CUBO-001
```

---

## 7. Variable de entorno requerida en Render

En **Render Dashboard → bocara → Environment → Environment Variables**, agregar:

| Variable | Valor |
|----------|-------|
| `CUBO_API_KEY_SANDBOX` | *(tu API Key de Cubo Admin Sandbox)* |
| `VISALINK_API_URL` | `https://api-payment-sandbox.cubopago.com` |

---

## 8. URL de webhook a configurar en Cubo Admin Sandbox

En **Cubo Admin Sandbox → Developers → Webhooks**, agregar:

```
https://bocara.onrender.com/api/webhooks/cubo
```

Eventos a suscribir: `payment.succeeded`, `payment.rejected`, `payment.failed`

---

## 9. Checklist de evidencia para solicitar producción

- [ ] Screenshot del link de pago generado en Cubo Sandbox
- [ ] Screenshot del checkout de Cubo con los datos de la bolsa
- [ ] Screenshot del pago completado (estado SUCCEEDED)
- [ ] Log de Render mostrando `[CUBO TEST] Response Cubo:` con la respuesta
- [ ] Log de Render mostrando `[CUBO WEBHOOK] Pago APROBADO`
- [ ] Screenshot de Cubo Admin mostrando el pago como completado
- [ ] Response JSON completa de `POST /api/v1/links/one-use` (pegar en sección 1)
- [ ] Body completo del webhook recibido (pegar en sección 3)

---

## 10. Notas de seguridad

- La API Key nunca se expone en frontend ni en logs completos.
- El `.env` está en `.gitignore` — la key no se sube al repositorio.
- En producción, usar `CUBO_API_KEY_PROD` (distinta key) y cambiar `VISALINK_API_URL`.
