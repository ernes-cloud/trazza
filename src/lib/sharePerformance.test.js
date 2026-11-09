import { describe, it, expect } from 'vitest';
import { samplePerformanceWeekly, rebasePerformanceRange } from './sharePerformance';

describe('samplePerformanceWeekly', () => {
  it('returns [] for empty or nullish input', () => {
    expect(samplePerformanceWeekly([])).toEqual([]);
    expect(samplePerformanceWeekly(null)).toEqual([]);
    expect(samplePerformanceWeekly(undefined)).toEqual([]);
  });

  it('maps pct from ttwror and roi from simpleROI, rounded to 2 decimals', () => {
    const out = samplePerformanceWeekly([
      { date: '2024-01-01', ttwror: 12.3456, simpleROI: 9.8765 },
    ]);
    // single point is also re-appended as "last" → assert on the first sample
    expect(out[0]).toEqual({ date: '2024-01-01', pct: 12.35, roi: 9.88 });
  });

  it('emits roi = null when no ROI field is present', () => {
    const out = samplePerformanceWeekly([{ date: '2024-01-01', ttwror: 5 }]);
    expect(out[0].roi).toBeNull();
    expect(out[0].pct).toBe(5);
  });

  it('falls back through normalizedTTWROR / yield for pct and normalizedSimpleROI for roi', () => {
    expect(samplePerformanceWeekly([{ date: '2024-01-01', normalizedTTWROR: 4 }])[0].pct).toBe(4);
    expect(samplePerformanceWeekly([{ date: '2024-01-01', yield: 3 }])[0].pct).toBe(3);
    expect(samplePerformanceWeekly([{ date: '2024-01-01', normalizedSimpleROI: 2 }])[0].roi).toBe(2);
  });

  it('keeps one point per week and always includes the most recent point', () => {
    // 2024-01-01, -02, -03 are the same calendar week → collapse to one sample,
    // then the last point (-03) is appended as the "today" anchor.
    const out = samplePerformanceWeekly([
      { date: '2024-01-01', ttwror: 1, simpleROI: 1 },
      { date: '2024-01-02', ttwror: 2, simpleROI: 2 },
      { date: '2024-01-03', ttwror: 3, simpleROI: 3 },
    ]);
    expect(out[0].date).toBe('2024-01-01');
    expect(out[out.length - 1].date).toBe('2024-01-03');
    // the middle day (-02) never gets its own sample
    expect(out.some(p => p.date === '2024-01-02')).toBe(false);
  });

  it('skips points without a date', () => {
    const out = samplePerformanceWeekly([
      { ttwror: 1 },
      { date: '2024-02-01', ttwror: 2, simpleROI: 2 },
    ]);
    expect(out.every(p => p.date)).toBe(true);
  });
});

describe('rebasePerformanceRange', () => {
  const NOW = new Date('2024-12-15T00:00:00Z');

  it('returns [] for empty input', () => {
    expect(rebasePerformanceRange([], '6M', NOW)).toEqual([]);
    expect(rebasePerformanceRange(null, '6M', NOW)).toEqual([]);
  });

  it('returns the full series unchanged for ALL', () => {
    const data = [{ date: '2024-01-01', pct: 5, roi: 4 }];
    expect(rebasePerformanceRange(data, 'ALL', NOW)).toBe(data);
  });

  it('rebases pct and roi so the first in-range point sits at 0%', () => {
    const data = [
      { date: '2024-01-01', pct: 0,    roi: 0 },
      { date: '2024-07-01', pct: 10,   roi: 8 },     // first point inside 6M window
      { date: '2024-12-01', pct: 21,   roi: 15.4 },
    ];
    const out = rebasePerformanceRange(data, '6M', NOW); // cutoff = 2024-06-15
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ date: '2024-07-01', pct: 0, roi: 0 });
    // pct: (1.21/1.10 − 1)*100 = 10 ; roi: (1.154/1.08 − 1)*100 = 6.85
    expect(out[1].pct).toBe(10);
    expect(out[1].roi).toBe(6.85);
  });

  it('preserves null roi while still rebasing pct', () => {
    const data = [
      { date: '2024-07-01', pct: 10, roi: null },
      { date: '2024-12-01', pct: 21, roi: null },
    ];
    const out = rebasePerformanceRange(data, '6M', NOW);
    expect(out[0].roi).toBeNull();
    expect(out[1].roi).toBeNull();
    expect(out[0].pct).toBe(0);
  });

  it('falls back to the full series when no points fall inside the range', () => {
    const data = [{ date: '2020-01-01', pct: 5, roi: 4 }];
    expect(rebasePerformanceRange(data, '6M', NOW)).toBe(data);
  });

  it('YTD cuts at Jan 1st of the current year', () => {
    const data = [
      { date: '2023-11-01', pct: 5,  roi: 5 },
      { date: '2024-02-01', pct: 12, roi: 10 },
    ];
    const out = rebasePerformanceRange(data, 'YTD', NOW);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2024-02-01');
  });
});
