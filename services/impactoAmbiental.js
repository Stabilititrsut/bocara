/**
 * Servicio de cálculo de impacto ambiental estimado para alimentos rescatados.
 *
 * Alcance definido:
 *   "Emisiones de producción potencialmente evitadas al rescatar el alimento
 *    antes de convertirse en desperdicio alimentario."
 *
 * No se afirma que es una medición exacta. Mostrar siempre como "estimado".
 * No suma impactos incompatibles ni realiza doble conteo.
 *
 * Fuentes primarias:
 *   - FAO (2013). "Food Wastage Footprint: Impacts on Natural Resources."
 *     ISBN 978-92-5-107752-8. https://www.fao.org/3/i3347e/i3347e.pdf
 *     Tabla A1: huella de carbono del desperdicio alimentario por grupo, kg CO₂e/kg.
 *   - WRAP (2016). "Quantification of food surplus, waste and related measures
 *     across the supply chain." https://wrap.org.uk (UK data, referencia secundaria)
 *
 * Los factores en kgCO₂e/kg NO incluyen Land Use Change (LUC) para mantener
 * estimaciones conservadoras y replicables desde la fuente citada.
 */

const supabaseModule = require('../config/supabase');

// Factores internos de respaldo — solo se usan si la BD no está disponible.
// Valores tomados directamente de FAO 2013, Tabla A1.
const FACTORES_FALLBACK = {
  'Panadería':     { factor: 1.0,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Cereales' },
  'Cafetería':     { factor: 1.5,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Cereales + lácteos estimado' },
  'Supermercado':  { factor: 2.5,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Mezcla conservadora' },
  'Sushi':         { factor: 2.4,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Pescados y mariscos' },
  'Pizza':         { factor: 2.0,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Cereales con ingredientes mixtos' },
  'Restaurante':   { factor: 3.8,  fuente: 'FAO 2013 + WRAP 2016', categoria_fao: 'Comida preparada mixta' },
  'Comida Típica': { factor: 3.5,  fuente: 'FAO 2013 Food Wastage Footprint Tabla A1', categoria_fao: 'Granos + proteína animal mixta' },
};

/**
 * Normaliza el texto de categoría para buscar coincidencias tolerantes a
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
 * Busca el factor CO₂ para una categoría dada.
 * Orden: tabla `factores_co2_alimentos` → fallback en memoria.
 * Si no encuentra ningún factor, devuelve null (sin inventar un valor).
 *
 * @param {object} supabase - cliente de Supabase
 * @param {string} categoria - categoría del negocio
 * @returns {Promise<{factor: number, fuente: string, categoria_fao: string} | null>}
 */
async function obtenerFactorCO2(supabase, categoria) {
  const catNorm = normalizarCategoria(categoria);
  if (!catNorm) {
    console.warn('[CO2] Categoría vacía — impacto no disponible');
    return null;
  }

  // 1. Intentar desde tabla dedicada en BD
  try {
    const { data: factores, error } = await supabase
      .from('factores_co2_alimentos')
      .select('categoria, factor_kg_co2e_por_kg, fuente, version_fuente, activo')
      .eq('activo', true);

    if (!error && factores && factores.length > 0) {
      // Búsqueda exacta normalizada
      const match = factores.find(f => normalizarCategoria(f.categoria) === catNorm);
      if (match) {
        return {
          factor: parseFloat(match.factor_kg_co2e_por_kg),
          fuente: `${match.fuente}${match.version_fuente ? ' v' + match.version_fuente : ''}`,
          categoria_fao: match.categoria,
        };
      }
      // Búsqueda parcial (ej. "Restaurante" encuentra "Restaurantes")
      const partial = factores.find(f => {
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
      // Sin coincidencia en BD → no inventar
      console.warn(`[CO2] Sin factor en BD para categoría: "${categoria}" — impacto no disponible`);
      return null;
    }
    if (error) {
      console.warn('[CO2] Tabla factores_co2_alimentos no disponible:', error.message, '— usando fallback en memoria');
    }
  } catch (err) {
    console.warn('[CO2] Error consultando factores:', err.message, '— usando fallback en memoria');
  }

  // 2. Fallback en memoria (para cuando la tabla aún no fue creada en Supabase)
  for (const [cat, datos] of Object.entries(FACTORES_FALLBACK)) {
    if (normalizarCategoria(cat) === catNorm || catNorm.includes(normalizarCategoria(cat))) {
      return datos;
    }
  }

  console.warn(`[CO2] Sin factor de fallback para categoría: "${categoria}" — impacto no disponible`);
  return null;
}

/**
 * Calcula el impacto estimado de un producto al ser rescatado.
 * Si no existe factor para la categoría, devuelve co2e_kg = 0 y sin_datos = true.
 *
 * @param {object} supabase
 * @param {number} peso_kg - peso en kg del producto rescatado
 * @param {string} categoria - categoría del negocio
 * @returns {Promise<{co2e_kg: number, factor_aplicado: number|null, fuente: string|null, sin_datos: boolean}>}
 */
async function calcularImpactoProducto(supabase, peso_kg, categoria) {
  if (!peso_kg || peso_kg <= 0) {
    return { co2e_kg: 0, factor_aplicado: null, fuente: null, sin_datos: true };
  }

  const datosFactor = await obtenerFactorCO2(supabase, categoria);
  if (!datosFactor) {
    return { co2e_kg: 0, factor_aplicado: null, fuente: null, sin_datos: true };
  }

  const co2e_kg = Math.round(peso_kg * datosFactor.factor * 100) / 100;
  console.log(`[CO2] ${categoria}: ${peso_kg} kg × ${datosFactor.factor} kgCO₂e/kg = ${co2e_kg} kgCO₂e (${datosFactor.fuente})`);

  return {
    co2e_kg,
    factor_aplicado: datosFactor.factor,
    fuente: datosFactor.fuente,
    sin_datos: false,
  };
}

/**
 * Calcula el impacto de un pedido completo (múltiples unidades).
 * Fórmula: peso_kg_unidad × cantidad × factor_emision
 *
 * @param {object} supabase
 * @param {number} peso_kg_unidad
 * @param {number} cantidad
 * @param {string} categoria
 */
async function calcularImpactoPedido(supabase, peso_kg_unidad, cantidad, categoria) {
  const cantidadFinal = cantidad && cantidad > 0 ? cantidad : 1;
  return calcularImpactoProducto(supabase, peso_kg_unidad * cantidadFinal, categoria);
}

module.exports = {
  obtenerFactorCO2,
  calcularImpactoProducto,
  calcularImpactoPedido,
  normalizarCategoria,
  FACTORES_FALLBACK,
};
