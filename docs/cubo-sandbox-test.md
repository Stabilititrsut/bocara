# Cubo Pago — Guía de integración y pruebas

**Proyecto:** Bocara  
**Backend:** https://bocara.onrender.com  
**Frontend:** https://bocara.vercel.app  
**Webhook URL (configurar en Cubo Admin):** `https://bocara.onrender.com/api/webhooks/cubo`

---

## 1. Cómo funciona el flujo completo

```
[App] → POST /api/pagos/cubopago
          ↓ crea pedido en DB (estado: pendiente, estado_pago: pendiente)
          ↓ crea link de pago en Cubo API con metadata.referencia = payu_reference_code
          ↓ devuelve visaLinkUrl al frontend

[Usuario] → abre visaLinkUrl → paga con tarjeta en Cubo Checkout

[Cubo] → POST /api/webhooks/cubo  (webhook)
          ↓ busca pedido por metadata.referencia (= payu_reference_code)
          ↓ actualiza: estado = "confirmado", estado_pago = "pagado"
          ↓ decrementa stock de la bolsa
          ↓ envía notificación push al cliente
          ↓ envía notificación push al restaurante
          ↓ responde 200 OK a Cubo
```

---

## 2. Tabla y campos que se actualizan

**Tabla:** `pedidos`

| Campo | Al aprobar (SUCCEEDED) | Al rechazar (REJECTED/FAILED/CANCELLED) |
|-------|------------------------|------------------------------------------|
| `estado` | `"confirmado"` | `"cancelado"` |
| `estado_pago` | `"pagado"` | `"fallido"` |

**Tabla secundaria:** `bolsas`

| Campo | Acción |
|-------|--------|
| `cantidad_disponible` | Se decrementa en 1 cuando `estado_pago = "pagado"` |

---

## 3. Lógica de búsqueda del pedido en el webhook

El webhook intenta encontrar el pedido en este orden:

1. **Por UUID directo** (`metadata.orderId` si es un UUID válido):
   ```sql
   SELECT * FROM pedidos WHERE id = metadata.orderId
   ```

2. **Por código de referencia** (`metadata.referencia || referenceId`):
   ```sql
   SELECT * FROM pedidos WHERE payu_reference_code = referencia
   ```

Para pagos reales de Cubo, siempre entra por la estrategia 2 (la app envía `metadata.referencia` al crear el link).

---

## 4. Variables de entorno requeridas en Render

| Variable | Descripción |
|----------|-------------|
| `CUBOPAGO_API_KEY` | API Key de Cubo Pago (sandbox o producción) |
| `VISALINK_API_URL` | `https://api-payment-sandbox.cubopago.com` (sandbox) |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Service Role Key de Supabase |

---

## 5. Comandos de prueba

### 5.1 Verificar que el backend está vivo
```bash
curl https://bocara.onrender.com/
```

### 5.2 Crear link de pago de prueba (sin auth)
```bash
curl -X POST https://bocara.onrender.com/api/pagos/cubo/crear-link-test \
  -H "Content-Type: application/json"
```

### 5.3 Simular webhook con un pedido REAL (recomendado para testing)

Primero, obtén el `payu_reference_code` de un pedido existente en Supabase:
```sql
SELECT id, payu_reference_code, estado, estado_pago
FROM pedidos
WHERE estado_pago = 'pendiente'
ORDER BY created_at DESC
LIMIT 5;
```

Luego simula el webhook usando ese valor como `metadata.referencia`:
```bash
curl -X POST https://bocara.onrender.com/api/webhooks/cubo \
  -H "Content-Type: application/json" \
  -d '{
    "status": "SUCCEEDED",
    "amount": 3623,
    "identifier": "cubo-identifier-real-001",
    "referenceId": "BOC-XXXXXXXXXX-YYYYYYYY",
    "authorizationCode": "AUTH123456",
    "processedAt": "2026-06-03T20:00:00Z",
    "metadata": {
      "referencia": "BOC-XXXXXXXXXX-YYYYYYYY"
    }
  }'
```
> Reemplaza `BOC-XXXXXXXXXX-YYYYYYYY` con el valor real de `payu_reference_code`.

### 5.4 Simular webhook con ID directo de pedido (alternativa)

Si conoces el UUID del pedido:
```bash
curl -X POST https://bocara.onrender.com/api/webhooks/cubo \
  -H "Content-Type: application/json" \
  -d '{
    "status": "SUCCEEDED",
    "amount": 3623,
    "identifier": "cubo-identifier-real-001",
    "authorizationCode": "AUTH123456",
    "processedAt": "2026-06-03T20:00:00Z",
    "metadata": {
      "orderId": "UUID-REAL-DEL-PEDIDO"
    }
  }'
```
> Reemplaza `UUID-REAL-DEL-PEDIDO` con el `id` real del pedido en la tabla `pedidos`.

### 5.5 Simular webhook de pago rechazado
```bash
curl -X POST https://bocara.onrender.com/api/webhooks/cubo \
  -H "Content-Type: application/json" \
  -d '{
    "status": "REJECTED",
    "amount": 3623,
    "identifier": "cubo-identifier-rejected-001",
    "processedAt": "2026-06-03T20:01:00Z",
    "metadata": {
      "referencia": "BOC-XXXXXXXXXX-YYYYYYYY"
    }
  }'
```

---

## 6. Logs esperados en Render

### Pago aprobado exitoso:
```
[CUBO WEBHOOK] Evento recibido: { ... }
[CUBO WEBHOOK] orderId: undefined
[CUBO WEBHOOK] status: SUCCEEDED
[CUBO WEBHOOK] referencia: BOC-XXXXXXXXXX-YYYYYYYY
[CUBO WEBHOOK] identifier: cubo-identifier-real-001
[CUBO WEBHOOK] authorizationCode: AUTH123456
[CUBO WEBHOOK] Pedido actualizado: <uuid> → estado: confirmado, estado_pago: pagado
[CUBO WEBHOOK] Stock bolsa <bolsa-id>: 3 → 2
[CUBO WEBHOOK] Pedido <uuid> (BOC-XXXXXX) marcado PAGADO — notificaciones enviadas
```

### Pedido no encontrado:
```
[CUBO WEBHOOK] Pedido no encontrado — orderId: undefined, referencia: BOC-XXXXXXXXXX-YYYYYYYY
```

---

## 7. Migración SQL opcional (campos extra de Cubo)

Si quieres guardar el `identifier` y `authorizationCode` de Cubo en la tabla `pedidos`, ejecuta en Supabase:

```sql
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_identifier text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_authorization_code text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cubo_reference_id text;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagado_en timestamptz;
```

Después de correr la migración, agregar estos campos al UPDATE en `routes/webhooks.js`.

---

## 8. URL del webhook en Cubo Admin

En **Cubo Admin → Developers → Webhooks**, configurar:

```
https://bocara.onrender.com/api/webhooks/cubo
```

Eventos a suscribir: `payment.succeeded`, `payment.rejected`, `payment.failed`, `payment.cancelled`

---

## 9. Notas de seguridad

- Las API Keys nunca se exponen en frontend ni en logs completos.
- El `.env` está en `.gitignore`.
- En producción: cambiar `VISALINK_API_URL` a la URL de producción de Cubo.
- El webhook siempre responde `200 OK` a Cubo aunque ocurra un error interno (evita reintentos infinitos).
