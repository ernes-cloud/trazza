import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { parseAmountInput } from '@/lib/parseAmountInput';
import { computeDividendIncome, ORIGIN_COUNTRIES, TREATY_CAP } from '@/services/publicTools/dividendCalculator';
import { TAX_YEAR } from '@/services/publicTools/savingsTax';
import { TOOL_COLORS } from './PublicToolShell';
import { NumberField, ResultRow, HeroNumber, makeMoney } from './toolUi';

const { TEXT, FAINT, RULE } = TOOL_COLORS;
const CUSTOM = 'custom';

/**
 * Calculadora de dividendos: del bruto al neto que cobras en España.
 * Toda la matemática está en services/publicTools/dividendCalculator.js (testeada).
 */
export default function DividendCalculator() {
  const { t, i18n } = useTranslation();
  const { money, money2, locale } = makeMoney(i18n.language);
  const pct = (v) => `${(v * 100).toLocaleString(locale, { maximumFractionDigits: 3 })} %`;

  const [invested, setInvested] = useState('20000');
  const [yieldPct, setYieldPct] = useState('3');
  const [country, setCountry] = useState('us');
  const [customRate, setCustomRate] = useState('15');
  const [other, setOther] = useState('0');

  const origin = ORIGIN_COUNTRIES.find((c) => c.id === country);
  const originRate = country === CUSTOM ? (parseAmountInput(customRate) ?? 0) / 100 : origin.rate;
  const treatyCap = country === CUSTOM ? TREATY_CAP : origin.treatyCap;

  const r = useMemo(() => computeDividendIncome({
    invested: parseAmountInput(invested) ?? 0,
    yieldPct: parseAmountInput(yieldPct) ?? 0,
    originRate,
    treatyCap,
    otherSavingsIncome: parseAmountInput(other) ?? 0,
  }), [invested, yieldPct, originRate, treatyCap, other]);

  return (
    <div className="bg-white grid lg:grid-cols-5">
      {/* ── Datos ── */}
      <div className="lg:col-span-2 p-6 md:p-8 space-y-5" style={{ borderRight: `1px solid ${RULE}` }}>
        <NumberField id="div-invested" label={t('div_calc.f_invested')} value={invested} onChange={setInvested} suffix="€" />
        <NumberField id="div-yield" label={t('div_calc.f_yield')} hint={t('div_calc.f_yield_hint')} value={yieldPct} onChange={setYieldPct} suffix="%" />
        <label htmlFor="div-country" className="block">
          <span className="block text-[13px] font-semibold mb-1.5" style={{ color: TEXT }}>{t('div_calc.f_country')}</span>
          <select
            id="div-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="w-full rounded-lg bg-white px-3 py-2.5 text-[15px] outline-hidden focus:ring-2 focus:ring-blue-500/40"
            style={{ border: `1px solid ${RULE}`, color: TEXT }}
          >
            {ORIGIN_COUNTRIES.map((c) => (
              <option key={c.id} value={c.id}>{t(`div_calc.country_${c.id}`)} — {pct(c.rate)}</option>
            ))}
            <option value={CUSTOM}>{t('div_calc.country_custom')}</option>
          </select>
        </label>
        {country === CUSTOM && (
          <NumberField id="div-custom" label={t('div_calc.f_custom_rate')} value={customRate} onChange={setCustomRate} suffix="%" />
        )}
        <NumberField id="div-other" label={t('div_calc.f_other')} hint={t('div_calc.f_other_hint')} value={other} onChange={setOther} suffix="€" />
      </div>

      {/* ── Resultado ── */}
      <div className="lg:col-span-3 p-6 md:p-8">
        <HeroNumber
          label={t('div_calc.r_net_year')}
          value={money2(r.net)}
          sub={t('div_calc.r_net_month', { amount: money2(r.netMonthly) })}
        />
        <div className="mt-6">
          <ResultRow label={t('div_calc.r_gross')} value={money2(r.gross)} />
          <ResultRow label={t('div_calc.r_origin')} value={`− ${money2(r.originWithholding)}`} />
          <ResultRow label={t('div_calc.r_spanish_tax', { year: TAX_YEAR })} value={`− ${money2(r.spanishTax)}`} />
          <ResultRow label={t('div_calc.r_deduction')} value={`+ ${money2(r.deduction)}`} tone="accent" />
          <ResultRow label={t('div_calc.r_net_year')} value={money2(r.net)} strong />
        </div>
        <p className="text-[13px] mt-3" style={{ color: FAINT }}>
          {t('div_calc.r_effective', { rate: r.effectiveRatePct.toLocaleString(locale, { maximumFractionDigits: 1 }) })}
        </p>
        {r.lostAbroad > 0 && (
          <div className="mt-5 flex gap-3 rounded-xl px-4 py-3" style={{ backgroundColor: '#fff7ed', border: '1px solid #fed7aa' }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#c2410c' }} />
            <p className="text-[13px] leading-relaxed" style={{ color: '#9a3412' }}>
              {t('div_calc.r_lost', { amount: money(r.lostAbroad) })}
            </p>
          </div>
        )}
        <p className="text-[12px] mt-6 leading-relaxed" style={{ color: FAINT }}>{t('div_calc.disclaimer', { year: TAX_YEAR })}</p>
      </div>
    </div>
  );
}
