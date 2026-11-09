/**
 * Qué formato merece el siguiente parser dedicado.
 *
 * La plataforma ya guarda telemetría de cada intento de import (`import_logs`:
 * broker, formato, si fue bien, cuántas filas salieron y — si el usuario lo
 * autorizó — una muestra anonimizada). Lo que faltaba era LEERLA con una
 * pregunta concreta: de todo lo que pasa por la IA, ¿qué se repite tanto, falla
 * tanto y es tan regular como para merecer treinta líneas de parser?
 *
 * La respuesta no es "el que más falla": un formato caótico que aparece una vez
 * no se arregla con un parser. Lo que se busca es la intersección de tres cosas:
 *
 *   VOLUMEN      cuánta gente lo trae — si es uno, que lo siga viendo la IA
 *   DOLOR        con qué frecuencia sale mal o sale a medias
 *   REGULARIDAD  si el texto tiene una estructura que un parser pueda leer
 *
 * La tercera es la que decide, y es la que nadie mira: un extracto REGULAR se
 * parsea exacto en una tarde (y entonces deja de gastar IA para siempre); uno
 * irregular no, por mucho que duela. Se mide sola, sin abrir la muestra a mano
 * — ver `estimateRecordShape`.
 *
 * PURO: entra un array de filas de import_logs, sale un ranking. Sin red.
 */

/** Brokers que YA tienen parser determinista: no son candidatos. */
const CON_PARSER = new Set(['degiro', 'ibkr', 'binance', 'myinvestor']);

const RE_FECHA = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/**
 * Cada línea reducida a su CLASE. Es la huella con la que se mide si un formato
 * se repite:
 *
 *   D  una fecha sola — cabecera de grupo
 *   N  un importe: empieza por cifra y como mucho lleva pegado un símbolo o
 *      código de divisa ("5,17 US$", "39,09 €")
 *   U  una cantidad con unidad: cifra y una palabra de verdad detrás
 *      ("0,589 participaciones")
 *   T  texto — descripción o palabra de estado
 *
 * Separar N de U importa: sin esa distinción, "0,589 participaciones" y
 * "Finalizada" caen en la misma clase y la ficha de cinco líneas deja de tener
 * una huella reconocible.
 */
export function lineKinds(texto) {
  return String(texto || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (RE_FECHA.test(l)) return 'D';
      if (!/^[^\p{L}]*\d/u.test(l)) return 'T';
      const letras = (l.match(/\p{L}+/gu) || []).join('');
      return letras.length <= 4 ? 'N' : 'U'; // "US$"/"EUR" es divisa; "participaciones", unidad
    })
    .join('');
}

/**
 * Periodo dominante de la huella: cuántas líneas ocupa un registro, y cómo de
 * bien se sostiene esa hipótesis.
 *
 * Dos decisiones que NO son obvias, y que sin ellas la medida miente:
 *
 * 1. Las cabeceras de fecha se QUITAN antes de medir. No forman parte del
 *    registro y aparecen a intervalos irregulares, así que desplazan la fase y
 *    hunden la puntuación de un formato que en realidad es perfecto.
 *
 * 2. La puntuación se compara contra la LÍNEA BASE de "todas las líneas son de
 *    la misma clase". Sin eso, un texto en prosa —donde cada línea es T—
 *    encajaba con cualquier periodo y sacaba un 1,0: uniformidad no es
 *    estructura. Ahora se mide cuánto MEJORA la hipótesis periódica sobre esa
 *    base, así que la prosa saca 0.
 *
 * Se prefiere el periodo MÁS CORTO: 10 líneas que encajan también encajan con
 * periodo 20, y el registro real es el corto.
 */
export function estimateRecordShape(texto, { maxPeriod = 12, minScore = 0.8 } = {}) {
  const completa = lineKinds(texto);
  const k = completa.replace(/D/g, ''); // las cabeceras no son parte del registro
  if (k.length < 6) return { period: null, score: 0, kinds: completa };

  // Línea base: acertaríamos esto diciendo siempre la clase más frecuente.
  const frec = {};
  for (const c of k) frec[c] = (frec[c] || 0) + 1;
  const base = Math.max(...Object.values(frec)) / k.length;
  if (base >= 0.999) return { period: null, score: 0, kinds: completa }; // todo igual: sin estructura

  let mejor = { period: null, score: 0 };
  for (let p = 2; p <= Math.min(maxPeriod, Math.floor(k.length / 3)); p += 1) {
    let aciertos = 0;
    for (let pos = 0; pos < p; pos += 1) {
      const cuenta = {};
      for (let i = pos; i < k.length; i += p) cuenta[k[i]] = (cuenta[k[i]] || 0) + 1;
      aciertos += Math.max(...Object.values(cuenta));
    }
    const crudo = aciertos / k.length;
    const score = (crudo - base) / (1 - base); // cuánto mejora sobre la línea base
    // > y no >=: ante empate gana el periodo más corto, que es el registro real.
    if (score > mejor.score + 0.001) mejor = { period: p, score };
  }
  const score = Math.max(0, Math.round(mejor.score * 1000) / 1000);
  return score >= minScore
    ? { period: mejor.period, score, kinds: completa }
    : { period: null, score, kinds: completa };
}

/** Clave con la que se agrupan los intentos: broker + formato declarado. */
const claveDe = (fila) => `${fila.broker || 'desconocido'}${fila.format ? ` · ${fila.format}` : ''}`;

/**
 * Rankea los formatos que pasan por la IA según merezcan parser propio.
 *
 * @param {Array<object>} logs  filas de import_logs
 * @param {object} [opts]
 * @param {number} [opts.minIntentos=3]  por debajo de esto no hay patrón, hay anécdota
 * @returns {Array<object>} candidatos ordenados, el primero es el que más renta
 */
export function rankParserCandidates(logs, { minIntentos = 3 } = {}) {
  const grupos = new Map();

  for (const fila of logs || []) {
    // Sólo interesa lo que HOY depende de la IA: si ya hay parser, el trabajo
    // está hecho y sus fallos son otro problema (uno de parser, no de cobertura).
    if (CON_PARSER.has(String(fila.broker || '').toLowerCase())) continue;

    const clave = claveDe(fila);
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        clave, broker: fila.broker || 'desconocido', format: fila.format || null,
        intentos: 0, fallos: 0, vacios: 0, muestras: [], ultimaVez: null,
      });
    }
    const g = grupos.get(clave);
    g.intentos += 1;
    if (fila.ok === false) g.fallos += 1;
    // Un import que "va bien" pero no saca ni una compra es un fallo disfrazado.
    else if ((fila.buy_sell ?? fila.transactions ?? 0) === 0) g.vacios += 1;
    if (fila.csv_sample) g.muestras.push(fila.csv_sample);
    if (fila.created_at && (!g.ultimaVez || fila.created_at > g.ultimaVez)) g.ultimaVez = fila.created_at;
  }

  const candidatos = [];
  for (const g of grupos.values()) {
    if (g.intentos < minIntentos) continue;

    const dolor = (g.fallos + g.vacios) / g.intentos;
    // La regularidad se mide sobre la muestra más larga disponible: es la que
    // más estructura enseña. Sin muestras no se puede juzgar, y se dice.
    const muestra = g.muestras.slice().sort((a, b) => b.length - a.length)[0] || null;
    const forma = muestra ? estimateRecordShape(muestra) : { period: null, score: 0 };

    candidatos.push({
      clave: g.clave,
      broker: g.broker,
      format: g.format,
      intentos: g.intentos,
      fallos: g.fallos,
      vacios: g.vacios,
      dolor: Math.round(dolor * 100) / 100,
      regularidad: Math.round(forma.score * 100) / 100,
      lineasPorRegistro: forma.period,
      muestras: g.muestras.length,
      ultimaVez: g.ultimaVez,
      // El volumen entra en logaritmo a propósito: que un formato aparezca 50
      // veces en vez de 25 no lo hace el doble de urgente, pero 3 veces en vez
      // de 1 sí cambia la decisión.
      prioridad: Math.round(Math.log2(1 + g.intentos) * (0.25 + dolor) * (0.25 + forma.score) * 100) / 100,
      veredicto: !muestra
        ? 'sin muestras: pide un informe de fallo para poder juzgarlo'
        : forma.period
          ? `formato regular de ${forma.period} líneas por registro — parser barato`
          : 'irregular: la IA sigue siendo la herramienta adecuada',
    });
  }

  return candidatos.sort((a, b) => b.prioridad - a.prioridad);
}
