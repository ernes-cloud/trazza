import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { parseAmountInput } from '@/lib/parseAmountInput';
import { computeFire } from '@/services/publicTools/fireCalculator';
import { TOOL_COLORS } from './PublicToolShell';
import { NumberField, ResultRow, HeroNumber, makeMoney } from './toolUi';

const { TEXT, MUTED, FAINT, RULE } = TOOL_COLORS;

// Paleta validada con validate_palette.js (modo claro, superficie blanca):
// azul = valor de la cartera, naranja = lo aportado. Todas las pruebas en PASS.
const SERIES = { value: '#2563eb', contributed: '#eb6834' };

/**
 * Calculadora FIRE: cifra objetivo y años hasta alcanzarla.
 * La matemática está en services/publicTools/fireCalculator.js (testeada).
 */
export default function FireCalculator() {
  const { t, i18n } = useTranslation();
  const { money, locale } = makeMoney(i18n.language);
  const compact = (v) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1, style: 'currency', currency: 'EUR' }).format(v);

  const [expenses, setExpenses] = useState('24000');
  const [savings, setSavings] = useState('20000');
  const [monthly, setMonthly] = useState('500');
  const [ret, setRet] = useState('5');
  const [wr, setWr] = useState('4');
  const [age, setAge] = useState('30');

  const r = useMemo(() => computeFire({
    annualExpenses: parseAmountInput(expenses) ?? 0,
    currentSavings: parseAmountInput(savings) ?? 0,
    monthlyContribution: parseAmountInput(monthly) ?? 0,
    realReturnPct: parseAmountInput(ret) ?? 0,
    withdrawalRatePct: parseAmountInput(wr) ?? 0,
  }), [expenses, savings, monthly, ret, wr]);

  const ageNum = parseAmountInput(age);
  const fireAge = r.reached && ageNum ? Math.floor(ageNum + r.years) : null;
  const yearsLabel = r.years === null ? null : r.years.toLocaleString(locale, { maximumFractionDigits: 1 });

  return (
    <div className="bg-white grid lg:grid-cols-5">
      <div className="lg:col-span-2 p-6 md:p-8 space-y-5" style={{ borderRight: `1px solid ${RULE}` }}>
        <NumberField id="fire-expenses" label={t('fire_calc.f_expenses')} hint={t('fire_calc.f_expenses_hint')} value={expenses} onChange={setExpenses} suffix="€" />
        <NumberField id="fire-savings" label={t('fire_calc.f_savings')} value={savings} onChange={setSavings} suffix="€" />
        <NumberField id="fire-monthly" label={t('fire_calc.f_monthly')} value={monthly} onChange={setMonthly} suffix="€" />
        <NumberField id="fire-return" label={t('fire_calc.f_return')} hint={t('fire_calc.f_return_hint')} value={ret} onChange={setRet} suffix="%" />
        <NumberField id="fire-wr" label={t('fire_calc.f_wr')} hint={t('fire_calc.f_wr_hint')} value={wr} onChange={setWr} suffix="%" />
        <NumberField id="fire-age" label={t('fire_calc.f_age')} value={age} onChange={setAge} />
      </div>

      <div className="lg:col-span-3 p-6 md:p-8 min-w-0">
        <HeroNumber
          label={t('fire_calc.r_target')}
          value={r.target === null ? '—' : money(r.target)}
          sub={r.target === null ? t('fire_calc.r_no_target') : t('fire_calc.r_target_sub', { multiple: (r.target / Math.max(1, parseAmountInput(expenses) || 1)).toLocaleString(locale, { maximumFractionDigits: 1 }) })}
        />
        <div className="mt-6">
          <ResultRow
            label={t('fire_calc.r_when')}
            value={!r.reached ? t('fire_calc.r_never') : r.months === 0 ? t('fire_calc.r_already') : t('fire_calc.r_years', { years: yearsLabel })}
            strong
            tone={r.reached ? 'accent' : 'negative'}
          />
          {fireAge !== null && r.months > 0 && <ResultRow label={t('fire_calc.r_age')} value={t('fire_calc.r_age_value', { age: fireAge })} />}
        </div>
        {!r.reached && <p className="text-[13px] mt-3" style={{ color: MUTED }}>{t('fire_calc.r_never_hint')}</p>}

        {/* Evolución: área = valor de la cartera; línea = lo aportado; la
            línea discontinua horizontal es el objetivo (referencia, no serie). */}
        <div className="mt-6" role="img" aria-label={t('fire_calc.chart_aria')}>
          <div className="flex flex-wrap gap-4 mb-2 text-[12px]" style={{ color: MUTED }}>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded" style={{ backgroundColor: SERIES.value }} />{t('fire_calc.legend_value')}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded" style={{ backgroundColor: SERIES.contributed }} />{t('fire_calc.legend_contributed')}</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={r.series} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fireValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES.value} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={SERIES.value} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={RULE} vertical={false} />
              <XAxis dataKey="year" tick={{ fontSize: 11, fill: FAINT }} tickLine={false} axisLine={{ stroke: RULE }} minTickGap={24} tickFormatter={(y) => t('fire_calc.axis_year', { y })} />
              <YAxis tick={{ fontSize: 11, fill: FAINT }} tickLine={false} axisLine={false} tickFormatter={compact} width={64} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 12, color: TEXT }}
                itemStyle={{ color: TEXT }}
                labelFormatter={(y) => t('fire_calc.tooltip_year', { y })}
                formatter={(v, key) => [money(v), key === 'value' ? t('fire_calc.legend_value') : t('fire_calc.legend_contributed')]}
              />
              {r.target !== null && (
                <ReferenceLine y={r.target} stroke={TEXT} strokeDasharray="4 4" strokeWidth={1}
                  label={{ value: t('fire_calc.target_line'), position: 'insideTopLeft', fontSize: 11, fill: TEXT }} />
              )}
              <Area type="monotone" dataKey="value" stroke={SERIES.value} strokeWidth={2} fill="url(#fireValue)" dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="contributed" stroke={SERIES.contributed} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[12px] mt-4 leading-relaxed" style={{ color: FAINT }}>{t('fire_calc.disclaimer')}</p>
      </div>
    </div>
  );
}
