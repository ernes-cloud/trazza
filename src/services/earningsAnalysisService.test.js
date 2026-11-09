import { describe, it, expect } from 'vitest';
import { parseEarningsDetail, extractChangePct, calendarQuarterOf, EMPTY_DETAIL, withEventEstimate } from './earningsAnalysisService';

const quoteSummary = (result) => ({ quoteSummary: { result: [result] } });

describe('extractChangePct', () => {
  it('prefers the fmt string, which Yahoo already expresses in percent points', () => {
    expect(extractChangePct({ raw: 0.0342, fmt: '3.42%' })).toBeCloseTo(3.42, 2);
  });

  it('scales raw by 100 only when fmt is absent (price module reports a fraction)', () => {
    expect(extractChangePct({ raw: 0.0342 })).toBeCloseTo(3.42, 2);
  });

  it('handles negative moves and comma decimals', () => {
    expect(extractChangePct({ raw: -0.0155, fmt: '-1,55%' })).toBeCloseTo(-1.55, 2);
  });

  it('returns null when there is no usable value', () => {
    expect(extractChangePct(undefined)).toBeNull();
    expect(extractChangePct({})).toBeNull();
    expect(extractChangePct({ raw: 'x', fmt: 'N/A' })).toBeNull();
  });
});

describe('calendarQuarterOf', () => {
  it('maps a period end date to its calendar quarter', () => {
    expect(calendarQuarterOf('2026-06-30')).toEqual({ quarter: 2, year: 2026 });
    expect(calendarQuarterOf('2025-12-31')).toEqual({ quarter: 4, year: 2025 });
    expect(calendarQuarterOf('2026-01-31')).toEqual({ quarter: 1, year: 2026 });
  });

  it('returns null for anything that is not an ISO date', () => {
    expect(calendarQuarterOf('0q')).toBeNull();
    expect(calendarQuarterOf(null)).toBeNull();
    expect(calendarQuarterOf('2026-13-01')).toBeNull();
  });
});

describe('parseEarningsDetail', () => {
  it('returns the empty shape for an error payload (e.g. Invalid Crumb)', () => {
    expect(parseEarningsDetail({ finance: { result: null, error: { code: 'Unauthorized' } } })).toEqual(EMPTY_DETAIL);
    expect(parseEarningsDetail(null)).toEqual(EMPTY_DETAIL);
  });

  it('orders quarterly history most-recent-first with the upcoming estimate on top', () => {
    const detail = parseEarningsDetail(quoteSummary({
      earningsHistory: {
        history: [
          { quarter: { fmt: '2025-12-31' }, epsActual: { raw: 2.41 }, epsEstimate: { raw: 2.36 }, surprisePercent: { raw: 0.0212, fmt: '2.12%' } },
          { quarter: { fmt: '2026-03-31' }, epsActual: { raw: 1.61 }, epsEstimate: { raw: 1.55 }, surprisePercent: { raw: 0.0387, fmt: '3.87%' } },
        ],
      },
      earningsTrend: {
        trend: [
          { period: '0q', endDate: { fmt: '2026-06-30' }, earningsEstimate: { avg: { raw: 2.88 } } },
          { period: '+1q', endDate: { fmt: '2026-09-30' }, earningsEstimate: { avg: { raw: 3.01 } } },
        ],
      },
    }));

    expect(detail.history.map(q => q.date)).toEqual(['2026-06-30', '2026-03-31', '2025-12-31']);
    expect(detail.history[0].upcoming).toBe(true);
    expect(detail.history[0].epsActual).toBeNull();
    expect(detail.history[1].epsActual).toBe(1.61);
  });

  // Forma REAL de quoteSummary para AMZN (2026-10-03): sorpresa como fracción,
  // endDate del trend como texto plano y fecha de publicación en earningsChart.
  const amzn = () => quoteSummary({
    earningsHistory: {
      history: [
        { quarter: { raw: 1767139200, fmt: '2025-12-31' }, epsActual: { raw: 1.95 }, epsEstimate: { raw: 1.95962 }, surprisePercent: { raw: -0.0049, fmt: '-0.49%' } },
        { quarter: { raw: 1782777600, fmt: '2026-06-30' }, epsActual: { raw: 5.75 }, epsEstimate: { raw: 1.82604 }, surprisePercent: { raw: 2.1489, fmt: '214.89%' } },
      ],
    },
    earningsTrend: {
      trend: [{ period: '0q', endDate: '2026-09-30', earningsEstimate: { avg: { raw: 1.94595 }, numberOfAnalysts: { raw: 44 } } }],
    },
    earnings: {
      earningsChart: {
        quarterly: [
          { periodEndDate: { raw: 1782777600, fmt: '2026-06-30' }, reportedDate: { raw: 1785441983, fmt: '2026-07-30' } },
        ],
      },
    },
  });

  it('reads the surprise as percent points, not as the raw fraction', () => {
    const [, latest, older] = parseEarningsDetail(amzn()).history;
    expect(latest.surprisePct).toBeCloseTo(214.89, 2);
    expect(older.surprisePct).toBeCloseTo(-0.49, 2);
  });

  it('dates the upcoming quarter from a plain-string endDate instead of showing "0q"', () => {
    const [upcoming] = parseEarningsDetail(amzn()).history;
    expect(upcoming.date).toBe('2026-09-30');
    expect(upcoming.analysts).toBe(44);
  });

  it('attaches the publication date when earningsChart has it', () => {
    const [, latest, older] = parseEarningsDetail(amzn()).history;
    expect(latest.reportedDate).toBe('2026-07-30');
    expect(older.reportedDate).toBeNull();
  });

  it('derives the surprise from both EPS when Yahoo omits it', () => {
    const detail = parseEarningsDetail(quoteSummary({
      earningsHistory: { history: [{ quarter: { fmt: '2026-03-31' }, epsActual: { raw: 1.1 }, epsEstimate: { raw: 1.0 } }] },
    }));
    expect(detail.history[0].surprisePct).toBeCloseTo(10, 6);
  });

  it('extracts quarterly revenue and earnings', () => {
    const detail = parseEarningsDetail(quoteSummary({
      earnings: { financialsChart: { quarterly: [{ date: '2Q2026', revenue: { raw: 94e9 }, earnings: { raw: 23.6e9 } }] } },
    }));

    expect(detail.revenue).toEqual([{ quarter: '2Q2026', revenue: 94e9, earnings: 23.6e9 }]);
  });

  it('normalises pence-quoted prices to pounds', () => {
    const detail = parseEarningsDetail(quoteSummary({
      price: { currency: 'GBp', regularMarketPrice: { raw: 11120 }, regularMarketChangePercent: { raw: 0.021, fmt: '2.10%' } },
    }));

    expect(detail.priceReaction.price).toBeCloseTo(111.2, 3);
    expect(detail.priceReaction.currency).toBe('GBP');
    expect(detail.priceReaction.changePct).toBeCloseTo(2.10, 2);
  });

  it('leaves non-pence prices untouched', () => {
    const detail = parseEarningsDetail(quoteSummary({
      price: { currency: 'USD', regularMarketPrice: { raw: 214.9 }, regularMarketChangePercent: { raw: 0.0342, fmt: '3.42%' } },
    }));

    expect(detail.priceReaction.price).toBe(214.9);
    expect(detail.priceReaction.currency).toBe('USD');
  });

  it('degrades module by module instead of failing whole', () => {
    const detail = parseEarningsDetail(quoteSummary({
      earnings: { financialsChart: { quarterly: [{ date: '2Q2026', revenue: { raw: 1e9 } }] } },
    }));

    expect(detail.history).toEqual([]);
    expect(detail.revenue[0].earnings).toBeNull();
    expect(detail.priceReaction.changePct).toBeNull();
  });
});

describe('withEventEstimate', () => {
  // META, octubre 2026: la cabecera (calendario Nasdaq) decía $6,39 y la fila
  // "Próximo" del historial (earningsTrend de Yahoo) $5,94 para el MISMO trimestre.
  const detail = {
    history: [
      { date: '2026-09-30', epsActual: null, epsEstimate: 5.94, analysts: 44, surprisePct: null, upcoming: true },
      { date: '2026-06-30', reportedDate: '2026-07-29', epsActual: 6.18, epsEstimate: 7.22, surprisePct: -14.4 },
    ],
    revenue: [],
    priceReaction: {},
  };
  const event = { date: '2026-10-21', epsActual: null, epsForecast: 6.39 };

  it('gives the upcoming row the same estimate the card header shows', () => {
    const out = withEventEstimate(detail, event);
    expect(out.history[0].epsEstimate).toBe(6.39);
  });

  it('drops the analyst count, which belonged to the other provider', () => {
    expect(withEventEstimate(detail, event).history[0].analysts).toBeNull();
  });

  it('leaves published quarters and the input untouched', () => {
    const out = withEventEstimate(detail, event);
    expect(out.history[1]).toBe(detail.history[1]);
    expect(detail.history[0].epsEstimate).toBe(5.94);
  });

  it('does nothing once the event is published (it is the quarter just reported)', () => {
    expect(withEventEstimate(detail, { ...event, epsActual: 6.5 })).toBe(detail);
  });

  it('does nothing without a header estimate', () => {
    expect(withEventEstimate(detail, { ...event, epsForecast: null })).toBe(detail);
  });

  it('does nothing when the event is not the report of that quarter', () => {
    expect(withEventEstimate(detail, { ...event, date: '2027-01-28' })).toBe(detail);
    expect(withEventEstimate(detail, { ...event, date: '2026-09-15' })).toBe(detail);
  });

  it('tolerates an empty detail', () => {
    expect(withEventEstimate(EMPTY_DETAIL, event)).toBe(EMPTY_DETAIL);
  });
});
