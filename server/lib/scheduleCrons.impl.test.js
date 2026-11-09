/**
 * N1v2 I3 — DISABLE_CRONS must be exactly '1' to skip crons (mutante invertido).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startNotificationCron,
  startPortfolioSnapshotsCron,
  startWeeklyReportCron,
  startSiteVisitsCron,
  startActivationEmailCron,
  addLog,
} = vi.hoisted(() => ({
  startNotificationCron: vi.fn(),
  startPortfolioSnapshotsCron: vi.fn(),
  startWeeklyReportCron: vi.fn(),
  startSiteVisitsCron: vi.fn(),
  startActivationEmailCron: vi.fn(),
  addLog: vi.fn(),
}));

vi.mock('../jobs/notificationCron.js', () => ({ startNotificationCron }));
vi.mock('../jobs/portfolioSnapshots.js', () => ({ startPortfolioSnapshotsCron }));
vi.mock('../jobs/weeklyReport.js', () => ({ startWeeklyReportCron }));
vi.mock('../jobs/siteVisits.js', () => ({ startSiteVisitsCron }));
vi.mock('../jobs/activationEmail.js', () => ({ startActivationEmailCron }));
vi.mock('./logBuffer.js', () => ({ addLog }));

import { scheduleCrons } from './scheduleCrons.js';

describe('scheduleCrons.impl — DISABLE_CRONS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DISABLE_CRONS=1 no registra; ausente o "0" sí (mata mutante invertido)', () => {
    expect(scheduleCrons({ DISABLE_CRONS: '1' })).toBe(false);
    expect(startNotificationCron).not.toHaveBeenCalled();
    expect(startPortfolioSnapshotsCron).not.toHaveBeenCalled();
    expect(startWeeklyReportCron).not.toHaveBeenCalled();
    expect(startSiteVisitsCron).not.toHaveBeenCalled();
    expect(startActivationEmailCron).not.toHaveBeenCalled();
    expect(addLog).toHaveBeenCalled();

    expect(scheduleCrons({ DISABLE_CRONS: undefined })).toBe(true);
    expect(startNotificationCron).toHaveBeenCalledTimes(1);
    expect(startPortfolioSnapshotsCron).toHaveBeenCalledTimes(1);
    expect(startWeeklyReportCron).toHaveBeenCalledTimes(1);
    expect(startSiteVisitsCron).toHaveBeenCalledTimes(1);
    expect(startActivationEmailCron).toHaveBeenCalledTimes(1);

    startNotificationCron.mockClear();
    expect(scheduleCrons({ DISABLE_CRONS: '0' })).toBe(true);
    expect(startNotificationCron).toHaveBeenCalled();
  });
});
