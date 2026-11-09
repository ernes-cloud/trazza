/**
 * Watchlist item persistence helpers.
 *
 * `watchlist_items.display_name` (migration 20260705) stores the asset name
 * captured when the item was ADDED (the search result knows it) — quote
 * responses for fund symbols (0P…, ISIN share classes) carry no name, so
 * re-deriving it at render time showed the raw symbol.
 *
 * Both writers tolerate the migration not being applied yet: on a
 * column-missing error the insert retries without the field, and the
 * backfill update is silently skipped.
 */

const isColumnMissing = (error) =>
  error && (error.code === 'PGRST204' || error.code === '42703' || /display_name/.test(error.message || ''));

export async function insertWatchlistItem(supabase, { watchlistId, ticker, displayName }) {
  const withName = await supabase
    .from('watchlist_items')
    .insert({ watchlist_id: watchlistId, ticker, ...(displayName ? { display_name: displayName } : {}) })
    .select()
    .single();

  if (displayName && isColumnMissing(withName.error)) {
    return supabase
      .from('watchlist_items')
      .insert({ watchlist_id: watchlistId, ticker })
      .select()
      .single();
  }
  return withName;
}

/** Fire-and-forget backfill of a resolved name; never throws. */
export async function persistItemDisplayName(supabase, itemId, displayName) {
  if (!displayName) return;
  try {
    await supabase.from('watchlist_items').update({ display_name: displayName }).eq('id', itemId);
  } catch (_) { /* pre-migration DB — the name still shows this session */ }
}

/**
 * True when the item has no persisted name AND the quote couldn't provide a
 * real one (fund symbols echo the ticker back as companyName).
 */
export const needsNameHealing = (item, quoteName) =>
  !item?.display_name && (!quoteName || quoteName === item?.ticker);
