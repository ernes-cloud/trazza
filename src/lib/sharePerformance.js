/**
 * Pure helpers for the shared-portfolio performance chart.
 *
 * Kept dependency-free (no React, no Supabase) so both SharePortfolioModal
 * (producer: samples the series into the DB payload) and SharedPortfolioPage
 * (consumer: rebases the stored series per range) share ONE implementation that
 * is unit-tested in isolation — see sharePerformance.test.js.
 *
 * Each chart point carries two cumulative-return chains, in percent:
 *   pct → TTWROR (true time-weighted, FX-aware)   — the default series
 *   roi → ROI Simple (latent / open cost basis)    — the Dashboard's other line
 */

// One representative point per ISO-ish week to keep the DB payload small.
// Input:  performanceService.calculateDailyTWR output [{date, ttwror, simpleROI, ...}]
// Output: [{date, pct, roi}] — pct = cumulative TTWROR %, roi = cumulative ROI Simple %
export function samplePerformanceWeekly(perfData) {
  if (!perfData?.length) return [];
  const seen = new Set();
  const result = [];
  const pointOf = (d) => {
    const pct = d.ttwror ?? d.normalizedTTWROR ?? d.yield ?? 0;
    const roi = d.simpleROI ?? d.normalizedSimpleROI ?? null;
    return { date: d.date, pct: +pct.toFixed(2), roi: roi == null ? null : +roi.toFixed(2) };
  };
  for (const d of perfData) {
    if (!d.date) continue;
    const dt   = new Date(d.date);
    const week = `${dt.getFullYear()}-W${Math.floor((dt.getDate() - 1) / 7 + 1).toString().padStart(2,'0')}-${String(dt.getMonth()).padStart(2,'0')}`;
    if (seen.has(week)) continue;
    seen.add(week);
    result.push(pointOf(d));
  }
  // Always include the last point (most recent) so the chart ends on "today".
  const last = perfData[perfData.length - 1];
  if (last?.date && !seen.has(last.date)) {
    result.push(pointOf(last));
  }
  return result;
}

// Geometrically rebase the cumulative series so the selected range starts at 0%:
// x_rebased = (1 + x) / (1 + x_base) − 1 (chained returns, not a ratio of values).
// Both pct (TTWROR) and roi are rebased the same way so the metric toggle stays
// consistent. `now` is injectable for deterministic tests.
export function rebasePerformanceRange(perfData, range, now = new Date()) {
  const data = perfData || [];
  if (!data.length) return [];
  if (range === 'ALL') return data;

  const cutoff = new Date(now);
  if (range === '1Y')  cutoff.setFullYear(now.getFullYear() - 1);
  if (range === '6M')  cutoff.setMonth(now.getMonth() - 6);
  if (range === 'YTD') cutoff.setMonth(0, 1);
  const cutStr = cutoff.toISOString().split('T')[0];

  const slice = data.filter(d => d.date >= cutStr);
  if (!slice.length) return data; // range has no points → fall back to the full series

  const rebase = (v, base) => base > 0 ? +(((1 + (v ?? 0) / 100) / base - 1) * 100).toFixed(2) : 0;
  const baseFactor    = 1 + (slice[0].pct ?? 0) / 100;
  const baseRoiFactor = 1 + (slice[0].roi ?? 0) / 100;
  return slice.map(d => ({
    ...d,
    pct: rebase(d.pct, baseFactor),
    roi: d.roi == null ? null : rebase(d.roi, baseRoiFactor),
  }));
}
