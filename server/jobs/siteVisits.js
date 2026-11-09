/**
 * OSS: el módulo de visitas (nginx → site_visits_daily) se retiró en D3.
 * Se conserva startSiteVisitsCron para el contrato de scheduleCrons y tests.
 */
export function startSiteVisitsCron() {
  console.log('[siteVisits] OSS — cron de visitas no programado (tabla retirada).');
}
