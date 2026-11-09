/**
 * Look-through exposure for index funds.
 *
 * The donut widgets classify a position by assets.currency / sector / country,
 * which for a fund describes the SHARE CLASS (EUR class) and the legal
 * DOMICILE (Ireland/Luxembourg ISIN prefix) — not what the index actually
 * holds. "iShares US Index EUR Acc" is 100% US equity in USD, yet it showed
 * as EUR / Europa.
 *
 * This service returns the economic exposure of a fund's underlying index:
 *
 *   getFundExposure(asset) → { region, currency, sector } | null
 *
 * Codes (the UI translates them):
 *   region:   NORTH_AMERICA | EUROPE | ASIA_PACIFIC | EMERGING | GLOBAL
 *   currency: ISO code ('USD', 'EUR', 'JPY'…) or 'MULTI' (multi-currency basket)
 *   sector:   FUND_EQUITY | FUND_BOND_GOVT | FUND_BOND_CORP | FUND_BOND
 *
 * PURE + deterministic: curated ISIN map first (exact, verified), then name
 * rules. A null return means "not an index fund / can't classify with
 * confidence" — the caller keeps its existing per-stock derivation. Never
 * guess: a wrong region here is worse than the Global/Sin-datos bucket.
 */

export const FUND_REGIONS = {
  NORTH_AMERICA: 'NORTH_AMERICA',
  EUROPE: 'EUROPE',
  ASIA_PACIFIC: 'ASIA_PACIFIC',
  EMERGING: 'EMERGING',
  GLOBAL: 'GLOBAL',
};

export const FUND_SECTORS = {
  EQUITY: 'FUND_EQUITY',
  BOND_GOVT: 'FUND_BOND_GOVT',
  BOND_CORP: 'FUND_BOND_CORP',
  BOND: 'FUND_BOND',
};

export const MULTI_CURRENCY = 'MULTI';

// Exact exposures for the MyInvestor carteras automatizadas funds (same
// curation philosophy as MYINVESTOR_FUNDS in fundNavEnricher.js). Keyed by
// ISIN — matched against assets.isin AND an ISIN embedded in the ticker
// (the EM govt bond fund is stored as 'LU1811365292.LU').
// EM government bonds (JPM EMBI-style indices) are hard-currency USD debt.
const CURATED_BY_ISIN = {
  IE00BYX5MD61: { region: 'EUROPE',        currency: 'EUR',   sector: 'FUND_EQUITY' },    // Fidelity MSCI Europe Index
  IE00BYX5N771: { region: 'ASIA_PACIFIC',  currency: 'JPY',   sector: 'FUND_EQUITY' },    // Fidelity MSCI Japan Index
  IE00BYWYCC39: { region: 'EMERGING',      currency: 'MULTI', sector: 'FUND_EQUITY' },    // iShares Emerging Markets Index (clase D)
  IE000QAZP7L2: { region: 'EMERGING',      currency: 'MULTI', sector: 'FUND_EQUITY' },    // iShares Emerging Markets Index (clase S, la de MyInvestor)
  IE000N4ZYX28: { region: 'NORTH_AMERICA', currency: 'USD',   sector: 'FUND_EQUITY' },    // iShares US Index (clase S Acc EUR, sin cubrir)
  IE00BJN4RG66: { region: 'GLOBAL',        currency: 'EUR',   sector: 'FUND_BOND_CORP' }, // iShares Screened Global Corp Bond, EUR Hedged
  IE0007471471: { region: 'NORTH_AMERICA', currency: 'EUR',   sector: 'FUND_BOND_GOVT' }, // Vanguard US Govt Bond Index EUR Hedged
  IE00BDZVHT63: { region: 'ASIA_PACIFIC',  currency: 'MULTI', sector: 'FUND_EQUITY' },    // Fidelity Pacific ex-Japan Index
  LU1811365292: { region: 'EMERGING',      currency: 'USD',   sector: 'FUND_BOND_GOVT' }, // BGIF EM Govt Bond Index
};

// ACTIVE funds whose name says nothing about the portfolio (name rules can
// never classify "Gestión Value A FI") — curated by Yahoo symbol root, since
// Spanish FI classes rarely carry an ISIN in the assets row. Exposure verified
// against Yahoo topHoldings before adding an entry.
const CURATED_BY_SYMBOL = {
  '0P00019ORF': { region: 'GLOBAL', currency: 'MULTI', sector: 'FUND_EQUITY' }, // Gestión Value A FI (Andbank) — 72% RV global value, top holding BRK-B

  // Fondos de la cartera gestionada de MyInvestor. Sus filas NO traen ISIN (el
  // export de Movimientos no lo incluye), así que el mapa por ISIN de arriba no
  // les llega nunca y su "ticker" es el propio nombre truncado del banco.
  // Clasificación verificada contra el X-Ray de Morningstar del titular.
  'VANGUARD 20': { region: 'EUROPE', currency: 'EUR', sector: 'FUND_BOND_GOVT' }, // Vanguard 20+ Yr € Trs Idx — deuda pública en euros a largo
  'VANGUARD US GOVERNMENT BD INDE': { region: 'NORTH_AMERICA', currency: 'EUR', sector: 'FUND_BOND_GOVT' }, // clase EUR Hedged: sin exposición al dólar
  'ISHARES ESG SCREENED GLB CORP': { region: 'GLOBAL', currency: 'EUR', sector: 'FUND_BOND_CORP' }, // iShares Scrn Gl Corp Bd, clase EUR Hedged
};

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

// '€' must survive normalization as a token — it disambiguates both the
// hedged tag ("€ H Acc") and euro-denominated bond indices ("20+ Yr € Trs").
const normalize = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/€/g, ' eur ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9&+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasToken = (name, tokens) => {
  const words = new Set(name.split(' '));
  return tokens.some((t) => (t.includes(' ') ? name.includes(t) : words.has(t)));
};

// Detection gate: only classify things that are clearly index funds/ETFs.
// 0P… = Yahoo native fund symbols; .EUFUND = EODHD fund exchange.
const looksLikeFund = (ticker, name) => {
  const t = (ticker || '').toUpperCase();
  if (t.startsWith('0P') || t.endsWith('.EUFUND')) return true;
  // 'inde' y 'indx': el extracto trunca los nombres a ~30 caracteres y "Index"
  // llega partido. Sin esto, "VANGUARD US GOVERNMENT BD INDE" no parecía un
  // fondo y se quedaba sin clasificar en TODOS los quesitos.
  return hasToken(name, ['index', 'indx', 'inde', 'idx', 'indice', 'ucits', 'etf', 'msci', 'ftse', 'icav']);
};

const isBond = (name) =>
  hasToken(name, ['bond', 'bonds', 'bd', 'treasury', 'trs', 'govt', 'government', 'gilt', 'aggregate', 'agg', 'gover']);

const isCorpBond = (name) => hasToken(name, ['corp', 'corporate']);
const isGovtBond = (name) => hasToken(name, ['treasury', 'trs', 'govt', 'government', 'gilt', 'gover']);

// "EUR H A" / "€ H Acc" / "EUR Hedged" — the class removes FX exposure,
// so the economic currency IS the share-class currency.
const isEurHedged = (name) => /\beur h(?:\s|$)/.test(name) || hasToken(name, ['hedged']);

/**
 * @param asset  { ticker, company_name, isin, asset_class } (assets row shape)
 * @returns { region, currency, sector } | null
 */
export function getFundExposure(asset) {
  if (!asset) return null;
  const ticker = asset.ticker || '';
  const rawName = asset.company_name || '';

  // Curated ISIN — from the isin column or embedded in the ticker
  // Los fondos monetarios guardan el NOMBRE como ticker, y las superficies le
  // añaden la divisa ("VANGUARD 20 (EUR)"). Sin recortarla, ninguna clave del
  // mapa curado coincide jamás.
  // Lo mismo con la marca de los fondos que se guardan en euros invertidos
  // ("NOMBRE [importe] (EUR)", ver assetIdentity.MONETARY_TICKER_TAG).
  const tickerRoot = ticker
    .replace(/\s*\([A-Z]{3}\)\s*$/i, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .split('.')[0]
    .trim()
    .toUpperCase();
  const isin = ISIN_RE.test((asset.isin || '').toUpperCase())
    ? asset.isin.toUpperCase()
    : ISIN_RE.test(tickerRoot) ? tickerRoot : null;
  if (isin && CURATED_BY_ISIN[isin]) return { ...CURATED_BY_ISIN[isin] };
  if (CURATED_BY_SYMBOL[tickerRoot]) return { ...CURATED_BY_SYMBOL[tickerRoot] };

  const name = normalize(rawName);
  if (!name || !looksLikeFund(ticker, name)) return null;

  const bond = isBond(name);
  const sector = bond
    ? (isCorpBond(name) ? FUND_SECTORS.BOND_CORP : isGovtBond(name) ? FUND_SECTORS.BOND_GOVT : FUND_SECTORS.BOND)
    : FUND_SECTORS.EQUITY;
  const hedged = isEurHedged(name);

  // The hedge tag ("eur h") must not leak into region matching: "Gl Corp Bd
  // EUR H" is a GLOBAL bond fund, its 'eur' token is the hedge, not Europe.
  const regionName = name.replace(/\beur h\b/g, ' ').replace(/\s+/g, ' ').trim();

  // Region rules — ORDER MATTERS:
  //  - "ex japan" before "japan", "emerging" before anything
  //  - US before the euro/€ bond check ("U.S. Govt Bd € H")
  //  - GLOBAL before Europe, and the euro-bond heuristic LAST: the trailing
  //    share-class "Acc EUR" token must never imply Europe for equity funds
  let region = null;
  let currency = null;

  if (hasToken(regionName, ['emerging', 'emergmkts', 'emergings', 'em'])) {
    region = FUND_REGIONS.EMERGING;
    currency = bond ? 'USD' : MULTI_CURRENCY; // EM sovereign debt indices are hard-currency USD
  } else if (regionName.includes('ex japan') || regionName.includes('exjapn') || hasToken(regionName, ['pacific', 'pacfc', 'asia'])) {
    region = FUND_REGIONS.ASIA_PACIFIC;
    currency = MULTI_CURRENCY;
  } else if (hasToken(regionName, ['japan', 'japn', 'nikkei', 'topix'])) {
    region = FUND_REGIONS.ASIA_PACIFIC;
    currency = 'JPY';
  } else if (hasToken(regionName, ['us', 'usa', 'u s', 'united states', 's&p', 'nasdaq', 'america', 'american'])) {
    region = FUND_REGIONS.NORTH_AMERICA;
    currency = 'USD';
  } else if (hasToken(regionName, ['europe', 'european', 'eurozone', 'euro stoxx', 'stoxx', 'europa'])) {
    region = FUND_REGIONS.EUROPE;
    currency = 'EUR';
  } else if (hasToken(regionName, ['global', 'glb', 'gl', 'world', 'all country', 'acwi', 'developed'])) {
    region = FUND_REGIONS.GLOBAL;
    currency = MULTI_CURRENCY;
  } else if (bond && hasToken(regionName, ['eur', 'euro'])) {
    // euro-denominated bond index ("20+ Yr € Trs Idx"): eurozone issuers
    region = FUND_REGIONS.EUROPE;
    currency = 'EUR';
  }

  if (!region) return null; // can't classify with confidence → caller's fallback

  if (hedged) currency = 'EUR';
  return { region, currency, sector };
}

// ——— Real sector weights from Yahoo quoteSummary topHoldings ———————————————
//
// Yahoo publishes the LOOK-THROUGH sector weights of a fund's equity sleeve
// (0P… symbols carry them; exchange listings like .MU usually don't). The
// labels below are the exact assetProfile sector strings stocks store in
// assets.sector, so fund slices MERGE with individual-stock slices.
const YAHOO_SECTOR_LABELS = {
  technology: 'Technology',
  financial_services: 'Financial Services',
  consumer_cyclical: 'Consumer Cyclical',
  consumer_defensive: 'Consumer Defensive',
  communication_services: 'Communication Services',
  industrials: 'Industrials',
  healthcare: 'Healthcare',
  energy: 'Energy',
  basic_materials: 'Basic Materials',
  utilities: 'Utilities',
  realestate: 'Real Estate',
};

// Below this equity share the sector split describes a sleeve the fund isn't:
// bond funds report a junk "financial_services 100%" row (seen live on the
// iShares Global Corp Bond fund) — those must keep their FUND_BOND_* bucket.
const MIN_STOCK_POSITION = 0.5;
const MIN_SECTOR_WEIGHT = 0.005;

/**
 * @param topHoldings  quoteSummary.result[0].topHoldings (raw Yahoo shape)
 * @returns [{ sector, weight }] normalized to sum 1, or null when the fund
 *          is not equity-dominant / carries no usable sector data.
 */
export function extractFundSectorWeights(topHoldings) {
  if (!topHoldings) return null;
  const stockPosition = topHoldings.stockPosition?.raw;
  if (!(stockPosition >= MIN_STOCK_POSITION)) return null;

  const entries = (topHoldings.sectorWeightings || [])
    .flatMap((sw) => Object.entries(sw || {}))
    .filter(([key, v]) => YAHOO_SECTOR_LABELS[key] && v?.raw > MIN_SECTOR_WEIGHT);
  const total = entries.reduce((s, [, v]) => s + v.raw, 0);
  if (total <= 0) return null;

  // Normalized to 1: the weights describe the equity sleeve and the donut
  // spreads the position's full value — a leftover "unclassified" slice would
  // be noise, not information.
  return entries
    .map(([key, v]) => ({ sector: YAHOO_SECTOR_LABELS[key], weight: v.raw / total }))
    .sort((a, b) => b.weight - a.weight);
}
