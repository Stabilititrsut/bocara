# Finanzas V2

El backend calcula y persiste `snapshot_financiero` al crear cada pedido. Merma (`es_tiempo_limitado` o publicación normal) usa 25%; promoción (`es_promocion` o `tipo=cupon`) usa 20%. En carritos mixtos se conserva una línea por bolsa y `tipo_financiero=mixto`.

El snapshot contiene subtotal de productos, comisión Bocara, porcentaje por línea, cargo de plataforma, propina, envío, total cliente y neto restaurante. Liquidaciones e historial deben usar esos campos del pedido/snapshot, nunca la configuración actual. Pedidos anteriores conservan `snapshot_financiero=NULL`: no se hizo backfill porque su tipo financiero no se puede reconstruir con certeza.

El frontend solo envía bolsas, cantidades, entrega y propina; no puede elegir porcentajes ni importes de comisión. `calcularSnapshotFinanciero` (`services/finanzasSnapshot.js`) solo lee porcentaje y precio de `bolsas` (el catálogo que el backend acaba de consultar) — cualquier `porcentaje_comision_aplicado`/`comision_bocara` que un cliente hostil incluya en `items` se ignora (`test/finanzasSnapshot.test.js`).

La función es pura: recibe `comisionMerma`/`comisionPromocion` como parámetros explícitos (leídos de `configuracion.js` una sola vez, antes de calcular) y nunca vuelve a consultar la configuración. Por eso un cambio posterior en `comision_porcentaje`/`comision_promocion_porcentaje` no puede alterar un pedido ya calculado — solo afecta al siguiente pedido que se cree (probado explícitamente).
