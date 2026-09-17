# API Backend V2 — suplemento Semana 1

`GET /api/bolsas?lat={lat}&lng={lng}&max_distancia={km}` valida latitud [-90,90], longitud [-180,180] y rechaza pares incompletos o NaN con 422. Para selección geográfica, el radio se limita a 10 km y negocios sin coordenadas quedan excluidos cuando se solicita radio. La distancia se calcula en backend con Haversine; el valor del cliente no es confiable.

Los errores nuevos de ubicación usan `{ error, code }` con `UBICACION_INVALIDA` o `RADIO_INVALIDO`, preservando el formato histórico de las rutas existentes.
