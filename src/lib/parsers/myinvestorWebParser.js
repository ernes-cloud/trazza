/**
 * Parser del texto COPIADO DE LA WEB de una cartera gestionada de MyInvestor.
 *
 * El XLSX/CSV lo cubre `myinvestorParser`; esto es la otra forma de traer los
 * datos, que resulta ser la que más usa la gente: seleccionar la pantalla y
 * pegar. Hasta ahora eso caía en el import por IA, y ahí se rompía de formas
 * caras — cantidades corridas un registro, filas perdidas, tickers de otro
 * fondo. Todo eso desaparece leyendo el formato, que es perfectamente regular.
 *
 * LO QUE TRAE CADA SECCIÓN (y por qué importa cuál se lee)
 *
 *   Composición  nombre + valor de mercado + variación. NO son transacciones:
 *                es la foto de hoy. Se ignora entera.
 *   Órdenes      ficha de 5 líneas con el nombre COMPLETO, el importe, la
 *                divisa y —esto es lo valioso— las PARTICIPACIONES.
 *   Movimientos  ficha de 2 líneas: nombre truncado a ~30 caracteres e importe.
 *                Sin unidades. Es la cara de caja de las MISMAS suscripciones.
 *
 * ⚠️ Órdenes y Movimientos describen los mismos hechos. Importar las dos
 * duplica la cartera, y sus importes ni siquiera coinciden (81,97 € ordenado
 * frente a 81,89 € liquidado: el fondo se ejecuta al NAV del día). Por eso,
 * cuando el texto trae ambas, las compras salen de ÓRDENES y de Movimientos
 * sólo se recogen las filas que no existen allí: intereses y traspasos. Sin
 * sección de Órdenes, Movimientos aporta todo, en forma monetaria.
 *
 * Contrato del módulo: `parse(texto) → Transaction[]`, igual que el resto de
 * parsers de `src/lib/parsers/`. Puro, sin red.
 */

const ACCIONES = {
  BUY: ['suscripcion', 'suscripción', 'compra', 'aportacion adicional'],
  SELL: ['reembolso', 'venta'],
  FEE: ['liquidac', 'comision', 'comisión', 'intereses'],
  TRANSFER: ['abono por traspaso', 'abono', 'cargo por traspaso', 'cargo', 'traspaso', 'retirada', 'ingreso'],
};

// Palabras de estado y periodicidad: estructura de la ficha, no datos.
const RELLENO = new Set([
  'puntual', 'periodica', 'periódica', 'mensual', 'trimestral',
  'finalizada', 'ejecutada', 'pendiente', 'cancelada', 'en curso', 'completada',
]);

const RE_FECHA = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const RE_FECHA_SUELTA = /(\d{1,2}\/\d{1,2}\/\d{4})/g;
const RE_IMPORTE = /^-?[\d.]*\d(?:,\d+)?\s*(€|eur|us\$|usd|\$|£|gbp|chf)?$/i;
const RE_PARTICIPACIONES = /^(-?[\d.]*\d(?:,\d+)?)\s+participaciones\b/i;

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "1.234,56" → 1234.56 (formato europeo, el único que usa esta pantalla). */
export function parseImporteEuropeo(txt) {
  const limpio = String(txt || '').replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** Divisa declarada junto al importe; EUR cuando no se dice otra cosa. */
export function divisaDe(txt) {
  const t = String(txt || '').toLowerCase();
  if (/us\$|usd|\$/.test(t)) return 'USD';
  if (/£|gbp/.test(t)) return 'GBP';
  if (/chf/.test(t)) return 'CHF';
  return 'EUR';
}

const tipoDeAccion = (linea) => {
  const l = sinTildes(linea);
  for (const [tipo, claves] of Object.entries(ACCIONES)) {
    if (claves.some((k) => l.startsWith(sinTildes(k)))) return tipo;
  }
  return null;
};

/**
 * Parte el texto en líneas lógicas.
 *
 * Hace falta porque quien pega desde un chat trae renglones fusionados con
 * prosa: "4,27 %. Te dejo a continuación las ordenes: 02/09/2026" lleva una
 * cabecera de fecha escondida al final, y "6,94 participaciones. Y los
 * movimientos:" lleva las unidades al principio.
 *
 * Las líneas de ACCIÓN se dejan intactas a propósito: "Liquidac. Intereses
 * PERIODO 02/08/2026 02/09/2026" contiene dos fechas que son parte de su
 * descripción, y trocearla convertiría una de ellas en cabecera, desplazando la
 * fecha de todo lo que viniera detrás.
 */
export function explotarLineas(texto) {
  const salida = [];
  for (const bruta of String(texto || '').split('\n')) {
    const linea = bruta.trim();
    if (!linea) continue;
    if (tipoDeAccion(linea)) { salida.push(linea); continue; }
    linea
      .replace(RE_FECHA_SUELTA, '\n$1\n')
      .replace(/\bparticipaciones\b/gi, 'participaciones\n')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((t) => salida.push(t));
  }
  return salida;
}

/** ¿Tiene el texto una sección de Órdenes (fichas con participaciones)? */
export function tieneOrdenes(texto) {
  return explotarLineas(texto).some((l) => RE_PARTICIPACIONES.test(l));
}

/** 'DD/MM/YYYY' → 'DD-MM-YYYY', la convención de fecha de los parsers. */
const aFechaDisplay = (f) => {
  const [d, m, y] = f.split('/');
  return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
};

/**
 * Nombre del fondo sin la etiqueta de la operación.
 * "Suscripción Fondos de Inversión Fidelity MSCI Japan…" → "Fidelity MSCI Japan…"
 * "Suscripcion Iic ISHARES EMERGING MARKETS INDEX"       → "ISHARES EMERGING MARKETS INDEX"
 */
export function nombreDelFondo(descripcion) {
  const tokens = String(descripcion || '').trim().split(/\s+/);
  const prescindible = new Set([
    'suscripcion', 'compra', 'reembolso', 'venta', 'fondos', 'fondo', 'de',
    'inversion', 'inversiones', 'iic', 'del', 'la', 'el',
  ]);
  let i = 0;
  while (i < tokens.length && prescindible.has(sinTildes(tokens[i]).replace(/[^a-z]/g, ''))) i += 1;
  return tokens.slice(i).join(' ') || String(descripcion || '').trim();
}

/**
 * @param {string} texto  lo que el usuario pegó
 * @returns {Array<object>} transacciones en la convención interna
 */
export function parseMyInvestorWeb(texto) {
  const lineas = explotarLineas(texto);
  const usarOrdenes = lineas.some((l) => RE_PARTICIPACIONES.test(l));
  const transacciones = [];
  let fecha = null;

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];

    if (RE_FECHA.test(linea)) { fecha = linea; continue; }

    const tipo = tipoDeAccion(linea);
    // Una línea que no abre operación es un nombre de la Composición, un
    // encabezado o prosa: nada que importar.
    if (!tipo) continue;

    // El importe es la primera línea numérica que sigue a la descripción.
    const lineaImporte = lineas[i + 1];
    if (!lineaImporte || !RE_IMPORTE.test(lineaImporte)) continue;
    const importe = parseImporteEuropeo(lineaImporte);
    if (importe == null || importe === 0) { i += 1; continue; }
    const moneda = divisaDe(lineaImporte);

    // Tras el importe puede venir el relleno de la ficha de órdenes
    // (periodicidad, estado) y, al final, las participaciones.
    let j = i + 2;
    let unidades = null;
    while (j < lineas.length && j <= i + 5) {
      const m = RE_PARTICIPACIONES.exec(lineas[j]);
      if (m) { unidades = parseImporteEuropeo(m[1]); j += 1; break; }
      if (!RELLENO.has(sinTildes(lineas[j]))) break;
      j += 1;
    }
    i = j - 1;

    const base = {
      fecha: fecha ? aFechaDisplay(fecha) : '',
      hora: '00:00',
      descripcion: linea,
      moneda,
      comisiones: 0,
      isin: '',
    };

    if (tipo === 'FEE' || tipo === 'TRANSFER') {
      transacciones.push({
        ...base,
        type: tipo === 'FEE' ? 'FEE' : 'TRANSFER',
        producto: '',
        cantidad: 0,
        precio: 0,
        // La web no pinta signo: el sentido lo da la acción. Un cargo o una
        // retirada salen de la cuenta; un abono y los intereses entran.
        total: /^(cargo|retirada)/.test(sinTildes(linea)) ? -Math.abs(importe) : Math.abs(importe),
      });
      continue;
    }

    // Las suscripciones del libro de Movimientos se descartan cuando el mismo
    // texto trae Órdenes: son el mismo hecho contado dos veces (ver cabecera).
    const esDeOrdenes = unidades != null;
    if (usarOrdenes && !esDeOrdenes) continue;

    const abs = Math.abs(importe);
    transacciones.push({
      ...base,
      type: tipo === 'SELL' ? 'SELL' : 'BUY',
      producto: nombreDelFondo(linea),
      // Con participaciones es una posición REAL; sin ellas se queda monetaria
      // (cantidad = importe, precio = 1) y marcada noQuote, igual que hace el
      // parser del XLSX: cotizar por nombre un importe en euros corrompe el valor.
      cantidad: unidades != null ? unidades : abs,
      precio: unidades != null ? Math.round((abs / unidades) * 100) / 100 : 1,
      total: tipo === 'SELL' ? abs : -abs,
      ...(unidades == null ? { noQuote: true } : {}),
    });
  }

  return transacciones;
}

/** Contrato común de los parsers de `src/lib/parsers/`. */
export const parse = parseMyInvestorWeb;
