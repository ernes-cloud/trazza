import { describe, it, expect } from 'vitest';
import { wantsEmail } from './emailPrefs.js';

describe('wantsEmail', () => {
  const all = {
    email_notifications_enabled: true,
    email_notify_dividends: true, email_notify_earnings: true,
    email_notify_alerts: true, email_notify_weekly_report: true,
  };

  it('respeta el interruptor de cada categoría (antes se ignoraba)', () => {
    expect(wantsEmail({ ...all, email_notify_dividends: false }, 'dividends')).toBe(false);
    expect(wantsEmail({ ...all, email_notify_earnings: false }, 'earnings')).toBe(false);
    expect(wantsEmail({ ...all, email_notify_alerts: false }, 'alerts')).toBe(false);
    expect(wantsEmail({ ...all, email_notify_weekly_report: false }, 'weekly')).toBe(false);
  });

  it('apagar una categoría no afecta a las demás', () => {
    expect(wantsEmail({ ...all, email_notify_dividends: false }, 'earnings')).toBe(true);
  });

  it('el interruptor general manda sobre todo', () => {
    expect(wantsEmail({ ...all, email_notifications_enabled: false }, 'alerts')).toBe(false);
    expect(wantsEmail({ ...all, email_notifications_enabled: false }, null)).toBe(false);
  });

  it('sin preferencias, sin columna o sin categoría: sí (comportamiento de siempre)', () => {
    expect(wantsEmail(null, 'dividends')).toBe(true);
    expect(wantsEmail({ email_notifications_enabled: true }, 'weekly')).toBe(true);
    expect(wantsEmail({ ...all, email_notify_dividends: null }, 'dividends')).toBe(true);
    expect(wantsEmail(all, null)).toBe(true);
  });
});
