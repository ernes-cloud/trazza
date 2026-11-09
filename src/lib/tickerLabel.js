// Funds/index positions often carry an ISIN (optionally suffixed, e.g. .EUFUND),
// a Morningstar-style 0P… Yahoo symbol, an exchange listing (FEPA.MU) or a raw
// fund name as their "ticker" — none of which mean anything to the user. Where
// the ticker is opaque, the UI leads with the NAME (Wallet Map, buscador).
const ISIN_TICKER_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9](\.[A-Z]+)?$/;

/** @param {string|null|undefined} ticker */
export const isOpaqueTicker = (ticker) =>
  !ticker || ISIN_TICKER_RE.test(ticker) || ticker.startsWith('0P') || /\s/.test(ticker);
