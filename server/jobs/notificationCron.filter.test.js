import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDividendFromYahooMock,
  getEarningsFromYahooMock,
  fetchDividendCalendarMock,
  fetchEarningsCalendarMock,
} = vi.hoisted(() => ({
  getDividendFromYahooMock: vi.fn(),
  getEarningsFromYahooMock: vi.fn(),
  fetchDividendCalendarMock: vi.fn(async () => ({})),
  fetchEarningsCalendarMock: vi.fn(async () => ({})),
}));

vi.mock('../lib/adminSupabase.js', () => ({
  supabaseAdmin: {
    from: vi.fn((table) => {
      if (table !== 'user_preferences') throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { language: 'es' }, error: null }),
          }),
        }),
      };
    }),
  },
}));

vi.mock('../lib/fetchAllRows.js', () => ({
  fetchAllRows: vi.fn(async () => ({
    data: [
      {
        id: 'pos-cash',
        quantity: 1500,
        assets: { ticker: 'CASH_USD', asset_class: 'Cash' },
        brokers: { user_id: 'user-1' },
      },
    ],
    error: null,
  })),
}));

vi.mock('../lib/marketCalendar.js', () => ({
  getDividendFromYahoo: getDividendFromYahooMock,
  getEarningsFromYahoo: getEarningsFromYahooMock,
  fetchDividendCalendar: fetchDividendCalendarMock,
  fetchEarningsCalendar: fetchEarningsCalendarMock,
}));

vi.mock('../lib/emailPrefs.js', () => ({ wantsEmail: vi.fn(async () => true) }));
vi.mock('../lib/heartbeat.js', () => ({ pingHeartbeat: vi.fn() }));
vi.mock('../lib/marketQuotes.js', () => ({
  resolveTicker: vi.fn((t) => t),
  getYahooQuotes: vi.fn(async () => new Map()),
}));
vi.mock('../lib/recurringEndAlerts.js', () => ({ computeRecurringEndAlerts: vi.fn(() => []) }));
vi.mock('../lib/watchlistAlerts.js', () => ({ evaluateWatchlistAlert: vi.fn(() => null) }));
vi.mock('../lib/emailQuota.js', () => ({ madridDayStartUtc: vi.fn(() => new Date()) }));
vi.mock('../lib/notificationText.js', () => ({
  langOf: vi.fn(() => 'es'),
  exDividendNotice: vi.fn(() => null),
  dividendPaidNotice: vi.fn(() => null),
  earningsUpcomingNotice: vi.fn(() => null),
  earningsResultNotice: vi.fn(() => null),
  priceTargetNotice: vi.fn(() => ({ title: '', message: '', type: '', dedup: '' })),
  percentMoveNotice: vi.fn(() => ({ title: '', message: '', type: '', dedup: '' })),
  portfolioMoveNotice: vi.fn(() => ({ title: '', message: '', type: '', dedup: '' })),
  recurringEndNotice: vi.fn(() => ({ title: '', message: '', type: '', dedup: '' })),
}));

import { checkDividendsAndEarnings } from './notificationCron.js';

describe('checkDividendsAndEarnings cash filter wiring', () => {
  beforeEach(() => {
    getDividendFromYahooMock.mockReset();
    getEarningsFromYahooMock.mockReset();
    fetchDividendCalendarMock.mockClear();
    fetchEarningsCalendarMock.mockClear();
  });

  it('skips calendar lookups for CASH_* positions', async () => {
    const ok = await checkDividendsAndEarnings();
    expect(ok).toBe(true);
    expect(fetchDividendCalendarMock).toHaveBeenCalledOnce();
    expect(fetchEarningsCalendarMock).toHaveBeenCalledOnce();
    expect(getDividendFromYahooMock).not.toHaveBeenCalled();
    expect(getEarningsFromYahooMock).not.toHaveBeenCalled();
  });
});
