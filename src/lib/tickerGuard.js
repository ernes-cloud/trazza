/**
 * Guarda de tickers: evita GASTAR peticiones en símbolos que no se pueden cotizar.
 *
 * Medido en la consola del owner, una sola carga del Dashboard pedía a Yahoo
 * `CASH_EUR`, `CASH_CAD`, `CASH_GBP`, `CASH_USD` (posiciones de LIQUIDEZ), más
 * `Interés` (una descripción de comisión de DeGiro que acabó de "ticker") y
 * `NLFLATEXACNT` (el identificador de cuenta de flatex). Todas devuelven 404
 * "symbol may be delisted", todas se REINTENTABAN, y todas volvían a pedirse en
 * la siguiente carga. Son peticiones que nunca podrán funcionar, y cada una
 * acerca el 429 que sí tumba a un activo de verdad.
 *
 * Dos capas:
 *   1. `isQuotableTicker` — PURA y barata: descarta lo que se ve a simple vista
 *      (liquidez, espacios, acentos, caracteres imposibles en un símbolo).
 *   2. Caché NEGATIVA — un 404 de Yahoo es información PERMANENTE: ese símbolo
 *      no existe. Se recuerda para no volver a preguntarlo en días. Es lo que
 *      cubre los casos que ninguna heurística puede adivinar (`NLFLATEXACNT`).
 *
 * Un 429 NO entra aquí: es transitorio y el símbolo puede ser perfectamente
 * válido. Confundirlos dejaría un activo real sin precio durante una semana.
 */

export const UNQUOTABLE_LS_KEY = 'wf_unquotable_v1';
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 días

/** Símbolos de Yahoo: letras, dígitos y `. - ^ = _`. Nada más. */
const SYMBOL_RE = /^[A-Za-z0-9.\-^=_]+$/;

/**
 * ¿Tiene sentido pedirle este símbolo a un proveedor de mercado?
 *
 * NO aplica tope de longitud a propósito: `fundNavEnricher` fabrica símbolos
 * legítimos y largos (`IE00B4L5Y983.EUFUND`, `0P00019OG5.F`), así que un límite
 * corto dejaría fondos reales sin precio. Lo que no se puede adivinar lo caza
 * la caché negativa.
 */
export function isQuotableTicker(ticker) {
  if (typeof ticker !== 'string') return false;
  const t = ticker.trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;                       // nombre de fondo sin resolver
  if (t === 'CASH' || t.toUpperCase().startsWith('CASH_')) return false;  // liquidez, no activo
  return SYMBOL_RE.test(t);                             // acentos y demás fuera
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function createTickerGuard({
  storage = defaultStorage(),
  key = UNQUOTABLE_LS_KEY,
  ttl = DEFAULT_TTL,
  now = () => Date.now(),
} = {}) {
  const read = () => {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };

  const write = (map) => {
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify(map)); } catch { /* cuota: no es crítico */ }
  };

  /** Marca un símbolo como inexistente. SOLO para fallos permanentes (404). */
  const markUnquotable = (ticker) => {
    if (typeof ticker !== 'string' || !ticker) return;
    const map = read();
    map[ticker] = now();
    write(map);
  };

  const isKnownUnquotable = (ticker) => {
    const ts = read()[ticker];
    if (typeof ts !== 'number') return false;
    if (now() - ts > ttl) return false;   // caducó: se le da otra oportunidad
    return true;
  };

  /** La pregunta que hacen los llamantes: ¿me ahorro esta petición? */
  const shouldSkip = (ticker) => !isQuotableTicker(ticker) || isKnownUnquotable(ticker);

  const clear = () => write({});

  return { markUnquotable, isKnownUnquotable, shouldSkip, clear };
}

/** Instancia compartida por la app (los tests crean la suya con storage falso). */
export const tickerGuard = createTickerGuard();
