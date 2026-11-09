-- Watchlist items only stored the ticker; the display name was re-derived from
-- getQuote() on every load. Fund symbols (0P…, ISIN-based share classes) return
-- no name in quote responses, so favorites showed the raw symbol ("0P00019ORF.F")
-- instead of "Fidelity MSCI World Index Fund". The search result that ADDED the
-- item knows the name — persist it.
alter table public.watchlist_items
  add column if not exists display_name text;
