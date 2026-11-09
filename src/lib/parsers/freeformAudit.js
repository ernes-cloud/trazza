/**
 * Auditoría de lo que extrajo el modelo CONTRA el texto que pegó el usuario.
 *
 * El contrato del prompt es que el LLM sólo EXTRAE: nunca calcula, nunca
 * completa, nunca deduce. Esto es lo que comprueba que se haya cumplido. Cada
 * cifra que devuelve una fila (importe, cantidad, precio) tiene que aparecer
 * LITERALMENTE junto a la línea que el propio modelo citó como origen.
 *
 * Por qué hace falta: un extracto copiado de una web llega APILADO —una línea
 * por campo—, así que dos transacciones seguidas son «nombre, importe, nombre,
 * importe». Ahí el fallo típico del modelo no es inventarse un número, es
 * DESPLAZAR el emparejamiento y darle a un fondo el importe del siguiente. Eso
 * no se ve en la tabla de revisión: la celda trae un número con la pinta
 * correcta. Caso real (cartera gestionada de MyInvestor): la fila «ISHARES US
 * INDEX FUND IE S EUR» se importó con 39,08 €, que es el importe del ESG
 * Screened; los 81,89 € que le tocaban desaparecieron con su fila.
 *
 * Qué hace al detectarlo: NADA destructivo. Marca el campo en `unverified` y
 * la tabla de revisión lo pinta en ámbar para que lo mire una persona. Misma
 * filosofía que `isPlausiblePriceUpdate` o `assessEpsPlausibility`: el dato no
 * se borra, se señala.
 *
 * La regla es deliberadamente estrecha: **el importe de una fila es el primer
 * número que aparece de su línea en adelante**. En un extracto apilado eso es
 * la línea siguiente a la descripción; en un CSV o una tabla, la propia línea.
 * No hay ventanas que afinar ni constantes por formato.
 *
 * Se probó antes a delimitar el grupo con las líneas que el modelo citó para
 * las demás filas, y falla precisamente en el caso real: como el modelo SE
 * SALTÓ una fila, su hueco ensanchaba el grupo del vecino justo hasta engullir
 * el importe equivocado, y la comprobación daba por buena la fila mala.
 *
 * La CANTIDAD se audita con otra regla, porque vive en otro sitio: en unas
 * «Órdenes» las participaciones van al final del grupo, detrás del estado. Ahí
 * la ventana llega hasta la línea que el modelo citó para la fila siguiente, y
 * sobre todo NO MIRA HACIA ARRIBA. Eso es lo que caza el fallo observado: al
 * pegar unas órdenes reales, diez de diecisiete filas se llevaron la cantidad
 * del registro ANTERIOR (a «iShares US Equity, 81,97 €» le puso 4,06
 * participaciones, que eran las del ESG Screened). Una cantidad legítima nunca
 * está por encima de su descripción, así que mirar sólo hacia abajo no puede
 * dar un falso positivo por esa vía.
 *
 * Alcance honesto: esto es una red para dos fallos concretos, no una
 * demostración de que la extracción sea correcta.
 *
 * PURO: sin red, sin estado. Entra (filas, texto), sale (filas anotadas).
 */

/** Cada campo tiene su regla de ventana: ver la cabecera del módulo. */
const AUDITED_FIELDS = ['amount', 'quantity'];

// Un token numérico: empieza en dígito y sigue con dígitos y separadores. Deja
// fuera las barras de las fechas (07/09/2026 se lee como 07, 09 y 2026).
const NUMBER_TOKEN = /\d[\d.,]*/g;

const EPSILON = 0.005;

/**
 * Lecturas plausibles de un token numérico tal y como está escrito.
 *
 * Devuelve un ARRAY porque "1,234" es genuinamente ambiguo (mil doscientos
 * treinta y cuatro, o uno coma doscientos treinta y cuatro) y aquí interesa
 * equivocarse hacia el lado bueno: aceptar de más sólo deja pasar una fila mala
 * de vez en cuando; aceptar de menos marcaría en ámbar filas correctas y
 * enseñaría al usuario a ignorar el aviso, que es como se pierde una alarma.
 */
export function readNumberToken(token) {
  const clean = String(token || '').replace(/[.,]+$/, '');
  if (!clean) return [];

  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');
  const plain = Number(clean.replace(/[.,]/g, ''));
  const readings = [];

  const decimalAt = Math.max(lastDot, lastComma);
  if (decimalAt >= 0) {
    const tail = clean.slice(decimalAt + 1);
    const asDecimal = Number(
      `${clean.slice(0, decimalAt).replace(/[.,]/g, '')}.${tail}`
    );
    // Una cola de exactamente 3 cifras puede ser un separador de millares, así
    // que ese token admite las DOS lecturas; cualquier otra longitud no.
    if (Number.isFinite(asDecimal)) readings.push(asDecimal);
    if (tail.length === 3 && Number.isFinite(plain)) readings.push(plain);
  } else if (Number.isFinite(plain)) {
    readings.push(plain);
  }

  return readings.filter((n) => Number.isFinite(n));
}

/** Todos los valores numéricos que aparecen en un trozo de texto. */
export function numbersIn(text) {
  const out = [];
  for (const match of String(text || '').match(NUMBER_TOKEN) || []) {
    out.push(...readNumberToken(match));
  }
  return out;
}

/**
 * Las líneas tal y como las numeró el servidor antes de mandarlas al modelo
 * (recortadas y sin vacías). Tiene que coincidir EXACTAMENTE con
 * `server/routes/parseFreeform.js`, o los índices no cuadran y la auditoría
 * mira la ventana equivocada.
 */
export function sourceLines(rawText) {
  return String(rawText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Índices de las líneas de las que pudo salir esta fila. */
function locate(lines, sourceLine) {
  const needle = String(sourceLine || '').trim();
  if (!needle) return [];
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    // El servidor recorta `sourceLine` a 200 caracteres, así que una línea
    // larga llega truncada y no puede compararse por igualdad.
    if (lines[i] === needle || lines[i].startsWith(needle) || needle.startsWith(lines[i])) hits.push(i);
  }
  return hits;
}

const near = (value, pool) => pool.some((n) => Math.abs(Math.abs(n) - Math.abs(value)) < EPSILON);

/**
 * Anota cada fila con los campos numéricos que NO ha podido encontrar en el
 * texto de origen.
 *
 * Cifras de la propia línea MÁS las del primer renglón con cifras por debajo.
 *
 * Hacen falta las dos: en un CSV el importe está en la línea, y en un extracto
 * apilado en la de abajo. Y no vale con quedarse en la primera que tenga
 * números, porque una descripción puede traer los suyos y tapar la de abajo
 * («Liquidac. Intereses PERIODO 02/08/2026 02/09/2026», cuyo importe real,
 * 0,06 €, va en el renglón siguiente).
 *
 * Lo que esto concede: en un formato de UNA línea por transacción, el conjunto
 * incluye también las cifras de la transacción siguiente, así que un
 * desplazamiento entre líneas contiguas ahí no se detecta. Se acepta porque el
 * fallo que esto persigue es el de los formatos apilados, y porque un CSV de
 * verdad ni siquiera pasa por el modelo: lo enruta `detectBrokerCsv`.
 */
function amountsNear(lines, at, lookahead) {
  const own = numbersIn(lines[at] || '');
  for (let i = at + 1; i <= Math.min(at + lookahead, lines.length - 1); i += 1) {
    const found = numbersIn(lines[i]);
    if (found.length > 0) return [...own, ...found];
  }
  return own;
}

/**
 * Anota cada fila con los campos numéricos que NO ha podido encontrar en el
 * texto de origen.
 *
 * @param {Array<object>} rows         filas neutras del modelo (con `sourceLine`)
 * @param {string} rawText             el texto que pegó el usuario
 * @param {object} [opts]
 * @param {number} [opts.lookahead=3]  renglones que se miran por debajo de la
 *   línea citada buscando el primero con cifras. Tres cubre la descripción y un
 *   par de renglones de relleno; más empezaría a alcanzar el importe del vecino.
 * @param {number} [opts.maxSpan=10]   tope de renglones del grupo al auditar la
 *   CANTIDAD, para el caso degenerado de una única fila en un texto larguísimo.
 * @returns {Array<object>} las mismas filas; las dudosas con `unverified: [...]`
 */
export function auditFreeformRows(rows, rawText, { lookahead = 3, maxSpan = 10 } = {}) {
  const all = rows || [];
  const lines = sourceLines(rawText);
  // Sin texto no hay contra qué auditar (la vía de imágenes no tiene ninguno):
  // devolver las filas intactas es lo correcto, no marcarlas todas.
  if (lines.length === 0) return all;

  const anchorsByRow = all.map((row) => locate(lines, row?.sourceLine));
  // El grupo de una fila acaba donde empieza el de la siguiente, y las líneas
  // citadas por las demás filas son la única señal fiable de dónde es eso.
  const boundaries = [...new Set(anchorsByRow.flat())].sort((a, b) => a - b);
  const groupEnd = (at) => {
    const next = boundaries.find((b) => b > at);
    return Math.min(next === undefined ? lines.length - 1 : next - 1, at + maxSpan, lines.length - 1);
  };

  return all.map((row, idx) => {
    const anchors = anchorsByRow[idx];
    // Una fila cuya línea de origen no aparece en el texto no es sospechosa:
    // es sencillamente inauditable (troceado, recorte, texto reformateado).
    if (anchors.length === 0) return row;

    // Con la misma descripción repetida, vale con que CUALQUIERA de sus
    // apariciones respalde la cifra.
    const poolImporte = anchors.flatMap((at) => amountsNear(lines, at, lookahead));
    const poolCantidad = anchors.flatMap((at) => numbersIn(lines.slice(at, groupEnd(at) + 1).join(' ')));
    const pools = { amount: poolImporte, quantity: poolCantidad };

    const unverified = AUDITED_FIELDS.filter((field) => {
      const value = row?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const pool = pools[field];
      // Sin nada contra lo que comparar no se acusa a nadie.
      return pool.length > 0 && !near(value, pool);
    });

    return unverified.length > 0 ? { ...row, unverified } : row;
  });
}
