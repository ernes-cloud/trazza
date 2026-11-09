/**
 * Schedule (or skip) background crons after the HTTP server is listening.
 * Extracted so tests can cover DISABLE_CRONS without importing index.js
 * (index.js always calls listen when loaded).
 */
import { addLog } from './logBuffer.js';
import { startNotificationCron } from '../jobs/notificationCron.js';
import { startWeeklyReportCron } from '../jobs/weeklyReport.js';
import { startPortfolioSnapshotsCron } from '../jobs/portfolioSnapshots.js';
import { startActivationEmailCron } from '../jobs/activationEmail.js';
import { startSiteVisitsCron } from '../jobs/siteVisits.js';

/** @param {NodeJS.ProcessEnv} [env] @returns {boolean} true if crons were scheduled */
export function scheduleCrons(env = process.env) {
  // DISABLE_CRONS=1 → arranca SOLO la API. Los cron apuntan a la Supabase real
  // (el de notificaciones corre inmediatamente y sus filas se convierten en
  // emails vía el webhook de `notifications`), así que levantar el server en
  // local "solo para probar una ruta" notificaba a usuarios de verdad.
  // Sin la variable, el comportamiento de producción es exactamente el de antes.
  if (env.DISABLE_CRONS === '1') {
    console.warn('[trazza-server] DISABLE_CRONS=1 — notification/snapshot crons NOT scheduled');
    addLog('info', 'system', 'Crons disabled via DISABLE_CRONS=1');
    return false;
  }
  startNotificationCron();
  startPortfolioSnapshotsCron();
  startWeeklyReportCron();
  startSiteVisitsCron();
  startActivationEmailCron();
  return true;
}
