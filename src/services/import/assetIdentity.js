/**
 * Asset identity resolution for CSV imports — extracted 1:1 from CarteraPage.
 *
 * Given a parsed transaction and the import source, returns the identifiers the
 * whole import pipeline keys on:
 *   key      — in-memory grouping key for net-holdings aggregation
 *   dbTicker — the assets.ticker value stored in Supabase
 *   name     — display name
 *
 * PURE: broker is an argument (the old inline version read React state).
 * Any change here shifts how positions are grouped and matched in the DB —
 * treat the characterization tests as a contract.
 */

/**
 * Marca del ticker de un activo MONETARIO: un fondo de MyInvestor que no se pudo
 * convertir a participaciones y se guarda como cantidad = euros, precio = 1.
 *
 * Tiene que ser una fila de `assets` DISTINTA de la del mismo fondo valorado con
 * participaciones. Las dos se llamaban "NOMBRE (EUR)" y compartían fila (la tabla
 * es compartida entre usuarios e imports): una posición monetaria heredaba el NAV
 * que otro import había escrito ahí. Caso real 2026-10-03: 503,04 € de iShares US
 * Index × NAV 33,67 = 16.937 € de valor y +3.267 % de rentabilidad.
 */
export const MONETARY_TICKER_TAG = '[importe]';

/** ¿Es el ticker guardado de un activo monetario (precio fijo 1, nunca se cotiza)? */
export function isMonetaryAssetTicker(ticker) {
  return typeof ticker === 'string' && ticker.includes(MONETARY_TICKER_TAG);
}

/**
 * El ticker del MISMO fondo en la otra representación (euros ↔ participaciones),
 * o null si la fila no tiene gemelo. Solo existe en MyInvestor y sin ISIN.
 *
 * Un fondo que en un import se quedó en euros y en el siguiente se convierte a
 * participaciones (o al revés) cambia de ticker, así que el import crearía una
 * posición NUEVA y dejaría la vieja abierta: el fondo contaría dos veces. El
 * planner usa esto para detectarlo y pedir el modo reemplazo.
 */
export function twinAssetTicker(t, broker) {
  if (broker !== 'myinvestor' || t.isin) return null;
  const own = getAssetIdentifiers(t, broker).dbTicker;
  const twin = getAssetIdentifiers({ ...t, noQuote: t.noQuote !== true }, broker).dbTicker;
  return twin !== own ? twin : null;
}

export function getAssetIdentifiers(t, broker) {
  const cur = (t.moneda || 'EUR').toUpperCase();
  const isin = t.isin || '';
  const symbol = t.producto || '';
  const exchange = t.exchange || '';

  // 1. DeGiro & MyInvestor: keyed by ISIN + Currency (no exchange suffix)
  if (broker === 'degiro' || broker === 'myinvestor') {
    const idActivo = t.id_activo || isin || symbol;
    // Fila monetaria (noQuote que el enriquecedor no pudo convertir): identidad
    // propia. El enriquecedor convierte TODAS las filas de un fondo o NINGUNA,
    // así que todas sus filas caen siempre del mismo lado.
    if (t.noQuote === true && !isin) {
      return {
        key: `${idActivo}_${cur}_monetary`,
        dbTicker: `${idActivo} ${MONETARY_TICKER_TAG} (${cur})`,
        name: t.nombre || t.producto || idActivo,
        isin: '',
        exchange: '',
        noQuote: true,
      };
    }
    return {
      key: `${idActivo}_${cur}`,
      dbTicker: isin ? `${isin} (${cur})` : `${idActivo} (${cur})`,
      name: t.nombre || t.producto || idActivo,
      isin: isin,
      exchange: ''
    };
  }

  // 2. IBKR Logic: Symbol/ISIN + Exchange + Currency (Differentiates same symbol on diff exchanges)
  if (broker === 'ibkr') {
    const primary = isin || symbol;
    const exchSuffix = exchange ? ` [${exchange}]` : '';
    return {
      key: `${symbol}_${isin}_${cur}_${exchange}`,
      dbTicker: `${primary}${exchSuffix} (${cur})`,
      name: t.nombre || symbol || primary,
      isin: isin,
      exchange: exchange
    };
  }

  // Freeform AI import: producto carries a quote symbol (AAPL, SAN.MC,
  // BTC-USD) extracted from pasted text and confirmed by the user — use it
  // directly as the DB ticker, same as Binance. isin is always empty here.
  // CASH rows keep the DeGiro-style "CASH_EUR (EUR)" dbTicker because the
  // TRANSFER/FEES → cash-position fallback in the save loop looks up that key.
  if (broker === 'freeform') {
    const symbolTicker = t.producto || t.ticker || isin || symbol;
    if (String(symbolTicker).startsWith('CASH_')) {
      return {
        key: `${symbolTicker}_${cur}`,
        dbTicker: `${symbolTicker} (${cur})`,
        name: t.nombre || t.name || symbolTicker,
        isin: null,
        exchange: ''
      };
    }
    return {
      key: `${symbolTicker}_${cur}`,
      dbTicker: symbolTicker,
      name: t.nombre || t.name || symbolTicker,
      isin: null,
      exchange: ''
    };
  }

  // 3. Binance: ticker is already a Yahoo ticker (BTC-USD, ETH-USD)
  if (broker === 'binance') {
    const yahooTicker = t.displayTicker || t.producto || t.isin || symbol;
    return {
      key: `${yahooTicker}_${cur}`,
      dbTicker: yahooTicker,
      name: t.nombre || yahooTicker,
      isin: null,
      exchange: ''
    };
  }

  // 4. Default Fallback
  return {
    key: `${t.id_activo || symbol || isin}_${cur}`,
    dbTicker: `${isin || symbol} (${cur})`,
    name: t.nombre || symbol || isin,
    isin: isin,
    exchange: exchange
  };
}
