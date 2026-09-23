const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TAMANO_LOTE,
  PESO_UNIDAD_DEFECTO_KG,
  FACTORES_CO2,
  FACTOR_CO2_DEFECTO,
  COMPOSICION_MIXTA,
  normalizarCategoria,
  factorCO2,
  co2PorUnidad,
  impactoDeUnidades,
  unidadesDePedidos,
  impactoDePedidos,
} = require('../services/impactoAmbiental');
const { ESTADOS_ENTREGADOS } = require('../services/orderStateMachine');

// ════════════════════════════════════════════════════════════════════════════
// Dobles de prueba
//
// services/impactoAmbiental.js resuelve su cliente Supabase de forma perezosa y
// lo acepta inyectado, así que ninguna de estas pruebas abre una conexión.
// ════════════════════════════════════════════════════════════════════════════

const BOLSA_PAN  = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOLSA_RES  = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Cliente Supabase falso sobre tablas en memoria. */
function crearCliente(tablas, { sinCategoriaAlimento = false } = {}) {
  function consulta(nombreTabla) {
    const q = { tabla: nombreTabla, campos: '', filtros: [] };
    q.select = (campos) => { q.campos = campos || ''; return q; };
    q.in = (campo, valores) => { q.filtros.push((f) => valores.includes(f[campo])); return q; };
    q.eq = (campo, valor) => { q.filtros.push((f) => f[campo] === valor); return q; };
    q.then = (resolver, rechazar) => ejecutar(q).then(resolver, rechazar);
    return q;
  }

  async function ejecutar(q) {
    // PostgREST devuelve 42703 al pedir una columna inexistente. Así se
    // reproduce el despliegue donde la migración 18d aún no corrió.
    if (sinCategoriaAlimento && q.campos.includes('categoria_alimento')) {
      return { data: null, error: { code: '42703', message: 'column bolsas.categoria_alimento does not exist' } };
    }
    const filas = (tablas[q.tabla] || []).filter((f) => q.filtros.every((cumple) => cumple(f)));
    // El doble no recorta columnas salvo la que puede faltar: lo que se prueba
    // es la agregación, no el proyector de PostgREST.
    const limpiar = (fila) => {
      const copia = JSON.parse(JSON.stringify(fila));
      if (sinCategoriaAlimento) {
        delete copia.categoria_alimento;
        if (copia.bolsas) delete copia.bolsas.categoria_alimento;
      }
      return copia;
    };
    return { data: filas.map(limpiar), error: null };
  }

  return { from: (tabla) => consulta(tabla) };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Los factores y el "factor estándar de plataforma"
// ════════════════════════════════════════════════════════════════════════════

test('el factor por defecto ES el promedio ponderado de la composición mixta', () => {
  // Recalculado aquí a mano: si alguien toca COMPOSICION_MIXTA o un factor y no
  // vuelve a pensar el default, esta prueba lo detiene.
  const esperado = Object.entries(COMPOSICION_MIXTA)
    .reduce((s, [cat, prop]) => s + FACTORES_CO2[cat] * prop, 0);
  assert.equal(FACTOR_CO2_DEFECTO, Math.round(esperado * 100) / 100);
  assert.equal(FACTOR_CO2_DEFECTO, 1.17, 'valor publicado: 1.17 kgCO₂e/kg');
});

test('las proporciones de la composición mixta suman 1', () => {
  const suma = Object.values(COMPOSICION_MIXTA).reduce((s, p) => s + p, 0);
  assert.equal(Math.round(suma * 100) / 100, 1);
});

test('ningún factor es cero o negativo', () => {
  for (const [categoria, factor] of Object.entries(FACTORES_CO2)) {
    assert.ok(factor > 0, `${categoria} debe tener factor > 0`);
  }
  assert.ok(FACTOR_CO2_DEFECTO > 0);
});

test('el orden de magnitud entre alimentos es el esperado', () => {
  // Carne > pescado/cerdo > pollo > lácteos > cereales > verduras. Si una
  // edición invierte esta escala, el cálculo dejó de tener sentido físico.
  assert.ok(FACTORES_CO2.carne_bovina > FACTORES_CO2.pollo);
  assert.ok(FACTORES_CO2.pollo > FACTORES_CO2.lacteos);
  assert.ok(FACTORES_CO2.lacteos > FACTORES_CO2.cereales);
  assert.ok(FACTORES_CO2.cereales > FACTORES_CO2.verduras);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Proporcionalidad al peso — la razón de ser de este módulo
//
// El valor fijo por bolsa (el histórico "1.4 kgCO₂e") hacía que media libra de
// pan y tres kilos de carne salvaran lo mismo. Estas pruebas impiden que vuelva.
// ════════════════════════════════════════════════════════════════════════════

test('el CO₂ es peso × factor, exactamente', () => {
  assert.equal(co2PorUnidad(1, 'cereales'), 1);
  assert.equal(co2PorUnidad(2, 'cereales'), 2);
  assert.equal(co2PorUnidad(0.5, 'pollo'), 1.85);
  assert.equal(co2PorUnidad(1, 'carne_bovina'), 9.5);
  assert.equal(co2PorUnidad(3, 'verduras'), 1.2);
});

test('duplicar el peso duplica el CO₂ en TODAS las categorías', () => {
  for (const categoria of [...Object.keys(FACTORES_CO2), 'comida_mixta', 'categoria_que_no_existe']) {
    const simple = co2PorUnidad(1, categoria);
    const doble = co2PorUnidad(2, categoria);
    assert.equal(doble, Math.round(simple * 2 * 100) / 100, `categoría ${categoria}`);
  }
});

test('dos bolsas de pesos distintos NUNCA reciben el mismo CO₂', () => {
  // Esta es la prueba de regresión del valor fijo: con "1.4 por bolsa" las tres
  // comparaciones daban iguales.
  const ligera = co2PorUnidad(0.25, 'cereales');
  const media  = co2PorUnidad(1, 'cereales');
  const pesada = co2PorUnidad(3, 'cereales');
  assert.notEqual(ligera, media);
  assert.notEqual(media, pesada);
  assert.ok(ligera < media && media < pesada, 'más peso rescatado, más CO₂ evitado');
});

test('sin peso utilizable no se acredita impacto (0, nunca un fijo)', () => {
  for (const peso of [0, -3, null, undefined, '', 'mucho', NaN]) {
    assert.equal(co2PorUnidad(peso, 'pollo'), 0, `peso=${String(peso)}`);
  }
});

test('el peso llega como string desde PostgREST y se respeta igual', () => {
  assert.equal(co2PorUnidad('2.5', 'cereales'), 2.5);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Categorías: normalización, alias y factor por defecto
// ════════════════════════════════════════════════════════════════════════════

test('la categoría se normaliza: tildes, mayúsculas, espacios y guiones', () => {
  assert.equal(normalizarCategoria('Carne Bovina'), 'carne_bovina');
  assert.equal(normalizarCategoria('carne-bovina'), 'carne_bovina');
  assert.equal(normalizarCategoria('  CARNE   BOVINA  '), 'carne_bovina');
  assert.equal(normalizarCategoria('Lácteos'), 'lacteos');
  assert.equal(normalizarCategoria('raíces y tubérculos'), 'raices_y_tuberculos');
  assert.equal(normalizarCategoria(null), '');
  assert.equal(normalizarCategoria(undefined), '');
});

test('los alias que escribe un restaurante llegan al factor correcto', () => {
  const casos = [
    ['Panadería', 'cereales'],
    ['pan', 'cereales'],
    ['Res', 'carne_bovina'],
    ['carne de res', 'carne_bovina'],
    ['Pescado', 'pescado_mariscos'],
    ['Sushi', 'pescado_mariscos'],
    ['queso', 'lacteos'],
    ['frijoles', 'legumbres'],
  ];
  for (const [entrada, esperada] of casos) {
    const r = factorCO2(entrada);
    assert.equal(r.categoria, esperada, `"${entrada}" → ${esperada}`);
    assert.equal(r.factor, FACTORES_CO2[esperada]);
    assert.equal(r.esDefecto, false);
  }
});

test('una categoría desconocida usa el factor de plataforma, no cero ni null', () => {
  for (const entrada of [null, '', 'lo que sea', 'comida_mixta', 'otro', 'variado']) {
    const r = factorCO2(entrada);
    assert.equal(r.factor, FACTOR_CO2_DEFECTO, `entrada=${String(entrada)}`);
    assert.equal(r.esDefecto, true);
    assert.ok(r.factor > 0, 'el impacto nunca se anula por no saber la categoría');
  }
});

test('el factor viene acompañado de su fuente', () => {
  assert.match(factorCO2('pollo').fuente, /FAO 2013/);
  assert.match(factorCO2('desconocida').fuente, /FAO 2013/);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Agregación determinista
// ════════════════════════════════════════════════════════════════════════════

const unidades = () => ([
  // 3 bolsas de pan de 2 kg: 6 kg × 1.0 = 6.00 kgCO₂e
  { pesoKg: 2, categoriaAlimento: 'cereales', cantidad: 3, precioOriginal: 50, precioPagado: 20 },
  // 1 bolsa de res de 1 kg: 1 kg × 9.5 = 9.50 kgCO₂e
  { pesoKg: 1, categoriaAlimento: 'carne_bovina', cantidad: 1, precioOriginal: 100, precioPagado: 40 },
  // 2 bolsas mixtas de 0.5 kg: 1 kg × 1.17 = 1.17 kgCO₂e
  { pesoKg: 0.5, categoriaAlimento: 'comida_mixta', cantidad: 2, precioOriginal: 30, precioPagado: 15 },
]);

test('la agregación suma unidades, kg, CO₂ y dinero por separado', () => {
  const r = impactoDeUnidades(unidades());
  assert.equal(r.unidades_rescatadas, 6, 'un carrito de 3 bolsas cuenta 3, no 1');
  assert.equal(r.kg_rescatados, 8);
  assert.equal(r.co2_evitado_kg, 16.67);
  assert.equal(r.dinero_ahorrado, 180);   // 30×3 + 60×1 + 15×2
  assert.equal(r.ventas_recuperadas, 130); // 20×3 + 40×1 + 15×2
});

test('el resultado no depende del orden de las filas', () => {
  const base = impactoDeUnidades(unidades());
  const alReves = impactoDeUnidades(unidades().reverse());
  const rotado = impactoDeUnidades([unidades()[2], unidades()[0], unidades()[1]]);
  assert.deepEqual(alReves, base);
  assert.deepEqual(rotado, base);
});

test('la misma entrada da SIEMPRE el mismo resultado', () => {
  const primera = impactoDeUnidades(unidades());
  for (let i = 0; i < 5; i++) assert.deepEqual(impactoDeUnidades(unidades()), primera);
});

test('el CO₂ agregado es exactamente la suma de peso × factor de cada línea', () => {
  const filas = unidades();
  const aMano = filas.reduce(
    (s, u) => s + u.pesoKg * u.cantidad * factorCO2(u.categoriaAlimento).factor, 0);
  assert.equal(impactoDeUnidades(filas).co2_evitado_kg, Math.round(aMano * 100) / 100);
});

test('sumar 1000 líneas pequeñas no acumula error de coma flotante', () => {
  const muchas = Array.from({ length: 1000 }, () => (
    { pesoKg: 0.1, categoriaAlimento: 'cereales', cantidad: 1, precioOriginal: 10, precioPagado: 7 }
  ));
  const r = impactoDeUnidades(muchas);
  assert.equal(r.kg_rescatados, 100);
  assert.equal(r.co2_evitado_kg, 100);
  assert.equal(r.dinero_ahorrado, 3000);
});

test('sin pedidos, todo es cero — nunca null ni NaN', () => {
  const r = impactoDeUnidades([]);
  assert.deepEqual(r, {
    unidades_rescatadas: 0, kg_rescatados: 0, co2_evitado_kg: 0,
    dinero_ahorrado: 0, ventas_recuperadas: 0,
  });
});

test('un precio original menor que el pagado no resta del ahorro de los demás', () => {
  const r = impactoDeUnidades([
    { pesoKg: 1, categoriaAlimento: 'cereales', cantidad: 1, precioOriginal: 50, precioPagado: 20 },
    { pesoKg: 1, categoriaAlimento: 'cereales', cantidad: 1, precioOriginal: 10, precioPagado: 40 },
  ]);
  assert.equal(r.dinero_ahorrado, 30, 'el dato corrupto aporta 0, no -30');
});

test('una fila sin peso ni cantidad usa los valores por defecto de la plataforma', () => {
  const r = impactoDeUnidades([{ categoriaAlimento: 'cereales' }]);
  assert.equal(r.unidades_rescatadas, 1);
  assert.equal(r.kg_rescatados, PESO_UNIDAD_DEFECTO_KG);
  assert.equal(r.co2_evitado_kg, 0.5);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. De pedidos a unidades — modelo híbrido (pedido_items + heredados)
// ════════════════════════════════════════════════════════════════════════════

const tablasBase = () => ({
  pedido_items: [
    { pedido_id: 'p1', cantidad: 3, precio_unitario: 20, bolsas: { peso_estimado_kg: 2, categoria_alimento: 'cereales', precio_original: 50 } },
    { pedido_id: 'p1', cantidad: 1, precio_unitario: 40, bolsas: { peso_estimado_kg: 1, categoria_alimento: 'carne_bovina', precio_original: 100 } },
  ],
  bolsas: [
    { id: BOLSA_PAN, peso_estimado_kg: 2, categoria_alimento: 'cereales', precio_original: 50 },
    { id: BOLSA_RES, peso_estimado_kg: 1, categoria_alimento: 'carne_bovina', precio_original: 100 },
  ],
});

test('un carrito multi-bolsa cuenta cada línea con su cantidad', async () => {
  const cliente = crearCliente(tablasBase());
  const r = await impactoDePedidos([{ id: 'p1', bolsa_id: BOLSA_PAN, cantidad: 4, precio_bolsa: 20 }], { cliente });

  assert.equal(r.unidades_rescatadas, 4, '3 panes + 1 res');
  assert.equal(r.kg_rescatados, 7);
  assert.equal(r.co2_evitado_kg, 15.5);
  assert.equal(r.pedidos_completados, 1);
});

test('un pedido con items NO se cuenta además por su bolsa_id heredada', async () => {
  const cliente = crearCliente(tablasBase());
  const conItems = await impactoDePedidos(
    [{ id: 'p1', bolsa_id: BOLSA_PAN, cantidad: 99, precio_bolsa: 20 }], { cliente });
  // Si el modelo híbrido fallara, el pedido sumaría además 99 unidades por su
  // columna bolsa_id — el doble conteo clásico.
  assert.equal(conItems.unidades_rescatadas, 4);
});

test('un pedido heredado (sin items) se cuenta por su bolsa_id y cantidad', async () => {
  const cliente = crearCliente(tablasBase());
  const r = await impactoDePedidos(
    [{ id: 'legacy', bolsa_id: BOLSA_RES, cantidad: 2, precio_bolsa: 45 }], { cliente });

  assert.equal(r.unidades_rescatadas, 2);
  assert.equal(r.kg_rescatados, 2);
  assert.equal(r.co2_evitado_kg, 19);
  assert.equal(r.dinero_ahorrado, 110); // (100 − 45) × 2
});

test('pedidos con y sin items conviven en la misma agregación', async () => {
  const cliente = crearCliente(tablasBase());
  const r = await impactoDePedidos([
    { id: 'p1', bolsa_id: BOLSA_PAN, cantidad: 4, precio_bolsa: 20 },
    { id: 'legacy', bolsa_id: BOLSA_RES, cantidad: 2, precio_bolsa: 45 },
  ], { cliente });

  assert.equal(r.unidades_rescatadas, 6);
  assert.equal(r.kg_rescatados, 9);
  assert.equal(r.co2_evitado_kg, 34.5); // 15.5 + 19
  assert.equal(r.pedidos_completados, 2);
});

test('sin pedidos no se consulta nada y el impacto es cero', async () => {
  const cliente = {
    from: () => { throw new Error('no debería consultarse la base de datos'); },
  };
  const r = await impactoDePedidos([], { cliente });
  assert.equal(r.unidades_rescatadas, 0);
  assert.equal(r.co2_evitado_kg, 0);
  assert.deepEqual(await unidadesDePedidos([], { cliente }), []);
});

test('si categoria_alimento no existe en la BD se usa el factor por defecto, no cero', async () => {
  // Despliegue sin la migración 18d: la columna no existe y el SELECT falla con
  // 42703. La consulta se reintenta sin ella; el peso sí está, así que el
  // impacto se sigue calculando.
  const cliente = crearCliente(tablasBase(), { sinCategoriaAlimento: true });
  const r = await impactoDePedidos([{ id: 'p1', bolsa_id: BOLSA_PAN, cantidad: 4, precio_bolsa: 20 }], { cliente });

  assert.equal(r.unidades_rescatadas, 4);
  assert.equal(r.kg_rescatados, 7);
  assert.equal(r.co2_evitado_kg, Math.round(7 * FACTOR_CO2_DEFECTO * 100) / 100);
  assert.ok(r.co2_evitado_kg > 0, 'una migración pendiente no puede borrar el impacto');
});

test('miles de pedidos se consultan por lotes y el total no cambia', async () => {
  // El panel de admin agrega todos los pedidos entregados de la plataforma: un
  // único IN(...) con miles de UUIDs no cabe en la URL de PostgREST.
  const N = TAMANO_LOTE * 3 + 7;
  const pedidos = Array.from({ length: N }, (_, i) => (
    { id: 'p' + i, bolsa_id: BOLSA_PAN, cantidad: 1, precio_bolsa: 20 }
  ));
  const tablas = {
    pedido_items: pedidos.map((p) => ({
      pedido_id: p.id, cantidad: 1, precio_unitario: 20,
      bolsas: { peso_estimado_kg: 2, categoria_alimento: 'cereales', precio_original: 50 },
    })),
    bolsas: [],
  };

  const lotes = [];
  const clienteBase = crearCliente(tablas);
  const cliente = {
    from: (tabla) => {
      const q = clienteBase.from(tabla);
      const inOriginal = q.in.bind(q);
      q.in = (campo, valores) => { lotes.push(valores.length); return inOriginal(campo, valores); };
      return q;
    },
  };

  const r = await impactoDePedidos(pedidos, { cliente });

  assert.equal(r.unidades_rescatadas, N);
  assert.equal(r.kg_rescatados, N * 2);
  assert.equal(r.co2_evitado_kg, N * 2);
  assert.equal(lotes.length, 4, '607 pedidos → 4 consultas');
  assert.ok(lotes.every((n) => n <= TAMANO_LOTE), 'ningún lote supera el tamaño máximo');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Qué pedidos entran en una métrica de impacto
// ════════════════════════════════════════════════════════════════════════════

test('solo cuentan los estados en los que la comida ya llegó al cliente', () => {
  assert.deepEqual([...ESTADOS_ENTREGADOS], ['completado', 'recogido']);
  for (const estado of ['borrador', 'pendiente', 'confirmado', 'en_preparacion', 'listo', 'cancelado']) {
    assert.equal(ESTADOS_ENTREGADOS.includes(estado), false,
      `"${estado}" no es comida rescatada: el pedido aún puede caerse`);
  }
});
