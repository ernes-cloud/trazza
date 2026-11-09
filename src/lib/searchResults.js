/**
 * Presentación de los resultados del buscador de activos (DashboardLayout).
 * Puro y sin React: qué título lleva cada fila, en qué orden van y qué parte
 * del texto se resalta.
 */
import { isOpaqueTicker } from './tickerLabel';
import { isHeldInvestedPosition } from './positionKind';
import { resolveQuoteSymbol } from '../services/quoteSymbol';

/**
 * Símbolos con los que el buscador reconoce una posición abierta ("En cartera").
 * Lleva el ticker GUARDADO y el símbolo con el que se COTIZA: un fondo de
 * MyInvestor se guarda como "VANGUARD 20 (EUR)" y Yahoo lo devuelve como
 * 0P0000CV2T.F; comparando solo el guardado, un fondo nunca salía "En cartera".
 * @param {Array<{ quantity: number|string, assets?: { ticker?: string, asset_class?: string } }>} positions
 * @returns {Set<string>}
 */
export function portfolioSymbols(positions) {
  const symbols = new Set();
  for (const p of positions || []) {
    if (!isHeldInvestedPosition(p)) continue;
    const ticker = p.assets?.ticker;
    if (!ticker) continue;
    symbols.add(ticker);
    const quoted = resolveQuoteSymbol(ticker);
    if (quoted) symbols.add(quoted);
  }
  return symbols;
}

// Los espacios no cuentan al comparar: la gente escribe "s&p500" y Yahoo
// devuelve "S&P 500" (y al revés), y "vanguard20" es "Vanguard 20".
const squash = (s) => (s || '').toLowerCase().replace(/\s+/g, '');

/**
 * Rango [inicio, fin) de `query` dentro de `text`, ignorando espacios y
 * mayúsculas, o null si no aparece.
 * @param {string} text
 * @param {string} query
 * @returns {[number, number] | null}
 */
export function findMatchRange(text, query) {
  const q = squash(query);
  if (!text || !q) return null;
  // Posición en `text` de cada carácter que no es espacio.
  const positions = [];
  for (let i = 0; i < text.length; i += 1) if (!/\s/.test(text[i])) positions.push(i);
  const at = squash(text).indexOf(q);
  if (at === -1) return null;
  return [positions[at], positions[at + q.length - 1] + 1];
}

/**
 * Título y subtítulo de una fila. Un símbolo opaco (0P…, ISIN) no le dice nada
 * a nadie: entonces manda el NOMBRE y el símbolo baja a la segunda línea.
 * @param {{ symbol: string, displaySymbol?: string, description?: string }} result
 * @returns {{ title: string, subtitle: string }}
 */
export function resultLabels(result) {
  const symbol = result.displaySymbol || result.symbol || '';
  const name = result.description || '';
  if (name && name !== symbol && isOpaqueTicker(symbol)) return { title: name, subtitle: symbol };
  return { title: symbol, subtitle: name === symbol ? '' : name };
}

// Derivados: Trazza sigue carteras de contado. Buscar "apple" devolvía dos
// futuros (SAAPL=F, XAAPL=F) entre la acción y sus otras cotizaciones. No se
// quitan —alguien puede buscarlos—, pero van detrás de todo lo demás.
const DEPRIORITIZED_TYPES = new Set(['FUTURE', 'OPTION']);
const MATCH_RANKS = 4;

const rankOf = (result, q) => {
  const symbol = squash(result.displaySymbol || result.symbol);
  const name = squash(result.description);
  let rank = 3;
  if (symbol === q) rank = 0;
  else if (symbol.startsWith(q) || name.startsWith(q)) rank = 1;
  else if (symbol.includes(q) || name.includes(q)) rank = 2;
  return DEPRIORITIZED_TYPES.has((result.type || '').toUpperCase()) ? rank + MATCH_RANKS : rank;
};

/**
 * Reordena SIN mutar: símbolo exacto → empieza por la búsqueda → la contiene →
 * resto, y los derivados detrás. Entre empatados se respeta el orden de Yahoo
 * (ya trae su relevancia).
 * @template {{ symbol: string, displaySymbol?: string, description?: string }} T
 * @param {T[]} results
 * @param {string} query
 * @returns {T[]}
 */
export function rankSearchResults(results, query) {
  const q = squash(query);
  if (!q) return [...results];
  return results
    .map((result, index) => ({ result, index, rank: rankOf(result, q) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ result }) => result);
}

/**
 * Lo que sale del proveedor, listo para pintar: sin filas sin símbolo, sin
 * símbolos repetidos (rompen la key de React y la navegación con flechas) y
 * ordenado con `rankSearchResults`.
 * @template {{ symbol?: string }} T
 * @param {T[]} raw
 * @param {string} query
 * @returns {T[]}
 */
export function prepareSearchResults(raw, query) {
  const seen = new Set();
  const unique = (raw || []).filter((r) => {
    if (!r?.symbol || seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
  return rankSearchResults(unique, query);
}

const TYPE_KEYS = {
  EQUITY: 'equity',
  ETF: 'etf',
  MUTUALFUND: 'fund',
  INDEX: 'index',
  CRYPTOCURRENCY: 'crypto',
  CURRENCY: 'currency',
  FUTURE: 'future',
  OPTION: 'option',
};

/**
 * Clave i18n de la etiqueta de un tipo de activo de Yahoo, o null si no se
 * conoce (entonces se enseña el tipo tal cual).
 * @param {string | null | undefined} type
 * @returns {string | null}
 */
export function typeLabelKey(type) {
  const key = TYPE_KEYS[(type || '').toUpperCase()];
  return key ? `search_types.${key}` : null;
}

/**
 * 'up' | 'down' | 'flat'. Lo que se pinta con 2 decimales como +0,00% es
 * 'flat': un activo que no se ha movido no ha subido.
 * @param {number | null | undefined} pct
 */
export function changeTone(pct) {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return 'flat';
  return pct > 0 ? 'up' : 'down';
}
