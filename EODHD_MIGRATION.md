# EODHD Migration Guide

## Overview

Trazza uses **Yahoo Finance** as the primary market data source (free, no key required) with EODHD and Finnhub as fallbacks. The "flip-switch" infrastructure is already wired in — switching to EODHD as the primary provider is a 2-line `.env` change.

---

## Architecture

### Provider fallback chain

```
Default:          Yahoo Finance → EODHD → Finnhub
EODHD primary:    EODHD → Yahoo Finance → Finnhub
```

All routing goes through `src/services/marketDataService.js`. Individual services (`yahooFinance.js`, `eodhd.js`, `finnhubService.js`) are never called directly from components.

### Secure proxy

API keys never reach the browser. Requests to `/api/eodhd-secure/*` go through `plugins/secure-api-proxy.js` (Vite dev) or the equivalent Vercel rewrite (production). The proxy:

1. Checks if `EODHD_PLATFORM_KEY` is set → uses it directly (no DB lookup)
2. Otherwise validates the user's JWT, fetches their personal `eodhd_api_key` from `user_preferences`, and injects it into the outbound request
3. Caches resolved keys for 10 minutes per user to avoid hitting Supabase on every request

### What EODHD covers

- 150,000+ global tickers
- All major European exchanges: LSE, XETRA, Euronext (Paris/Amsterdam/Brussels/Lisbon), Borsa Italiana, Bolsa de Madrid, Nasdaq Nordic
- US, Canada, APAC, emerging markets
- Real-time quotes, historical OHLCV, fundamentals, news, earnings calendar, dividend calendar

---

## Environment variables

| Variable | Side | Purpose |
|---|---|---|
| `EODHD_PLATFORM_KEY` | Server only | Shared platform key — skips per-user DB lookup |
| `VITE_MARKET_DATA_PRIMARY` | Frontend | Set to `eodhd` to flip provider order |

Both are optional. When empty the app behaves exactly as before (Yahoo primary).

---

## How to activate EODHD as primary

### Step 1 — Get an EODHD API key

Sign up at [eodhd.com](https://eodhd.com/) and copy your API token.

### Step 2 — Add to `.env`

```env
EODHD_PLATFORM_KEY=your_eodhd_api_token_here
VITE_MARKET_DATA_PRIMARY=eodhd
```

### Step 3 — Restart the dev server

```bash
npm run dev
```

The dev server must restart to pick up `EODHD_PLATFORM_KEY` (server-side) and for Vite to re-bake `VITE_MARKET_DATA_PRIMARY` into the frontend bundle.

### Step 4 — Verify

Open the browser DevTools Network tab and look for requests to `/api/eodhd-secure/real-time/...`. If they return 200 and the portfolio loads prices, the switch is complete.

---

## What to do if Yahoo Finance goes down

Yahoo Finance does not have an SLA. If it starts returning errors, throttling aggressively, or blocking requests:

1. **Add the env vars** (Step 2 above) — this is the main action.
2. **Redeploy** if on Vercel (env vars are per-deployment).
3. **Check calendar widgets**: the Earnings and Dividend calendars already route through the secure proxy automatically. No extra changes needed.
4. **Check user Settings**: users who configured personal EODHD keys in Settings continue to work. Users without keys now get the platform key transparently.
5. **Historical charts**: `marketDataService.getHistoricalData()` will fall back to EODHD if Yahoo returns empty. Period notation differs slightly (Yahoo uses `1mo`, EODHD maps to `1M`) — `eodhdService.getHistoricalData()` already handles the mapping internally.

### Partial failure (Yahoo flaky but not fully down)

If Yahoo returns data for some tickers but not others (common with rate limiting):

- `marketDataService.getQuotes()` already handles partial failures — Yahoo results are kept, failed tickers are retried against EODHD/Finnhub.
- No code change needed.

### Yahoo completely unreachable

Set `VITE_MARKET_DATA_PRIMARY=eodhd` and redeploy. Done.

---

## Rollback

Remove or blank out both env vars and redeploy:

```env
EODHD_PLATFORM_KEY=
VITE_MARKET_DATA_PRIMARY=
```

---

## Files changed during the flip-switch implementation

| File | Change |
|---|---|
| `plugins/secure-api-proxy.js` | Added `EODHD_PLATFORM_KEY` shortcut — skips JWT + DB if set |
| `src/services/marketDataService.js` | Added `USE_EODHD_PRIMARY` flag; all methods respect provider order |
| `src/services/eodhd.js` | Added `getEnrichedData()` matching Yahoo's return shape (`header`, `metrics`, `about`, `news`) |
| `src/services/earningsService.js` | EODHD earnings calendar now routes through secure proxy (no bare `api_token` in URL) |
| `src/services/dividendService.js` | Added EODHD dividend calendar as fallback for non-US stocks |
| `.env.example` | Documented the two new variables |

---

## EODHD API endpoints used

| Use case | Endpoint |
|---|---|
| Real-time quote | `/api/eodhd-secure/real-time/{ticker}?fmt=json` |
| Historical OHLCV | `/api/eodhd-secure/eod/{ticker}?from=&to=&period=d&fmt=json` |
| Fundamentals | `/api/eodhd-secure/fundamentals/{ticker}?fmt=json` |
| News | `/api/eodhd-secure/news?s={ticker}&from=&to=&fmt=json&limit=20` |
| Ticker search | `/api/eodhd-secure/search/{query}?limit=15` |
| Earnings calendar | `/api/eodhd-secure/calendar/earnings?fmt=json&from=&to=` |
| Dividend calendar | `/api/eodhd-secure/calendar/dividends?fmt=json&from=&to=` |

All requests include `Authorization: Bearer <user-jwt>`. The secure proxy validates the JWT and injects the EODHD key before forwarding to `https://eodhd.com/api`.
