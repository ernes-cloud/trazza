import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock } from 'lucide-react';
import { TAX_YEAR } from '@/services/publicTools/savingsTax';
import { TOOL_COLORS } from './PublicToolShell';
import { ResultRow, HeroNumber, makeMoney } from './toolUi';

const { TEXT, MUTED, FAINT, RULE, ACCENT, PANEL } = TOOL_COLORS;

/**
 * Resultado de `computeCapitalGains` (services/publicTools/capitalGains.js):
 * resumen por año y detalle venta a venta. Lo comparten la calculadora de
 * plusvalías y la de la Renta desde el CSV del broker. `assetLabel` traduce la
 * clave del valor (p. ej. el ISIN) al nombre que se enseña; `noSalesText` y
 * `disclaimerText` sustituyen los textos de cg_calc cuando no encajan.
 */
export default function CapitalGainsResult({ result, assetLabel = (a) => a, noSalesText, disclaimerText }) {
  const { t, i18n } = useTranslation();
  const { money2, locale } = makeMoney(i18n.language);
  const qtyFmt = (v) => v.toLocaleString(locale, { maximumFractionDigits: 6 });
  const dateFmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const signed = (v) => (v > 0 ? `+${money2(v)}` : money2(v));

  return (
    <>
      <div className="p-5 md:p-8" style={{ backgroundColor: '#fcfcfd' }}>
        {result.years.length === 0 ? (
          <p className="text-[15px]" style={{ color: MUTED }}>{noSalesText || t('cg_calc.no_sales')}</p>
        ) : (
          <div className="space-y-8">
            {result.years.map((y) => (
              <div key={y.year} className="grid lg:grid-cols-5 gap-6">
                <div className="lg:col-span-2">
                  <HeroNumber
                    label={t('cg_calc.year_label', { year: y.year })}
                    value={signed(y.net)}
                    sub={y.net > 0 ? t('cg_calc.tax_sub', { tax: money2(y.tax) }) : t('cg_calc.loss_sub')}
                  />
                  {y.year !== TAX_YEAR && (
                    <p className="mt-2 text-[12px]" style={{ color: FAINT }}>{t('cg_calc.brackets_note', { year: TAX_YEAR })}</p>
                  )}
                </div>
                <div className="lg:col-span-3">
                  <ResultRow label={t('cg_calc.r_gains')} value={money2(y.gains)} />
                  <ResultRow label={t('cg_calc.r_losses')} value={money2(y.losses)} tone={y.losses < 0 ? 'negative' : undefined} />
                  {y.deferred > 0 && <ResultRow label={t('cg_calc.r_deferred')} value={money2(y.deferred)} />}
                  {y.released > 0 && <ResultRow label={t('cg_calc.r_released')} value={money2(-y.released)} tone="negative" />}
                  <ResultRow label={t('cg_calc.r_net')} value={signed(y.net)} strong tone={y.net < 0 ? 'negative' : undefined} />
                  <ResultRow label={t('cg_calc.r_tax')} value={money2(y.tax)} strong tone="accent" />
                </div>
              </div>
            ))}

            {result.stillDeferred > 0 && (
              <p className="flex gap-2 rounded-xl px-4 py-3 text-[13px]" style={{ backgroundColor: PANEL, color: MUTED }}>
                <Clock className="w-4 h-4 shrink-0 mt-0.5" style={{ color: ACCENT }} />
                {t('cg_calc.still_deferred', { amount: money2(result.stillDeferred) })}
              </p>
            )}

            <div>
              <h3 className="font-ledger text-[11px] uppercase tracking-[0.2em] mb-3" style={{ color: FAINT }}>{t('cg_calc.detail_title')}</h3>
              <div className="space-y-3">
                {result.sales.map((s) => (
                  <div key={s.id} className="rounded-xl bg-white px-4 py-3.5" style={{ border: `1px solid ${RULE}` }}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[14px] font-semibold" style={{ color: TEXT }}>
                        {t('cg_calc.sale_line', { date: dateFmt(s.date), qty: qtyFmt(s.qty), asset: assetLabel(s.asset) })}
                      </p>
                      <p className="text-[15px] font-bold tabular-nums" style={{ color: s.gain < 0 ? '#b91c1c' : '#047857' }}>{signed(s.gain)}</p>
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
                      {t('cg_calc.sale_math', { proceeds: money2(s.proceeds), cost: money2(s.cost) })}
                    </p>
                    {s.lots.length > 0 && (
                      <p className="mt-1 text-[12px]" style={{ color: FAINT }}>
                        {t('cg_calc.lots_used')}{' '}
                        {s.lots.map((l) => t('cg_calc.lot', { qty: qtyFmt(l.qty), date: dateFmt(l.date), cost: money2(l.unitCost) })).join(' · ')}
                      </p>
                    )}
                    {s.deferred > 0 && (
                      <p className="mt-2 text-[12px] flex gap-1.5" style={{ color: '#b45309' }}>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {t('cg_calc.deferred_note', { amount: money2(s.deferred), dates: s.blockedBy.map((b) => dateFmt(b.date)).join(', ') })}
                      </p>
                    )}
                    {s.released > 0 && (
                      <p className="mt-2 text-[12px] flex gap-1.5" style={{ color: ACCENT }}>
                        <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {t('cg_calc.released_note', { amount: money2(s.released) })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <p className="text-[12px]" style={{ color: FAINT }}>{disclaimerText || t('cg_calc.disclaimer')}</p>
          </div>
        )}
      </div>
    </>
  );
}
