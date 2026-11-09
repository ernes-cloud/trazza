import { supabase } from '@/lib/customSupabaseClient';

/**
 * Applies any corporate actions (splits, reverse splits) that occurred
 * between a transaction's date and today to a given price or quantity.
 *
 * Usage: call adjustForSplits() before computing FIFO cost basis so that
 * pre-split prices and quantities are expressed in post-split terms.
 */
export const corporateActionsService = {
  // In-memory cache: asset_id → [{ action_type, effective_date, ratio }]
  _cache: new Map(),

  async getActionsForAsset(assetId) {
    if (this._cache.has(assetId)) return this._cache.get(assetId);

    const { data, error } = await supabase
      .from('corporate_actions')
      .select('action_type, effective_date, ratio')
      .eq('asset_id', assetId)
      .order('effective_date', { ascending: true });

    if (error) {
      console.error('corporateActionsService:', error);
      return [];
    }

    const actions = data || [];
    this._cache.set(assetId, actions);
    return actions;
  },

  /**
   * Adjusts a historical transaction's price and quantity to today's
   * terms by applying all splits that occurred after the transaction date.
   *
   * Example: bought 10 shares at $100 before a 10:1 split →
   *   adjustedQty = 100, adjustedPrice = $10
   */
  async adjustTransaction(transaction, assetId) {
    const actions = await this.getActionsForAsset(assetId);
    const txDate = (transaction.transaction_date || transaction.fecha || '').substring(0, 10);

    let qtyMultiplier = 1;
    let priceDivisor = 1;

    for (const action of actions) {
      if (action.effective_date > txDate) {
        const ratio = parseFloat(action.ratio);
        if (action.action_type === 'SPLIT') {
          qtyMultiplier *= ratio;
          priceDivisor *= ratio;
        } else if (action.action_type === 'REVERSE_SPLIT') {
          qtyMultiplier /= ratio;
          priceDivisor /= ratio;
        }
      }
    }

    return {
      ...transaction,
      cantidad: (parseFloat(transaction.cantidad || transaction.quantity || 0)) * qtyMultiplier,
      precio: (parseFloat(transaction.precio || transaction.price || 0)) / priceDivisor,
    };
  },

  /**
   * Detects a likely split by comparing the current market price against the
   * stored DB price. If the ratio is close to a common split factor (2, 3, 4, 5,
   * 10, 20) the function returns the detected ratio; otherwise returns null.
   *
   * This is a heuristic — always confirm against official corporate action data.
   */
  detectSplitFromPriceJump(storedPrice, currentPrice) {
    if (!storedPrice || !currentPrice || storedPrice <= 0 || currentPrice <= 0) return null;

    const ratio = storedPrice / currentPrice;
    const commonRatios = [2, 3, 4, 5, 10, 20, 0.5, 0.25, 0.1];

    for (const r of commonRatios) {
      if (Math.abs(ratio - r) / r < 0.05) {  // within 5% of a common ratio
        return r > 1
          ? { type: 'SPLIT', ratio: r, description: `Possible ${r}:1 split detected` }
          : { type: 'REVERSE_SPLIT', ratio: 1 / r, description: `Possible 1:${1 / r} reverse split detected` };
      }
    }
    return null;
  },

  clearCache() {
    this._cache.clear();
  },
};
