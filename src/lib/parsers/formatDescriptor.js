/**
 * Motor de DESCRIPTORES de formato: el modelo reconoce la forma UNA vez, el
 * código la aplica N veces.
 *
 * POR QUÉ EXISTE
 *
 * Pedirle a un LLM que extraiga 40 filas de un extracto apilado falla de una
 * manera concreta y cara: no se inventa datos, los DESPLAZA. Medido sobre un
 * extracto real de cartera gestionada, diez de diecisiete filas salieron con la
 * cantidad del registro anterior, una fila se perdió y otra se duplicó — y los
 * importes eran correctos, así que el error no se ve mirando la tabla.
 *
 * El modelo es bueno reconociendo un formato y malo aplicándolo cuarenta veces
 * seguidas. Así que aquí sólo hace lo primero: describe la FORMA del texto
 * (cuántas líneas ocupa un registro, qué hay en cada una, cómo empieza) y este
 * módulo —determinista— la aplica. Consecuencias:
 *
 *   · No hay desplazamientos: aplicar una plantilla es exacto.
 *   · La salida del modelo son ~200 tokens, no 40 filas: se acabó trocear el
 *     texto, y con ello los cortes a mitad de ficha y el truncado por cupo.
 *   · El descriptor se puede CACHEAR por formato: el segundo import no gasta IA.
 *   · Un descriptor se revisa y se fija con tests; una extracción de 40 filas no.
 *
 * Esto NO sustituye a un parser dedicado (degiro, ibkr, myinvestor…): es el
 * escalón intermedio para los formatos que todavía no tienen uno. Un descriptor
 * que se repite es, justamente, la señal de que ese broker ya merece parser.
 *
 * PURO: sin red y sin estado.
 */

/**
 * @typedef {object} FormatDescriptor
 * @property {'stacked'} layout        Un registro ocupa VARIAS líneas seguidas.
 * @property {string}   startPattern   Regex (fuente) que reconoce la PRIMERA línea de un registro.
 * @property {number}   recordLines    Cuántas líneas ocupa como mucho un registro.
 * @property {boolean}  [dateHeading]  Una línea con sólo una fecha encabeza los registros que le siguen.
 * @property {Array<{offset:number, role:'description'|'amount'|'quantity'|'price'|'date', marker?:string}>} fields
 */

const ROLES = new Set(['description', 'amount', 'quantity', 'price', 'date']);
const RE_SOLO_FECHA = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s*$/;
const RE_NUMERO = /-?\d[\d.,]*/;

/** Compila el descriptor, o explica por qué no vale. Nunca lanza. */
export function validateDescriptor(d) {
  const errores = [];
  if (!d || typeof d !== 'object') return { ok: false, errores: ['descriptor ausente'] };
  if (d.layout !== 'stacked') errores.push(`layout no soportado: ${d.layout}`);
  if (!Number.isInteger(d.recordLines) || d.recordLines < 1 || d.recordLines > 12) {
    errores.push('recordLines debe estar entre 1 y 12');
  }
  let start = null;
  try {
    start = new RegExp(d.startPattern, 'i');
  } catch {
    errores.push('startPattern no es una expresión regular válida');
  }
  const campos = Array.isArray(d.fields) ? d.fields : [];
  if (!campos.some((f) => f.role === 'description')) errores.push('falta el campo description');
  if (!campos.some((f) => f.role === 'amount')) errores.push('falta el campo amount');
  for (const f of campos) {
    if (!ROLES.has(f.role)) errores.push(`rol desconocido: ${f.role}`);
    if (!Number.isInteger(f.offset) || f.offset < 0 || f.offset >= (d.recordLines || 0)) {
      errores.push(`offset fuera del registro: ${f.role}@${f.offset}`);
    }
  }
  return errores.length ? { ok: false, errores } : { ok: true, start, campos };
}

/**
 * Cuál es el separador DECIMAL del documento: ',' , '.' o null si no se prueba.
 *
 * Igual que con las fechas, la convención se deduce del texto ENTERO y no de
 * cada número suelto. Hace falta porque "0,589" y "1.234" son ambiguos por
 * separado —cola de tres cifras, que tanto puede ser decimales como millares—
 * y decidir por número acaba leyendo 0,589 participaciones como 589.
 *
 * Prueba decisiva: un número con los DOS separadores ("1.467,01") dice cuál es
 * cuál. En su defecto, una cola de 1 ó 2 cifras sólo puede ser decimal.
 */
export function detectDecimalSeparator(texto) {
  const t = String(texto || '');
  const ambos = /\d[.,]\d[\d.,]*[.,]\d/.exec(t);
  if (ambos) {
    const s = ambos[0];
    return s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
  }
  if (/\d,\d{1,2}(?!\d)/.test(t)) return ',';
  if (/\d\.\d{1,2}(?!\d)/.test(t)) return '.';
  return null;
}

/**
 * "1.234,56" / "1,234.56" → 1234.56. Devuelve null si no hay número.
 *
 * @param {string} texto
 * @param {','|'.'|null} [decimal]  separador decimal del documento; sin él se
 *   cae a la heurística de "cola de tres cifras = millares", que es lo mejor
 *   que se puede hacer con un número aislado.
 */
export function leerNumero(texto, decimal = null) {
  const m = RE_NUMERO.exec(String(texto || ''));
  if (!m) return null;
  const crudo = m[0].replace(/[.,]+$/, '');
  const ultimoPunto = crudo.lastIndexOf('.');
  const ultimaComa = crudo.lastIndexOf(',');
  const corte = Math.max(ultimoPunto, ultimaComa);
  if (corte < 0) {
    const entero = Number(crudo);
    return Number.isFinite(entero) ? entero : null;
  }

  const esDecimal = decimal
    ? crudo[corte] === decimal
    : crudo.length - corte - 1 !== 3; // sin convención probada: la cola manda

  const n = esDecimal
    ? Number(`${crudo.slice(0, corte).replace(/[.,]/g, '')}.${crudo.slice(corte + 1)}`)
    : Number(crudo.replace(/[.,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const fechaISO = (linea) => {
  const m = RE_SOLO_FECHA.exec(linea);
  if (!m) return null;
  const [, a, b, c] = m;
  const año = c.length === 2 ? `20${c}` : c;
  // Día primero: es la convención de las pantallas europeas que esto cubre. Si
  // el primer componente pasa de 12 no hay duda; si no la hay, se mantiene.
  return `${año}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
};

/**
 * Aplica el descriptor al texto.
 *
 * @param {string} texto
 * @param {FormatDescriptor} descriptor
 * @returns {{ rows: Array<object>, incompletos: number, errores: string[] }}
 *   `incompletos` cuenta SÓLO las líneas que abrían registro y no pudieron
 *   completarse. Las que ni siquiera abren registro (prosa, cabeceras, la tabla
 *   de composición) no son fallos: son texto que no toca.
 */
export function applyFormatDescriptor(texto, descriptor) {
  const v = validateDescriptor(descriptor);
  if (!v.ok) return { rows: [], incompletos: 0, errores: v.errores };

  const lineas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Una sola vez para TODO el documento: ver detectDecimalSeparator.
  const decimal = detectDecimalSeparator(texto);
  const rows = [];
  let incompletos = 0;
  let fecha = null;

  for (let i = 0; i < lineas.length; i += 1) {
    if (descriptor.dateHeading) {
      const f = fechaISO(lineas[i]);
      if (f) { fecha = f; continue; }
    }
    if (!v.start.test(lineas[i])) continue;

    const fila = { date: fecha, description: null, amount: null, quantity: null, price: null, sourceLine: lineas[i] };
    let consumidas = 1;

    for (const campo of v.campos) {
      const linea = lineas[i + campo.offset];
      if (linea === undefined) continue;
      // Un campo con marcador sólo cuenta si el marcador está ahí: es lo que
      // impide leer "Finalizada" como si fueran las participaciones cuando un
      // registro viene incompleto.
      if (campo.marker && !new RegExp(campo.marker, 'i').test(linea)) continue;
      consumidas = Math.max(consumidas, campo.offset + 1);

      if (campo.role === 'description') fila.description = linea;
      else if (campo.role === 'date') fila.date = fechaISO(linea) || fila.date;
      else fila[campo.role] = leerNumero(linea, decimal);
    }

    // Un registro sin descripción o sin importe no es un registro: se ignora en
    // vez de emitir una fila a medias que alguien tendría que completar a mano.
    if (fila.description && fila.amount != null) rows.push(fila);
    else incompletos += 1;

    i += consumidas - 1;
  }

  return { rows, incompletos, errores: [] };
}

/**
 * ¿Merece la pena el descriptor?
 *
 * Se aplica a una MUESTRA antes de usarlo en serio: si sólo entiende la mitad
 * de lo que parece un registro, el formato no es el que el modelo creyó y vale
 * más caer a la extracción fila a fila que importar medio extracto.
 */
export function scoreDescriptor(texto, descriptor, { minRows = 2, minRatio = 0.7 } = {}) {
  const { rows, incompletos, errores } = applyFormatDescriptor(texto, descriptor);
  if (errores.length) return { usable: false, rows: [], ratio: 0, motivo: errores.join('; ') };

  const candidatos = rows.length + incompletos;
  const ratio = candidatos > 0 ? rows.length / candidatos : 0;
  if (rows.length < minRows) {
    return { usable: false, rows, ratio, motivo: `sólo ${rows.length} registro(s) completo(s)` };
  }
  if (ratio < minRatio) {
    return { usable: false, rows, ratio, motivo: `${incompletos} de ${candidatos} registros quedaron a medias` };
  }
  return { usable: true, rows, ratio, motivo: `${rows.length} registros, ${(ratio * 100).toFixed(0)}% completos` };
}
