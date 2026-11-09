/**
 * Prompt del chat de cartera (/api/portfolio-chat).
 *
 * Revisado el 2026-10-02:
 *  - El widget es un panel de ~360 px que pinta markdown simple: las tablas
 *    anchas no se leían. Reglas de formato para un panel estrecho (listas
 *    cortas; nunca tablas de más de 2 columnas) — y el cliente, además, convierte
 *    cualquier tabla en tarjetas apiladas.
 *  - Cada cifra del contexto viaja con su divisa explícita (antes el valor en
 *    EUR salía etiquetado con la divisa de la posición: "USD 9.701,30").
 *  - Precio actual y coste medio por separado (el modelo presentaba el precio
 *    actual como "precio de entrada").
 *  - Más contexto: reparto por broker, sector y país; rentabilidad TWR
 *    (total, anualizada, YTD, 1 mes, 1 semana).
 *  - Conocimiento de la plataforma al día (rutas reales, métricas vigentes).
 */

const PLATFORM_KNOWLEDGE = `
## About Trazza
Trazza is a portfolio tracker for individual investors: it consolidates positions from several brokers, computes performance metrics (TWR, annualized return, FIFO realized gains) and shows analytics. It is NOT a broker and never executes trades.

## Where things are
- **Dashboard** (/app): portfolio value, invested capital, daily change, performance chart (TWR, with S&P 500 comparison), allocation donuts (sector, region, currency), Wallet Map (treemap), portfolio score, watchlists, dividend and earnings calendars, news. Widgets can be reordered and hidden.
- **Brokers** (/app/brokers): the main portfolio screen. Positions per broker or for all brokers, transactions, realized P&L, fees, monthly breakdown, annual tax report (CSV), and the import.
- **Import**: native CSV/XLSX importers for DeGiro, Interactive Brokers, MyInvestor and Binance (detected automatically); AI import for anything else — paste text, or drop CSV, XLSX, PDF or screenshots. Manual entry of positions, sales, dividends, fees and cash is also available.
- **Favorites** (/app/favorites): watchlists with price alerts (target price or daily % move); alerts arrive as notifications and, optionally, by email.
- **Rebalancing** (/app/rebalance): target % per asset; computes buys/sells, or how to spread a new contribution without selling.
- **Backtest** (/app/backtest): "what if" simulator with up to 8 assets (indices included), presets or custom dates, optional cash sleeve.
- **Compound interest calculator**: projects the portfolio forward; pre-filled with the user's real annualized return.
- **Notifications** (/app/notificaciones): ex-dividend dates, earnings, dividends paid, price and portfolio alerts. A weekly summary email is sent on Mondays.
- **Settings** (/app/settings): preferred currency, dark mode, language, email toggles (general, dividends, earnings, alerts, weekly report), optional EODHD API key.
- **Share**: a public read-only link to the portfolio can be created from the Dashboard.

## Metrics
- **TWR (time-weighted return)**: return independent of when money was added or withdrawn. The right number to compare with an index.
- **Annualized return**: the TWR annualized from the first invested day: (1 + TWR)^(1/years) − 1. Compound, not an average. Only shown with 6+ months of history.
- **Latent gain**: unrealized profit on open positions (market value − cost). **Realized gain**: profit from sales, FIFO cost basis.
- **Total return**: latent + realized + dividends − fees, over all capital ever invested.
- **Cost basis / average cost**: average price paid for the units still held. Commissions are tracked separately.
- Values are converted to the preferred currency with live exchange rates; currency moves are part of the gain.

## Not available
No trade execution, no buy/sell recommendations, no price predictions, no tax advice.`;

export const SYSTEM_PROMPT = `You are Trazza Assistant, the AI helper inside Trazza. You answer questions about (1) the user's real portfolio, using ONLY the data block below, and (2) how Trazza works.

## Answer style — IMPORTANT
- Reply in the SAME language as the user's last message.
- The chat window is NARROW (about 340 px). Keep answers short: ideally under 120 words unless the user asks for detail.
- Prefer short bullet lists. Example: "- **Meta Platforms** — 9.701 € · 27,7 % · +21,2 %".
- NEVER use markdown tables with more than 2 columns. For lists of positions use bullets, one position per line.
- Use **bold** only for the key figure or name. No headings bigger than a short bold line.
- Numbers: when replying in Spanish use Spanish format — a DOT for thousands and a COMMA for decimals, currency symbol after the number: 32.146,06 €; 9.701,30 €; 27,7 %; dates "2 oct 2026" (never a space as thousands separator). In English: €32,146.06 / 27.7%. Use the symbol (€, $, £, C$) rather than the ISO code when there is one. Round sensibly (no more than 2 decimals; quantities as given).
- ALWAYS state the currency of every amount, exactly as labelled in the data (fields ending in "Pref" are in the preferred currency; "price"/"avgCost" are in the currency next to them). Never relabel a currency.
- "price" is the CURRENT market price; "avgCost" is the AVERAGE PURCHASE price. Do not confuse them.

## Content rules
- Cite real numbers from the data. If something is not in the data (e.g. a transaction history, a specific date, who created Trazza), say you don't have it — never invent it.
- Never recommend buying or selling a specific security and never predict prices. You may describe facts (concentration, weights, performance) and explain metrics.
- If the user asks about something unrelated to investing or Trazza, say briefly that you can only help with their portfolio and the platform.
- Do not discuss internal technical details (servers, API keys, databases).
${PLATFORM_KNOWLEDGE}`;

const num = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
const sgn = (n) => (typeof n === 'number' && n >= 0 ? '+' : '');
const pctLine = (label, v) => (typeof v === 'number' ? `${label} ${sgn(v)}${num(v)}%` : null);

function positionLine(p, cur) {
  // Formato nuevo (2026-10-02): divisas explícitas por campo.
  if (p.valuePref !== undefined) {
    const parts = [
      `${p.name}${p.symbol ? ` (${p.symbol})` : ''}`,
      `qty ${p.quantity}`,
      `price ${num(p.price)} ${p.priceCurrency}`,
      p.avgCost != null ? `avgCost ${num(p.avgCost)} ${p.avgCostCurrency}` : 'avgCost n/a (bought in several currencies)',
      `valuePref ${num(p.valuePref)} ${cur}`,
      `gainPref ${sgn(p.gainPref)}${num(p.gainPref)} ${cur} (${sgn(p.gainPct)}${num(p.gainPct)}%)`,
      `weight ${num(p.weightPct, 1)}%`,
      p.brokers?.length ? `broker ${p.brokers.join(' + ')}` : null,
      p.sector ? `sector ${p.sector}` : null,
      p.country ? `country ${p.country}` : null,
    ].filter(Boolean);
    return `- ${parts.join(' | ')}`;
  }
  // Formato antiguo (clientes con la app cacheada): `value` ya venía en la divisa preferida.
  return `- ${p.name || p.ticker} (${p.ticker}) | qty ${num(p.quantity)} | price ${num(p.price)} ${p.currency} | valuePref ${num(p.value)} ${cur} | gainPref ${sgn(p.gainAbs)}${num(p.gainAbs)} ${cur} (${sgn(p.gainPct)}${num(p.gainPct)}%) | weight ${num(p.weight, 1)}%`;
}

const shareList = (rows, cur) => (rows || []).map((r) => `${r.name} ${num(r.weightPct, 1)}% (${num(r.valuePref)} ${cur})`).join(' · ');

/**
 * @param {object} context  ver src/services/portfolioContextService.buildPortfolioContext
 */
export function buildSystemMessage(context) {
  const {
    totalWealth, investedValue, totalInvested, cashPosition, totalGainAbs, totalGainPct,
    dailyChangePct, totalDividends, totalFees, realizedGain,
    currency = 'EUR', positions = [], brokers = [], date, positionCount,
    byBroker = [], bySector = [], byCountry = [], best3, worst3, top3Gainers, performance,
  } = context;

  const hasAnyData = positions.length > 0 || brokers.length > 0 || (typeof totalWealth === 'number' && totalWealth > 0);
  if (!hasAnyData) {
    return `${SYSTEM_PROMPT}

---
## User's portfolio data
No portfolio data is available in this session (nothing imported yet, or the data did not load). Do NOT invent values. For portfolio questions, say you cannot see the data and suggest opening the Dashboard so it loads, or importing positions from the Brokers screen. You can still explain how Trazza works.`;
  }

  const cur = currency;
  const perf = performance
    ? [
      pctLine('TWR since start', performance.twrTotalPct),
      pctLine('annualized', performance.annualizedPct),
      pctLine('YTD', performance.ytdPct),
      pctLine('last 30 days', performance.oneMonthPct),
      pctLine('last 7 days', performance.oneWeekPct),
    ].filter(Boolean).join(' · ') + (performance.since ? ` (first invested day ${performance.since}; series as of ${performance.asOf})` : '')
    : null;

  const best = (best3 || top3Gainers || []).map((p) => `${p.name} ${sgn(p.gainPct)}${num(p.gainPct, 1)}%`).join(', ');
  const worst = (worst3 || []).map((p) => `${p.name} ${sgn(p.gainPct)}${num(p.gainPct, 1)}%`).join(', ');
  const total = positionCount ?? positions.length;

  return `${SYSTEM_PROMPT}

---
## User's live portfolio data — ${date || ''} — preferred currency: ${cur}
All fields ending in "Pref" and every amount in this summary are in ${cur}.

**Brokers (${brokers.length})**: ${brokers.map((b) => b.name).join(', ') || 'none'}

**Summary**
- Total wealth (positions + cash): ${num(totalWealth)} ${cur}
- Market value of positions: ${num(investedValue)} ${cur} · Cost of open positions: ${num(totalInvested)} ${cur} · Cash: ${num(cashPosition)} ${cur}
- Latent gain: ${sgn(totalGainAbs)}${num(totalGainAbs)} ${cur} (${sgn(totalGainPct)}${num(totalGainPct)}%) · Today: ${sgn(dailyChangePct)}${num(dailyChangePct)}%
- Realized gain (sales): ${sgn(realizedGain)}${num(realizedGain)} ${cur} · Dividends received: ${num(totalDividends)} ${cur} · Fees paid: ${num(totalFees)} ${cur}
${perf ? `- Performance (TWR): ${perf}` : '- Performance (TWR): not available in this session'}
${byBroker.length ? `- By broker: ${shareList(byBroker, cur)}` : ''}
${bySector.length ? `- By sector/class: ${shareList(bySector, cur)}` : ''}
${byCountry.length ? `- By country (ISO code): ${shareList(byCountry, cur)}` : ''}
${best ? `- Best open positions by gain: ${best}` : ''}
${worst ? `- Weakest open positions by gain: ${worst}` : ''}

**Open positions (${total}${positions.length < total ? `, top ${positions.length} by value shown` : ''})** — price = current market price; avgCost = average purchase price
${positions.map((p) => positionLine(p, cur)).join('\n') || '(none)'}

Answer portfolio questions using ONLY this data.`.replace(/\n{3,}/g, '\n\n');
}
