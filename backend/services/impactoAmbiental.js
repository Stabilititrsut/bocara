// ════════════════════════════════════════════════════════════════════════════
// Bocara — Impacto ambiental: CO₂ evitado por alimento rescatado
// ════════════════════════════════════════════════════════════════════════════
//
// Plan técnico Semana 1 (Jueves / Ingeniero 1): métricas reales de CO₂ basadas
// en `bolsas.peso_estimado_kg` y agregaciones deterministas.
//
// ── La regla, en una línea ──────────────────────────────────────────────────
//
//   co2e_kg = peso_estimado_kg × factor_kg_co2e_por_kg(categoria_alimento)
//
// Es PROPORCIONAL AL PESO, siempre. El antipatrón que este módulo existe para
// impedir es el valor fijo por bolsa (el histórico "1.4 kg por bolsa"): con él,
// media libra de pan y tres kilos de carne salvaban lo mismo, así que la cifra
// no medía nada — solo contaba pedidos con otro nombre.
//
// ── Por qué los factores viven en código y no en la BD ──────────────────────
//
// Existe una tabla `factores_co2_alimentos` (scripts/migrations.sql, bloques 14
// y 18) con todas sus filas en activo=false, verificado=false: en junio de 2026
// se desactivaron porque mapeaban CATEGORÍA DE NEGOCIO (Panadería, Sushi…) a
// CO₂, que es metodológicamente incorrecto — el tipo de establecimiento no
// determina la composición del alimento rescatado.
//
// Aquí se corrige eso y se conserva lo aprendido:
//   · los factores se indexan por CATEGORÍA ALIMENTARIA (`bolsas.categoria_alimento`),
//     nunca por la categoría del negocio;
//   · viven en código, versionados en git y cubiertos por pruebas, para que la
//     misma entrada dé SIEMPRE la misma salida — "agregaciones deterministas"
//     significa exactamente eso: el resultado no puede depender de qué tenga
//     hoy una fila de configuración, ni de en qué orden se leyó;
//   · la tabla sigue siendo el catálogo editorial del admin (fuente, página,
//     región, alcance). Si algún día se verifica documentalmente, este mapa se
//     actualiza en un commit revisable, no con un UPDATE silencioso.
//
// ── Honestidad de la cifra ──────────────────────────────────────────────────
//
// Los valores provienen de FAO (2013), "Food Wastage Footprint: Impacts on
// Natural Resources", ISBN 978-92-5-107752-8, Annex 1 / Tabla A1, y EXCLUYEN
// cambio de uso de suelo (LUC), que es la lectura conservadora. Son una
// ESTIMACIÓN: la cifra se presenta como "impacto estimado", nunca como medición.
// La verificación documental fila por fila sigue pendiente (ver migración 18e).
// ════════════════════════════════════════════════════════════════════════════

// El cliente por defecto se resuelve al usarlo, no al importar: así las pruebas
// pueden cargar este módulo e inyectar su propio cliente sin abrir conexión.
// Mismo criterio que services/stock.js.
let _supabase = null;
function supabasePorDefecto() {
  if (!_supabase) _supabase = require('../config/supabase');
  return _supabase;
}

/**
 * Peso por unidad cuando la publicación no declara uno.
 *
 * 0.5 kg es el mismo valor que routes/bolsas.js aplica al crear una bolsa sin
 * peso; se exporta para que exista UN solo número y no tres literales sueltos.
 */
const PESO_UNIDAD_DEFECTO_KG = 0.5;

/**
 * Composición de referencia de una "bolsa sorpresa" (comida preparada mixta).
 *
 * El factor por defecto NO es un número inventado: es el promedio ponderado de
 * esta mezcla, y la prueba `impacto.test.js` lo recalcula para que no puedan
 * divergir. Si mañana se mide la composición real de las bolsas de Bocara, se
 * ajustan estos pesos y el factor se mueve solo.
 */
const COMPOSICION_MIXTA = Object.freeze({
  cereales: 0.50,  // pan, tortilla, arroz, pasta — el grueso de una bolsa típica
  verduras: 0.20,
  lacteos:  0.10,
  pollo:    0.10,
  legumbres:0.10,
});

/**
 * Factores de emisión, kgCO₂e por kg de alimento rescatado.
 * FAO 2013, Annex 1 Tabla A1, sin LUC. Mismos valores que el catálogo de
 * `factores_co2_alimentos` (migración 18e) — indexados por categoría alimentaria.
 */
const FACTORES_CO2 = Object.freeze({
  cereales:          1.0,
  frutas:            0.4,
  verduras:          0.4,
  raices_tuberculos: 0.3,
  legumbres:         0.9,
  lacteos:           1.3,
  huevos:            1.6,
  pollo:             3.7,
  cerdo:             2.8,
  carne_bovina:      9.5,
  pescado_mariscos:  2.9,
});

/**
 * Promedio ponderado de COMPOSICION_MIXTA — el "factor estándar de plataforma".
 * Se redondea a dos decimales aquí mismo: es una constante publicada (aparece en
 * la ficha del producto y en la documentación), no un intermedio de cálculo, y
 * 1.17 se lee mejor que 1.1700000000000002.
 */
const FACTOR_CO2_DEFECTO = Math.round(
  Object.entries(COMPOSICION_MIXTA)
    .reduce((suma, [categoria, proporcion]) => suma + FACTORES_CO2[categoria] * proporcion, 0) * 100,
) / 100;

const FUENTE_FACTORES = 'FAO 2013 Food Wastage Footprint, Annex 1 Tabla A1 (sin LUC)';
const FUENTE_DEFECTO = 'Bocara — promedio ponderado de composición mixta sobre ' + FUENTE_FACTORES;

/**
 * Sinónimos que escriben los restaurantes o que arrastran despliegues viejos.
 * Se resuelven ANTES de buscar en FACTORES_CO2; lo que no esté aquí ni allí cae
 * al factor por defecto (nunca a cero, nunca a null).
 */
const ALIAS_CATEGORIAS = Object.freeze({
  pan: 'cereales',
  panaderia: 'cereales',
  reposteria: 'cereales',
  pasteleria: 'cereales',
  arroz: 'cereales',
  pasta: 'cereales',
  tortillas: 'cereales',
  fruta: 'frutas',
  vegetales: 'verduras',
  verdura: 'verduras',
  ensaladas: 'verduras',
  tuberculos: 'raices_tuberculos',
  raices: 'raices_tuberculos',
  papa: 'raices_tuberculos',
  frijoles: 'legumbres',
  frijol: 'legumbres',
  leguminosas: 'legumbres',
  lacteo: 'lacteos',
  queso: 'lacteos',
  leche: 'lacteos',
  huevo: 'huevos',
  ave: 'pollo',
  aves: 'pollo',
  pavo: 'pollo',
  puerco: 'cerdo',
  cerdo_carne: 'cerdo',
  res: 'carne_bovina',
  carne_de_res: 'carne_bovina',
  carne_res: 'carne_bovina',
  bovino: 'carne_bovina',
  pescado: 'pescado_mariscos',
  mariscos: 'pescado_mariscos',
  sushi: 'pescado_mariscos',
  mixta: 'comida_mixta',
  mixto: 'comida_mixta',
  variado: 'comida_mixta',
  comida_preparada: 'comida_mixta',
  bolsa_sorpresa: 'comida_mixta',
});

/**
 * Categorías que existen en el catálogo pero NO tienen factor propio: describen
 * una mezcla, no un alimento. Usan el factor por defecto, que es justamente el
 * promedio ponderado de una mezcla.
 */
const CATEGORIAS_MIXTAS = Object.freeze(['comida_mixta', 'otro']);

/**
 * Normaliza el texto de categoría: minúsculas, sin tildes, espacios/guiones a
 * guion bajo. 'Carne Bovina', 'carne-bovina' y 'CARNE  BOVINA' son la misma.
 */
function normalizarCategoria(categoria) {
  if (categoria === null || categoria === undefined) return '';
  return String(categoria)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Factor aplicable a una categoría alimentaria.
 *
 * SIEMPRE devuelve un factor > 0. Una categoría desconocida, vacía o mixta cae
 * al factor de plataforma: es la diferencia con el diseño anterior, donde no
 * tener factor verificado significaba co2 = null y el restaurante no veía nada.
 * La cifra se etiqueta `esDefecto: true` para que la interfaz pueda decir
 * "estimado con la composición estándar" en vez de fingir precisión.
 *
 * @returns {{ categoria: string, factor: number, fuente: string, esDefecto: boolean }}
 */
function factorCO2(categoria) {
  const clave = normalizarCategoria(categoria);
  const resuelta = ALIAS_CATEGORIAS[clave] || clave;

  if (Object.prototype.hasOwnProperty.call(FACTORES_CO2, resuelta)) {
    return { categoria: resuelta, factor: FACTORES_CO2[resuelta], fuente: FUENTE_FACTORES, esDefecto: false };
  }

  return {
    categoria: CATEGORIAS_MIXTAS.includes(resuelta) ? resuelta : 'comida_mixta',
    factor: FACTOR_CO2_DEFECTO,
    fuente: FUENTE_DEFECTO,
    esDefecto: true,
  };
}

/** Redondeo determinista a `decimales` (2 por defecto). */
function redondear(valor, decimales = 2) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
}

/** Peso utilizable de una unidad: número > 0, o 0 si el dato no sirve. */
function pesoUnitario(pesoKg) {
  const n = Number(pesoKg);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * CO₂ estimado de UNA unidad de un producto — lo que se guarda en
 * `bolsas.co2_salvado_kg` al publicar o editar la bolsa.
 *
 * Sin peso utilizable devuelve 0: no se atribuye impacto a un dato que no
 * existe (0 es "no acreditamos nada", nunca "da igual el peso").
 */
function co2PorUnidad(pesoKg, categoriaAlimento) {
  const peso = pesoUnitario(pesoKg);
  if (peso === 0) return 0;
  return redondear(peso * factorCO2(categoriaAlimento).factor);
}

/**
 * Normaliza una fila cualquiera (item de pedido o pedido heredado) al formato
 * que entiende `impactoDeUnidades`.
 *
 * Sin peso utilizable se aplica PESO_UNIDAD_DEFECTO_KG, el mismo que la
 * plataforma asume al publicar una bolsa sin peso: toda bolsa nace con peso, así
 * que llegar aquí sin él significa que falta el dato (bolsa borrada, columna
 * ausente), no que la bolsa pesara cero. Acreditar 0 kg escondería comida que sí
 * se rescató; acreditar el peso estándar la cuenta con el mismo criterio con el
 * que se publicó.
 */
function unidadRescatada({ pesoKg, categoriaAlimento, cantidad, precioOriginal, precioPagado }) {
  const n = Number(cantidad);
  return {
    cantidad: Number.isFinite(n) && n > 0 ? n : 1,
    pesoKg: pesoUnitario(pesoKg) || PESO_UNIDAD_DEFECTO_KG,
    categoriaAlimento: categoriaAlimento ?? null,
    precioOriginal: Number(precioOriginal) || 0,
    precioPagado: Number(precioPagado) || 0,
  };
}

/**
 * LA agregación. Único sitio donde se suman kg, CO₂ y dinero ahorrado.
 *
 * Determinista por construcción:
 *   · se recalcula desde peso × factor, nunca desde `co2_salvado_kg` guardado
 *     (ese es una foto redondeada para mostrar en la ficha del producto; sumar
 *     valores ya redondeados arrastra el error y hace que el total dependa de
 *     cuándo se escribió cada fila);
 *   · se suma en crudo y se redondea UNA vez, al final;
 *   · el orden de las filas no altera el resultado más allá del épsilon de
 *     coma flotante, que el redondeo final absorbe.
 *
 * @param {Array} unidades filas de unidadRescatada()
 * @returns {{ unidades_rescatadas: number, kg_rescatados: number,
 *             co2_evitado_kg: number, dinero_ahorrado: number,
 *             ventas_recuperadas: number }}
 */
function impactoDeUnidades(unidades = []) {
  let unidadesTotales = 0;
  let kg = 0;
  let co2 = 0;
  let ahorro = 0;
  let ventas = 0;

  for (const cruda of unidades) {
    const u = unidadRescatada(cruda);
    const kgUnidad = u.pesoKg * u.cantidad;
    unidadesTotales += u.cantidad;
    kg += kgUnidad;
    co2 += kgUnidad * factorCO2(u.categoriaAlimento).factor;
    // El ahorro nunca es negativo: un precio "original" mal capturado por debajo
    // del pagado no puede restar del ahorro de los demás pedidos.
    ahorro += Math.max(0, u.precioOriginal - u.precioPagado) * u.cantidad;
    ventas += u.precioPagado * u.cantidad;
  }

  return {
    unidades_rescatadas: unidadesTotales,
    kg_rescatados: redondear(kg),
    co2_evitado_kg: redondear(co2),
    // Las dos caras del mismo precio: lo que el cliente dejó de pagar y lo que
    // el restaurante recuperó de comida que iba a tirar.
    dinero_ahorrado: redondear(ahorro),
    ventas_recuperadas: redondear(ventas),
  };
}

/**
 * SELECT tolerante a que `categoria_alimento` no exista todavía.
 *
 * La columna llega en la migración 18d y este código puede desplegarse contra
 * una base que no la tenga: PostgREST responde 42703 y, sin este reintento, la
 * consulta entera se perdería y el impacto saldría en cero. Sin categoría, cada
 * unidad usa el factor de plataforma. Mismo criterio que
 * services/stock.js → pedidosConMarcaDeReserva.
 */
/**
 * Trocea una lista de ids para no mandar un `IN (...)` interminable.
 *
 * PostgREST viaja por querystring: el panel de admin agrega TODOS los pedidos
 * entregados de la plataforma, y un solo IN con miles de UUIDs revienta el
 * límite de longitud de URL. Trocear no altera el resultado — la suma es la
 * misma en cualquier orden y en cualquier partición.
 */
const TAMANO_LOTE = 200;
function enLotes(items, tamano = TAMANO_LOTE) {
  const lotes = [];
  for (let i = 0; i < items.length; i += tamano) lotes.push(items.slice(i, i + tamano));
  return lotes;
}

async function consultarTolerante(construir, camposConCategoria, camposSinCategoria) {
  const { data, error } = await construir(camposConCategoria);
  if (!error) return data || [];
  console.warn('[IMPACTO] categoria_alimento no disponible, se usa el factor por defecto:', error.message);
  const { data: sinColumna } = await construir(camposSinCategoria);
  return sinColumna || [];
}

/**
 * Convierte una lista de pedidos en las unidades que realmente se rescataron.
 *
 * Modelo híbrido, el mismo que services/stock.js:
 *   · fuente primaria : pedido_items (carritos multi-bolsa, con cantidad real)
 *   · fuente heredada : pedidos.bolsa_id, SOLO si el pedido no tiene items
 *     (así un mismo pedido nunca se cuenta dos veces)
 *
 * Contar "un pedido = una unidad" era el otro error de las métricas anteriores:
 * un carrito de 4 bolsas sumaba 1.
 *
 * @param {Array} pedidos filas con { id, bolsa_id, cantidad, precio_bolsa }
 * @param {object} [opciones] { cliente } — cliente Supabase inyectable
 */
async function unidadesDePedidos(pedidos = [], opciones = {}) {
  const cliente = opciones.cliente || supabasePorDefecto();
  const ids = pedidos.map((p) => p.id).filter(Boolean);
  if (ids.length === 0) return [];

  const items = [];
  for (const lote of enLotes(ids)) {
    const filas = await consultarTolerante(
      (campos) => cliente.from('pedido_items').select(campos).in('pedido_id', lote),
      'pedido_id, cantidad, precio_unitario, bolsas(peso_estimado_kg, categoria_alimento, precio_original)',
      'pedido_id, cantidad, precio_unitario, bolsas(peso_estimado_kg, precio_original)',
    );
    items.push(...filas);
  }

  const unidades = items.map((i) => unidadRescatada({
    pesoKg: i.bolsas?.peso_estimado_kg,
    categoriaAlimento: i.bolsas?.categoria_alimento,
    cantidad: i.cantidad,
    precioOriginal: i.bolsas?.precio_original,
    precioPagado: i.precio_unitario,
  }));

  const conItems = new Set(items.map((i) => i.pedido_id));
  const heredados = pedidos.filter((p) => !conItems.has(p.id) && p.bolsa_id);
  if (heredados.length === 0) return unidades;

  const bolsaIds = [...new Set(heredados.map((p) => p.bolsa_id))];
  const bolsas = [];
  for (const lote of enLotes(bolsaIds)) {
    const filas = await consultarTolerante(
      (campos) => cliente.from('bolsas').select(campos).in('id', lote),
      'id, peso_estimado_kg, categoria_alimento, precio_original',
      'id, peso_estimado_kg, precio_original',
    );
    bolsas.push(...filas);
  }
  const porId = new Map(bolsas.map((b) => [b.id, b]));

  for (const pedido of heredados) {
    const bolsa = porId.get(pedido.bolsa_id);
    unidades.push(unidadRescatada({
      pesoKg: bolsa?.peso_estimado_kg,
      categoriaAlimento: bolsa?.categoria_alimento,
      cantidad: pedido.cantidad,
      precioOriginal: bolsa?.precio_original,
      precioPagado: pedido.precio_bolsa,
    }));
  }

  return unidades;
}

/**
 * Impacto de una lista de pedidos, de punta a punta.
 * Quien llama se encarga de que esos pedidos sean los correctos — es decir,
 * entregados y del negocio que toca (ver ESTADOS_ENTREGADOS en
 * services/orderStateMachine.js).
 */
async function impactoDePedidos(pedidos = [], opciones = {}) {
  const unidades = await unidadesDePedidos(pedidos, opciones);
  return { ...impactoDeUnidades(unidades), pedidos_completados: pedidos.length };
}

module.exports = {
  TAMANO_LOTE,
  PESO_UNIDAD_DEFECTO_KG,
  FACTORES_CO2,
  FACTOR_CO2_DEFECTO,
  COMPOSICION_MIXTA,
  CATEGORIAS_MIXTAS,
  ALIAS_CATEGORIAS,
  FUENTE_FACTORES,
  FUENTE_DEFECTO,
  normalizarCategoria,
  factorCO2,
  redondear,
  co2PorUnidad,
  unidadRescatada,
  impactoDeUnidades,
  unidadesDePedidos,
  impactoDePedidos,
};
