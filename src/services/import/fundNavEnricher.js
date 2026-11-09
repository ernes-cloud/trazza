/**
 * NAV enrichment for MyInvestor Movimientos fund rows.
 *
 * The Movimientos XLSX carries no ISIN/units/price, so the parser emits
 * MONETARY rows (cantidad = |importe|, precio = 1, noQuote). This service
 * upgrades them to REAL positions when it can do so with confidence:
 *
 *   fund name → Yahoo search (MUTUALFUND/ETF only + strict name validation)
 *             → historical NAV at the purchase date
 *             → units = |importe| / NAV
 *
 * Any row that fails ANY step keeps its monetary representation — a wrong
 * guess here would corrupt the portfolio value, so no fuzzy fallbacks.
 *
 * PURE: Yahoo access is injected ({ searchTickers, getHistoricalData }) so the
 * decision logic is fully unit-testable offline.
 */

const GENERIC_TOKENS = new Set(['fund', 'index', 'ucits', 'etf', 'class', 'acc', 'inc', 'inst', 'the']);

// Yahoo lists one symbol per share class (EUR/USD/PLN…) with DIFFERENT NAVs.
// Currency tokens are excluded from name matching (many classes omit them and
// the share-class currency is verified via getQuote) but a candidate that
// DECLARES another currency is a wrong class and gets rejected outright.
const CURRENCY_TOKENS = new Set(['eur', 'usd', 'gbp', 'gbx', 'chf', 'pln', 'jpy', 'aud', 'cad', 'sek', 'nok', 'dkk']);

// The broker truncates fund names to ~30 chars with aggressive abbreviations
// Yahoo's search can't bridge. Deterministic expansions, applied to both the
// search query and the validation reference.
const ABBREVIATIONS = {
  bgif: 'blackrock', // BlackRock Global Index Funds
  mkt: 'markets',
  em: 'emerging',
  gover: 'government',
  bd: 'bond',
  inde: 'index',
  idx: 'index',
  glb: 'global',
  corp: 'corporate',
  pacfc: 'pacific',
  exjapn: 'ex japan',
};

// MyInvestor's carteras automatizadas hold a FIXED public set of index funds,
// but Yahoo's name search can't find several EUR classes. Curated broker-name
// entries (each verified live):
//   isin     — Yahoo/EODHD ISIN search resolves it to a EUR class with usable
//              NAV history. A wrong/withdrawn ISIN degrades safely: candidates
//              still pass fund-type, quote-currency and history guards.
//   usdProxy — Yahoo symbol of the fund's USD share class, used as LAST resort
//              when no EUR NAV source exists: units are derived from
//              NAV_USD / EURUSD at the purchase date and the position is then
//              valued through the normal multi-currency quote path. For
//              EUR-HEDGED real classes this proxy shows FX movement the real
//              fund doesn't have — accepted trade-off (value > nothing).
// name — nombre LEGIBLE del fondo (el extracto lo recorta a ~30 caracteres:
// "BGIF EM MKT GOVER BOND INDEX D"). Solo se usa para PINTAR, vía
// curatedFundDisplayName / services/assetDisplayName; el activo guardado y su
// identidad no cambian.
const MYINVESTOR_FUNDS = {
  'FIDELITY MSCI EUROPE INDEX P A': { isin: 'IE00BYX5MD61', name: 'Fidelity MSCI Europe Index Fund P Acc EUR' },
  'FIDELITY MSCI JAPAN INDEX P AC': { isin: 'IE00BYX5N771', name: 'Fidelity MSCI Japan Index Fund P Acc EUR' },
  // Clases verificadas el 2026-10-03 cruzando con el NAV que muestra MyInvestor
  // (una cuenta con la misma cartera, dada de alta a mano con los precios del
  // broker) y con Yahoo. Elegir mal la clase apenas mueve el valor de una
  // posición nueva —sale de la rentabilidad, igual salvo comisión y cobertura—,
  // pero mezclar clases DENTRO de una posición sería grave: de ahí `symbol`.
  //
  // Clase S Acc EUR (IE000QAZP7L2): la misma serie que el US Index. El ISIN
  // curado anterior (IE00BYWYCC39) era el de la clase D.
  'ISHARES EMERGING MARKETS INDEX': { isin: 'IE000QAZP7L2', symbol: '0P0001XF3Z.F', name: 'iShares Emerging Markets Index Fund (IE) S Acc EUR' },
  'VANGUARD US GOVERNMENT BD INDE': { isin: 'IE0007471471', name: 'Vanguard U.S. Government Bond Index Fund EUR Hedged Acc' },
  'FIDELITY MSCI PACFC EXJAPN IDX': { isin: 'IE00BDZVHT63', usdProxy: '0P0001COSJ', name: 'Fidelity MSCI Pacific ex-Japan Index Fund P Acc EUR' },
  // La clase de MyInvestor es la EUR (LU1811365292: 139,60 € en el broker,
  // 137,26 € en Yahoo), pero Yahoo NO tiene su histórico — el ISIN solo sirve
  // para EODHD; sin clave de EODHD se sigue valorando con la clase USD.
  'BGIF EM MKT GOVER BOND INDEX D': { isin: 'LU1811365292', usdProxy: '0P0001DCMP', name: 'iShares Emerging Markets Government Bond Index Fund (LU) D2 EUR' },
  // Clase D EUR Hedged (IE00BJN4RG66): MyInvestor enseña ~9,76 €, y la USD
  // que se usaba como aproximación equivale a ~8,5 € y además metía un
  // movimiento de divisa que un fondo cubierto no tiene. La USD queda de respaldo.
  'ISHARES ESG SCREENED GLB CORP': { isin: 'IE00BJN4RG66', symbol: '0P0001JAFO.F', usdProxy: '0P0001LKD2', name: 'iShares ESG Screened Global Corporate Bond Index Fund D EUR Hedged' },
  // symbol — símbolo EXACTO verificado a mano. Se usa cuando el nombre del
  // extracto es tan ambiguo que ninguna búsqueda puede acertar: "VANGUARD 20"
  // devuelve la clase Institucional Plus ANTES que la del particular, y las dos
  // son el mismo fondo con NAV distinto (61,15 € contra 125,89 € el mismo día).
  // Con la institucional, una posición de 146,77 € se enseñaba como 70,93 €.
  'VANGUARD 20': { symbol: '0P0000CV2T.F', name: 'Vanguard 20+ Year Euro Treasury Index Fund EUR Acc' },
  // El extracto dice la clase ("IE S EUR") pero el nombre no tiene ninguna
  // palabra discriminante (ver curatedIsinForFundName), así que por búsqueda
  // NUNCA se resolvía y la posición se quedaba monetaria. Verificado
  // 2026-10-03: la búsqueda por este ISIN en Yahoo devuelve justo
  // "iShares US Index (IE) S Acc EUR", cotiza en EUR y tiene histórico diario.
  'ISHARES US INDEX FUND IE S EUR': { isin: 'IE000N4ZYX28', symbol: '0P0001XF42.F', name: 'iShares US Equity Index Fund (IE) S Acc EUR' },
};

/**
 * Otras grafías con las que el extracto de MyInvestor nombra un fondo curado →
 * su nombre canónico (clave de MYINVESTOR_FUNDS). Sin esto, una grafía nueva
 * abría una SEGUNDA posición del mismo fondo, y además en euros porque la
 * búsqueda por nombre no la resolvía (reimport real del 2026-10-15:
 * "ISHARES US INDEX FUND (IE) - S" = clase S Acc EUR, 0P0001XF42.F).
 */
const FUND_NAME_ALIASES = {
  'ISHARES US INDEX FUND (IE) - S': 'ISHARES US INDEX FUND IE S EUR',
};

/** Nombre canónico de un fondo del extracto (sin tocar los que no tienen alias). */
export function canonicalFundName(name) {
  const limpio = String(name || '').trim();
  return FUND_NAME_ALIASES[limpio.toUpperCase()] || limpio;
}

// Clave de MYINVESTOR_FUNDS para un nombre tal como se guarda ("NOMBRE [importe] (EUR)").
const curatedKey = (name) => canonicalFundName(
  String(name || '')
    .replace(/\s*\[.*?\]/g, '')
    .replace(/\s*\([A-Z]{3}\)\s*$/i, '')
).toUpperCase();

/**
 * Regiones que un nombre de fondo EXCLUYE: "Pacific ex-Japan" no es Japón, y
 * "World ex-US" no es EE.UU.
 *
 * Hace falta porque el matcher difuso cuenta "japan" como acierto tanto si el
 * nombre lo incluye como si lo excluye, y con eso el ISIN del Fidelity MSCI
 * Japan se le llegó a asignar al Fidelity MSCI Pacific ex-Japan: dos fondos
 * distintos con el mismo ticker y, por tanto, con el NAV del que no es.
 *
 * Como el extracto abrevia ("EXJAPN"), se reconocen las dos formas: la palabra
 * suelta "ex" seguida de la región, y el pegote "ex…" dentro de un token.
 */
function excludedRegions(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  const out = new Set();
  tokens.forEach((tok, i) => {
    if (tok === 'ex' && tokens[i + 1]) out.add(tokens[i + 1].slice(0, 4));
    else if (tok.length > 3 && tok.startsWith('ex')) out.add(tok.slice(2, 6));
  });
  return out;
}

/**
 * Palabras que IDENTIFICAN al fondo y aparecen en los dos nombres.
 *
 * Se descartan la marca (siempre coincide y no distingue nada), las genéricas
 * ("fund", "index", "acc"…), las divisas y todo lo de menos de tres letras. Lo
 * que queda es lo que de verdad separa un producto de su hermano: "japan",
 * "europe", "government", "treasury".
 *
 * Un nombre que no aporta NINGUNA de estas palabras no es identificable por
 * nombre, y ahí lo correcto es no resolver en vez de acertar por casualidad.
 */
function sharedDiscriminators(a, b) {
  const significativas = (s) => {
    const [, ...resto] = normalizeName(s).split(' ').filter(Boolean); // fuera la marca
    return resto.filter((t) => t.length >= 3 && !/^\d/.test(t) && !GENERIC_TOKENS.has(t) && !CURRENCY_TOKENS.has(t));
  };
  const ta = significativas(a);
  const tb = significativas(b);
  return ta.filter((t) => tb.some((o) => o.startsWith(t) || t.startsWith(o))).length;
}

/** ¿Los dos nombres excluyen lo mismo? Si no, son fondos distintos. */
function sameExclusions(a, b) {
  const ea = excludedRegions(a);
  const eb = excludedRegions(b);
  if (ea.size !== eb.size) return false;
  for (const r of ea) if (!eb.has(r)) return false;
  return true;
}

/**
 * ISIN curado para un nombre de fondo tal y como lo escribe el broker, o null.
 *
 * Lo consume TAMBIÉN el import por IA (`resolveMissingTickers`): cuando alguien
 * pega el «Movimientos» de su cartera gestionada, los nombres que llegan son
 * literalmente estas claves truncadas, y buscarlas por nombre en Yahoo no da
 * con la clase correcta. Si el mapa ya sabe el ISIN, no hay nada que adivinar.
 */
export function curatedIsinForFundName(brokerName) {
  const texto = String(brokerName || '').trim().toUpperCase();
  if (!texto) return null;
  if (MYINVESTOR_FUNDS[texto]?.isin) return MYINVESTOR_FUNDS[texto].isin;

  // Las claves son los nombres TRUNCADOS a ~30 caracteres del libro de
  // movimientos, pero el mismo fondo llega con su nombre COMPLETO desde la
  // pantalla de órdenes ("…JAPAN INDEX P AC" frente a "…Japan Index Fund
  // P-ACC-EUR"). Contenerlas no basta, así que se comparan con el mismo
  // matcher difuso que valida los candidatos de Yahoo.
  const conIsin = Object.entries(MYINVESTOR_FUNDS).filter(([, d]) => d.isin);
  for (const [clave, datos] of conIsin) {
    if (texto.includes(clave)) return datos.isin;
  }
  const difusas = conIsin.filter(([clave]) =>
    // Exigir al menos UNA palabra discriminante compartida es lo que impide que
    // un nombre que se queda en la marca case con cualquier fondo de la casa:
    // "ISHARES US INDEX FUND IE S EUR" no tiene ninguna ("us", "ie", "s" son
    // muy cortas; "index" y "fund" son genéricas; "eur" es divisa), y así se
    // llevaba el ISIN del iShares Emerging Markets — otro fondo, −42% de valor.
    sharedDiscriminators(brokerName, clave) >= 1
    && sameExclusions(brokerName, clave)
    && (fundNameMatches(brokerName, clave) || fundNameMatches(clave, brokerName))
  );
  // Sólo si NO hay duda: dos fondos de la misma gestora compitiendo por el
  // mismo nombre es exactamente el caso en el que acertar por casualidad hace
  // daño, así que ahí se prefiere no resolver.
  return difusas.length === 1 ? difusas[0][1].isin : null;
}

/**
 * Símbolo curado y verificado a mano para un nombre de fondo, o null.
 *
 * Lo consulta también el REFRESCO DE PRECIOS, y por delante del mapa persistido
 * de la sesión: si no, un símbolo mal resuelto en un import antiguo se queda
 * para siempre y ni reimportar lo corrige. Mismo principio que ya aplica
 * usePositions con TICKER_MAP — lo curado manda sobre lo adivinado.
 */
export function curatedSymbolForFundName(name) {
  // El activo se guarda como "VANGUARD 20 (EUR)": fuera el sufijo de divisa y
  // los corchetes que añaden algunas superficies (ver curatedKey).
  const clave = curatedKey(name);
  return (clave && MYINVESTOR_FUNDS[clave]?.symbol) || null;
}

/**
 * Clase USD curada (proxy) de un fondo, o null. Mismo saneado del nombre que
 * `curatedSymbolForFundName`.
 *
 * Un símbolo persistido que COINCIDE con el proxy solo puede venir del tier 3
 * del enricher, que derivó las unidades de ese NAV: quien valore la posición
 * tiene que cotizar ESE símbolo y no el curado, o mezcla clases (caso real
 * 2026-10-09: ESG Screened Glb Corp con unidades a 8,65 € del proxy y precio
 * 9,44 € de la clase EUR Hedged, un +9 % que no existe).
 */
export function curatedProxyForFundName(name) {
  const clave = curatedKey(name);
  return (clave && MYINVESTOR_FUNDS[clave]?.usdProxy) || null;
}

/** Nombre legible de un fondo curado (por su nombre de extracto o guardado), o null. */
export function curatedFundDisplayName(name) {
  const clave = curatedKey(name);
  return (clave && MYINVESTOR_FUNDS[clave]?.name) || null;
}

/**
 * Fondo curado al que pertenece un SÍMBOLO de cotización, o null.
 * `isUsdProxy`: se está cotizando la clase USD de un fondo que el usuario
 * tiene en EUR (Yahoo no tiene la clase EUR) — la ficha lo avisa.
 * @param {string} symbol
 * @returns {{ name: string, isUsdProxy: boolean } | null}
 */
export function curatedFundForSymbol(symbol) {
  if (!symbol) return null;
  for (const fund of Object.values(MYINVESTOR_FUNDS)) {
    if (fund.usdProxy === symbol) return { name: fund.name, isUsdProxy: true };
    if (fund.symbol === symbol) return { name: fund.name, isUsdProxy: false };
  }
  return null;
}

const FX_EURUSD_SYMBOL = 'EURUSD=X'; // USD per 1 EUR

const normalizeName = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const expandAbbreviations = (name) =>
  normalizeName(name)
    .split(' ')
    .map((tok) => ABBREVIATIONS[tok] || tok)
    .join(' ');

/**
 * Broker names are truncated to ~30 chars and abbreviate freely
 * ("GOVER BOND", "PACFC EXJAPN"), so exact matching is impossible. Contract:
 *  - the brand (first token) must appear in the candidate
 *  - every numeric token must appear ("VANGUARD 20" ≠ LifeStrategy 80)
 *  - ≥ 60% of the remaining significant tokens (len ≥ 3, non-generic) must
 *    appear as (prefixes of) candidate tokens — prefix matching absorbs the
 *    broker's truncations ("gover" → "government").
 */
export function fundNameMatches(brokerName, candidateName) {
  const queryTokens = normalizeName(brokerName).split(' ').filter(Boolean);
  const candTokens = normalizeName(candidateName).split(' ').filter(Boolean);
  if (queryTokens.length === 0 || candTokens.length === 0) return false;

  const candHas = (tok) => candTokens.some((c) => c.startsWith(tok));

  const [brand, ...rest] = queryTokens;
  if (!candHas(brand)) return false;

  const numeric = rest.filter((tok) => /^\d+%?$/.test(tok));
  if (!numeric.every((tok) => candTokens.some((c) => c === tok || c === `${tok}%`))) return false;

  const significant = rest.filter(
    (tok) => tok.length >= 3 && !/^\d/.test(tok) && !GENERIC_TOKENS.has(tok) && !CURRENCY_TOKENS.has(tok)
  );
  if (significant.length === 0) return true;
  const hits = significant.filter(candHas).length;
  return hits / significant.length >= 0.6;
}

/**
 * Cuántas palabras significativas añade el candidato que el extracto NO pedía.
 *
 * Sirve de desempate entre clases del MISMO fondo, que es donde la búsqueda por
 * nombre se equivoca sin que nada lo note: "Vanguard 20+ Yr € Trs Idx € Acc" y
 * "…Idx Ins Pl € Acc" son el mismo producto con NAV distinto, y Yahoo devuelve
 * la institucional primero.
 *
 * La regla es que la clase del particular es la de nombre MÁS PELADO: cualquier
 * calificador extra —Institutional, Plus, Hedged, una divisa— el extracto lo
 * habría dicho si se aplicara. Ante empate, gana quien menos añade.
 */
function extraClassTokens(queryName, candidateName) {
  const q = new Set(normalizeName(queryName).split(' ').filter(Boolean));
  return normalizeName(candidateName)
    .split(' ')
    .filter((tok) => tok.length >= 3 && !GENERIC_TOKENS.has(tok) && !CURRENCY_TOKENS.has(tok) && !q.has(tok))
    .length;
}

const FUND_TYPES = new Set(['MUTUALFUND', 'ETF']);
const MAX_NAV_GAP_DAYS = 7;
const MAX_QUOTE_CHECKS = 5; // share-class candidates to currency-verify per fund

const declaresOtherCurrency = (candidateName, wanted) => {
  const tokens = normalizeName(candidateName).split(' ');
  return tokens.some((tok) => CURRENCY_TOKENS.has(tok) && tok !== wanted.toLowerCase());
};

// 'DD-MM-YYYY' (parser convention) → epoch ms
const displayDateToMs = (fecha) => {
  const [d, m, y] = (fecha || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1).getTime();
};

const navAtDate = (series, fecha) => {
  const target = displayDateToMs(fecha);
  let best = null;
  let bestGap = Infinity;
  for (const point of series || []) {
    const gap = Math.abs(new Date(point.time).getTime() - target);
    if (point.close > 0 && gap < bestGap) {
      best = point;
      bestGap = gap;
    }
  }
  return best && bestGap <= MAX_NAV_GAP_DAYS * 86_400_000 ? best.close : null;
};

// History range that covers the oldest purchase with margin
const rangeForDates = (fechas) => {
  const oldest = Math.min(...fechas.map(displayDateToMs));
  const years = (Date.now() - oldest) / (365 * 86_400_000);
  if (years < 0.9) return '1y';
  if (years < 1.9) return '2y';
  if (years < 4.5) return '5y';
  return '10y';
};

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Last-resort resolution via EODHD (only wired when the user has an EODHD API
 * key): its /search reports the share-class CURRENCY directly and its EUFUND
 * virtual exchange carries the European fund classes Yahoo doesn't index.
 * Only runs for curated ISINs — never on free-text names.
 */
async function resolveViaEodhd(curatedIsin, fechas, currency, { eodhdSearchTickers, eodhdGetHistory }) {
  if (!curatedIsin || !eodhdSearchTickers || !eodhdGetHistory) return null;
  try {
    const results = await eodhdSearchTickers(curatedIsin);
    const fund = (results || []).find(
      (r) =>
        (r.currency || '').toUpperCase() === currency.toUpperCase() &&
        (!r.type || /fund|etf/i.test(r.type))
    );
    if (!fund) return null;

    const symbol = fund.displaySymbol || `${fund.symbol}.${fund.exchange}`;
    const series = await eodhdGetHistory(symbol, rangeForDates(fechas));
    if (series && fechas.some((f) => navAtDate(series, f) != null)) return { symbol, series };
    console.warn(`[fundNavEnricher] EODHD ${curatedIsin}: sin histórico que cubra las fechas de compra`);
    return null;
  } catch (e) {
    // Visible on purpose: "key inválida / plan sin fondos / 403" must be
    // diagnosable from DevTools — a silent failure here looks like "no funciona".
    console.warn(`[fundNavEnricher] EODHD fallback failed for ${curatedIsin}:`, e?.message);
    return null;
  }
}

/**
 * Tier 3 — the fund's USD share class as pricing proxy. Units are derived from
 * NAV_USD / EURUSD at the purchase date; the resulting position quotes in USD
 * and the app's normal multi-currency path converts it live (same mechanism as
 * a USD stock bought on DeGiro). Caveat: if the real class is EUR-HEDGED the
 * proxy shows FX movement the fund doesn't have — accepted trade-off.
 */
async function resolveViaUsdProxy(proxySymbol, fechas, { getQuote, getHistoricalData, pauseMs }) {
  try {
    const quote = await getQuote(proxySymbol);
    if ((quote?.currency || '').toUpperCase() !== 'USD') return null;

    const range = rangeForDates(fechas);
    const series = await getHistoricalData(proxySymbol, range, '1d');
    if (!series || series.length === 0) return null;

    await sleep(pauseMs);
    const fxSeries = await getHistoricalData(FX_EURUSD_SYMBOL, range, '1d');
    const usable = (fxSeries || []).length > 0 && fechas.some((f) => {
      const nav = navAtDate(series, f);
      const fx = navAtDate(fxSeries, f);
      return nav != null && fx != null && fx > 0;
    });
    return usable ? { symbol: proxySymbol, series, fxSeries } : null;
  } catch (_) {
    return null;
  }
}

/** NAV in EUR at a date — divides by EURUSD when the resolution is a USD proxy */
const navEurAt = (resolution, fecha) => {
  const nav = navAtDate(resolution.series, fecha);
  if (nav == null || !resolution.fxSeries) return nav;
  const fx = navAtDate(resolution.fxSeries, fecha);
  return fx > 0 ? nav / fx : null;
};

/**
 * Re-import determinism: a fund name resolved in a PREVIOUS import must keep
 * resolving to the SAME symbol — Yahoo's search can return a different share
 * class of the same fund on the next run, and different class = different
 * NAV = different qty/price = dedupe keys never match = duplicated history.
 * The persisted ticker_map symbol is tried FIRST; if it died, fall through.
 */
async function resolveKnownSymbol(symbol, fechas, currency, deps) {
  try {
    if (symbol.toUpperCase().endsWith('.EUFUND')) {
      if (!deps.eodhdGetHistory) return null;
      const series = await deps.eodhdGetHistory(symbol, rangeForDates(fechas));
      if (series && fechas.some((f) => navAtDate(series, f) != null)) return { symbol, series };
      return null;
    }
    const quote = await deps.getQuote(symbol);
    if ((quote?.currency || '').toUpperCase() !== currency.toUpperCase()) return null;
    const series = await deps.getHistoricalData(symbol, rangeForDates(fechas), '1d');
    if (series && fechas.some((f) => navAtDate(series, f) != null)) return { symbol, series };
    return null;
  } catch (_) {
    return null;
  }
}

async function resolveFund(name, fechas, currency, deps) {
  const { searchTickers, getHistoricalData, getQuote, pauseMs } = deps;
  try {
    // El símbolo CURADO va por delante del persistido, y el orden importa: un
    // símbolo curado es un hecho verificado a mano; uno persistido es el
    // resultado de una búsqueda pasada, que pudo salir mal. Mientras el
    // persistido ganaba, un error se volvía PERMANENTE — ni reimportando se
    // corregía, porque el propio mapa viejo se reinyecta como knownSymbols
    // (caso real: la clase institucional del Vanguard 20+, la mitad de NAV).
    // La determinación de re-import se mantiene igual: el curado es una
    // constante del código, no un resultado de búsqueda.
    const curadoPrimero = MYINVESTOR_FUNDS[name.toUpperCase()]?.symbol;
    if (curadoPrimero) {
      const viaCurado = await resolveKnownSymbol(curadoPrimero, fechas, currency, deps);
      if (viaCurado) return viaCurado;
    }

    const known = deps.knownSymbols?.[name];
    if (known) {
      const viaKnown = await resolveKnownSymbol(known, fechas, currency, deps);
      if (viaKnown) return viaKnown;
    }
    // Yahoo's fuzzy search chokes on long truncated broker names (returns
    // futures/FX junk) but finds the fund with shorter prefixes and with the
    // broker's abbreviations expanded. Validation always runs against the
    // full EXPANDED name (prefix matching absorbs remaining truncations).
    const expanded = expandAbbreviations(name);
    const expandedTokens = expanded.split(' ');
    // Curated ISIN first: Yahoo's ISIN search exact-matches the share class,
    // so those candidates skip the (abbreviation-fragile) name validation.
    // El símbolo curado ya se intentó al principio (va por delante incluso del
    // persistido); aquí sólo queda el ISIN curado como primera consulta.
    const curated = MYINVESTOR_FUNDS[name.toUpperCase()] || {};
    const attempts = [
      ...(curated.isin ? [{ query: curated.isin, byIsin: true }] : []),
      ...[...new Set([
        name,
        expanded,
        expandedTokens.slice(0, 5).join(' '),
        expandedTokens.slice(0, 4).join(' '),
      ])].filter((q) => q.split(/\s+/).length >= 2).map((query) => ({ query, byIsin: false })),
    ];

    const seen = new Set();
    let quoteChecks = 0;
    let firstAttempt = true;

    yahooAttempts: for (const { query, byIsin } of attempts) {
      // Yahoo throttles bursts and silently returns empty result sets —
      // pace the retries instead of hammering.
      if (!firstAttempt) await sleep(pauseMs);
      firstAttempt = false;
      const results = await searchTickers(query);
      const candidates = (results || [])
        .filter(
          (r) =>
            r.symbol && !seen.has(r.symbol) &&
            FUND_TYPES.has((r.type || '').toUpperCase()) &&
            (byIsin || fundNameMatches(expanded, r.description || '')) &&
            !declaresOtherCurrency(r.description || '', currency)
        )
        // Prefer Yahoo's native fund-NAV series (0P… symbols): exchange ETF
        // listings (FEP5.MU…) often quote fine but carry no usable history.
        // A igualdad, la clase de nombre más pelado (ver extraClassTokens).
        .sort((a, b) => {
          const nav = (b.symbol.startsWith('0P') ? 1 : 0) - (a.symbol.startsWith('0P') ? 1 : 0);
          if (nav !== 0) return nav;
          return extraClassTokens(expanded, a.description || '') - extraClassTokens(expanded, b.description || '');
        });

      // Several share classes of the right fund can pass the name check with
      // no currency label — the quote currency is the final authority. Try a
      // few candidates, not just the first.
      for (const candidate of candidates) {
        seen.add(candidate.symbol);
        if (quoteChecks >= MAX_QUOTE_CHECKS) break yahooAttempts;
        quoteChecks++;
        try {
          const quote = await getQuote(candidate.symbol);
          if ((quote?.currency || '').toUpperCase() !== currency.toUpperCase()) continue;
        } catch (_) {
          continue;
        }
        const series = await getHistoricalData(candidate.symbol, rangeForDates(fechas), '1d');
        // The series must actually cover the purchase dates — a 1-point
        // "today only" history cannot price a past buy.
        if (series && fechas.some((f) => navAtDate(series, f) != null)) {
          return { symbol: candidate.symbol, series };
        }
      }
    }

    // Tier 2 — EODHD by curated ISIN: the TRUE EUR NAV (needs the user's key)
    if (curated.isin) {
      await sleep(pauseMs);
      const viaEodhd = await resolveViaEodhd(curated.isin, fechas, currency, deps);
      if (viaEodhd) return viaEodhd;
    }

    // Tier 3 — USD share-class proxy + historical FX (EUR rows only)
    if (curated.usdProxy && currency.toUpperCase() === 'EUR') {
      await sleep(pauseMs);
      return await resolveViaUsdProxy(curated.usdProxy, fechas, deps);
    }
    return null;
  } catch (_) {
    return null; // network/quota errors → keep monetary rows
  }
}

/**
 * @param rows  parsed MyInvestor transactions (any mix; only noQuote BUY/SELL are touched)
 * @param deps  { searchTickers, getHistoricalData, getQuote } — yahooFinanceService in prod
 * @returns { rows, tickerMap, resolved, total } — new array, inputs untouched
 */
/**
 * Vuelve a resolver el símbolo de UN fondo por su nombre, sin tocar nada más.
 *
 * Existe porque un ticker mal resuelto se FOSILIZA: queda escrito en el mapa
 * persistido (`imported_data.ticker_map`) y el refresco de precios lo seguirá
 * usando para siempre. Hasta ahora la única salida era reimportar el extracto
 * entero con "reemplazar" — un martillo para un clavo, y con el riesgo que
 * tiene borrar y recrear transacciones sólo para corregir un símbolo.
 *
 * Aplica exactamente las mismas reglas que el enricher (símbolo curado, ISIN
 * curado, validación de nombre, exclusiones "ex-Japan", preferencia por el
 * símbolo de NAV y, a igualdad, por la clase de nombre más pelado) pero SIN
 * exigir histórico: aquí sólo hace falta un símbolo que cotice en la divisa de
 * la posición, no reconstruir unidades de compras pasadas.
 *
 * @param {string} name        el nombre tal y como lo guardó el extracto
 * @param {object} deps        { searchTickers, getQuote, pauseMs }
 * @param {string} [deps.currency='EUR']
 * @returns {Promise<{symbol: string, description: string} | null>}
 */
export async function resolveFundSymbol(name, deps) {
  const { searchTickers, getQuote, pauseMs = 200, currency = 'EUR' } = deps || {};
  const limpio = String(name || '').trim();
  if (!limpio || !searchTickers || !getQuote) return null;

  const enDivisa = async (symbol, description) => {
    try {
      const quote = await getQuote(symbol);
      if ((quote?.currency || '').toUpperCase() !== currency.toUpperCase()) return null;
      if (!(Number(quote?.price) > 0)) return null;
      return { symbol, description: description || symbol };
    } catch (_) {
      return null;
    }
  };

  const curated = MYINVESTOR_FUNDS[limpio.toUpperCase()] || {};
  // Un símbolo curado se ha verificado a mano: no hay nada que buscar.
  if (curated.symbol) {
    const ok = await enDivisa(curated.symbol, limpio);
    if (ok) return ok;
  }

  const expanded = expandAbbreviations(limpio);
  const tokens = expanded.split(' ');
  const isinCurado = curated.isin || curatedIsinForFundName(limpio);
  const intentos = [
    ...(isinCurado ? [{ query: isinCurado, byIsin: true }] : []),
    ...[...new Set([limpio, expanded, tokens.slice(0, 5).join(' '), tokens.slice(0, 4).join(' ')])]
      .filter((q) => q.split(/\s+/).length >= 2)
      .map((query) => ({ query, byIsin: false })),
  ];

  const vistos = new Set();
  let primero = true;
  for (const { query, byIsin } of intentos) {
    if (!primero) await sleep(pauseMs);
    primero = false;
    let resultados = [];
    try { resultados = (await searchTickers(query)) || []; } catch (_) { continue; }

    const candidatos = resultados
      .filter((r) => (
        r.symbol && !vistos.has(r.symbol)
        && FUND_TYPES.has((r.type || '').toUpperCase())
        // Un ISIN identifica el producto exacto: ahí la validación de nombre
        // sobra (y estorba, porque el extracto abrevia).
        && (byIsin || (fundNameMatches(expanded, r.description || '') && sameExclusions(expanded, r.description || '')))
        && !declaresOtherCurrency(r.description || '', currency)
      ))
      .sort((a, b) => {
        const nav = (b.symbol.startsWith('0P') ? 1 : 0) - (a.symbol.startsWith('0P') ? 1 : 0);
        if (nav !== 0) return nav;
        return extraClassTokens(expanded, a.description || '') - extraClassTokens(expanded, b.description || '');
      });

    for (const c of candidatos) {
      vistos.add(c.symbol);
      const ok = await enDivisa(c.symbol, c.description);
      if (ok) return ok;
    }
  }

  // Último recurso: la clase en USD curada del mismo fondo. Cotiza en otra
  // divisa, pero la plataforma ya convierte el precio de la cotización a la de
  // la posición, así que vale más un valor con matiz cambiario que ninguno —
  // el mismo compromiso que acepta el enricher para estos fondos.
  if (curated.usdProxy) {
    try {
      const quote = await getQuote(curated.usdProxy);
      if (Number(quote?.price) > 0) return { symbol: curated.usdProxy, description: limpio, viaProxy: true };
    } catch (_) { /* sin proxy utilizable */ }
  }
  return null;
}

/**
 * ¿Este ticker guardado es en realidad el NOMBRE de un fondo sin resolver?
 *
 * Los símbolos reales no llevan espacios; las filas monetarias guardan el
 * nombre del extracto ("VANGUARD 20") como si fuera el ticker. Es la misma
 * señal que ya usan las superficies de cotización para saltárselas.
 */
export function looksLikeUnresolvedFundName(ticker) {
  const t = String(ticker || '').replace(/\s*\([A-Z]{3}\)$/i, '').trim();
  return t.length > 0 && /\s/.test(t);
}

export async function enrichFundRows(inputRows, deps) {
  // Una grafía alternativa del mismo fondo se agrupa bajo su nombre canónico
  // ANTES de nada: así se convierte (o no) junto al resto de sus filas.
  const rows = inputRows.map((r) => (r.noQuote && r.producto
    ? { ...r, producto: canonicalFundName(r.producto) }
    : r));
  const fundRows = rows.filter((r) => r.noQuote && (r.type === 'BUY' || r.type === 'SELL'));
  const total = fundRows.length;
  if (total === 0) return { rows, tickerMap: {}, resolved: 0, total };

  const byName = {};
  fundRows.forEach((r) => {
    (byName[r.producto] = byName[r.producto] || []).push(r);
  });

  // SEQUENTIAL on purpose (not Promise.all): each fund needs several Yahoo
  // calls and a parallel burst trips Yahoo's rate limit, silently emptying
  // every search result. ~10 funds resolve in a few seconds.
  const pauseMs = deps.pauseMs ?? 250;
  const bySymbolName = {};
  let firstFund = true;
  for (const [name, group] of Object.entries(byName)) {
    if (!firstFund) await sleep(pauseMs);
    firstFund = false;
    bySymbolName[name] = await resolveFund(
      name, group.map((r) => r.fecha), group[0].moneda || 'EUR', { ...deps, pauseMs }
    );
  }

  // A position must hold ONE representation: mixing NAV-derived units with
  // monetary rows (or mapping a name to a real quote while any of its rows
  // stays qty-in-EUR) corrupts the position value. Per fund: enrich ALL rows
  // or NONE — and if a fund mixes "@ units" rows with unresolvable monetary
  // rows, the "@" rows are demoted to monetary too.
  const tickerMap = {};
  let resolved = 0;
  const perFund = {};

  for (const [name, group] of Object.entries(byName)) {
    const resolution = bySymbolName[name];
    const monetaryRows = group.filter((r) => r.precio === 1);
    const navs = resolution
      ? new Map(monetaryRows.map((r) => [r, navEurAt(resolution, r.fecha)]))
      : new Map();
    const fullCoverage = resolution && monetaryRows.every((r) => navs.get(r) != null);

    if (fullCoverage) {
      perFund[name] = { mode: 'enrich', symbol: resolution.symbol, navs };
      tickerMap[name] = resolution.symbol;
    } else if (monetaryRows.length > 0 && group.some((r) => r.precio !== 1)) {
      perFund[name] = { mode: 'demote' };
    } else {
      perFund[name] = { mode: 'keep' };
    }
  }

  const newRows = rows.map((row) => {
    if (!(row.noQuote && (row.type === 'BUY' || row.type === 'SELL'))) return row;
    const fund = perFund[row.producto];

    if (fund.mode === 'demote' && row.precio !== 1) {
      return { ...row, cantidad: Math.abs(row.total), precio: 1 };
    }
    if (fund.mode !== 'enrich') return row;

    const { noQuote, ...rest } = row;
    resolved++;

    // "@ units" rows carry authoritative units — just attach the quote symbol.
    if (row.precio !== 1) return { ...rest, displayTicker: fund.symbol };

    // transactions.price is scale 2 in the DB — derive units from the rounded
    // NAV so re-imports reproduce identical rows (dedupe stability).
    const precio = Math.round(fund.navs.get(row) * 100) / 100;
    const cantidad = Math.round((Math.abs(row.total) / precio) * 10000) / 10000;
    return { ...rest, cantidad, precio, displayTicker: fund.symbol };
  });

  return { rows: newRows, tickerMap, resolved, total };
}
