/**
 * Servicio de cálculo de impacto ambiental estimado para alimentos rescatados.
 *
 * Métricas definidas:
 *   co2_estimado_por_unidad (kgCO₂e):
 *     = peso_kg_unidad × factor_kg_co2e_por_kg
 *     Se almacena en bolsas.co2_salvado_kg al crear/editar el producto.
 *     Representa el impacto potencial de rescatar UNA unidad del producto.
 *
 *   co2_evitado_real (kgCO₂e) — calculado en routes/pedidos.js al confirmar:
 *     = peso_kg_unidad × cantidad_rescatada × factor_kg_co2e_por_kg
 *     Representa el impacto real de un pedido completado.
 *
 * Regla: un producto publicado pero no vendido NO tiene "impacto evitado real".
 * No llamar "evitado" al inventario únicamente publicado.
 *
 * Factor válido: activo = true AND verificado = true AND factor_kg_co2e_por_kg > 0.
 * Si no existe un factor que cumpla los tres requisitos: co2e_kg = null, sin_datos = true.
 * NULL significa "sin información suficiente", distinto de 0 (impacto calculado igual a cero).
 *
 * Los factores se buscan por categoria_alimento (tipo de alimento),
 * NO por categoria del negocio (tipo de establecimiento).
 *
 * Fuente de factores: tabla factores_co2_alimentos en Supabase.
 * No existe fallback en memoria: los factores deben estar verificados en BD.
 */

const supabaseModule = require('../config/supabase');

/**
 * Normaliza el texto de categoría para búsquedas tolerantes a
 * tildes, mayúsculas y espacios extra.
 */
function normalizarCategoria(cat) {
  if (!cat) return '';
  return cat
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca el factor CO₂ para una categoría alimentaria dada.
 * Solo devuelve factores con activo=true, verificado=true y factor>0.
 * Si no encuentra ninguno, devuelve null (sin inventar un valor).
 *
 * @param {object} supabase - cliente de Supabase
 * @param {string} categoriaAlimento - categoría del alimento (ej. 'pollo', 'cereales')
 * @returns {Promise<{factor: number, fuente: string, categoria_fao: string} | null>}
 */
async function obtenerFactorCO2(supabase, categoriaAlimento) {
  const catNorm = normalizarCategoria(categoriaAlimento);
  if (!catNorm) {
    console.warn('[CO2] Categoría de alimento vacía — impacto no disponible');
    return null;
  }

  try {
    const { data: factores, error } = await supabase
      .from('factores_co2_alimentos')
      .select('categoria, factor_kg_co2e_por_kg, fuente, version_fuente, activo, verificado')
      .eq('activo', true)
      .eq('verificado', true);

    if (error) {
      console.warn('[CO2] Error consultando factores_co2_alimentos:', error.message, '— impacto no disponible');
      return null;
    }

    if (!factores || factores.length === 0) {
      console.warn('[CO2] Sin factores activos y verificados en BD — impacto no disponible');
      return null;
    }

    // Filtrar factor > 0 (comida_mixta y otro tienen factor=0 explícitamente)
    const validos = factores.filter(f => parseFloat(f.factor_kg_co2e_por_kg) > 0);

    // Búsqueda exacta normalizada
    const match = validos.find(f => normalizarCategoria(f.categoria) === catNorm);
    if (match) {
      return {
        factor: parseFloat(match.factor_kg_co2e_por_kg),
        fuente: `${match.fuente}${match.version_fuente ? ' v' + match.version_fuente : ''}`,
        categoria_fao: match.categoria,
      };
    }

    // Búsqueda parcial (ej. 'pescado' encuentra 'pescado_mariscos')
    const partial = validos.find(f => {
      const fn = normalizarCategoria(f.categoria);
      return fn.includes(catNorm) || catNorm.includes(fn);
    });
    if (partial) {
      return {
        factor: parseFloat(partial.factor_kg_co2e_por_kg),
        fuente: `${partial.fuente}${partial.version_fuente ? ' v' + partial.version_fuente : ''}`,
        categoria_fao: partial.categoria,
      };
    }

    console.warn(`[CO2] Sin factor verificado para categoria_alimento="${categoriaAlimento}" — impacto no disponible`);
    return null;
  } catch (err) {
    console.warn('[CO2] Excepción consultando factores:', err.message, '— impacto no disponible');
    return null;
  }
}

/**
 * Calcula co2_estimado_por_unidad para un producto al ser publicado.
 * Devuelve co2e_kg = null cuando no existe factor verificado (sin_datos = true).
 *
 * @param {object} supabase
 * @param {number} peso_kg - peso por unidad del producto
 * @param {string} categoriaAlimento - categoría alimentaria del producto
 * @returns {Promise<{co2e_kg: number|null, factor_aplicado: number|null, fuente: string|null, sin_datos: boolean}>}
 */
async function calcularImpactoProducto(supabase, peso_kg, categoriaAlimento) {
  if (!peso_kg || peso_kg <= 0) {
    return { co2e_kg: null, factor_aplicado: null, fuente: null, sin_datos: true };
  }

  const datosFactor = await obtenerFactorCO2(supabase, categoriaAlimento);
  if (!datosFactor) {
    return { co2e_kg: null, factor_aplicado: null, fuente: null, sin_datos: true };
  }

  const co2e_kg = Math.round(peso_kg * datosFactor.factor * 100) / 100;
  console.log(
    `[CO2] categoria_alimento="${categoriaAlimento}": ${peso_kg} kg × ${datosFactor.factor} kgCO₂e/kg` +
    ` = ${co2e_kg} kgCO₂e/unidad (${datosFactor.fuente})`
  );

  return {
    co2e_kg,
    factor_aplicado: datosFactor.factor,
    fuente: datosFactor.fuente,
    sin_datos: false,
  };
}

/**
 * Calcula co2_evitado_real para un pedido completado (múltiples unidades).
 * Fórmula: peso_kg_unidad × cantidad_rescatada × factor
 *
 * Usar solo al confirmar/completar un pedido real, no al publicar el producto.
 *
 * @param {object} supabase
 * @param {number} peso_kg_unidad - peso por unidad
 * @param {number} cantidad - unidades efectivamente recogidas
 * @param {string} categoriaAlimento - categoría alimentaria
 */
async function calcularImpactoPedido(supabase, peso_kg_unidad, cantidad, categoriaAlimento) {
  const cantidadFinal = cantidad && cantidad > 0 ? cantidad : 1;
  return calcularImpactoProducto(supabase, peso_kg_unidad * cantidadFinal, categoriaAlimento);
}

module.exports = {
  obtenerFactorCO2,
  calcularImpactoProducto,
  calcularImpactoPedido,
  normalizarCategoria,
};
